/**
 * The three reference sessions every graph and mask claim is checked against.
 *
 * WHY THESE THREE
 *
 * A. Normal      nothing was hidden, so both modes must agree exactly. It is the
 *                control: any difference between full-process and final-visible
 *                here is a bug in the derivation, not a property of the data.
 * B. Undo/Redo   a stroke undone and left undone, and another undone then
 *                redone. It separates "was removed" from "was removed and put
 *                back", which a naive visibility pass gets wrong.
 * C. Clear       a clear in the middle with drawing after it. It is the case
 *                where the two modes must diverge the most, and where the
 *                distinction between `cleared` and `undone` has to survive.
 *
 * They are built from real coordinates on a real canvas, with a timeline that
 * runs forwards, so an artifact derived from them is the same shape as one
 * derived from an actual recording. Nothing here is a stub.
 */

import type { DrawingAction, DrawingSession, PointSample } from '../../drawing/types/drawing.types'
import {
  makeClearAction,
  makePoint,
  makeRedoAction,
  makeSession,
  makeStroke,
  makeUndoAction,
  timeForSequence,
} from '../../drawing/testing/sessionFixture'

/** The canvas every fixture uses. Small enough to reason about, real enough to draw on. */
export const FIXTURE_CANVAS = { width: 400, height: 300, devicePixelRatio: 1 } as const

/** A point placed by pixel coordinates, with normalized values derived from them. */
export function fixturePoint(sequence: number, x: number, y: number): PointSample {
  return makePoint({
    sequence,
    timeMs: timeForSequence(sequence),
    x,
    y,
    // Derived from the pixels, never set independently: the two must agree or
    // the session is internally inconsistent before any artifact touches it.
    normalizedX: x / FIXTURE_CANVAS.width,
    normalizedY: y / FIXTURE_CANVAS.height,
  })
}

/** Builds one stroke from a list of pixel coordinates. */
export function fixtureStroke(
  id: string,
  order: number,
  startSequence: number,
  coordinates: readonly (readonly [number, number])[],
  extra: { width?: number; color?: string } = {},
) {
  const points = coordinates.map(([x, y], index) =>
    fixturePoint(startSequence + index, x, y),
  )
  const first = points[0]
  const last = points[points.length - 1]
  return makeStroke({
    id,
    order,
    width: extra.width ?? 4,
    color: extra.color ?? '#1f2933',
    points,
    startedAtMs: first?.timeMs ?? 0,
    endedAtMs: last?.timeMs ?? 0,
  })
}

/**
 * Fixture A - a normal drawing.
 *
 * Three strokes, nothing hidden: a horizontal line, a diagonal, and a short
 * two-point tick. One tool change between strokes, which is a timeline event
 * with no geometry of its own.
 */
export function fixtureNormalSession(): DrawingSession {
  return makeSession({
    canvas: { ...FIXTURE_CANVAS },
    strokes: [
      fixtureStroke('n-1', 0, 1, [
        [40, 60],
        [120, 60],
        [200, 60],
      ]),
      fixtureStroke('n-2', 1, 6, [
        [60, 120],
        [140, 190],
        [220, 260],
      ]),
      fixtureStroke('n-3', 2, 12, [
        [300, 100],
        [330, 140],
      ]),
    ],
    actions: [
      {
        sequence: 10,
        timeMs: timeForSequence(10),
        type: 'width_change',
        payload: { from: 4, to: 8 },
      } satisfies DrawingAction,
    ],
  })
}

/**
 * Fixture B - undo and redo.
 *
 * Four strokes. `u-2` is undone and stays undone. `u-3` is undone and then
 * redone, so it must come back as fully visible - a graph that shows it greyed
 * would be reporting an event that was taken back. `u-4` is drawn afterwards.
 *
 * WHY THE EVENTS ARE IN THIS PARTICULAR ORDER
 *
 * Leaving one stroke undone while a later one is redone cannot be done by
 * undoing twice and redoing only the older of the two: the redo stack is LIFO,
 * so the editor - and the validator - would refuse that. The only way a real
 * user reaches this state is the one recorded here: undo `u-2`, then DRAW
 * `u-3`, which discards the redo history and strands `u-2` permanently. The
 * fixture has to be a sequence the app can actually produce, or it would be
 * testing the derivation against a session that can never exist.
 */
export function fixtureUndoRedoSession(): DrawingSession {
  return makeSession({
    canvas: { ...FIXTURE_CANVAS },
    strokes: [
      fixtureStroke('u-1', 0, 1, [
        [40, 40],
        [160, 40],
      ]),
      fixtureStroke('u-2', 1, 5, [
        [40, 90],
        [160, 90],
      ]),
      fixtureStroke('u-3', 2, 11, [
        [40, 140],
        [160, 140],
      ]),
      fixtureStroke('u-4', 3, 20, [
        [40, 190],
        [160, 190],
        [280, 240],
      ]),
    ],
    actions: [
      // u-2 is undone, and the stroke drawn next throws away the redo history,
      // so it stays undone for the rest of the session.
      makeUndoAction('u-2', 9),
      // u-3 is undone and immediately put back: an event that was taken back.
      makeUndoAction('u-3', 14),
      makeRedoAction('u-3', 16),
    ],
  })
}

/**
 * Fixture C - a clear with work on both sides.
 *
 * Two strokes, a clear, then two more. The first pair must read as `cleared`
 * and the second as `visible`, and the final-visible graph must contain only
 * the second pair while keeping the labels S03 and S04 the first pair vacated.
 */
export function fixtureClearSession(): DrawingSession {
  return makeSession({
    canvas: { ...FIXTURE_CANVAS },
    strokes: [
      fixtureStroke('c-1', 0, 1, [
        [30, 50],
        [150, 50],
      ]),
      fixtureStroke('c-2', 1, 5, [
        [30, 100],
        [150, 100],
      ]),
      fixtureStroke('c-3', 2, 15, [
        [200, 60],
        [320, 60],
        [360, 130],
      ]),
      fixtureStroke('c-4', 3, 22, [
        [200, 200],
        [320, 200],
      ]),
    ],
    actions: [makeClearAction(['c-1', 'c-2'], 12)],
  })
}
