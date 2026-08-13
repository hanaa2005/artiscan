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

  for (const event of buildTimeline(strokes, actions)) {
    if (event.kind === 'draw') {
      visibleIds.add(event.strokeId)
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
        visibleIds.delete(id)
        redoStack.push(id)
        break
      }
      case 'redo': {
        const id = readStrokeId(action)
        if (id === null || !knownIds.has(id)) break
        visibleIds.add(id)
        redoStack = redoStack.filter((entry) => entry !== id)
        break
      }
      case 'clear': {
        for (const id of readAffectedStrokeIds(action)) {
          visibleIds.delete(id)
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

  return { visibleIds, redoStack }
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
