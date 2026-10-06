import { describe, expect, it } from 'vitest'
import {
  PAUSE_THRESHOLD_MS,
  createEmptyFeatures,
  extractDrawingFeatures,
} from './featureExtraction'
import {
  makeClearAction,
  makePoint,
  makeRedoAction,
  makeSession,
  makeStroke,
  makeStrokeSeries,
  makeUndoAction,
} from '../../drawing/testing/sessionFixture'
import type { DrawingFeatures } from '../types/trial.types'
import type { DrawingStroke, PointSample } from '../../drawing/types/drawing.types'

/**
 * Walks every value a feature object contains, including inside the two
 * bounding boxes, so a NaN cannot hide in a nested field.
 */
function everyNumber(features: DrawingFeatures): number[] {
  const numbers: number[] = []
  for (const value of Object.values(features)) {
    if (typeof value === 'number') {
      numbers.push(value)
    } else if (value !== null && typeof value === 'object') {
      for (const inner of Object.values(value)) {
        if (typeof inner === 'number') numbers.push(inner)
      }
    }
  }
  return numbers
}

function expectAllFinite(features: DrawingFeatures): void {
  for (const value of everyNumber(features)) {
    expect(Number.isFinite(value)).toBe(true)
  }
}

/** A stroke whose points are given explicitly, with consistent stroke timing. */
function strokeWithPoints(
  id: string,
  order: number,
  points: PointSample[],
  overrides: Partial<DrawingStroke> = {},
): DrawingStroke {
  const first = points[0]
  const last = points[points.length - 1]
  return makeStroke({
    id,
    order,
    points,
    startedAtMs: first?.timeMs ?? 0,
    endedAtMs: last?.timeMs ?? 0,
    ...overrides,
  })
}

describe('empty and degenerate sessions', () => {
  it('returns a valid zero-valued object for an empty session', () => {
    const features = extractDrawingFeatures(makeSession({ strokes: [], actions: [] }))

    expect(features).toEqual(createEmptyFeatures())
    expectAllFinite(features)
  })

  it('reports null bounding boxes rather than a zero-sized rectangle', () => {
    // A zero-sized box at the origin would look like a real measurement of a
    // drawing in the corner, which is a different claim from "nothing drawn".
    const features = extractDrawingFeatures(makeSession({ strokes: [], actions: [] }))

    expect(features.boundingBox).toBeNull()
    expect(features.boundingBoxNormalized).toBeNull()
    expect(features.canvasCoverageRatio).toBe(0)
  })

  it('handles a stroke with a single point', () => {
    const point = makePoint({ sequence: 1, timeMs: 10, x: 40, y: 20 })
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeWithPoints('a', 0, [point])], actions: [] }),
    )

    expect(features.totalPointCount).toBe(1)
    // A dot covers no distance and supports no speed sample.
    expect(features.totalPathLengthPx).toBe(0)
    expect(features.validSpeedSampleCount).toBe(0)
    expect(features.meanSpeedNormalizedPerSecond).toBe(0)
    expect(features.boundingBox).toEqual({
      minX: 40,
      minY: 20,
      maxX: 40,
      maxY: 20,
      width: 0,
      height: 0,
    })
    expectAllFinite(features)
  })

  it('handles a stroke with no points at all', () => {
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeWithPoints('a', 0, [])], actions: [] }),
    )

    expect(features.totalStrokeCount).toBe(1)
    expect(features.totalPointCount).toBe(0)
    expect(features.boundingBox).toBeNull()
    expectAllFinite(features)
  })
})

