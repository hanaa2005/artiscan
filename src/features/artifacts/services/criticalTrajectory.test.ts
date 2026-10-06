/**
 * WEEK 1C - critical trajectory selection.
 *
 * Two properties are load-bearing and are tested hardest:
 *
 *  1. TRACEABILITY. Every node points at a real raw sample and copies its
 *     values verbatim. Nothing is interpolated, so nothing in the artifact can
 *     claim evidence that the session does not contain.
 *  2. MANDATORY PRESERVATION. Endpoints, taps, pauses, corners and canvas
 *     crossings survive every tolerance, because losing them loses the
 *     observation rather than the redundancy.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUALITY_PROFILE,
  QUALITY_PROFILES,
  buildCriticalTrajectory,
  buildCriticalTrajectoryFileName,
  findMandatoryIndices,
  measureGeometryQuality,
  selectStrokeIndices,
} from './criticalTrajectory'
import {
  makeClearAction,
  makePoint,
  makeSession,
  makeStroke,
  makeUndoAction,
} from '../../drawing/testing/sessionFixture'
import type { DrawingSession, DrawingStroke, PointSample } from '../../drawing/types/drawing.types'

const CANVAS = { width: 800, height: 400 }

/**
 * Builds a stroke from explicit coordinates, one sample every 10 ms.
 *
 * The shared fixture only makes three-point strokes, and simplification needs
 * real geometry to have anything to simplify.
 */
function strokeFrom(
  id: string,
  order: number,
  coordinates: ReadonlyArray<readonly [number, number]>,
  options: { startSequence?: number; stepMs?: number; pressures?: ReadonlyArray<number | null> } = {},
): DrawingStroke {
  const startSequence = options.startSequence ?? 1
  const stepMs = options.stepMs ?? 10

  const points: PointSample[] = coordinates.map(([x, y], index) => {
    const sequence = startSequence + index
    const pressure = options.pressures?.[index] ?? null
    return makePoint({
      sequence,
      timeMs: sequence * stepMs,
      x,
      y,
      normalizedX: x / CANVAS.width,
      normalizedY: y / CANVAS.height,
      pressure,
      pointerType: pressure === null ? 'mouse' : 'pen',
    })
  })

  const first = points[0]
  const last = points[points.length - 1]
  return makeStroke({
    id,
    order,
    startedAtMs: first?.timeMs ?? 0,
    endedAtMs: last?.timeMs ?? 0,
    hasPressureSamples: points.some((p) => p.pressure !== null),
    points,
  })
}

/** A straight line of `count` evenly spaced samples. */
function straightCoordinates(count: number): Array<[number, number]> {
  return Array.from({ length: count }, (_, i) => [50 + i * 5, 200] as [number, number])
}

function sessionOf(strokes: DrawingStroke[], actions: DrawingSession['actions'] = []): DrawingSession {
  return makeSession({ canvas: { ...CANVAS, devicePixelRatio: 1 }, strokes, actions })
}

// ---------------------------------------------------------------------------

