/**
 * The deterministic replay engine.
 *
 * ONE SOURCE OF TRUTH
 *
 * Replay reads the canonical DrawingSession and nothing else. It builds no
 * second copy of the raw data, writes nothing back, and never takes the stored
 * final picture as a shortcut for the history that produced it. Given a session
 * and a time, it answers exactly one question: what was on the canvas then.
 *
 * ONE VISIBILITY SEMANTICS
 *
 * Undo, redo and clear are NOT reinterpreted here. The state at time `t` is
 * computed by handing the events that had happened by `t` to `replayHistory()` -
 * the same function the live editor and the importer use. A second
 * implementation of those rules would be a second thing to keep in agreement,
 * and the first time the two disagreed the exported data would stop meaning
 * what the app showed. Final-state equivalence with `replayHistory()` is
 * therefore structural, not merely tested.
 *
 * WHY FILTERING BY TIME IS SOUND
 *
 * `sequence` is the authoritative order; `timeMs` places events in time. Those
 * two keys cannot contradict each other, because validateMergedTimeMonotonicity
 * rejects any session in which time runs backwards as sequence runs forwards.
 * The set of entries with `timeMs <= t` is therefore exactly a PREFIX of the
 * sequence order - which is what makes a direct seek to any time give the same
 * answer as playing there from the start. Ties in `timeMs` are common (the
 * clock is rounded to 0.1 ms) and are resolved by `sequence`, inside
 * replayHistory.
 *
 * PURITY
 *
 * No React, no DOM, no canvas, no timer. Nothing is mutated: the returned
 * points arrays are either fresh slices or the session's own arrays exposed as
 * `readonly`. Identical input gives identical output, every time.
 */

import type {
  DrawingAction,
  DrawingSession,
  DrawingStroke,
  DrawingTool,
  ParseResult,
  PointSample,
} from '../../drawing/types/drawing.types'
import { replayHistory } from '../../drawing/utils/strokeVisibility'
import { validateSession } from '../../drawing/services/drawingValidator'

/** One stroke as it looked at the replayed instant. */
export interface ReplayStroke {
  id: string
  /** Position in the canonical append-only history. */
  order: number
  tool: DrawingTool
  color: string
  width: number
  /**
   * The points recorded up to the replayed instant - never any later ones.
   *
   * This is what makes a half-drawn stroke visible. Read-only: when the stroke
   * is complete this is the session's own array, shared rather than copied.
   */
  points: readonly PointSample[]
  /** False while the stroke is still being drawn at this instant. */
  isComplete: boolean
}

/**
 * Tool, colour and width in effect at the replayed instant.
 *
 * DERIVED, and honest about what it can know. The session records CHANGES
 * (`{ from, to }`), not an initial value, so the starting point is recovered
 * from the `from` of the first change of that kind. With no changes recorded at
 * all there is nothing to derive and the field is null - the strokes themselves
 * still carry their own tool, colour and width, which is what rendering uses.
 */
export interface ReplaySettings {
  tool: DrawingTool | null
  color: string | null
  width: number | null
}

/** The complete canvas state at one instant. */
export interface ReplayState {
  /** The instant this state describes, clamped into 0..durationMs. */
  timeMs: number
  durationMs: number
  /**
   * The strokes to paint, in canonical creation order.
   *
   * Creation order rather than the order a redo happened to restore them in,
   * because an eraser stroke must composite over exactly the ink that existed
   * when it was drawn.
   */
  strokes: readonly ReplayStroke[]
  /** The stroke still being drawn at this instant, if any. */
  activeStrokeId: string | null
  settings: ReplaySettings
  /** True once the whole timeline has been replayed. */
  isAtEnd: boolean
}

/** When a stroke entered the timeline: its first sample's timestamp. */
function strokeStartTimeMs(stroke: DrawingStroke): number {
  return stroke.points[0]?.timeMs ?? 0
}

/**
 * The number of leading elements whose key is <= `value`.
 *
 * Binary search, not a filter: points inside a stroke and entries across the
 * session are already sorted by time (the validator guarantees it), so a scan
 * would do avoidable work on every animation frame.
 */
