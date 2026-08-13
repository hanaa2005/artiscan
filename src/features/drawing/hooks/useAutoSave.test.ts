/**
 * Autosave across an editor remount.
 *
 * `useRevision` counts changes within one component lifetime and restarts at
 * zero on remount. The repository's stale-write guard compares revisions - so
 * unless the two agree about what a revision means, restoring a session in the
 * same page can leave a stale high-water mark that swallows every subsequent
 * write. That failure is invisible: autosave reports success while nothing is
 * actually stored.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoSave, useRevision } from './useAutoSave'
import {
  clearSessions,
  flushPendingWrites,
  getSession,
  saveSession,
} from '../services/drawingSessionRepository'
import { makeSession, makeStrokeSeries } from '../testing/sessionFixture'
import type { DrawingSession } from '../types/drawing.types'

const SESSION_ID = 'autosave-session'

function snapshotWithStrokes(count: number): DrawingSession {
  const ids = Array.from({ length: count }, (_, i) => `stroke-${i}`)
  return makeSession({ id: SESSION_ID, strokes: makeStrokeSeries(count, ids) })
}

/** Drives one autosave hook lifetime, letting the debounce fire. */
async function runAutoSaveCycle(snapshot: DrawingSession, revision: number): Promise<void> {
  const { unmount } = renderHook(() => useAutoSave(() => snapshot, revision))
  await act(async () => {
    // Past the 500 ms debounce.
    await vi.advanceTimersByTimeAsync(600)
  })
  await flushPendingWrites(SESSION_ID)
  unmount()
}

describe('useAutoSave - revision lifetime', () => {
  beforeEach(async () => {
    // Only setTimeout is faked, so the debounce can be advanced on demand.
    // fake-indexeddb drives its transactions on setImmediate/microtasks; faking
    // those too would freeze every database call and hang the test.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await clearSessions()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores a change made after a remount, even though the counter reset', async () => {
    // Lifetime 1 gets as far as revision 10.
    await runAutoSaveCycle(snapshotWithStrokes(8), 10)
    expect((await getSession(SESSION_ID))?.strokes).toHaveLength(8)

    // The component unmounts and remounts - a brand new epoch whose counter
    // starts again at 1. This snapshot must be stored immediately.
    await runAutoSaveCycle(snapshotWithStrokes(9), 1)

    const stored = await getSession(SESSION_ID)
    expect(stored?.strokes).toHaveLength(9)
  })

  it('stores several consecutive changes after a remount', async () => {
    await runAutoSaveCycle(snapshotWithStrokes(20), 42)

    // Revisions 1, 2, 3 of a fresh lifetime - all lower than 42.
    for (let revision = 1; revision <= 3; revision += 1) {
      await runAutoSaveCycle(snapshotWithStrokes(revision), revision)
      expect((await getSession(SESSION_ID))?.strokes).toHaveLength(revision)
    }
  })

  it('still discards a stale revision from within the SAME lifetime', async () => {
    // One hook instance, two revisions in flight: the guard must still work.
    const newer = snapshotWithStrokes(5)
    const older = snapshotWithStrokes(2)

    const { rerender } = renderHook(
      ({ snapshot, revision }: { snapshot: DrawingSession; revision: number }) =>
        useAutoSave(() => snapshot, revision),
      { initialProps: { snapshot: newer, revision: 2 } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    await flushPendingWrites(SESSION_ID)

    rerender({ snapshot: older, revision: 1 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    await flushPendingWrites(SESSION_ID)

    expect((await getSession(SESSION_ID))?.strokes).toHaveLength(5)
  })

  it('reports "saved" once the write lands', async () => {
    const snapshot = snapshotWithStrokes(1)
    const { result } = renderHook(() => useAutoSave(() => snapshot, 1))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
      // Inside act(), so the state update the resolved write triggers is
      // flushed before the assertion reads it.
      await flushPendingWrites(SESSION_ID)
    })

    expect(result.current.state).toBe('saved')
  })

  it('writes nothing at revision zero, which is the untouched initial session', async () => {
    const snapshot = snapshotWithStrokes(1)
    renderHook(() => useAutoSave(() => snapshot, 0))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })

    expect(await getSession(SESSION_ID)).toBeNull()
  })

  it('does not resurrect a revision the repository already accepted directly', async () => {
    // A manual save (no epoch) followed by autosave from a fresh epoch: the
    // autosave epoch is new, so it wins - which is correct, it is later.
    await saveSession(snapshotWithStrokes(3))
    await runAutoSaveCycle(snapshotWithStrokes(4), 1)

    expect((await getSession(SESSION_ID))?.strokes).toHaveLength(4)
  })
})

describe('useRevision', () => {
  it('starts at zero and ignores the initial mount', () => {
    const strokes: unknown[] = []
    const actions: unknown[] = []
    const { result } = renderHook(() => useRevision(strokes, actions))
    expect(result.current).toBe(0)
  })

  it('increments when the recorded arrays are replaced', () => {
    const { result, rerender } = renderHook(
      ({ strokes, actions }: { strokes: unknown; actions: unknown }) =>
        useRevision(strokes, actions),
      { initialProps: { strokes: [] as unknown, actions: [] as unknown } },
    )
    expect(result.current).toBe(0)

    rerender({ strokes: [1], actions: [] })
    expect(result.current).toBe(1)

    rerender({ strokes: [1], actions: [2] })
    expect(result.current).toBe(2)
  })

  it('does not increment when the same references are re-rendered', () => {
    // Pointer movement never replaces these arrays, so it must never trigger
    // a write - that is the whole reason the trigger is reference-based.
    const strokes: unknown[] = []
    const actions: unknown[] = []
    const { result, rerender } = renderHook(() => useRevision(strokes, actions))

    rerender()
    rerender()
    expect(result.current).toBe(0)
  })
})