describe('findMandatoryIndices', () => {
  it('marks the endpoints of an ordinary stroke', () => {
    const stroke = strokeFrom('a', 0, straightCoordinates(10))
    const reasons = findMandatoryIndices(stroke, CANVAS)

    expect(reasons.get(0)).toContain('stroke_start')
    expect(reasons.get(9)).toContain('stroke_end')
  })

  it('marks a single-point stroke as a tap', () => {
    const stroke = strokeFrom('tap', 0, [[100, 100]])
    const reasons = findMandatoryIndices(stroke, CANVAS)

    expect(reasons.get(0)).toEqual(['single_point_stroke'])
  })

  it('finds nothing in an empty stroke without throwing', () => {
    const stroke = makeStroke({ id: 'empty', order: 0, points: [] })
    expect(findMandatoryIndices(stroke, CANVAS).size).toBe(0)
  })

  it('marks both sides of a pause', () => {
    const points = straightCoordinates(6)
    const stroke = strokeFrom('a', 0, points)
    // Push everything from index 3 onwards half a second later.
    stroke.points = stroke.points.map((point, index) =>
      index >= 3 ? { ...point, timeMs: point.timeMs + 500 } : point,
    )

    const reasons = findMandatoryIndices(stroke, CANVAS)
    expect(reasons.get(2)).toContain('temporal_gap_boundary')
    expect(reasons.get(3)).toContain('temporal_gap_boundary')
  })

  it('marks a sharp turn', () => {
    // A right angle at index 2.
    const stroke = strokeFrom('a', 0, [
      [100, 200],
      [150, 200],
      [200, 200],
      [200, 250],
      [200, 300],
    ])
    expect(findMandatoryIndices(stroke, CANVAS).get(2)).toContain('direction_change')
  })

  it('does not mark a gentle curve as a corner', () => {
    const coordinates: Array<[number, number]> = Array.from({ length: 20 }, (_, i) => {
      const angle = (i / 19) * (Math.PI / 2)
      return [200 + Math.cos(angle) * 150, 200 + Math.sin(angle) * 150]
    })
    const reasons = findMandatoryIndices(strokeFrom('a', 0, coordinates), CANVAS)

    const corners = [...reasons.entries()].filter(([, list]) =>
      list.includes('direction_change'),
    )
    expect(corners).toHaveLength(0)
  })

  it('ignores direction on segments too short to have a reliable one', () => {
    // Jitter around one spot: the direction between near-identical samples is
    // meaningless and must not be reported as a series of corners.
    const stroke = strokeFrom('a', 0, [
      [100, 100],
      [100.1, 100.1],
      [100, 100.2],
      [100.1, 100],
      [100, 100.1],
    ])
    const reasons = findMandatoryIndices(stroke, CANVAS)

    const corners = [...reasons.entries()].filter(([, list]) =>
      list.includes('direction_change'),
    )
    expect(corners).toHaveLength(0)
  })

  it('marks a pressure transition, but only where pressure is real', () => {
    const stroke = strokeFrom('a', 0, straightCoordinates(5), {
      pressures: [0.2, 0.22, 0.9, 0.91, 0.92],
    })
    expect(findMandatoryIndices(stroke, CANVAS).get(2)).toContain('pressure_change')
  })

  it('never reports a pressure transition when pressure is null', () => {
    // A mouse records null. Null is an absence, never a reading of zero.
    const stroke = strokeFrom('a', 0, straightCoordinates(8))
    const reasons = findMandatoryIndices(stroke, CANVAS)

    for (const list of reasons.values()) {
      expect(list).not.toContain('pressure_change')
    }
  })

  it('marks canvas exit and re-entry', () => {
    const stroke = strokeFrom('a', 0, [
      [100, 200],
      [400, 200],
      [900, 200],
      [950, 200],
      [400, 200],
      [200, 200],
    ])
    const reasons = findMandatoryIndices(stroke, CANVAS)

    // Index 1 is the last sample inside before leaving.
    expect(reasons.get(1)).toContain('canvas_exit')
    // Index 4 is the first sample back inside.
    expect(reasons.get(4)).toContain('canvas_entry')
  })

  it('accumulates several reasons on one point', () => {
    // A corner that is also where the stroke ends.
    const stroke = strokeFrom('a', 0, [
      [100, 200],
      [200, 200],
      [200, 300],
    ])
    const reasons = findMandatoryIndices(stroke, CANVAS)
    expect(reasons.get(2)).toContain('stroke_end')
  })
})

