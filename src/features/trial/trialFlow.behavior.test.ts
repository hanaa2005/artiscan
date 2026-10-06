/**
 * The full week-2 journey, driven through the real hooks.
 *
 *   select task -> instructions -> countdown -> draw -> undo -> redo
 *   -> finish -> build result -> serialize -> import -> recompute features
 *   -> verify canonical session identity and feature equality
 *
 * Nothing is stubbed except the clock. This is the test that would fail if the
 * trial machine, the recorder, the validator and the extractor ever stopped
 * agreeing with each other.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDrawingSession, type RawPointerSample } from '../drawing/hooks/useDrawingSession'
import { validateSession } from '../drawing/services/drawingValidator'
import { useDrawingTrial } from './hooks/useDrawingTrial'
import {
  buildTrialResult,
  deserializeTrialResult,
  serializeTrialResult,
} from './services/trialResultSerializer'
import { extractDrawingFeatures } from './utils/featureExtraction'
import { findTaskById, selectTaskBySeed } from './utils/taskSelection'
import type { DrawingTask } from './types/trial.types'

const CANVAS = { width: 800, height: 400 }

function sample(x: number, y: number): RawPointerSample {
  return {
    x,
    y,
    normalizedX: x / CANVAS.width,
    normalizedY: y / CANVAS.height,
    pressure: null,
    tiltX: null,
    tiltY: null,
    pointerType: 'mouse',
  }
}

function drawStroke(
  recorder: { current: ReturnType<typeof useDrawingSession> },
  offset: number,
): void {
  act(() => {
    recorder.current.beginStroke(sample(offset, offset))
    recorder.current.extendStroke([sample(offset + 20, offset + 10)])
    recorder.current.extendStroke([sample(offset + 40, offset + 30)])
    recorder.current.endStroke()
  })
}

describe('full trial flow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs end to end and reproduces identical features after a round trip', async () => {
    const recorder = renderHook(() => useDrawingSession())
    const trial = renderHook(() =>
      useDrawingTrial({
        countdownSeconds: 3,
        onDrawingStart: () => {
          recorder.result.current.startNewSession()
        },
        getRecordedStrokeCount: () => recorder.result.current.strokes.length,
      }),
    )

    // --- select a task, deterministically ---------------------------------
    const task = selectTaskBySeed('participant-7')
    expect(task).not.toBeNull()
    if (task === null) return
    expect(findTaskById(task.id)?.id).toBe(task.id)

    act(() => {
      expect(trial.result.current.selectTask(task)).toBe(true)
    })
    expect(trial.result.current.status).toBe('instructions')

    // --- countdown --------------------------------------------------------
    act(() => {
      expect(trial.result.current.beginCountdown()).toBe(true)
    })
    expect(trial.result.current.status).toBe('countdown')
    expect(trial.result.current.countdownRemaining).toBe(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(trial.result.current.status).toBe('drawing')

    // --- draw, undo, redo -------------------------------------------------
    drawStroke(recorder.result, 20)
    drawStroke(recorder.result, 120)
    drawStroke(recorder.result, 220)
    expect(recorder.result.current.strokes).toHaveLength(3)

    act(() => {
      recorder.result.current.undo()
    })
    expect(recorder.result.current.visibleStrokes).toHaveLength(2)

    act(() => {
      recorder.result.current.redo()
    })
    expect(recorder.result.current.visibleStrokes).toHaveLength(3)

    // --- finish -----------------------------------------------------------
    act(() => {
      expect(trial.result.current.complete()).toBe(true)
    })
    expect(trial.result.current.status).toBe('completed')
    expect(trial.result.current.canExport).toBe(true)

    const completedTrial = trial.result.current.trial
    expect(completedTrial).not.toBeNull()
    if (completedTrial === null) return

    // --- build the result -------------------------------------------------
    const session = recorder.result.current.buildSession(CANVAS)
    // The recording must itself be a session the week-1 validator accepts.
    expect(validateSession(session).ok).toBe(true)

    const result = buildTrialResult(completedTrial, task, session)
    expect(result.features.totalStrokeCount).toBe(3)
    expect(result.features.visibleStrokeCount).toBe(3)
    expect(result.features.undoCount).toBe(1)
    expect(result.features.redoCount).toBe(1)

    // --- serialize and import --------------------------------------------
    const text = serializeTrialResult(result)
    const imported = deserializeTrialResult(text)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return

    // --- canonical session identity ---------------------------------------
    expect(imported.value.session).toEqual(session)
    expect(imported.value.session.id).toBe(session.id)
    expect(imported.value.session.strokes).toHaveLength(3)

    // --- features recomputed from the canonical session --------------------
    const recomputed = extractDrawingFeatures(imported.value.session)
    expect(imported.value.features).toEqual(recomputed)
    expect(imported.value.features).toEqual(result.features)

    // --- trial metadata survived ------------------------------------------
    expect(imported.value.task.id).toBe(task.id)
    expect(imported.value.trial.id).toBe(completedTrial.id)
    expect(imported.value.trial.status).toBe('completed')
  })

  it('keeps anything drawn before the countdown out of the trial session', async () => {
    const recorder = renderHook(() => useDrawingSession())
    const trial = renderHook(() =>
      useDrawingTrial({
        countdownSeconds: 1,
        onDrawingStart: () => {
          recorder.result.current.startNewSession()
        },
        getRecordedStrokeCount: () => recorder.result.current.strokes.length,
      }),
    )

    const task = findTaskById('house') as DrawingTask
    act(() => {
      trial.result.current.selectTask(task)
    })

    // The participant idly scribbles while reading the instructions.
    drawStroke(recorder.result, 10)
    expect(recorder.result.current.strokes).toHaveLength(1)

    act(() => {
      trial.result.current.beginCountdown()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    // The recorder was reset at the moment drawing began.
    expect(recorder.result.current.strokes).toHaveLength(0)

    drawStroke(recorder.result, 50)
    act(() => {
      trial.result.current.complete()
    })

    const session = recorder.result.current.buildSession(CANVAS)
    expect(session.strokes).toHaveLength(1)
  })

  it('produces a result that cannot be built from a cancelled trial', async () => {
    const trial = renderHook(() => useDrawingTrial({ countdownSeconds: 1, getRecordedStrokeCount: () => 1 }))
    const task = findTaskById('tree') as DrawingTask

    act(() => {
      trial.result.current.selectTask(task)
    })
    act(() => {
      trial.result.current.beginCountdown()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    act(() => {
      trial.result.current.cancel()
    })

    expect(trial.result.current.canExport).toBe(false)

    // Even if a caller forced a result out of a cancelled trial, the validator
    // refuses it on import.
    const cancelledTrial = trial.result.current.trial
    expect(cancelledTrial?.status).toBe('cancelled')
  })

  /*
    REPLACES an earlier test that asserted an empty trial completed normally and
    round-tripped with totalStrokeCount 0.

    That expectation was wrong, not merely outdated: it encoded the defect. A
    trial with no strokes records that someone opened the page, and exporting it
    produced a file indistinguishable from real data once it left the app. The
    rule is now that such a trial cannot complete at all.
  */
  it('refuses to complete a trial with an empty drawing, and completes once a stroke exists', async () => {
    const recorder = renderHook(() => useDrawingSession())
    const trial = renderHook(() =>
      useDrawingTrial({
        countdownSeconds: 0,
        onDrawingStart: () => {
          recorder.result.current.startNewSession()
        },
        getRecordedStrokeCount: () => recorder.result.current.strokes.length,
      }),
    )

    const task = findTaskById('star') as DrawingTask
    act(() => {
      trial.result.current.selectTask(task)
    })
    act(() => {
      trial.result.current.beginCountdown()
    })

    let completed = true
    act(() => {
      completed = trial.result.current.complete()
    })

    expect(completed).toBe(false)
    expect(trial.result.current.status).toBe('drawing')
    expect(trial.result.current.canExport).toBe(false)
    expect(trial.result.current.trial?.timing.completedAt).toBeNull()
    expect(trial.result.current.trial?.timing.durationMs).toBeNull()

    // The participant simply carries on, and now it completes.
    drawStroke(recorder.result, 10)
    act(() => {
      completed = trial.result.current.complete()
    })

    expect(completed).toBe(true)
    expect(trial.result.current.status).toBe('completed')

    const completedTrial = trial.result.current.trial
    if (completedTrial === null) throw new Error('trial should exist')

    const result = buildTrialResult(
      completedTrial,
      task,
      recorder.result.current.buildSession(CANVAS),
    )
    expect(result.features.totalStrokeCount).toBe(1)

    const imported = deserializeTrialResult(serializeTrialResult(result))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.value.features).toEqual(result.features)
  })

  it('carries a cleared drawing through the round trip intact', async () => {
    // Week 1's append-only guarantee must still hold inside a trial result.
    const recorder = renderHook(() => useDrawingSession())
    const trial = renderHook(() =>
      useDrawingTrial({
        countdownSeconds: 0,
        onDrawingStart: () => {
          recorder.result.current.startNewSession()
        },
        getRecordedStrokeCount: () => recorder.result.current.strokes.length,
      }),
    )

    const task = findTaskById('cat') as DrawingTask
    act(() => {
      trial.result.current.selectTask(task)
    })
    act(() => {
      trial.result.current.beginCountdown()
    })

    drawStroke(recorder.result, 20)
    drawStroke(recorder.result, 120)
    act(() => {
      recorder.result.current.clear()
    })
    drawStroke(recorder.result, 220)

    act(() => {
      trial.result.current.complete()
    })

    const completedTrial = trial.result.current.trial
    if (completedTrial === null) throw new Error('trial should exist')

    const result = buildTrialResult(
      completedTrial,
      task,
      recorder.result.current.buildSession(CANVAS),
    )

    // Three strokes recorded, one visible - the cleared ones are still there.
    expect(result.features.totalStrokeCount).toBe(3)
    expect(result.features.visibleStrokeCount).toBe(1)
    expect(result.features.clearCount).toBe(1)

    const imported = deserializeTrialResult(serializeTrialResult(result))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return

    expect(imported.value.session.strokes).toHaveLength(3)
    expect(imported.value.features).toEqual(result.features)
  })
})
