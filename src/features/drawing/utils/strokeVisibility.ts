/**
 * Deriving what is VISIBLE from what was RECORDED.
 *
 * The project's founding rule is that the event log is the primary data and
 * everything else is derived from it. Undo, redo and clear are therefore
 * recorded as events that change VISIBILITY - they never delete a stroke from
 * the session. `session.strokes` is append-only: once a stroke is completed it
 * stays in the research data forever, with its points, timing and tool intact.
 *
 * This module is the single place that turns that log back into UI state: which
 * strokes the canvas paints, and what is still available to redo.
 */

import type { DrawingAction, DrawingStroke } from '../types/drawing.types'

/** Payload written by the `clear` action. */
export interface ClearActionPayload {
  affectedStrokeIds: string[]
}

/** The complete UI state implied by a session's history. */
export interface ReplayResult {
  /** Ids of the strokes that should be painted. */
  visibleIds: Set<string>
  /**
   * Ids still available to redo, oldest first - so the LAST entry is the next
   * one a redo would restore, exactly like the in-memory stack.
   */
  redoStack: string[]
  /**
   * For every stroke NOT in `visibleIds`, which kind of event last removed it.
   *
   * Carried out of the replay rather than recomputed, because deciding "was
   * this cleared or undone?" needs the order events actually happened in - the
   * one thing a second pass over the log no longer has.
   */
  hiddenBy: Map<string, StrokeHiddenCause>
}

/** Reads `strokeId` from an undo/redo payload, or null when it is missing. */
function readStrokeId(action: DrawingAction): string | null {
  const value = action.payload?.['strokeId']
  return typeof value === 'string' ? value : null
}

/** Reads `affectedStrokeIds` from a clear payload, ignoring malformed entries. */
export function readAffectedStrokeIds(action: DrawingAction): string[] {
  const value = action.payload?.['affectedStrokeIds']
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === 'string')
}

/** When a stroke entered the timeline: its first sample's sequence number. */
function strokeSequence(stroke: DrawingStroke): number {
  const first = stroke.points[0]
  return first?.sequence ?? 0
}

type TimelineEvent =
  | { kind: 'draw'; sequence: number; tieBreak: number; strokeId: string }
  | { kind: 'action'; sequence: number; tieBreak: number; action: DrawingAction }

/**
 * Merges strokes and actions into one chronological list.
 *
 * This merge is why `sequence` exists. Strokes and actions live in two separate
 * arrays, but they happened in ONE interleaved order, and questions like "was
 * this stroke drawn before or after that undo?" can only be answered by putting
 * them back on a single timeline.
 *
 * `tieBreak` keeps the merge deterministic when two events report the same
 * sequence (possible in a hand-written or legacy file): strokes are ordered
 * among themselves by array position, and actions likewise.
 */
function buildTimeline(
  strokes: readonly DrawingStroke[],
  actions: readonly DrawingAction[],
): TimelineEvent[] {
  const events: TimelineEvent[] = []

  strokes.forEach((stroke, index) => {
    events.push({
      kind: 'draw',
      sequence: strokeSequence(stroke),
      tieBreak: index,
      strokeId: stroke.id,
    })
  })

  actions.forEach((action, index) => {
    events.push({
      kind: 'action',
      sequence: action.sequence,
      tieBreak: index,
      action,
    })
  })

  return events.sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence
    // A draw and an action at the same sequence: the draw is treated as first,
    // because an action always refers to strokes that already existed.
    if (a.kind !== b.kind) return a.kind === 'draw' ? -1 : 1
    return a.tieBreak - b.tieBreak
  })
}

/**
 * Replays the whole history to recover both visibility and the redo stack.
 *
 * The rules mirror the live editor exactly, which is the point: restoring a
 * session must land in the same state the user left it in.
 *
 * - drawing a stroke makes it visible AND invalidates the redo stack
 * - undo hides a stroke and pushes it onto the redo stack
 * - redo re-shows a stroke and pops it off
 * - clear hides the named strokes and invalidates the redo stack
 */
