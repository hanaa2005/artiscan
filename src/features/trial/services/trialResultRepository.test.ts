/**
 * WEEK 1A - persistence of completed trial results.
 *
 * Before this store existed a finished trial lived only in React state, so a
 * reload before the user clicked "export JSON" destroyed the recording. These
 * tests cover the three things that makes it safe to rely on:
 *
 *   1. a completed result survives and comes back intact, canonical session
 *      included;
 *   2. an INCOMPLETE result is refused rather than stored as if it were an
 *      observation;
 *   3. a slow older write can never overwrite a newer snapshot.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearExpiredTrialResults,
  clearTrialResults,
  deleteTrialResult,
  flushPendingTrialWrites,
  getLatestTrialResult,
  getTrialResult,
  isCompleteTrialResult,
  listTrialResults,
  saveTrialResult,
} from './trialResultRepository'
import { resetDatabaseConnectionForTests } from '../../drawing/services/indexedDb'
import { validateTrialResult } from './trialResultValidator'
import { buildTrialResult } from './trialResultSerializer'
import { makeSession, makeStrokeSeries } from '../../drawing/testing/sessionFixture'
import type { DrawingTask, DrawingTrial, DrawingTrialResult } from '../types/trial.types'

const TASK: DrawingTask = {
  id: 'house',
  labelFa: 'خانه',
  labelEn: 'house',
  quickDrawCategory: 'house',
  instructionFa: 'یک خانه بکشید.',
  timeLimitSeconds: 60,
  enabled: true,
}

function completedTrial(overrides: Partial<DrawingTrial> = {}): DrawingTrial {
  return {
    id: 'trial-1',
    status: 'completed',
    timeLimitSeconds: 60,
    timing: {
      startedAt: '2026-08-17T10:00:00.000Z',
      completedAt: '2026-08-17T10:00:30.000Z',
      durationMs: 30_000,
      countdownSeconds: 3,
    },
    ...overrides,
  }
}

/** A complete, valid result with real strokes in its canonical session. */
function makeResult(
  trialOverrides: Partial<DrawingTrial> = {},
  strokeCount = 2,
): DrawingTrialResult {
  const session = makeSession({ strokes: makeStrokeSeries(strokeCount) })
  return buildTrialResult(completedTrial(trialOverrides), TASK, session)
}

beforeEach(async () => {
  resetDatabaseConnectionForTests()
  await clearTrialResults()
})

describe('isCompleteTrialResult', () => {
  it('accepts a genuinely finished trial', () => {
    expect(isCompleteTrialResult(makeResult())).toBe(true)
  })

  it.each([
    ['status is still drawing', { status: 'drawing' as const }],
    ['status is cancelled', { status: 'cancelled' as const }],
  ])('rejects when %s', (_label, overrides) => {
    expect(isCompleteTrialResult(makeResult(overrides))).toBe(false)
  })

  it('rejects a completed status with no completion timestamp', () => {
    const result = makeResult()
    result.trial.timing.completedAt = null
    expect(isCompleteTrialResult(result)).toBe(false)
  })

  it('rejects a completed status with no measured duration', () => {
    const result = makeResult()
    result.trial.timing.durationMs = null
    expect(isCompleteTrialResult(result)).toBe(false)
  })

  it('rejects a negative duration', () => {
    const result = makeResult()
    result.trial.timing.durationMs = -1
    expect(isCompleteTrialResult(result)).toBe(false)
  })
})