describe('counts', () => {
  it('separates recorded strokes from visible strokes', () => {
    // The undone stroke stays in the research data but leaves the canvas.
    const session = makeSession({
      strokes: makeStrokeSeries(3, ['a', 'b', 'c']),
      actions: [makeUndoAction('c', 50)],
    })
    const features = extractDrawingFeatures(session)

    expect(features.totalStrokeCount).toBe(3)
    expect(features.visibleStrokeCount).toBe(2)
  })

  it('counts cleared strokes as recorded but not visible', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(3, ['a', 'b', 'c']),
      actions: [makeClearAction(['a', 'b', 'c'], 50)],
    })
    const features = extractDrawingFeatures(session)

    expect(features.totalStrokeCount).toBe(3)
    expect(features.visibleStrokeCount).toBe(0)
  })

  it('separates pen strokes from eraser strokes', () => {
    const strokes = makeStrokeSeries(3, ['a', 'b', 'c']).map((stroke, index) =>
      index === 1 ? { ...stroke, tool: 'eraser' as const } : stroke,
    )
    const features = extractDrawingFeatures(makeSession({ strokes, actions: [] }))

    expect(features.penStrokeCount).toBe(2)
    expect(features.eraserStrokeCount).toBe(1)
  })

  it('tallies every action type', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(2, ['a', 'b']),
      actions: [
        makeUndoAction('b', 50),
        makeRedoAction('b', 51),
        makeUndoAction('b', 52),
        makeClearAction(['a'], 53),
        { sequence: 54, timeMs: 540, type: 'tool_change', payload: {} },
        { sequence: 55, timeMs: 550, type: 'color_change', payload: {} },
        { sequence: 56, timeMs: 560, type: 'width_change', payload: {} },
      ],
    })
    const features = extractDrawingFeatures(session)

    expect(features.undoCount).toBe(2)
    expect(features.redoCount).toBe(1)
    expect(features.clearCount).toBe(1)
    expect(features.toolChangeCount).toBe(1)
    expect(features.colorChangeCount).toBe(1)
    expect(features.widthChangeCount).toBe(1)
  })
})

describe('geometry', () => {
  it('sums path length across the points of a stroke', () => {
    // A 3-4-5 triangle then a straight run: 5 + 10 = 15 px.
    const points = [
      makePoint({ sequence: 1, timeMs: 10, x: 0, y: 0 }),
      makePoint({ sequence: 2, timeMs: 20, x: 3, y: 4 }),
      makePoint({ sequence: 3, timeMs: 30, x: 13, y: 4 }),
    ]
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeWithPoints('a', 0, points)], actions: [] }),
    )

    expect(features.totalPathLengthPx).toBeCloseTo(15, 4)
  })

  it('does not connect the end of one stroke to the start of the next', () => {
    // Pen-up travel is not drawing, so the gap between strokes adds no length.
    const strokeA = strokeWithPoints('a', 0, [
      makePoint({ sequence: 1, timeMs: 10, x: 0, y: 0 }),
      makePoint({ sequence: 2, timeMs: 20, x: 10, y: 0 }),
    ])
    const strokeB = strokeWithPoints('b', 1, [
      makePoint({ sequence: 3, timeMs: 30, x: 500, y: 0 }),
      makePoint({ sequence: 4, timeMs: 40, x: 510, y: 0 }),
    ])
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeA, strokeB], actions: [] }),
    )

    expect(features.totalPathLengthPx).toBeCloseTo(20, 4)
  })

  /*
    UPDATED for result schema 2. The pixel and normalized coordinates now have
    to AGREE, because the normalized figures are derived from the pixels rather
    than read from the recorded (and clamped) normalized fields. The old version
    of this test set the two independently, so it silently asserted a normalized
    box that the pixel box contradicted.

    The fixture canvas is 800 x 400.
  */
  it('computes the bounding box over every recorded point', () => {
    const points = [
      makePoint({ sequence: 1, timeMs: 10, x: 80, y: 200, normalizedX: 0.1, normalizedY: 0.5 }),
      makePoint({ sequence: 2, timeMs: 20, x: 720, y: 80, normalizedX: 0.9, normalizedY: 0.2 }),
      makePoint({ sequence: 3, timeMs: 30, x: 320, y: 320, normalizedX: 0.4, normalizedY: 0.8 }),
    ]
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeWithPoints('a', 0, points)], actions: [] }),
    )

    expect(features.boundingBox).toEqual({
      minX: 80,
      minY: 80,
      maxX: 720,
      maxY: 320,
      width: 640,
      height: 240,
    })
    expect(features.boundingBoxNormalized?.width).toBeCloseTo(0.8, 4)
    expect(features.boundingBoxNormalized?.height).toBeCloseTo(0.6, 4)
  })

  /*
    UPDATED for result schema 2: coverage is now derived from the IN-CANVAS box,
    normalized to the canvas, so movement off the surface can no longer inflate
    it. Both points here are inside, so the expected value is unchanged - only
    the coordinates had to be made self-consistent.
  */
  it('derives coverage from the visible box, so it is screen-independent', () => {
    const points = [
      makePoint({ sequence: 1, timeMs: 10, x: 160, y: 80, normalizedX: 0.2, normalizedY: 0.2 }),
      makePoint({ sequence: 2, timeMs: 20, x: 560, y: 240, normalizedX: 0.7, normalizedY: 0.6 }),
    ]
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeWithPoints('a', 0, points)], actions: [] }),
    )

    // 0.5 wide x 0.4 tall = 0.2 of the canvas.
    expect(features.canvasCoverageRatio).toBeCloseTo(0.2, 4)
  })

  it('includes hidden strokes in the geometry, because they were still drawn', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(2, ['a', 'b']),
      actions: [makeUndoAction('b', 50)],
    })
    const features = extractDrawingFeatures(session)

    // Both strokes contribute points: the pen really did travel there.
    expect(features.totalPointCount).toBe(6)
    expect(features.visibleStrokeCount).toBe(1)
  })
})