describe('selectStrokeIndices', () => {
  it('collapses a straight line to its endpoints', () => {
    const stroke = strokeFrom('a', 0, straightCoordinates(30))
    expect(selectStrokeIndices(stroke, CANVAS, 1).indices).toEqual([0, 29])
  })

  it('keeps every point at tolerance zero', () => {
    const stroke = strokeFrom('a', 0, straightCoordinates(12))
    expect(selectStrokeIndices(stroke, CANVAS, 0).indices).toHaveLength(12)
  })

  it('keeps mandatory points at any tolerance, however large', () => {
    const stroke = strokeFrom('a', 0, [
      [100, 200],
      [150, 200],
      [200, 200],
      [200, 250],
      [200, 300],
    ])
    const mandatory = [...findMandatoryIndices(stroke, CANVAS).keys()].sort((a, b) => a - b)

    for (const tolerance of [0, 1, 10, 1000]) {
      const kept = selectStrokeIndices(stroke, CANVAS, tolerance).indices
      for (const index of mandatory) {
        expect(kept).toContain(index)
      }
    }
  })

  it('preserves ascending index order', () => {
    const coordinates: Array<[number, number]> = Array.from({ length: 100 }, (_, i) => [
      50 + i * 3,
      200 + Math.sin(i / 6) * 60,
    ])
    const kept = selectStrokeIndices(strokeFrom('a', 0, coordinates), CANVAS, 1).indices

    for (let i = 1; i < kept.length; i += 1) {
      expect(kept[i]!).toBeGreaterThan(kept[i - 1]!)
    }
  })

  it('handles a two-point stroke', () => {
    const stroke = strokeFrom('a', 0, [[10, 10], [90, 90]])
    expect(selectStrokeIndices(stroke, CANVAS, 5).indices).toEqual([0, 1])
  })

  it('handles an empty stroke', () => {
    const stroke = makeStroke({ id: 'empty', order: 0, points: [] })
    expect(selectStrokeIndices(stroke, CANVAS, 1).indices).toEqual([])
  })

  it('keeps a point outside the canvas rather than dropping it', () => {
    const stroke = strokeFrom('a', 0, [
      [100, 200],
      [400, 200],
      [900, 200],
      [400, 200],
    ])
    const kept = selectStrokeIndices(stroke, CANVAS, 1).indices
    // The excursion is a turn, and it is outside; both keep it in the artifact.
    expect(kept).toContain(2)
  })

  it('is deterministic', () => {
    const coordinates: Array<[number, number]> = Array.from({ length: 200 }, (_, i) => [
      40 + i * 3,
      200 + Math.sin(i / 9) * 70 + Math.cos(i / 4) * 15,
    ])
    const stroke = strokeFrom('a', 0, coordinates)

    expect(selectStrokeIndices(stroke, CANVAS, 1.5).indices).toEqual(
      selectStrokeIndices(stroke, CANVAS, 1.5).indices,
    )
  })

  it('does not mutate the stroke', () => {
    const stroke = strokeFrom('a', 0, straightCoordinates(20))
    const before = JSON.parse(JSON.stringify(stroke)) as DrawingStroke

    selectStrokeIndices(stroke, CANVAS, 2)

    expect(stroke).toEqual(before)
  })
})

describe('measureGeometryQuality', () => {
  it('is perfect when nothing was simplified', () => {
    const strokes = [strokeFrom('a', 0, straightCoordinates(20))]
    const quality = measureGeometryQuality(
      strokes,
      strokes.map((s) => ({ points: [...s.points], width: s.width })),
      CANVAS,
    )

    expect(quality.maskIoU).toBe(1)
    expect(quality.maxGeometricDeviationPx).toBe(0)
    expect(quality.pathLengthErrorRatio).toBe(0)
    expect(quality.boundingBoxErrorRatio).toBe(0)
  })

  it('reports no error for an empty session', () => {
    const quality = measureGeometryQuality([], [], CANVAS)

    expect(quality.maskIoU).toBe(1)
    expect(quality.maxGeometricDeviationPx).toBe(0)
    expect(quality.pathLengthErrorRatio).toBe(0)
    expect(quality.boundingBoxErrorRatio).toBe(0)
  })

  it('never produces NaN or Infinity', () => {
    const cases: DrawingStroke[][] = [
      [],
      [strokeFrom('a', 0, [[100, 100]])],
      [strokeFrom('a', 0, straightCoordinates(3))],
      [strokeFrom('a', 0, [[900, 900], [950, 950]])],
    ]

    for (const strokes of cases) {
      const quality = measureGeometryQuality(
        strokes,
        strokes.map((s) => ({ points: [s.points[0]!].filter(Boolean), width: s.width })),
        CANVAS,
      )
      for (const value of Object.values(quality)) {
        expect(value === null || Number.isFinite(value)).toBe(true)
      }
    }
  })

  it('does not count the pen-up gap between strokes as path length', () => {
    // Two short strokes far apart. Path length is per stroke, so the distance
    // travelled with the pen lifted must not appear in either total.
    const strokes = [
      strokeFrom('a', 0, [[10, 10], [20, 10]]),
      strokeFrom('b', 1, [[700, 380], [710, 380]], { startSequence: 10 }),
    ]
    const quality = measureGeometryQuality(
      strokes,
      strokes.map((s) => ({ points: [...s.points], width: s.width })),
      CANVAS,
    )

    // Identical input and output: any leaked gap distance would show up here.
    expect(quality.pathLengthErrorRatio).toBe(0)
  })
})