describe('saveTrialResult / getTrialResult', () => {
  it('stores a completed result and reads it back intact', async () => {
    const result = makeResult()
    await saveTrialResult(result)

    const stored = await getTrialResult('trial-1')
    expect(stored).not.toBeNull()
    expect(stored?.id).toBe('trial-1')
    expect(stored?.createdAt).toBe('2026-08-17T10:00:30.000Z')
    expect(stored?.result.task.id).toBe('house')
  })

  it('preserves the canonical session, strokes and points included', async () => {
    const result = makeResult({}, 3)
    const expectedPointCount = result.session.strokes[0]?.points.length ?? 0
    await saveTrialResult(result)

    const stored = await getTrialResult('trial-1')
    const session = stored?.result.session

    expect(session?.schemaVersion).toBe(2)
    expect(session?.strokes).toHaveLength(3)
    expect(session?.strokes[0]?.points).toHaveLength(expectedPointCount)
    expect(session?.id).toBe(result.session.id)
  })

  it('a restored result still validates, with features recomputed from the session', async () => {
    const result = makeResult()
    await saveTrialResult(result)
    const stored = await getTrialResult('trial-1')

    const parsed = validateTrialResult(stored?.result)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // Recomputed rather than trusted: the round trip must not change them.
    expect(parsed.value.features.totalStrokeCount).toBe(result.features.totalStrokeCount)
    expect(parsed.value.features.totalPointCount).toBe(result.features.totalPointCount)
  })

  it('REFUSES an incomplete result instead of storing it', async () => {
    const incomplete = makeResult({ status: 'drawing' })

    await expect(saveTrialResult(incomplete)).rejects.toThrow(/ناقص/)
    expect(await getTrialResult('trial-1')).toBeNull()
  })

  it('rejects rather than throwing synchronously on a non-serializable value', async () => {
    const result = makeResult()
    // A function cannot be structured-cloned; IndexedDB would throw
    // DataCloneError. The caller awaits, so it must arrive as a rejection.
    ;(result.session as unknown as Record<string, unknown>)['oops'] = () => undefined

    await expect(saveTrialResult(result)).rejects.toBeInstanceOf(Error)
  })

  it('lets a retry succeed after a failed write', async () => {
    const broken = makeResult()
    ;(broken.session as unknown as Record<string, unknown>)['oops'] = () => undefined

    const options = { epoch: 'epoch-a', revision: 1 }
    await expect(saveTrialResult(broken, options)).rejects.toBeInstanceOf(Error)

    // The failed write must not have claimed the revision slot: a retry at a
    // higher revision has to get through, or the result is lost for good.
    await saveTrialResult(makeResult(), { epoch: 'epoch-a', revision: 2 })
    expect(await getTrialResult('trial-1')).not.toBeNull()
  })

  it('returns null for an id that was never stored', async () => {
    expect(await getTrialResult('nope')).toBeNull()
  })
})

describe('stale write protection', () => {
  it('discards a revision that is not newer than one already accepted', async () => {
    const epoch = 'epoch-a'

    await saveTrialResult(makeResult({}, 3), { epoch, revision: 5 })
    // An older snapshot from the same editor lifetime arrives late.
    await saveTrialResult(makeResult({}, 1), { epoch, revision: 4 })
    await flushPendingTrialWrites('trial-1')

    const stored = await getTrialResult('trial-1')
    // The newer three-stroke snapshot survives.
    expect(stored?.result.session.strokes).toHaveLength(3)
  })

  it('a slow older save never overwrites a newer one, whatever the completion order', async () => {
    /*
      DETERMINISTIC out-of-order simulation: both saves are issued before either
      is awaited, so they are in flight together and the queue decides the
      outcome. Without the guard the last write to land would win, and which
      one that is would be a coin toss.
    */
    const epoch = 'epoch-b'

    const older = saveTrialResult(makeResult({}, 1), { epoch, revision: 1 })
    const newer = saveTrialResult(makeResult({}, 4), { epoch, revision: 2 })
    const stale = saveTrialResult(makeResult({}, 2), { epoch, revision: 1 })

    await Promise.all([older, newer, stale])
    await flushPendingTrialWrites('trial-1')

    const stored = await getTrialResult('trial-1')
    expect(stored?.result.session.strokes).toHaveLength(4)
  })

  it('accepts a low revision from a DIFFERENT epoch, because counters restart on remount', async () => {
    await saveTrialResult(makeResult({}, 1), { epoch: 'epoch-a', revision: 9 })
    // A remount begins a fresh counter at 1. Comparing it against 9 would
    // discard every write until the user made nine more changes.
    await saveTrialResult(makeResult({}, 5), { epoch: 'epoch-b', revision: 1 })
    await flushPendingTrialWrites('trial-1')

    expect((await getTrialResult('trial-1'))?.result.session.strokes).toHaveLength(5)
  })

  it('an unguarded save always writes', async () => {
    await saveTrialResult(makeResult({}, 3), { epoch: 'epoch-a', revision: 7 })
    await saveTrialResult(makeResult({}, 1))
    await flushPendingTrialWrites('trial-1')

    expect((await getTrialResult('trial-1'))?.result.session.strokes).toHaveLength(1)
  })

  it('keeps separate trials completely independent', async () => {
    await saveTrialResult(makeResult({ id: 'trial-a' }, 2))
    await saveTrialResult(makeResult({ id: 'trial-b' }, 3))

    expect((await getTrialResult('trial-a'))?.result.session.strokes).toHaveLength(2)
    expect((await getTrialResult('trial-b'))?.result.session.strokes).toHaveLength(3)
  })
})

