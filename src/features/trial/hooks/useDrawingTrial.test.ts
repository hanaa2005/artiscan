/**
 * The trial state machine.
 *
 * Every legal transition is exercised, and so is every illegal one - a state
 * machine is only worth having if it actually refuses the moves it forbids.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDrawingTrial } from './useDrawingTrial'
import type { DrawingTask } from '../types/trial.types'

const TASK: DrawingTask = {
  id: 'house',
  labelFa: 'خانه',
  labelEn: 'House',
  quickDrawCategory: 'house',
  instructionFa: 'یک خانه بکشید.',
  timeLimitSeconds: 60,
  enabled: true,
}

const OTHER_TASK: DrawingTask = { ...TASK, id: 'tree', labelFa: 'درخت', labelEn: 'Tree' }

/**
 * Stands in for a recorder that holds one stroke.
 *
 * The hook now REQUIRES a stroke count, because the empty-trial rule is
 * enforced in the state machine rather than trusted to the UI. Most tests here
 * are about transitions, not about that rule, so they hand it a canvas that is
 * not empty; the empty case has its own describe block below.
 */
const hasStrokes = (): number => 1
/** A recorder holding nothing at all. */
const noStrokes = (): number => 0

/** Advances past a countdown of `seconds`. */
async function runCountdown(seconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1000)
  })
}

describe('useDrawingTrial - legal transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts idle with nothing selected', () => {
    const { result } = renderHook(() => useDrawingTrial({ getRecordedStrokeCount: hasStrokes }))

    expect(result.current.status).toBe('idle')
    expect(result.current.task).toBeNull()
    expect(result.current.trial).toBeNull()
    expect(result.current.canExport).toBe(false)
  })

  it('idle -> instructions on selectTask', () => {
    const { result } = renderHook(() => useDrawingTrial({ getRecordedStrokeCount: hasStrokes }))

    act(() => {
      expect(result.current.selectTask(TASK)).toBe(true)
    })
    expect(result.current.status).toBe('instructions')
    expect(result.current.task?.id).toBe('house')
  })

  it('instructions -> instructions when a different task is chosen', () => {
    const { result } = renderHook(() => useDrawingTrial({ getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      expect(result.current.selectTask(OTHER_TASK)).toBe(true)
    })
    expect(result.current.task?.id).toBe('tree')
  })

  it('instructions -> countdown on beginCountdown', () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 3, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      expect(result.current.beginCountdown()).toBe(true)
    })

    expect(result.current.status).toBe('countdown')
    expect(result.current.countdownRemaining).toBe(3)
  })

  it('countdown ticks down and then enters drawing', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 3, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })

    await runCountdown(1)
    expect(result.current.countdownRemaining).toBe(2)

    await runCountdown(2)
    expect(result.current.status).toBe('drawing')
    expect(result.current.isDrawingPhase).toBe(true)
  })

  it('goes straight to drawing when the countdown is zero seconds', () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 0, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })

    expect(result.current.status).toBe('drawing')
  })

  it('drawing -> completed on complete', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 1, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    await runCountdown(1)

    act(() => {
      expect(result.current.complete()).toBe(true)
    })

    expect(result.current.status).toBe('completed')
    expect(result.current.canExport).toBe(true)
    expect(result.current.trial?.timing.completedAt).not.toBeNull()
    expect(result.current.trial?.timing.durationMs).not.toBeNull()
  })

  it('drawing -> cancelled on cancel', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 1, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    await runCountdown(1)

    act(() => {
      expect(result.current.cancel()).toBe(true)
    })

    expect(result.current.status).toBe('cancelled')
    expect(result.current.canExport).toBe(false)
  })

  it('countdown -> cancelled on cancel', () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 3, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    act(() => {
      expect(result.current.cancel()).toBe(true)
    })

    expect(result.current.status).toBe('cancelled')
  })

  it('completed -> idle on reset', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 1, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    await runCountdown(1)
    act(() => {
      result.current.complete()
    })
    act(() => {
      result.current.reset()
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.task).toBeNull()
    expect(result.current.trial).toBeNull()
  })

  it('cancelled -> idle on reset', () => {
    const { result } = renderHook(() => useDrawingTrial({ getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.cancel()
    })
    act(() => {
      result.current.reset()
    })

    expect(result.current.status).toBe('idle')
  })
})