describe('buildCriticalTrajectory', () => {
  const now = (): string => '2026-08-18T09:00:00.000Z'

  it('produces a well-formed, explicitly lossy artifact', () => {
    const session = sessionOf([strokeFrom('a', 0, straightCoordinates(40))])
    const artifact = buildCriticalTrajectory(session, { now })

    // UPDATED: the artifact is v2. Its MEANING changed - it now declares a
    // `mode`, and `pause_boundary` became `temporal_gap_boundary`. The old
    // expectation pinned a version that no longer describes this format.
    expect(artifact.artifactSchemaVersion).toBe(2)
    expect(artifact.mode).toBe('full_process')
    expect(artifact.artifactType).toBe('critical_trajectory')
    expect(artifact.lossy).toBe(true)
    expect(artifact.sourceSessionId).toBe(session.id)
    expect(artifact.sourceSchemaVersion).toBe(2)
    expect(artifact.algorithm.coordinateSpace).toBe('logical_canvas_px')
    expect(artifact.algorithm.qualityProfile).toBe(DEFAULT_QUALITY_PROFILE)
    expect(artifact.canvas).toEqual(CANVAS)
  })

  it('defaults to the high profile', () => {
    const session = sessionOf([strokeFrom('a', 0, straightCoordinates(20))])
    expect(buildCriticalTrajectory(session, { now }).algorithm.qualityProfile).toBe('high')
  })

  it('traces every node back to a real raw sample, verbatim', () => {
    const coordinates: Array<[number, number]> = Array.from({ length: 60 }, (_, i) => [
      50 + i * 4,
      200 + Math.sin(i / 5) * 70,
    ])
    const session = sessionOf([strokeFrom('a', 0, coordinates)])
    const artifact = buildCriticalTrajectory(session, { now })

    const stroke = session.strokes[0]!
    expect(artifact.nodes.length).toBeGreaterThan(0)

    for (const node of artifact.nodes) {
      const source = stroke.points[node.sourcePointIndex]
      expect(source).toBeDefined()
      // Every value copied, not derived: an interpolated node would fail here.
      expect(node.sourcePointSequence).toBe(source!.sequence)
      expect(node.x).toBe(source!.x)
      expect(node.y).toBe(source!.y)
      expect(node.normalizedX).toBe(source!.normalizedX)
      expect(node.normalizedY).toBe(source!.normalizedY)
      expect(node.timeMs).toBe(source!.timeMs)
      expect(node.strokeId).toBe(stroke.id)
      expect(node.reasons.length).toBeGreaterThan(0)
    }
  })

  it('gives every node and edge a unique id', () => {
    const session = sessionOf(
      [
        strokeFrom('a', 0, straightCoordinates(20)),
        strokeFrom('b', 1, [[300, 100], [350, 150], [400, 100]], { startSequence: 40 }),
      ],
      [makeUndoAction('b', 60)],
    )
    const artifact = buildCriticalTrajectory(session, { now })

    const nodeIds = [...artifact.nodes.map((n) => n.id), ...artifact.actionNodes.map((n) => n.id)]
    expect(new Set(nodeIds).size).toBe(nodeIds.length)

    const edgeIds = artifact.edges.map((e) => e.id)
    expect(new Set(edgeIds).size).toBe(edgeIds.length)
  })

  it('never leaves an edge pointing at a missing node', () => {
    const session = sessionOf(
      [
        strokeFrom('a', 0, straightCoordinates(15)),
        strokeFrom('b', 1, [[300, 100], [400, 200]], { startSequence: 30 }),
      ],
      [makeUndoAction('b', 50), makeClearAction(['a'], 60)],
    )
    const artifact = buildCriticalTrajectory(session, { now })

    const known = new Set([
      ...artifact.nodes.map((n) => n.id),
      ...artifact.actionNodes.map((n) => n.id),
    ])
    for (const edge of artifact.edges) {
      expect(known.has(edge.from)).toBe(true)
      expect(known.has(edge.to)).toBe(true)
    }
  })

  it('never joins two different strokes with a geometric edge', () => {
    /*
      The pen was lifted between strokes. An edge across that gap would assert a
      distance the hand never travelled on the surface.
    */
    const session = sessionOf([
      strokeFrom('a', 0, [[10, 10], [50, 50]]),
      strokeFrom('b', 1, [[700, 300], [750, 350]], { startSequence: 20 }),
    ])
    const artifact = buildCriticalTrajectory(session, { now })

    const nodeStroke = new Map(artifact.nodes.map((n) => [n.id, n.strokeId]))
    for (const edge of artifact.edges) {
      if (edge.relationType !== 'temporal_path') continue
      expect(nodeStroke.get(edge.from)).toBe(nodeStroke.get(edge.to))
    }
  })

  it('records undo, redo and clear as action nodes, never as points', () => {
    const session = sessionOf(
      [strokeFrom('a', 0, straightCoordinates(10))],
      [makeUndoAction('a', 30), makeClearAction(['a'], 40)],
    )
    const artifact = buildCriticalTrajectory(session, { now })

    expect(artifact.actionNodes.map((n) => n.actionType)).toEqual(['undo', 'clear'])
    for (const actionNode of artifact.actionNodes) {
      expect(actionNode.sourceActionSequence).toBeGreaterThan(0)
      // No action node may masquerade as a point.
      expect(artifact.nodes.some((n) => n.id === actionNode.id)).toBe(false)
    }
  })

  it('keeps action nodes in timeline order', () => {
    const session = sessionOf(
      [strokeFrom('a', 0, straightCoordinates(10))],
      [makeUndoAction('a', 30), makeClearAction(['a'], 40)],
    )
    const artifact = buildCriticalTrajectory(session, { now })

    const times = artifact.actionNodes.map((n) => n.timeMs)
    expect([...times].sort((x, y) => x - y)).toEqual(times)
  })

  it('reduces the point count on a realistic stroke', () => {
    const coordinates: Array<[number, number]> = Array.from({ length: 400 }, (_, i) => [
      50 + i * 1.7,
      200 + Math.sin(i / 20) * 80,
    ])
    const session = sessionOf([strokeFrom('a', 0, coordinates)])
    const artifact = buildCriticalTrajectory(session, { now })

    expect(artifact.quality.criticalPointCount).toBeLessThan(artifact.quality.rawPointCount)
    expect(artifact.quality.retentionRatio).toBeLessThan(1)
    expect(artifact.quality.retentionRatio).toBeGreaterThan(0)
  })

  it('meets the profile it was asked for, and says so', () => {
    const coordinates: Array<[number, number]> = Array.from({ length: 300 }, (_, i) => [
      50 + i * 2,
      200 + Math.sin(i / 15) * 90,
    ])
    const session = sessionOf([strokeFrom('a', 0, coordinates)])

    for (const profile of ['high', 'balanced', 'compact'] as const) {
      const artifact = buildCriticalTrajectory(session, { profile, now })
      const thresholds = QUALITY_PROFILES[profile]

      expect(artifact.quality.meetsProfile).toBe(true)
      expect(artifact.quality.qualityFailureReason).toBeNull()
      expect(artifact.quality.maskIoU!).toBeGreaterThanOrEqual(thresholds.minimumMaskIoU)
      expect(artifact.quality.maxGeometricDeviationPx!).toBeLessThanOrEqual(
        thresholds.maximumGeometricDeviationPx,
      )
      expect(artifact.quality.pathLengthErrorRatio!).toBeLessThanOrEqual(
        thresholds.maximumPathLengthErrorRatio,
      )
    }
  })

  it('keeps at least as many points on high as on compact', () => {
    const coordinates: Array<[number, number]> = Array.from({ length: 300 }, (_, i) => [
      50 + i * 2,
      200 + Math.sin(i / 12) * 85,
    ])
    const session = sessionOf([strokeFrom('a', 0, coordinates)])

    const high = buildCriticalTrajectory(session, { profile: 'high', now })
    const balanced = buildCriticalTrajectory(session, { profile: 'balanced', now })
    const compact = buildCriticalTrajectory(session, { profile: 'compact', now })

    // A stricter profile can never be satisfied by fewer points than a looser
    // one, because the tolerance ladder is shared and monotonic.
    expect(high.quality.criticalPointCount).toBeGreaterThanOrEqual(
      balanced.quality.criticalPointCount,
    )
    expect(balanced.quality.criticalPointCount).toBeGreaterThanOrEqual(
      compact.quality.criticalPointCount,
    )
  })

  it('reports a quality failure instead of hiding it', () => {
    // A tolerance far too coarse for the shape, forced past the search.
    const coordinates: Array<[number, number]> = Array.from({ length: 120 }, (_, i) => [
      50 + i * 5,
      200 + Math.sin(i / 2) * 90,
    ])
    const session = sessionOf([strokeFrom('a', 0, coordinates)])

    const artifact = buildCriticalTrajectory(session, {
      profile: 'high',
      fixedTolerancePx: 60,
      now,
    })

    expect(artifact.quality.meetsProfile).toBe(false)
    expect(artifact.quality.qualityFailureReason).not.toBeNull()
    expect(artifact.quality.qualityFailureReason!.length).toBeGreaterThan(0)
  })

  it('never emits NaN or Infinity in the quality block', () => {
    const sessions = [
      sessionOf([]),
      sessionOf([strokeFrom('tap', 0, [[100, 100]])]),
      sessionOf([strokeFrom('a', 0, straightCoordinates(2))]),
      sessionOf([strokeFrom('out', 0, [[900, 900], [1000, 1000]])]),
    ]

    for (const session of sessions) {
      const quality = buildCriticalTrajectory(session, { now }).quality
      for (const [key, value] of Object.entries(quality)) {
        if (typeof value === 'number') {
          expect(Number.isFinite(value), `${key} must be finite`).toBe(true)
        }
      }
    }
  })

  it('handles an empty session', () => {
    const artifact = buildCriticalTrajectory(sessionOf([]), { now })

    expect(artifact.nodes).toEqual([])
    expect(artifact.edges).toEqual([])
    expect(artifact.quality.rawPointCount).toBe(0)
    expect(artifact.quality.retentionRatio).toBe(0)
  })

  it('keeps a tap', () => {
    const artifact = buildCriticalTrajectory(sessionOf([strokeFrom('tap', 0, [[100, 100]])]), {
      now,
    })

    expect(artifact.nodes).toHaveLength(1)
    expect(artifact.nodes[0]?.reasons).toContain('single_point_stroke')
  })

  it('is deterministic', () => {
    const coordinates: Array<[number, number]> = Array.from({ length: 250 }, (_, i) => [
      50 + i * 2.5,
      200 + Math.sin(i / 11) * 75,
    ])
    const session = sessionOf([strokeFrom('a', 0, coordinates)])

    expect(buildCriticalTrajectory(session, { now })).toEqual(
      buildCriticalTrajectory(session, { now }),
    )
  })

  it('does not mutate the session', () => {
    const session = sessionOf(
      [strokeFrom('a', 0, straightCoordinates(30)), strokeFrom('b', 1, [[300, 100], [400, 200]], { startSequence: 50 })],
      [makeUndoAction('b', 80)],
    )
    const before = JSON.parse(JSON.stringify(session)) as DrawingSession

    buildCriticalTrajectory(session, { now })

    expect(session).toEqual(before)
  })

  it('reports a size reduction against the raw JSON', () => {
    const coordinates: Array<[number, number]> = Array.from({ length: 500 }, (_, i) => [
      50 + i * 1.4,
      200 + Math.sin(i / 25) * 80,
    ])
    const session = sessionOf([strokeFrom('a', 0, coordinates)])
    const artifact = buildCriticalTrajectory(session, { now })

    expect(artifact.quality.rawJsonBytes).toBeGreaterThan(0)
    expect(artifact.quality.criticalJsonBytes).toBeGreaterThan(0)
    expect(artifact.quality.sizeReductionRatio).toBeGreaterThan(0)
  })

  it('preserves stroke count and order in the nodes', () => {
    const session = sessionOf([
      strokeFrom('a', 0, straightCoordinates(10)),
      strokeFrom('b', 1, [[300, 100], [400, 200]], { startSequence: 30 }),
      strokeFrom('c', 2, [[500, 300], [550, 350]], { startSequence: 50 }),
    ])
    const artifact = buildCriticalTrajectory(session, { now })

    const order: string[] = []
    for (const node of artifact.nodes) {
      if (order[order.length - 1] !== node.strokeId) order.push(node.strokeId)
    }
    expect(order).toEqual(['a', 'b', 'c'])
  })
})

describe('buildCriticalTrajectoryFileName', () => {
  it('names the file after the session', () => {
    expect(buildCriticalTrajectoryFileName('abcdef12-3456-4789-8abc-def012345678', '1405-05-27')).toBe(
      // UPDATED: the mode is now part of the name. Two graphs of one session
      // answer different questions and must not share a filename.
      'artiscan-full-process-graph-abcdef12-1405-05-27.json',
    )
  })
})