describe('speed', () => {
  it('ignores intervals whose timestamps are equal', () => {
    // Equal timestamps are routine at 0.1 ms rounding. Dividing by that gap
    // would produce Infinity and silently poison the mean.
    const points = [
      makePoint({ sequence: 1, timeMs: 100, x: 0, y: 0, normalizedX: 0, normalizedY: 0 }),
      makePoint({ sequence: 2, timeMs: 100, x: 400, y: 0, normalizedX: 0.5, normalizedY: 0 }),
    ]
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeWithPoints('a', 0, points)], actions: [] }),
    )

    expect(features.validSpeedSampleCount).toBe(0)
    expect(features.meanSpeedNormalizedPerSecond).toBe(0)
    expect(features.maxSpeedNormalizedPerSecond).toBe(0)
    // The distance still counts - the pen moved, we just cannot time it.
    expect(features.totalPathLengthNormalized).toBeCloseTo(0.5, 4)
    expectAllFinite(features)
  })

  it('computes speed in normalized units per second', () => {
    // 0.5 normalized units in 500 ms = 1.0 units/second.
    const points = [
      makePoint({ sequence: 1, timeMs: 0, x: 0, y: 0, normalizedX: 0, normalizedY: 0 }),
      makePoint({ sequence: 2, timeMs: 500, x: 400, y: 0, normalizedX: 0.5, normalizedY: 0 }),
    ]
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeWithPoints('a', 0, points)], actions: [] }),
    )

    expect(features.validSpeedSampleCount).toBe(1)
    expect(features.meanSpeedNormalizedPerSecond).toBeCloseTo(1, 4)
    expect(features.maxSpeedNormalizedPerSecond).toBeCloseTo(1, 4)
  })

  it('reports the maximum separately from the mean', () => {
    const points = [
      makePoint({ sequence: 1, timeMs: 0, x: 0, y: 0, normalizedX: 0, normalizedY: 0 }),
      makePoint({ sequence: 2, timeMs: 1000, x: 80, y: 0, normalizedX: 0.1, normalizedY: 0 }),
      makePoint({ sequence: 3, timeMs: 2000, x: 480, y: 0, normalizedX: 0.6, normalizedY: 0 }),
    ]
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeWithPoints('a', 0, points)], actions: [] }),
    )

    expect(features.validSpeedSampleCount).toBe(2)
    expect(features.maxSpeedNormalizedPerSecond).toBeCloseTo(0.5, 4)
    expect(features.meanSpeedNormalizedPerSecond).toBeCloseTo(0.3, 4)
  })

  it('counts only the intervals that could be timed', () => {
    const points = [
      makePoint({ sequence: 1, timeMs: 0, normalizedX: 0, normalizedY: 0 }),
      makePoint({ sequence: 2, timeMs: 0, normalizedX: 0.1, normalizedY: 0 }),
      makePoint({ sequence: 3, timeMs: 100, normalizedX: 0.2, normalizedY: 0 }),
    ]
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeWithPoints('a', 0, points)], actions: [] }),
    )

    // Three points, two intervals, but only the second one has dt > 0.
    expect(features.validSpeedSampleCount).toBe(1)
    expectAllFinite(features)
  })
})

