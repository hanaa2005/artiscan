/**
 * Shared test fixtures.
 *
 * Building a valid session by hand in every test would be noisy and would make
 * it easy to accidentally test against an invalid object. These builders always
 * produce a session that the validator accepts, so a test that expects a
 * REJECTION has to state explicitly what it broke.
 *
 * The builders honour the schema-2 invariants: unique stroke ids, `order` as a
 * clean 0..n-1 permutation, and one strictly increasing `sequence` counter
 * shared by every point and action.
 *
 * ONE RULE MAKES ALL OF THIS COMPOSE: every builder places an event at
 * `timeMs === sequence * MS_PER_SEQUENCE`. Because the merged timeline must
 * never let time run backwards as sequence runs forwards, tying the two
 * together means any mixture of these builders is automatically valid - a test
 * can drop an action at sequence 50 without working out whether that timestamp
 * lands after the strokes around it.
 */

import {
  CURRENT_SCHEMA_VERSION,
  type DrawingAction,
  type DrawingSession,
  type DrawingStroke,
  type DrawingTool,
  type PointSample,
} from '../types/drawing.types'

/** Milliseconds per sequence step. Keeps time and sequence in lockstep. */
export const MS_PER_SEQUENCE = 10

/** The canonical timestamp for a given position on the timeline. */
export function timeForSequence(sequence: number): number {
  return sequence * MS_PER_SEQUENCE
}

export function makePoint(overrides: Partial<PointSample> = {}): PointSample {
  return {
    sequence: 1,
    timeMs: timeForSequence(1),
    x: 40,
    y: 20,
    normalizedX: 0.05,
    normalizedY: 0.05,
    pressure: null,
    tiltX: null,
    tiltY: null,
    pointerType: 'mouse',
    ...overrides,
  }
}

export function makeStroke(overrides: Partial<DrawingStroke> = {}): DrawingStroke {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    order: 0,
    tool: 'pen' satisfies DrawingTool,
    color: '#1f2933',
    width: 4,
    startedAtMs: timeForSequence(1),
    endedAtMs: timeForSequence(3),
    hasPressureSamples: false,
    points: [
      makePoint({ sequence: 1, timeMs: timeForSequence(1), normalizedX: 0.1, normalizedY: 0.1 }),
      makePoint({ sequence: 2, timeMs: timeForSequence(2), normalizedX: 0.4, normalizedY: 0.35 }),
      makePoint({ sequence: 3, timeMs: timeForSequence(3), normalizedX: 0.8, normalizedY: 0.6 }),
    ],
    ...overrides,
  }
}

/**
 * An action. When `sequence` is overridden without `timeMs`, the timestamp
 * follows automatically so the merged timeline stays monotonic.
 */
export function makeAction(overrides: Partial<DrawingAction> = {}): DrawingAction {
  const sequence = overrides.sequence ?? 4
  return {
    sequence,
    timeMs: timeForSequence(sequence),
    type: 'tool_change',
    payload: { from: 'pen', to: 'eraser' },
    ...overrides,
  }
}

export function makeSession(overrides: Partial<DrawingSession> = {}): DrawingSession {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: '22222222-2222-4222-8222-222222222222',
    createdAt: '2026-08-09T10:00:00.000Z',
    startedAt: '2026-08-09T10:00:00.000Z',
    canvas: { width: 800, height: 400, devicePixelRatio: 2 },
    strokes: [makeStroke()],
    actions: [makeAction()],
    ...overrides,
  }
}

/**
 * Builds `count` strokes that satisfy every schema-2 invariant: distinct ids,
 * `order` running 0..count-1, and non-overlapping ascending sequence blocks.
 *
 * Tests that care about the timeline (redo restoration, clear replay) need
 * genuinely ordered sequences - a fixture where every stroke reuses 1,2,3 would
 * make the merged timeline meaningless.
 */
export function makeStrokeSeries(
  count: number,
  ids?: readonly string[],
): DrawingStroke[] {
  const strokes: DrawingStroke[] = []
  let sequence = 1

  for (let index = 0; index < count; index += 1) {
    const startedAtMs = timeForSequence(sequence)
    const points: PointSample[] = []

    for (let p = 0; p < 3; p += 1) {
      points.push(
        makePoint({
          sequence,
          timeMs: timeForSequence(sequence),
          normalizedX: 0.1 + p * 0.1,
          normalizedY: 0.1 + index * 0.05,
        }),
      )
      sequence += 1
    }

    strokes.push(
      makeStroke({
        id: ids?.[index] ?? `stroke-${index}`,
        order: index,
        startedAtMs,
        endedAtMs: timeForSequence(sequence - 1),
        points,
      }),
    )
    // A one-step gap between strokes leaves room to interleave an action.
    sequence += 1
  }

  return strokes
}

/** An `undo` action referencing a stroke, placed at a given timeline position. */
export function makeUndoAction(strokeId: string, sequence: number): DrawingAction {
  return { sequence, timeMs: timeForSequence(sequence), type: 'undo', payload: { strokeId } }
}

/** A `redo` action referencing a stroke. */
export function makeRedoAction(strokeId: string, sequence: number): DrawingAction {
  return { sequence, timeMs: timeForSequence(sequence), type: 'redo', payload: { strokeId } }
}

/** A schema-2 `clear` action naming exactly the strokes it hid. */
export function makeClearAction(
  affectedStrokeIds: readonly string[],
  sequence: number,
): DrawingAction {
  return {
    sequence,
    timeMs: timeForSequence(sequence),
    type: 'clear',
    payload: { affectedStrokeIds: [...affectedStrokeIds] },
  }
}
