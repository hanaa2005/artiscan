import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSessions,
  deleteSession,
  flushPendingWrites,
  getLatestSession,
  getSession,
  isIndexedDbSupported,
  saveSession,
} from './drawingSessionRepository'
import { makeSession, makeStrokeSeries } from '../testing/sessionFixture'

// IndexedDB here comes from fake-indexeddb (see src/test/setup.ts).
describe('drawingSessionRepository', () => {
  beforeEach(async () => {
    await clearSessions()
  })

  it('detects that IndexedDB is available', () => {
    expect(isIndexedDbSupported()).toBe(true)
  })

  it('stores a session and reads it back unchanged', async () => {
    const session = makeSession()
    await saveSession(session)

    const stored = await getSession(session.id)
    expect(stored).toEqual(session)
  })

  it('returns null for an id that was never stored', async () => {
    expect(await getSession('does-not-exist')).toBeNull()
  })

  it('overwrites an existing session rather than duplicating it', async () => {
    const session = makeSession()
    await saveSession(session)
    await saveSession({ ...session, strokes: [] })

    const stored = await getSession(session.id)
    expect(stored?.strokes).toHaveLength(0)
  })

  it('returns the most recently created session', async () => {
    await saveSession(makeSession({ id: 'older', createdAt: '2026-08-01T10:00:00.000Z' }))
    await saveSession(makeSession({ id: 'newer', createdAt: '2026-08-09T10:00:00.000Z' }))

    const latest = await getLatestSession()
    expect(latest?.id).toBe('newer')
  })

  it('returns null when nothing is stored', async () => {
    expect(await getLatestSession()).toBeNull()
  })

  it('deletes a single session', async () => {
    const session = makeSession()
    await saveSession(session)
    await deleteSession(session.id)

    expect(await getSession(session.id)).toBeNull()
  })
})

/**
 * Autosave writes a WHOLE session snapshot, not a delta. So if an older write
 * lands after a newer one, the stored record silently moves backwards: the user
 * draws a fifth stroke, a late write carrying four strokes commits, and the
 * restored session is missing a stroke nobody deleted.
 *
 * Every test here is deterministic - no timers, no sleeps.
 */
describe('drawingSessionRepository - stale write protection', () => {
  beforeEach(async () => {
    await clearSessions()
  })

  /** One editor lifetime. */
  const EPOCH = 'epoch-a'

  /** A session whose stroke count encodes its revision, for easy assertions. */
  function snapshotWithStrokes(count: number) {
    const ids = Array.from({ length: count }, (_, i) => `stroke-${i}`)
    return makeSession({ id: 'session-under-test', strokes: makeStrokeSeries(count, ids) })
  }

  it('discards a save whose revision is older than one already accepted', async () => {
    await saveSession(snapshotWithStrokes(5), { epoch: EPOCH, revision: 2 })
    // This one was built before the newer snapshot but only arrives now.
    await saveSession(snapshotWithStrokes(4), { epoch: EPOCH, revision: 1 })

    const stored = await getSession('session-under-test')
    expect(stored?.strokes).toHaveLength(5)
  })

  it('discards a save that repeats the accepted revision', async () => {
    await saveSession(snapshotWithStrokes(3), { epoch: EPOCH, revision: 7 })
    await saveSession(snapshotWithStrokes(1), { epoch: EPOCH, revision: 7 })

    const stored = await getSession('session-under-test')
    expect(stored?.strokes).toHaveLength(3)
  })

  it('accepts a save whose revision is newer', async () => {
    await saveSession(snapshotWithStrokes(2), { epoch: EPOCH, revision: 1 })
    await saveSession(snapshotWithStrokes(6), { epoch: EPOCH, revision: 2 })

    const stored = await getSession('session-under-test')
    expect(stored?.strokes).toHaveLength(6)
  })

  it('serializes concurrent writes so the newest revision wins', async () => {
    // Issued together, without awaiting between them: this is what autosave
    // actually does when several changes land inside one debounce window.
    const writes = [
      saveSession(snapshotWithStrokes(1), { epoch: EPOCH, revision: 1 }),
      saveSession(snapshotWithStrokes(2), { epoch: EPOCH, revision: 2 }),
      saveSession(snapshotWithStrokes(3), { epoch: EPOCH, revision: 3 }),
    ]
    await Promise.all(writes)
    await flushPendingWrites('session-under-test')

    const stored = await getSession('session-under-test')
    expect(stored?.strokes).toHaveLength(3)
  })

  it('still wins for the newest revision when writes are issued in reverse', async () => {
    const writes = [
      saveSession(snapshotWithStrokes(9), { epoch: EPOCH, revision: 3 }),
      saveSession(snapshotWithStrokes(2), { epoch: EPOCH, revision: 2 }),
      saveSession(snapshotWithStrokes(1), { epoch: EPOCH, revision: 1 }),
    ]
    await Promise.all(writes)
    await flushPendingWrites('session-under-test')

    const stored = await getSession('session-under-test')
    expect(stored?.strokes).toHaveLength(9)
  })

  it('tracks revisions per session, so one session cannot block another', async () => {
    await saveSession(makeSession({ id: 'session-a' }), { epoch: EPOCH, revision: 10 })
    await saveSession(makeSession({ id: 'session-b' }), { epoch: EPOCH, revision: 1 })

    // session-b's low revision is unrelated to session-a's high one.
    expect(await getSession('session-b')).not.toBeNull()
  })

  it('writes unconditionally when no revision is supplied', async () => {
    await saveSession(snapshotWithStrokes(5), { epoch: EPOCH, revision: 9 })
    // A manual save carries no revision and must not be silently dropped.
    await saveSession(snapshotWithStrokes(1))

    const stored = await getSession('session-under-test')
    expect(stored?.strokes).toHaveLength(1)
  })

  it('snapshots the session at call time, not at write time', async () => {
    // The caller's object can keep mutating while the write waits its turn.
    const session = snapshotWithStrokes(2)
    const write = saveSession(session, { epoch: EPOCH, revision: 1 })
    session.strokes = []
    await write

    const stored = await getSession('session-under-test')
    expect(stored?.strokes).toHaveLength(2)
  })
})