export function replayHistory(
  strokes: readonly DrawingStroke[],
  actions: readonly DrawingAction[],
): ReplayResult {
  const knownIds = new Set<string>()
  for (const stroke of strokes) {
    knownIds.add(stroke.id)
  }

  const visibleIds = new Set<string>()
  let redoStack: string[] = []
  /**
   * WHY a stroke stopped being visible, for the strokes that are not visible at
   * the end. Overwritten each time, so it always names the LAST thing that
   * happened to the stroke - which is what its final status is.
   */
  const hiddenBy = new Map<string, StrokeHiddenCause>()

  for (const event of buildTimeline(strokes, actions)) {
    if (event.kind === 'draw') {
      visibleIds.add(event.strokeId)
      hiddenBy.delete(event.strokeId)
      redoStack = []
      continue
    }

    const { action } = event
    switch (action.type) {
      case 'undo': {
        const id = readStrokeId(action)
        // A reference to a stroke that is not in this file is ignored rather
        // than treated as an error: legacy v1 exports legitimately contain
        // undo events whose stroke was deleted by the old destructive model.
        if (id === null || !knownIds.has(id)) break
        // Only a stroke that was actually on the canvas is hidden BY this undo.
        // One that had already gone - cleared, or undone earlier - keeps the
        // cause that really removed it, exactly as the `clear` branch below
        // does. Without this the last event to mention a stroke would overwrite
        // the history of why it left.
        if (visibleIds.delete(id)) {
          hiddenBy.set(id, 'undo')
        }
        redoStack.push(id)
        break
      }
      case 'redo': {
        const id = readStrokeId(action)
        if (id === null || !knownIds.has(id)) break
        visibleIds.add(id)
        // A redone stroke is visible again, so it carries no hidden cause. This
        // is what makes "undone then redone then visible at the end" report
        // `visible` rather than `undone`.
        hiddenBy.delete(id)
        redoStack = redoStack.filter((entry) => entry !== id)
        break
      }
      case 'clear': {
        for (const id of readAffectedStrokeIds(action)) {
          // Only strokes that were actually visible are hidden BY the clear.
          // An already-undone stroke listed in a clear payload keeps `undo` as
          // its cause, because that is what removed it from the canvas.
          if (visibleIds.delete(id)) {
            hiddenBy.set(id, 'clear')
          }
        }
        // Clear is a hard boundary: nothing hidden before it can be redone.
        redoStack = []
        break
      }
      default:
        // tool_change / color_change / width_change do not affect visibility.
        break
    }
  }

  return { visibleIds, redoStack, hiddenBy }
}

/**
 * The final state of one stroke after the whole timeline has been replayed.
 *
 * DERIVED, never stored. The canonical session records what happened; this is
 * the single place that decides what that adds up to, so the graph, the masks
 * and the canvas can never disagree about it.
 */
export type StrokeStatus =
  /** Painted in the final state. */
  | 'visible'
  /** Removed from the canvas by a clear. */
  | 'cleared'
  /** Not active in the final state because of an undo. */
  | 'undone'

/** Which kind of event last removed a stroke from the canvas. */
export type StrokeHiddenCause = 'clear' | 'undo'

/**
 * The final status of every stroke, keyed by stroke id.
 *
 * Built from the SAME replay walk the canvas uses. Re-deriving undo/redo/clear
 * semantics separately for the graph is exactly how a visualisation starts
 * quietly disagreeing with the drawing it claims to describe.
 */
export function computeStrokeStatuses(
  strokes: readonly DrawingStroke[],
  actions: readonly DrawingAction[],
): Map<string, StrokeStatus> {
  const { visibleIds, hiddenBy } = replayHistory(strokes, actions)
  const statuses = new Map<string, StrokeStatus>()

  for (const stroke of strokes) {
    if (visibleIds.has(stroke.id)) {
      statuses.set(stroke.id, 'visible')
      continue
    }
    // A stroke that is not visible and has no recorded cause was never drawn
    // into the timeline at all - only possible in a malformed history. It is
    // reported as `undone` rather than invented as visible, because the one
    // thing that is certain is that it is not on the final canvas.
    statuses.set(stroke.id, hiddenBy.get(stroke.id) === 'clear' ? 'cleared' : 'undone')
  }

  return statuses
}

/**
 * Ids of the strokes the canvas should paint.
 *
 * Referencing strokes by id (rather than by position, or by a count) is what
 * makes the replay order-independent and safe: a stroke drawn AFTER a clear can
 * never appear in that clear's id list, so it is untouched by it.
 */
export function computeVisibleStrokeIds(
  strokes: readonly DrawingStroke[],
  actions: readonly DrawingAction[],
): Set<string> {
  return replayHistory(strokes, actions).visibleIds
}

/**
 * The strokes the canvas should paint, in canonical creation order.
 *
 * Painting in creation order (rather than in the order strokes happened to be
 * re-appended by a redo) keeps the eraser correct: an eraser stroke must always
 * composite over exactly the ink that existed before it was drawn.
 */
export function computeVisibleStrokes(
  strokes: readonly DrawingStroke[],
  actions: readonly DrawingAction[],
): DrawingStroke[] {
  const visible = computeVisibleStrokeIds(strokes, actions)
  return strokes.filter((stroke) => visible.has(stroke.id))
}

/** The redo stack implied by a session's history, oldest entry first. */
export function computeRedoStack(
  strokes: readonly DrawingStroke[],
  actions: readonly DrawingAction[],
): string[] {
  return replayHistory(strokes, actions).redoStack
}
