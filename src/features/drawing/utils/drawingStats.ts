/**
 * Derived session statistics.
 *
 * These are pure, objective counts - deliberately NOT interpretations.
 * The project roadmap is explicit that version 1 extracts objective features
 * and performs no psychological interpretation whatsoever.
 */

import type { DrawingSession, DrawingStroke } from '../types/drawing.types'

export interface DrawingStats {
  strokeCount: number
  pointCount: number
  penStrokeCount: number
  eraserStrokeCount: number
  /** Length of the session in milliseconds, derived from the recorded events. */
  durationMs: number
  undoCount: number
  redoCount: number
  clearCount: number
  /**
   * True when at least one stroke contains pressure samples.
   * Claims presence only - not that the pressure varied. See DrawingStroke.
   */
  hasPressureSamples: boolean
}

/** Total number of sampled points across every stroke. */
export function countPoints(strokes: readonly DrawingStroke[]): number {
  let total = 0
  for (const stroke of strokes) {
    total += stroke.points.length
  }
  return total
}

/**
 * Session duration derived from the data itself - the largest recorded
 * timestamp across strokes and actions.
 *
 * It is deliberately NOT `performance.now() - start`: that would be wall time
 * since the app opened, which is wrong for a session loaded from a JSON file.
 * Deriving it from the events means an imported session reports the duration it
 * actually had when it was recorded.
 */
export function computeDurationMs(session: DrawingSession): number {
  let maxMs = 0
  for (const stroke of session.strokes) {
    if (stroke.endedAtMs > maxMs) maxMs = stroke.endedAtMs
  }
  for (const action of session.actions) {
    if (action.timeMs > maxMs) maxMs = action.timeMs
  }
  return maxMs
}

/** Computes every objective statistic shown in the debug panel. */
export function computeStats(session: DrawingSession): DrawingStats {
  let penStrokeCount = 0
  let eraserStrokeCount = 0
  let hasPressureSamples = false

  for (const stroke of session.strokes) {
    if (stroke.tool === 'eraser') {
      eraserStrokeCount += 1
    } else {
      penStrokeCount += 1
    }
    if (stroke.hasPressureSamples) {
      hasPressureSamples = true
    }
  }

  let undoCount = 0
  let redoCount = 0
  let clearCount = 0
  for (const action of session.actions) {
    if (action.type === 'undo') undoCount += 1
    else if (action.type === 'redo') redoCount += 1
    else if (action.type === 'clear') clearCount += 1
  }

  return {
    strokeCount: session.strokes.length,
    pointCount: countPoints(session.strokes),
    penStrokeCount,
    eraserStrokeCount,
    durationMs: computeDurationMs(session),
    undoCount,
    redoCount,
    clearCount,
    hasPressureSamples,
  }
}