describe('pressure', () => {
  it('reports null statistics when nothing recorded pressure', () => {
    // Null, not zero: "no pressure was measured" and "the pressure was zero"
    // are different claims and only one of them is true.
    const features = extractDrawingFeatures(makeSession())

    expect(features.pressureSampleCount).toBe(0)
    expect(features.minPressure).toBeNull()
    expect(features.maxPressure).toBeNull()
    expect(features.meanPressure).toBeNull()
  })

  it('computes min, max and mean over the pressure samples', () => {
    const points = [
      makePoint({ sequence: 1, timeMs: 10, pressure: 0.2, pointerType: 'pen' }),
      makePoint({ sequence: 2, timeMs: 20, pressure: 0.6, pointerType: 'pen' }),
      makePoint({ sequence: 3, timeMs: 30, pressure: 0.4, pointerType: 'pen' }),
    ]
    const features = extractDrawingFeatures(
      makeSession({
        strokes: [strokeWithPoints('a', 0, points, { hasPressureSamples: true })],
        actions: [],
      }),
    )

    expect(features.pressureSampleCount).toBe(3)
    expect(features.minPressure).toBeCloseTo(0.2, 4)
    expect(features.maxPressure).toBeCloseTo(0.6, 4)
    expect(features.meanPressure).toBeCloseTo(0.4, 4)
  })

  it('ignores null pressures inside an otherwise pressure-bearing stroke', () => {
    const points = [
      makePoint({ sequence: 1, timeMs: 10, pressure: null }),
      makePoint({ sequence: 2, timeMs: 20, pressure: 0.8, pointerType: 'pen' }),
    ]
    const features = extractDrawingFeatures(
      makeSession({
        strokes: [strokeWithPoints('a', 0, points, { hasPressureSamples: true })],
        actions: [],
      }),
    )

    expect(features.pressureSampleCount).toBe(1)
    expect(features.meanPressure).toBeCloseTo(0.8, 4)
  })
})

describe('pauses', () => {
  it('counts a gap between strokes longer than the threshold', () => {
    const strokeA = strokeWithPoints('a', 0, [makePoint({ sequence: 1, timeMs: 0 })])
    const strokeB = strokeWithPoints('b', 1, [
      makePoint({ sequence: 2, timeMs: PAUSE_THRESHOLD_MS + 500 }),
    ])
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeA, strokeB], actions: [] }),
    )

    expect(features.pauseCount).toBe(1)
    expect(features.totalPauseMs).toBeCloseTo(PAUSE_THRESHOLD_MS + 500, 4)
    expect(features.longestPauseMs).toBeCloseTo(PAUSE_THRESHOLD_MS + 500, 4)
  })

  it('does not count a gap at or below the threshold', () => {
    const strokeA = strokeWithPoints('a', 0, [makePoint({ sequence: 1, timeMs: 0 })])
    const strokeB = strokeWithPoints('b', 1, [
      makePoint({ sequence: 2, timeMs: PAUSE_THRESHOLD_MS }),
    ])
    const features = extractDrawingFeatures(
      makeSession({ strokes: [strokeA, strokeB], actions: [] }),
    )

    expect(features.pauseCount).toBe(0)
    expect(features.totalPauseMs).toBe(0)
  })

  it('reports the longest pause separately from the total', () => {
    const build = (id: string, order: number, start: number, end: number) =>
      makeStroke({
        id,
        order,
        startedAtMs: start,
        endedAtMs: end,
        points: [makePoint({ sequence: order * 10 + 1, timeMs: start })],
      })

    const features = extractDrawingFeatures(
      makeSession({
        strokes: [
          build('a', 0, 0, 100),
          build('b', 1, 900, 1000), // 800 ms pause
          build('c', 2, 3000, 3100), // 2000 ms pause
        ],
        actions: [],
      }),
    )

    expect(features.pauseCount).toBe(2)
    expect(features.totalPauseMs).toBeCloseTo(2800, 4)
    expect(features.longestPauseMs).toBeCloseTo(2000, 4)
  })

  it('ignores a negative gap between overlapping strokes', () => {
    const build = (id: string, order: number, start: number, end: number) =>
      makeStroke({
        id,
        order,
        startedAtMs: start,
        endedAtMs: end,
        points: [makePoint({ sequence: order * 10 + 1, timeMs: start })],
      })

    const features = extractDrawingFeatures(
      makeSession({ strokes: [build('a', 0, 0, 1000), build('b', 1, 500, 1500)], actions: [] }),
    )

    expect(features.pauseCount).toBe(0)
    expectAllFinite(features)
  })

  it('reports no pause for a single stroke', () => {
    const features = extractDrawingFeatures(makeSession())
    expect(features.pauseCount).toBe(0)
  })
})