describe('listing and deletion', () => {
  it('lists stored results newest completion first', async () => {
    await saveTrialResult(
      makeResult({
        id: 'older',
        timing: {
          startedAt: '2026-08-15T09:00:00.000Z',
          completedAt: '2026-08-15T09:01:00.000Z',
          durationMs: 60_000,
          countdownSeconds: 3,
        },
      }),
    )
    await saveTrialResult(
      makeResult({
        id: 'newer',
        timing: {
          startedAt: '2026-08-16T09:00:00.000Z',
          completedAt: '2026-08-16T09:01:00.000Z',
          durationMs: 60_000,
          countdownSeconds: 3,
        },
      }),
    )

    const all = await listTrialResults()
    expect(all.map((row) => row.id)).toEqual(['newer', 'older'])
    expect((await getLatestTrialResult())?.id).toBe('newer')
  })

  it('returns an empty list and a null latest when nothing is stored', async () => {
    expect(await listTrialResults()).toEqual([])
    expect(await getLatestTrialResult()).toBeNull()
  })

  it('deletes exactly the row it is asked to delete', async () => {
    await saveTrialResult(makeResult({ id: 'keep' }))
    await saveTrialResult(makeResult({ id: 'drop' }))

    await deleteTrialResult('drop')

    expect(await getTrialResult('drop')).toBeNull()
    expect(await getTrialResult('keep')).not.toBeNull()
  })
})

describe('expiry policy', () => {
  /** Saves a row whose updatedAt is set explicitly. */
  async function saveAged(id: string, updatedAt: string): Promise<void> {
    await saveTrialResult(makeResult({ id }), {}, () => updatedAt)
  }

  const NOW = Date.parse('2026-08-17T12:00:00.000Z')
  const DAY_MS = 24 * 60 * 60 * 1000

  it('removes only rows older than the stated age', async () => {
    await saveAged('ancient', '2026-08-01T12:00:00.000Z')
    await saveAged('recent', '2026-08-17T11:00:00.000Z')

    const removed = await clearExpiredTrialResults({ maxAgeMs: 7 * DAY_MS, now: () => NOW })

    expect(removed).toBe(1)
    expect(await getTrialResult('ancient')).toBeNull()
    // A completed result inside the window is never removed automatically.
    expect(await getTrialResult('recent')).not.toBeNull()
  })

  it('removes nothing when every row is inside the window', async () => {
    await saveAged('recent', '2026-08-17T11:00:00.000Z')

    expect(await clearExpiredTrialResults({ maxAgeMs: 7 * DAY_MS, now: () => NOW })).toBe(0)
    expect(await getTrialResult('recent')).not.toBeNull()
  })

  it('KEEPS a row whose updatedAt cannot be parsed', async () => {
    // Deleting research data because a timestamp failed to parse would destroy
    // a recording on the strength of a bug.
    await saveAged('unreadable', 'not-a-date')

    await clearExpiredTrialResults({ maxAgeMs: 1, now: () => NOW })
    expect(await getTrialResult('unreadable')).not.toBeNull()
  })

  it('refuses a nonsensical policy rather than guessing one', async () => {
    await expect(clearExpiredTrialResults({ maxAgeMs: 0 })).rejects.toThrow(/انقضا/)
    await expect(clearExpiredTrialResults({ maxAgeMs: -5 })).rejects.toThrow(/انقضا/)
    await expect(
      clearExpiredTrialResults({ maxAgeMs: Number.NaN }),
    ).rejects.toThrow(/انقضا/)
  })

  it('stamps updatedAt on every write', async () => {
    await saveAged('row', '2026-08-17T11:30:00.000Z')
    expect((await getTrialResult('row'))?.updatedAt).toBe('2026-08-17T11:30:00.000Z')
  })
})