describe('useDrawingTrial - refused transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refuses beginCountdown with no task selected', () => {
    const { result } = renderHook(() => useDrawingTrial({ getRecordedStrokeCount: hasStrokes }))

    act(() => {
      expect(result.current.beginCountdown()).toBe(false)
    })
    expect(result.current.status).toBe('idle')
  })

  it('refuses a task change once the countdown has started', () => {
    // The participant has already been told what to draw; swapping the task
    // now would mislabel the recording that follows.
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 3, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    act(() => {
      expect(result.current.selectTask(OTHER_TASK)).toBe(false)
    })

    expect(result.current.task?.id).toBe('house')
    expect(result.current.canChangeTask).toBe(false)
  })

  it('refuses a task change while drawing', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 1, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    await runCountdown(1)

    act(() => {
      expect(result.current.selectTask(OTHER_TASK)).toBe(false)
    })
    expect(result.current.task?.id).toBe('house')
  })

  it('refuses complete before drawing has started', () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 3, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      expect(result.current.complete()).toBe(false)
    })
    act(() => {
      result.current.beginCountdown()
    })
    act(() => {
      expect(result.current.complete()).toBe(false)
    })

    expect(result.current.status).toBe('countdown')
  })

  it('refuses a second complete', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 1, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    await runCountdown(1)

    act(() => {
      expect(result.current.complete()).toBe(true)
    })
    act(() => {
      // Double completion would overwrite the recorded end time with a later one.
      expect(result.current.complete()).toBe(false)
    })

    expect(result.current.status).toBe('completed')
  })

  it('refuses cancel after completion', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 1, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    await runCountdown(1)
    act(() => {
      result.current.complete()
    })
    act(() => {
      expect(result.current.cancel()).toBe(false)
    })

    expect(result.current.status).toBe('completed')
  })

  it('refuses cancel from idle', () => {
    const { result } = renderHook(() => useDrawingTrial({ getRecordedStrokeCount: hasStrokes }))
    act(() => {
      expect(result.current.cancel()).toBe(false)
    })
    expect(result.current.status).toBe('idle')
  })

  it('never allows export of an incomplete trial', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 1, getRecordedStrokeCount: hasStrokes }))
    expect(result.current.canExport).toBe(false)

    act(() => {
      result.current.selectTask(TASK)
    })
    expect(result.current.canExport).toBe(false)

    act(() => {
      result.current.beginCountdown()
    })
    expect(result.current.canExport).toBe(false)

    await runCountdown(1)
    expect(result.current.canExport).toBe(false)

    act(() => {
      result.current.cancel()
    })
    expect(result.current.canExport).toBe(false)
  })
})

describe('useDrawingTrial - timers and side effects', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears the countdown on unmount', async () => {
    const { unmount } = renderHook(() => useDrawingTrial({ countdownSeconds: 5, getRecordedStrokeCount: hasStrokes }))
    unmount()

    // A leaked interval would keep firing and try to set state on an unmounted
    // component; with proper cleanup nothing is left to run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer running after unmount mid-countdown', async () => {
    const { result, unmount } = renderHook(() => useDrawingTrial({ countdownSeconds: 5, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer running after unmount mid-drawing', async () => {
    const { result, unmount } = renderHook(() => useDrawingTrial({ countdownSeconds: 1, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    await runCountdown(1)
    expect(result.current.status).toBe('drawing')

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops the countdown when cancelled', () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 5, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    act(() => {
      result.current.cancel()
    })

    expect(vi.getTimerCount()).toBe(0)
    expect(result.current.countdownRemaining).toBe(0)
  })

  it('stops the elapsed timer when the trial completes', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 1, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    await runCountdown(1)
    act(() => {
      result.current.complete()
    })

    expect(vi.getTimerCount()).toBe(0)
  })

  it('calls onDrawingStart exactly once, when drawing begins', async () => {
    // The recorder is wiped here rather than at task selection, so anything
    // scribbled while reading the instructions stays out of the data.
    const onDrawingStart = vi.fn()
    const { result } = renderHook(() =>
      useDrawingTrial({ countdownSeconds: 2, onDrawingStart, getRecordedStrokeCount: hasStrokes }),
    )

    act(() => {
      result.current.selectTask(TASK)
    })
    expect(onDrawingStart).not.toHaveBeenCalled()

    act(() => {
      result.current.beginCountdown()
    })
    expect(onDrawingStart).not.toHaveBeenCalled()

    await runCountdown(2)
    expect(onDrawingStart).toHaveBeenCalledTimes(1)
  })

  it('calls onDrawingStart ONCE even after the countdown keeps ticking', async () => {
    // Regression: the tick used to start the drawing phase from inside a state
    // updater. React StrictMode double-invokes updaters, and the interval was
    // left alive - so it kept firing and resetting the recorder once a second,
    // silently wiping the participant's drawing as they made it.
    const onDrawingStart = vi.fn()
    const { result } = renderHook(() =>
      useDrawingTrial({ countdownSeconds: 2, onDrawingStart, getRecordedStrokeCount: hasStrokes }),
    )

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })

    await runCountdown(2)
    expect(result.current.status).toBe('drawing')
    expect(onDrawingStart).toHaveBeenCalledTimes(1)

    // Five more seconds of drawing: nothing may reset the recorder again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(onDrawingStart).toHaveBeenCalledTimes(1)
  })

  it('clears the countdown interval the moment drawing starts', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 2, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    await runCountdown(2)

    // Only the elapsed-time interval may remain.
    expect(result.current.status).toBe('drawing')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('never lets the countdown display go negative', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 2, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })

    expect(result.current.countdownRemaining).toBe(0)
  })

  it('measures a duration that does not depend on the wall clock', async () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 0, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    act(() => {
      result.current.complete()
    })

    const durationMs = result.current.trial?.timing.durationMs ?? -1
    expect(durationMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(durationMs)).toBe(true)
  })

  it('copies the task time limit into the trial at start', () => {
    // Copied, not referenced: editing the catalog later must not rewrite what
    // this participant was actually asked to do.
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 0, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })

    expect(result.current.trial?.timeLimitSeconds).toBe(60)
  })

  it('records the countdown length actually used', () => {
    const { result } = renderHook(() => useDrawingTrial({ countdownSeconds: 4, getRecordedStrokeCount: hasStrokes }))

    act(() => {
      result.current.selectTask(TASK)
    })
    act(() => {
      result.current.beginCountdown()
    })

    expect(result.current.trial?.timing.countdownSeconds).toBe(4)
  })
})