describe('duration', () => {
  it('takes the largest recorded timestamp across strokes and actions', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(1, ['a']),
      actions: [makeUndoAction('a', 400)],
    })
    const features = extractDrawingFeatures(session)

    // makeUndoAction places the action at sequence * 10 ms.
    expect(features.durationMs).toBe(4000)
  })
})

describe('purity', () => {
  it('does not mutate the session it is given', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(3, ['a', 'b', 'c']),
      actions: [makeUndoAction('c', 50)],
    })
    const before = JSON.stringify(session)

    extractDrawingFeatures(session)

    expect(JSON.stringify(session)).toBe(before)
  })

  it('is deterministic: the same session yields identical features', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(3, ['a', 'b', 'c']),
      actions: [makeUndoAction('c', 50)],
    })

    expect(extractDrawingFeatures(session)).toEqual(extractDrawingFeatures(session))
  })

  it('never emits NaN or Infinity, even for adversarial input', () => {
    // Zero-length movement, identical timestamps, an empty stroke and a
    // single-point stroke all in one session.
    const session = makeSession({
      strokes: [
        strokeWithPoints('a', 0, []),
        strokeWithPoints('b', 1, [makePoint({ sequence: 1, timeMs: 0 })]),
        strokeWithPoints('c', 2, [
          makePoint({ sequence: 2, timeMs: 5, normalizedX: 0.5, normalizedY: 0.5 }),
          makePoint({ sequence: 3, timeMs: 5, normalizedX: 0.5, normalizedY: 0.5 }),
        ]),
      ],
      actions: [],
    })

    expectAllFinite(extractDrawingFeatures(session))
  })
})

/**
 * RAW versus IN-CANVAS geometry.
 *
 * Pointer capture keeps recording after the pointer leaves the surface, so a
 * real export contained 1586 outside points out of 3186 and reported 100%
 * coverage of a canvas the participant had barely touched. These tests pin down
 * the split that fixes it - and, just as importantly, that the raw data is
 * still all there.
 */
