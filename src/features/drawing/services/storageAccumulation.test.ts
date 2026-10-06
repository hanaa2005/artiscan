/**
 * WEEK 1A - does simply opening the app accumulate abandoned records?
 *
 * The concern was that every launch creates a fresh session id, so a user who
 * opens ArtiScan, looks at it and leaves would leave a row behind each time -
 * and the store would grow without bound with recordings of nothing.
 *
 * These tests establish what actually happens, so the cleanup policy is written
 * against measured behaviour rather than a worry. The answer turns out to be
 * that autosave never writes an untouched session, which is why no automatic
 * deletion of drawing sessions is introduced: there is nothing accumulating to
 * delete, and deleting real recordings on a timer would be far worse than the
 * problem it solved.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoSave } from '../hooks/useAutoSave'
import {
  clearSessions,
  deleteSession,
  flushPendingWrites,
  getLatestSession,
  getSession,
  saveSession,
} from './drawingSessionRepository'
import { resetDatabaseConnectionForTests, withStore } from './indexedDb'
import { makeSession, makeStrokeSeries } from '../testing/sessionFixture'
import type { DrawingSession } from '../types/drawing.types'

/** How many rows the drawing-session store currently holds. */
function countStoredSessions(): Promise<number> {
  return withStore('drawingSessions', 'readonly', async (store) => {
    return new Promise<number>((resolve, reject) => {
      const request = store.count()
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('count failed'))
      }
    })
  })
}

/** Simulates one app launch: mount autosave, wait past the debounce, unmount. */
async function launchApp(snapshot: DrawingSession, revision: number): Promise<void> {
  const { unmount } = renderHook(() => useAutoSave(() => snapshot, revision))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })
  await flushPendingWrites(snapshot.id)
  unmount()
}

describe('repeated app launches', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    resetDatabaseConnectionForTests()
    await clearSessions()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('MEASURED: five launches with no drawing leave the store empty', async () => {
    for (let launch = 0; launch < 5; launch += 1) {
      // Revision 0 is the untouched initial session of a fresh lifetime.
      await launchApp(makeSession({ id: `launch-${launch}`, strokes: [] }), 0)
    }

    expect(await countStoredSessions()).toBe(0)
  })

  it('writes as soon as something is actually drawn', async () => {
    await launchApp(makeSession({ id: 'drawn', strokes: makeStrokeSeries(1) }), 1)

    expect(await countStoredSessions()).toBe(1)
    expect(await getSession('drawn')).not.toBeNull()
  })

  it('one row per session that was drawn in, not one per launch', async () => {
    await launchApp(makeSession({ id: 'a', strokes: makeStrokeSeries(1) }), 1)
    await launchApp(makeSession({ id: 'b', strokes: [] }), 0)
    await launchApp(makeSession({ id: 'c', strokes: makeStrokeSeries(2) }), 1)

    expect(await countStoredSessions()).toBe(2)
  })
})

describe('drawing sessions are never removed behind the user', () => {
  beforeEach(async () => {
    resetDatabaseConnectionForTests()
    await clearSessions()
  })

  it('keeps an old session indefinitely: age alone deletes nothing', async () => {
    await saveSession(makeSession({ id: 'old', createdAt: '2024-01-01T00:00:00.000Z' }))
    await saveSession(makeSession({ id: 'new', createdAt: '2026-08-17T00:00:00.000Z' }))

    // There is deliberately no age-based sweep for drawing sessions. The only
    // way a row leaves this store is an explicit call.
    expect(await getSession('old')).not.toBeNull()
    expect((await getLatestSession())?.id).toBe('new')
  })

  it('removes a session only when explicitly asked', async () => {
    await saveSession(makeSession({ id: 'target' }))
    await saveSession(makeSession({ id: 'bystander' }))

    await deleteSession('target')

    expect(await getSession('target')).toBeNull()
    expect(await getSession('bystander')).not.toBeNull()
  })

  it('surfaces a write failure as a rejection instead of failing silently', async () => {
    const broken = makeSession({ id: 'broken' })
    // A function cannot be structured-cloned. A quota or clone failure must
    // reach the caller so the UI can report it honestly rather than showing a
    // "saved" state for data that was never written.
    ;(broken as unknown as Record<string, unknown>)['oops'] = () => undefined

    await expect(saveSession(broken)).rejects.toBeInstanceOf(Error)
    expect(await getSession('broken')).toBeNull()
  })
})