/**
 * THE EMPTY-TRIAL RULE.
 *
 * A trial that recorded nothing is not a completed observation. It used to be
 * allowed through a confirmation dialog, which produced an ordinary-looking
 * result with totalStrokeCount 0 - indistinguishable from real data once
 * exported. The rule now lives in the state machine, so a direct programmatic
 * call cannot walk past it either.
 */
describe('useDrawingTrial - the empty-trial rule', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Drives a trial to the drawing phase with the given recorder stub. */
  function drawingTrial(getRecordedStrokeCount: () => number) {
    const rendered = renderHook(() =>
      useDrawingTrial({ countdownSeconds: 0, getRecordedStrokeCount }),
    )
    act(() => {
      rendered.result.current.selectTask(TASK)
    })
    act(() => {
      rendered.result.current.beginCountdown()
    })
    return rendered
  }

  it('refuses to complete an empty trial and stays in the drawing phase', () => {
    const { result } = drawingTrial(noStrokes)
    expect(result.current.status).toBe('drawing')

    let completed = true
    act(() => {
      completed = result.current.complete()
    })

    expect(completed).toBe(false)
    expect(result.current.status).toBe('drawing')
  })

  it('writes no completion timestamp and no duration when it refuses', () => {
    const { result } = drawingTrial(noStrokes)
    act(() => {
      result.current.complete()
    })

    expect(result.current.trial?.timing.completedAt).toBeNull()
    expect(result.current.trial?.timing.durationMs).toBeNull()
    expect(result.current.trial?.status).toBe('drawing')
  })

  it('keeps export unavailable after a refused completion', () => {
    const { result } = drawingTrial(noStrokes)
    act(() => {
      result.current.complete()
    })

    expect(result.current.canExport).toBe(false)
  })

  it('refuses repeatedly - the rule is not a one-time confirmation', () => {
    const { result } = drawingTrial(noStrokes)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let completed = true
      act(() => {
        completed = result.current.complete()
      })
      expect(completed).toBe(false)
    }
    expect(result.current.status).toBe('drawing')
  })

  it('completes as soon as the recorder holds a stroke', () => {
    let strokeCount = 0
    const { result } = drawingTrial(() => strokeCount)

    act(() => {
      expect(result.current.complete()).toBe(false)
    })

    strokeCount = 1
    act(() => {
      expect(result.current.complete()).toBe(true)
    })

    expect(result.current.status).toBe('completed')
    expect(result.current.canExport).toBe(true)
    expect(result.current.trial?.timing.completedAt).not.toBeNull()
  })

  it('still allows an empty trial to be CANCELLED - abandoning is always valid', () => {
    const { result } = drawingTrial(noStrokes)

    let cancelled = false
    act(() => {
      cancelled = result.current.cancel()
    })

    expect(cancelled).toBe(true)
    expect(result.current.status).toBe('cancelled')
    expect(result.current.canExport).toBe(false)
  })

  it('refuses a nonsensical stroke count rather than trusting it', () => {
    const { result } = drawingTrial(() => Number.NaN)

    act(() => {
      expect(result.current.complete()).toBe(false)
    })
    expect(result.current.status).toBe('drawing')
  })
})