describe('outside-canvas geometry', () => {
  const CANVAS = { width: 800, height: 400, devicePixelRatio: 1 }

  /** A point at a pixel position, with the sequence and clock kept consistent. */
  function pointAt(sequence: number, x: number, y: number): PointSample {
    return makePoint({
      sequence,
      timeMs: sequence * 10,
      x,
      y,
      // The recorder CLAMPS these, which is exactly why the extractor derives
      // raw normalized figures from x/y instead of reading them.
      normalizedX: Math.min(1, Math.max(0, x / CANVAS.width)),
      normalizedY: Math.min(1, Math.max(0, y / CANVAS.height)),
    })
  }

  /** A single-stroke session on the 800x400 canvas. */
  function sessionOf(...points: PointSample[]) {
    return makeSession({
      canvas: CANVAS,
      strokes: [strokeWithPoints('stroke-a', 0, points)],
      actions: [],
    })
  }

  it('counts every point as inside when the whole stroke stays on the canvas', () => {
    const features = extractDrawingFeatures(
      sessionOf(pointAt(1, 100, 100), pointAt(2, 200, 100), pointAt(3, 300, 200)),
    )

    expect(features.totalPointCount).toBe(3)
    expect(features.insideCanvasPointCount).toBe(3)
    expect(features.outsideCanvasPointCount).toBe(0)
    expect(features.outsideCanvasPointRatio).toBe(0)
    expect(features.strokeWithOutsidePointsCount).toBe(0)
    // Nothing was clipped, so the two geometries agree exactly.
    expect(features.inCanvasPathLengthPx).toBeCloseTo(features.rawPathLengthPx, 3)
    expectAllFinite(features)
  })

  it('treats a point exactly on each boundary as inside', () => {
    const features = extractDrawingFeatures(
      sessionOf(
        pointAt(1, 0, 0),
        pointAt(2, 800, 0),
        pointAt(3, 800, 400),
        pointAt(4, 0, 400),
      ),
    )

    expect(features.outsideCanvasPointCount).toBe(0)
    expect(features.insideCanvasPointCount).toBe(4)
  })

  it('clips a segment with one endpoint outside', () => {
    // 400px inside, 400px outside, along a straight horizontal line.
    const features = extractDrawingFeatures(
      sessionOf(pointAt(1, 400, 200), pointAt(2, 1200, 200)),
    )

    expect(features.outsideCanvasPointCount).toBe(1)
    expect(features.strokeWithOutsidePointsCount).toBe(1)
    expect(features.rawPathLengthPx).toBeCloseTo(800, 3)
    expect(features.inCanvasPathLengthPx).toBeCloseTo(400, 3)
  })

  it('contributes nothing visible for an outside segment that never crosses', () => {
    const features = extractDrawingFeatures(
      sessionOf(pointAt(1, -300, -200), pointAt(2, -100, -50)),
    )

    expect(features.outsideCanvasPointCount).toBe(2)
    expect(features.insideCanvasPointCount).toBe(0)
    expect(features.rawPathLengthPx).toBeGreaterThan(0)
    expect(features.inCanvasPathLengthPx).toBe(0)
    // No visible geometry at all - reported as null, not a zero-sized box.
    expect(features.inCanvasBoundingBox).toBeNull()
    expect(features.visibleCanvasCoverageRatio).toBe(0)
    // The raw box still records where the hand actually went.
    expect(features.rawBoundingBox).not.toBeNull()
    expect(features.rawBoundingBox?.minX).toBeCloseTo(-300, 3)
  })

  it('KEEPS the visible part of a segment whose endpoints are both outside', () => {
    // A sweep straight across the canvas: both samples are off the surface, but
    // the full width of it was drawn on.
    const features = extractDrawingFeatures(
      sessionOf(pointAt(1, -400, 200), pointAt(2, 1200, 200)),
    )

    expect(features.insideCanvasPointCount).toBe(0)
    expect(features.inCanvasPathLengthPx).toBeCloseTo(800, 3)
    expect(features.inCanvasBoundingBox).not.toBeNull()
    expect(features.inCanvasBoundingBox?.minX).toBeCloseTo(0, 3)
    expect(features.inCanvasBoundingBox?.maxX).toBeCloseTo(800, 3)
  })

  it('handles negative coordinates and coordinates beyond the canvas together', () => {
    const features = extractDrawingFeatures(
      sessionOf(pointAt(1, -209, -304), pointAt(2, 400, 200), pointAt(3, 970, 514)),
    )

    expect(features.outsideCanvasPointCount).toBe(2)
    expect(features.insideCanvasPointCount).toBe(1)
    expect(features.outsideCanvasPointRatio).toBeCloseTo(2 / 3, 4)
    expect(features.inCanvasPathLengthPx).toBeGreaterThan(0)
    expect(features.inCanvasPathLengthPx).toBeLessThan(features.rawPathLengthPx)
    expectAllFinite(features)
  })

  it('counts a one-point stroke that is entirely outside', () => {
    const features = extractDrawingFeatures(sessionOf(pointAt(1, -50, -50)))

    expect(features.totalPointCount).toBe(1)
    expect(features.outsideCanvasPointCount).toBe(1)
    expect(features.outsideCanvasPointRatio).toBe(1)
    expect(features.strokeWithOutsidePointsCount).toBe(1)
    expect(features.inCanvasPathLengthPx).toBe(0)
    expect(features.inCanvasBoundingBox).toBeNull()
  })

  it('gives a one-point stroke inside the canvas a visible box - a dot is visible', () => {
    const features = extractDrawingFeatures(sessionOf(pointAt(1, 120, 240)))

    expect(features.inCanvasBoundingBox).not.toBeNull()
    expect(features.inCanvasBoundingBox?.width).toBe(0)
    expect(features.visibleCanvasCoverageRatio).toBe(0)
  })

  it('counts strokes with outside points, not the outside points per stroke', () => {
    const session = makeSession({
      canvas: CANVAS,
      strokes: [
        strokeWithPoints('a', 0, [pointAt(1, 100, 100), pointAt(2, 200, 150)]),
        strokeWithPoints('b', 1, [pointAt(3, -100, 100), pointAt(4, -200, 150)]),
        strokeWithPoints('c', 2, [pointAt(5, 100, 100), pointAt(6, 9000, 150)]),
      ],
      actions: [],
    })
    const features = extractDrawingFeatures(session)

    expect(features.totalStrokeCount).toBe(3)
    expect(features.strokeWithOutsidePointsCount).toBe(2)
    expect(features.outsideCanvasPointCount).toBe(3)
    expect(features.insideCanvasPointCount).toBe(3)
    expect(features.outsideCanvasPointRatio).toBeCloseTo(0.5, 4)
  })

  it('does NOT let outside movement force visible coverage to 100%', () => {
    // The exact shape of the real bug: a short stroke in the middle of the
    // canvas, with the pointer then dragged far past two opposite corners.
    // Clamped normalized coordinates used to report full coverage for this.
    const features = extractDrawingFeatures(
      sessionOf(
        pointAt(1, -500, -500),
        pointAt(2, 390, 195),
        pointAt(3, 410, 205),
        pointAt(4, 1500, 1500),
      ),
    )

    expect(features.visibleCanvasCoverageRatio).toBeLessThan(1)
    expect(features.canvasCoverageRatio).toBe(features.visibleCanvasCoverageRatio)
    expectAllFinite(features)
  })

  it('exposes raw figures that are unclamped, unlike the recorded normalized values', () => {
    const features = extractDrawingFeatures(
      sessionOf(pointAt(1, -800, 200), pointAt(2, 0, 200)),
    )

    // The recorded normalizedX values are both clamped to 0, so a figure derived
    // from them would be zero. The raw figure knows the pointer travelled a full
    // canvas width.
    expect(features.rawPathLengthNormalized).toBeCloseTo(1, 4)
    expect(features.rawBoundingBox?.minX).toBeCloseTo(-800, 3)
    expect(features.boundingBoxNormalized?.minX).toBeCloseTo(-1, 4)
  })

  it('never mutates the session while computing either geometry', () => {
    const session = sessionOf(pointAt(1, -100, -100), pointAt(2, 400, 200))
    const before = structuredClone(session)

    extractDrawingFeatures(session)

    expect(session).toEqual(before)
  })

  it('keeps the documented aliases pointing at the right explicit fields', () => {
    const features = extractDrawingFeatures(
      sessionOf(pointAt(1, -100, 100), pointAt(2, 400, 200), pointAt(3, 700, 300)),
    )

    expect(features.totalPathLengthPx).toBe(features.rawPathLengthPx)
    expect(features.totalPathLengthNormalized).toBe(features.rawPathLengthNormalized)
    expect(features.boundingBox).toEqual(features.rawBoundingBox)
    expect(features.canvasCoverageRatio).toBe(features.visibleCanvasCoverageRatio)
    expect(features.validSpeedSampleCount).toBe(features.validRawSpeedSampleCount)
    expect(features.meanSpeedNormalizedPerSecond).toBe(
      features.meanRawSpeedNormalizedPerSecond,
    )
    expect(features.maxSpeedNormalizedPerSecond).toBe(features.maxRawSpeedNormalizedPerSecond)
  })

  it('skips in-canvas speed samples for segments with no visible part', () => {
    const features = extractDrawingFeatures(
      sessionOf(pointAt(1, -400, -400), pointAt(2, -300, -300), pointAt(3, 400, 200)),
    )

    // Two raw intervals; only the second one crosses the canvas.
    expect(features.validRawSpeedSampleCount).toBe(2)
    expect(features.validInCanvasSpeedSampleCount).toBe(1)
    expectAllFinite(features)
  })

  it('produces no NaN or Infinity for a degenerate canvas', () => {
    const session = makeSession({
      canvas: { width: 0, height: 0, devicePixelRatio: 1 },
      strokes: [strokeWithPoints('a', 0, [pointAt(1, 10, 10), pointAt(2, 20, 20)])],
      actions: [],
    })

    expectAllFinite(extractDrawingFeatures(session))
  })
})
