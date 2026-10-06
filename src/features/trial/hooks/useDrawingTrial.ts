/**
 * The trial state machine.
 *
 * This controller owns WHEN drawing happens; useDrawingSession still owns WHAT
 * was drawn. The two are deliberately separate: the recorder knows nothing
 * about tasks or countdowns, and this hook never touches stroke data. It does
 * READ one number from the recorder - the stroke count - because the
 * empty-trial rule below has to be enforced here rather than trusted to the UI.
 *
 * LEGAL TRANSITIONS (anything else is refused and returns false)
 *
 *   idle         --selectTask-->      instructions
 *   instructions --selectTask-->      instructions   (still free to change task)
 *   instructions --beginCountdown-->  countdown
 *   instructions --cancel-->          cancelled
 *   countdown    --(timer reaches 0)->drawing
 *   countdown    --cancel-->          cancelled
 *   drawing      --complete-->        completed      ONLY with >= 1 stroke
 *   drawing      --complete-->        drawing        (refused when empty)
 *   drawing      --cancel-->          cancelled
 *   completed    --reset-->           idle
 *   cancelled    --reset-->           idle
 *
 * The task is LOCKED from `countdown` onwards: once the participant has seen
 * the countdown, changing what they were asked to draw would silently
 * misattribute the recording that follows.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createSessionClock, nowIsoTimestamp } from '../../drawing/utils/timing'
import type { DrawingTask, DrawingTrial, TrialStatus } from '../types/trial.types'

export const DEFAULT_COUNTDOWN_SECONDS = 3

/** One tick of the countdown, in milliseconds. */
const COUNTDOWN_TICK_MS = 1000

export interface UseDrawingTrialOptions {
  countdownSeconds?: number
  /** Called once, at the exact moment drawing begins, to reset the recorder. */
  onDrawingStart?: () => void
  /**
   * How many strokes the recorder currently holds.
   *
   * REQUIRED, because the empty-trial rule is enforced HERE and not only in the
   * UI. A controller that could not see the recorder would have to trust its
   * caller to refuse an empty completion, and a direct programmatic call would
   * then walk straight past the rule.
   */
  getRecordedStrokeCount: () => number
}

export interface UseDrawingTrialResult {
  status: TrialStatus
  task: DrawingTask | null
  trial: DrawingTrial | null
  /** Seconds still to go, while status is 'countdown'. */
  countdownRemaining: number
  /** Live elapsed drawing time in ms. Frozen once the trial completes. */
  elapsedMs: number

  /** True while the recorder should accept input. */
  isDrawingPhase: boolean
  /** True when a result can be built. */
  canExport: boolean
  /** True while the task may still be changed. */
  canChangeTask: boolean

  selectTask: (task: DrawingTask) => boolean
  beginCountdown: () => boolean
  complete: () => boolean
  cancel: () => boolean
  reset: () => void
}

function createTrial(countdownSeconds: number, task: DrawingTask): DrawingTrial {
  return {
    id: crypto.randomUUID(),
    status: 'countdown',
    timeLimitSeconds: task.timeLimitSeconds,
    timing: {
      // Filled in for real when drawing actually starts.
      startedAt: nowIsoTimestamp(),
      completedAt: null,
      durationMs: null,
      countdownSeconds,
    },
  }
}