function countAtOrBefore<T>(
  items: readonly T[],
  value: number,
  key: (item: T) => number,
): number {
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const item = items[middle]
    if (item !== undefined && key(item) <= value) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/**
 * The last instant anything happened.
 *
 * Read from both points and actions: a session whose final event is a clear or
 * an undo lasts until that event, not until its last stroke.
 */
export function getReplayDurationMs(session: DrawingSession): number {
  let duration = 0
  for (const stroke of session.strokes) {
    const last = stroke.points[stroke.points.length - 1]
    if (last !== undefined && last.timeMs > duration) duration = last.timeMs
    // endedAtMs can exceed the final sample: the pointer was released after it.
    if (stroke.endedAtMs > duration) duration = stroke.endedAtMs
  }
  for (const action of session.actions) {
    if (action.timeMs > duration) duration = action.timeMs
  }
  return duration
}

/** Reads a `{ from, to }` payload field, or null when absent or ill-typed. */
function readChange<T>(
  action: DrawingAction,
  field: 'from' | 'to',
  guard: (value: unknown) => value is T,
): T | null {
  const value = action.payload?.[field]
  return guard(value) ? value : null
}

function isTool(value: unknown): value is DrawingTool {
  return value === 'pen' || value === 'eraser'
}
function isColor(value: unknown): value is string {
  return typeof value === 'string'
}
function isWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Derives the settings in effect after `appliedActions`.
 *
 * The value before any change is the first change's `from`; each applied change
 * then moves it to that change's `to`.
 */
function deriveSettings(
  allActions: readonly DrawingAction[],
  appliedCount: number,
): ReplaySettings {
  function resolve<T>(
    type: DrawingAction['type'],
    guard: (value: unknown) => value is T,
  ): T | null {
    let value: T | null = null
    let seen = false

    for (let i = 0; i < allActions.length; i += 1) {
      const action = allActions[i]
      if (action === undefined || action.type !== type) continue

      if (!seen) {
        // The state before the very first change of this kind.
        value = readChange(action, 'from', guard)
        seen = true
      }
      if (i >= appliedCount) break
      value = readChange(action, 'to', guard) ?? value
    }
    return value
  }

  return {
    tool: resolve('tool_change', isTool),
    color: resolve('color_change', isColor),
    width: resolve('width_change', isWidth),
  }
}

/**
 * The canvas state at `timeMs`.
 *
 * Pure and total: a negative time yields the empty opening state, a time past
 * the end yields the final state, and repeated calls with the same arguments
 * return equal results. The session is never modified.
 *
 * Seeking directly to an instant is exactly as correct as playing to it,
 * because nothing here depends on how the caller arrived at that time.
 */
export function getReplayStateAt(session: DrawingSession, timeMs: number): ReplayState {
  const durationMs = getReplayDurationMs(session)

  // A negative or NaN time is the start; anything past the end is the end.
  const clamped = Number.isFinite(timeMs) ? Math.min(Math.max(timeMs, 0), durationMs) : 0

  /*
    Which strokes had STARTED, and which actions had happened.

    Both arrays are already in timeline order - strokes by their first sample,
    actions by construction - so the cut is a binary search rather than a scan.
  */
  const startedCount = countAtOrBefore(session.strokes, clamped, strokeStartTimeMs)
  const appliedActionCount = countAtOrBefore(
    session.actions,
    clamped,
    (action) => action.timeMs,
  )

  const startedStrokes = session.strokes.slice(0, startedCount)
  const appliedActions = session.actions.slice(0, appliedActionCount)

  // THE reuse point: undo / redo / clear are resolved by the same function the
  // live editor uses, so replay can never drift from capture.
  const { visibleIds } = replayHistory(startedStrokes, appliedActions)

  const strokes: ReplayStroke[] = []
  let activeStrokeId: string | null = null

  for (const stroke of startedStrokes) {
    if (!visibleIds.has(stroke.id)) continue

    const revealed = countAtOrBefore(stroke.points, clamped, (point) => point.timeMs)
    // A started stroke always has at least its first point revealed; the guard
    // costs nothing and keeps a hand-edited file from producing an empty stroke.
    if (revealed === 0) continue

    const isComplete = revealed === stroke.points.length
    strokes.push({
      id: stroke.id,
      order: stroke.order,
      tool: stroke.tool,
      color: stroke.color,
      width: stroke.width,
      // Complete strokes share the session's own array instead of copying it -
      // read-only, and the common case during playback and at the end.
      points: isComplete ? stroke.points : stroke.points.slice(0, revealed),
      isComplete,
    })

    if (!isComplete) {
      activeStrokeId = stroke.id
    }
  }

  return {
    timeMs: clamped,
    durationMs,
    strokes,
    activeStrokeId,
    settings: deriveSettings(session.actions, appliedActionCount),
    isAtEnd: clamped >= durationMs,
  }
}

/**
 * Checks a session before it is replayed.
 *
 * Replay must not quietly render an invalid file: a session with duplicate
 * sequences or time running backwards has no single well-defined state at a
 * given instant, and showing something anyway would present a guess as a
 * reconstruction. The existing validator is reused rather than re-implemented,
 * so replay accepts exactly what import accepts - including a legacy v1 file,
 * which arrives here already upgraded and marked.
 */
export function validateReplaySession(raw: unknown): ParseResult<DrawingSession> {
  return validateSession(raw)
}