/**
 * A revision counter belongs to ONE editor lifetime. It restarts at zero on
 * every mount, so a number from one lifetime says nothing about a number from
 * another - and comparing them silently discards perfectly good writes.
 */
describe('drawingSessionRepository - revision epochs', () => {
  beforeEach(async () => {
    await clearSessions()
  })

  function snapshotWithStrokes(count: number) {
    const ids = Array.from({ length: count }, (_, i) => `stroke-${i}`)
    return makeSession({ id: 'session-under-test', strokes: makeStrokeSeries(count, ids) })
  }

  it('accepts a low revision from a NEW epoch after a high one from the old epoch', async () => {
    // The exact remount scenario: autosave reaches revision 10, the editor
    // remounts, the same session is restored, and the user makes one change.
    // That change is revision 1 of a fresh counter and must be stored at once.
    await saveSession(snapshotWithStrokes(8), { epoch: 'lifetime-1', revision: 10 })

    // ...component unmounts, remounts, revision counter resets to zero...
    await saveSession(snapshotWithStrokes(9), { epoch: 'lifetime-2', revision: 1 })

    const stored = await getSession('session-under-test')
    expect(stored?.strokes).toHaveLength(9)
  })

  it('keeps guarding within the new epoch once it has taken over', async () => {
    await saveSession(snapshotWithStrokes(8), { epoch: 'lifetime-1', revision: 10 })
    await saveSession(snapshotWithStrokes(3), { epoch: 'lifetime-2', revision: 2 })
    // Stale inside the new lifetime, so it is still dropped.
    await saveSession(snapshotWithStrokes(1), { epoch: 'lifetime-2', revision: 1 })

    const stored = await getSession('session-under-test')
    expect(stored?.strokes).toHaveLength(3)
  })

  it('stores every change of a fresh epoch counting up from one', async () => {
    await saveSession(snapshotWithStrokes(7), { epoch: 'lifetime-1', revision: 42 })

    for (let revision = 1; revision <= 3; revision += 1) {
      await saveSession(snapshotWithStrokes(revision), { epoch: 'lifetime-2', revision })
    }

    const stored = await getSession('session-under-test')
    expect(stored?.strokes).toHaveLength(3)
  })
})

describe('drawingSessionRepository - retry after a failed write', () => {
  beforeEach(async () => {
    await clearSessions()
  })

  it('lets a retry at the SAME revision through after a failure', async () => {
    // A revision claim exists to protect a snapshot that WAS stored. If a
    // transient IndexedDB error meant nothing was written, holding the claim
    // would block the retry and lose the change permanently.
    const session = makeSession({ id: 'retry-session' })

    // structuredClone rejects a function, so this write fails inside saveSession.
    const poisoned = { ...session, canvas: { ...session.canvas, devicePixelRatio: 1 } }
    Object.defineProperty(poisoned, 'boom', { value: () => undefined, enumerable: true })

    await expect(
      saveSession(poisoned as typeof session, { epoch: 'e1', revision: 5 }),
    ).rejects.toBeDefined()
    expect(await getSession('retry-session')).toBeNull()

    // The retry carries the same logical revision, because it is the same change.
    await saveSession(session, { epoch: 'e1', revision: 5 })
    expect(await getSession('retry-session')).not.toBeNull()
  })

  it('keeps a newer revision protected after an earlier write failed', async () => {
    const poisoned = { ...makeSession({ id: 'retry-session' }) }
    Object.defineProperty(poisoned, 'boom', { value: () => undefined, enumerable: true })

    await expect(
      saveSession(poisoned as ReturnType<typeof makeSession>, { epoch: 'e1', revision: 1 }),
    ).rejects.toBeDefined()

    // A later change succeeds and claims the slot.
    await saveSession(makeSession({ id: 'retry-session' }), { epoch: 'e1', revision: 2 })

    // Releasing the failed claim must not have reopened the door to revision 1.
    await saveSession(makeSession({ id: 'retry-session', strokes: [] }), {
      epoch: 'e1',
      revision: 1,
    })

    const stored = await getSession('retry-session')
    expect(stored?.strokes.length).toBeGreaterThan(0)
  })

  it('reports the failure to the caller rather than throwing synchronously', async () => {
    // saveSession's contract is a promise; a sync throw would escape every
    // `.then(..., onError)` autosave uses and surface as an unhandled error.
    const poisoned = { ...makeSession({ id: 'retry-session' }) }
    Object.defineProperty(poisoned, 'boom', { value: () => undefined, enumerable: true })

    let threwSynchronously = false
    let promise: Promise<void> = Promise.resolve()
    try {
      promise = saveSession(poisoned as ReturnType<typeof makeSession>, {
        epoch: 'e1',
        revision: 1,
      })
    } catch {
      threwSynchronously = true
    }

    expect(threwSynchronously).toBe(false)
    await expect(promise).rejects.toBeDefined()
  })
})