export function useDrawingTrial(options: UseDrawingTrialOptions): UseDrawingTrialResult {
  const countdownSeconds = options.countdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS

  const [status, setStatus] = useState<TrialStatus>('idle')
  const [task, setTask] = useState<DrawingTask | null>(null)
  const [trial, setTrial] = useState<DrawingTrial | null>(null)
  const [countdownRemaining, setCountdownRemaining] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)

  /**
   * Every timer this hook owns. Held in a ref and cleared through one helper so
   * there is a single place to be right about cleanup - a stray interval keeps
   * firing after unmount and writes state into a component that no longer
   * exists.
   */
  const countdownTimerRef = useRef<number | null>(null)
  const elapsedTimerRef = useRef<number | null>(null)

  /** Measured drawing time. performance.now(), never the wall clock. */
  const clockRef = useRef<ReturnType<typeof createSessionClock> | null>(null)

  /** Mirrors countdownRemaining so the tick can read it without a state updater. */
  const remainingRef = useRef(0)

  /** Latest status, readable from timer callbacks without re-subscribing. */
  const statusRef = useRef<TrialStatus>(status)
  statusRef.current = status

  const onDrawingStartRef = useRef(options.onDrawingStart)
  onDrawingStartRef.current = options.onDrawingStart

  const getRecordedStrokeCountRef = useRef(options.getRecordedStrokeCount)
  getRecordedStrokeCountRef.current = options.getRecordedStrokeCount

  const clearTimers = useCallback((): void => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current)
      elapsedTimerRef.current = null
    }
  }, [])

  // The only unconditional cleanup: whatever state the trial is in, no timer
  // may outlive the component.
  useEffect(() => clearTimers, [clearTimers])

  /** Moves into the drawing phase and starts measuring. */
  const startDrawing = useCallback((): void => {
    // Guard against a duplicate entry into the drawing phase: it would reset the
    // recorder a second time and discard whatever had already been drawn.
    if (statusRef.current === 'drawing') return

    clearTimers()
    clockRef.current = createSessionClock()
    remainingRef.current = 0
    setCountdownRemaining(0)
    setElapsedMs(0)

    // The recorder is reset here rather than at task selection, so the session
    // contains only what was drawn after the countdown - nothing from a
    // participant idly scribbling while reading the instructions.
    // Marked before the state update lands, so a second synchronous call in the
    // same tick is caught by the guard above rather than resetting the recorder.
    statusRef.current = 'drawing'
    onDrawingStartRef.current?.()

    setStatus('drawing')
    setTrial((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            status: 'drawing',
            timing: { ...previous.timing, startedAt: nowIsoTimestamp() },
          },
    )

    elapsedTimerRef.current = window.setInterval(() => {
      setElapsedMs(clockRef.current?.elapsedMs() ?? 0)
    }, 100)
  }, [clearTimers])

  const selectTask = useCallback(
    (next: DrawingTask): boolean => {
      // Refused from 'countdown' onwards: the participant has already been told
      // what to draw, so swapping the task would mislabel the recording.
      const current = statusRef.current
      if (current !== 'idle' && current !== 'instructions') return false

      setTask(next)
      setStatus('instructions')
      return true
    },
    [],
  )

  const beginCountdown = useCallback((): boolean => {
    if (statusRef.current !== 'instructions') return false
    if (task === null) return false

    clearTimers()
    setTrial(createTrial(countdownSeconds, task))
    setStatus('countdown')

    // A zero-second countdown is a valid configuration; go straight to drawing
    // rather than scheduling a tick that would land after an awkward delay.
    if (countdownSeconds <= 0) {
      startDrawing()
      return true
    }

    remainingRef.current = countdownSeconds
    setCountdownRemaining(countdownSeconds)

    /**
     * The tick is deliberately NOT written as a side effect inside a state
     * updater.
     *
     * React StrictMode invokes updaters twice in development to surface impure
     * logic. Starting the drawing phase from inside one would therefore reset
     * the recorder twice - and, worse, leave the interval alive so it kept
     * firing and wiping the participant's drawing once a second. The countdown
     * is tracked in a ref and the state update stays pure.
     */
    countdownTimerRef.current = window.setInterval(() => {
      const next = remainingRef.current - 1
      remainingRef.current = next
      setCountdownRemaining(Math.max(0, next))
      if (next <= 0) {
        startDrawing()
      }
    }, COUNTDOWN_TICK_MS)

    return true
  }, [clearTimers, countdownSeconds, startDrawing, task])

  const complete = useCallback((): boolean => {
    // Only a trial that is actually drawing can finish. This is what makes
    // double completion impossible: the second call sees status 'completed'.
    if (statusRef.current !== 'drawing') return false

    /*
      THE EMPTY-TRIAL RULE.

      A trial with no strokes is not a completed observation - it records that
      someone opened the page, nothing more. Letting it complete produced a
      normal-looking result with totalStrokeCount 0 that was indistinguishable
      from real data once exported, so it is refused outright.

      Refusing means staying in 'drawing': the participant can simply keep
      drawing, or cancel the trial explicitly. Nothing is written - no
      completedAt, no duration, no result - because nothing happened.
    */
    const strokeCount = getRecordedStrokeCountRef.current()
    if (!Number.isFinite(strokeCount) || strokeCount <= 0) return false

    clearTimers()
    const durationMs = clockRef.current?.elapsedMs() ?? 0
    setElapsedMs(durationMs)
    setStatus('completed')
    setTrial((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            status: 'completed',
            timing: {
              ...previous.timing,
              completedAt: nowIsoTimestamp(),
              durationMs,
            },
          },
    )
    return true
  }, [clearTimers])

  const cancel = useCallback((): boolean => {
    const current = statusRef.current
    if (current !== 'instructions' && current !== 'countdown' && current !== 'drawing') {
      return false
    }

    clearTimers()
    remainingRef.current = 0
    setCountdownRemaining(0)
    setStatus('cancelled')
    setTrial((previous) =>
      previous === null ? previous : { ...previous, status: 'cancelled' },
    )
    return true
  }, [clearTimers])

  const reset = useCallback((): void => {
    clearTimers()
    clockRef.current = null
    remainingRef.current = 0
    statusRef.current = 'idle'
    setStatus('idle')
    setTask(null)
    setTrial(null)
    setCountdownRemaining(0)
    setElapsedMs(0)
  }, [clearTimers])

  return {
    status,
    task,
    trial,
    countdownRemaining,
    elapsedMs,
    isDrawingPhase: status === 'drawing',
    // Guards export of an incomplete trial: a result may only be built from a
    // finished one, so a cancelled or in-progress trial can never be exported.
    canExport: status === 'completed' && trial !== null && task !== null,
    canChangeTask: status === 'idle' || status === 'instructions',
    selectTask,
    beginCountdown,
    complete,
    cancel,
    reset,
  }
}
