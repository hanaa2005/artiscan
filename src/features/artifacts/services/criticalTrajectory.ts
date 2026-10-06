/**
 * Building the critical trajectory.
 *
 * THE SHAPE OF THE ALGORITHM
 *
 *   1. Find the MANDATORY points of each stroke - the ones whose removal would
 *      destroy evidence rather than redundancy (endpoints, taps, pause
 *      boundaries, sharp turns, pressure transitions, canvas crossings).
 *   2. Run RDP on each SPAN BETWEEN consecutive mandatory points, so geometric
 *      simplification can never delete a mandatory point and can never smooth
 *      across one.
 *   3. Measure what that cost - coverage, deviation, path length, bounding box.
 *   4. If the requested quality profile was not met, keep more points and try
 *      again. Quality is never traded away for size.
 *
 * WHY STEP 2 IS PER-SPAN
 *
 * Running RDP over a whole stroke and then adding the mandatory points back
 * would let RDP choose support points on the assumption that a corner was
 * absent, and the result depends on the order the two sets are merged in.
 * Simplifying each span independently makes the mandatory points structural:
 * the output is the same however the spans are traversed.
 *
 * PURITY
 *
 * Nothing here mutates the session. Every coordinate, timestamp and sequence in
 * the output is copied from a real sample; no point is interpolated or
 * invented.
 */

import type {
  DrawingAction,
  DrawingSession,
  DrawingStroke,
  PointSample,
} from '../../drawing/types/drawing.types'
import { nowIsoTimestamp } from '../../drawing/utils/timing'
import { computeStrokeStatuses } from '../../drawing/utils/strokeVisibility'
import { serializeSession } from '../../drawing/services/drawingSerializer'
import {
  maxDeviationFromPolyline,
  polylineLength,
  simplifyRdpIndices,
  type Point2D,
} from '../utils/rdp'
import { MASK_RENDERER_VERSION, maskIoU, rasterizeStrokes } from '../utils/rasterMask'
import {
  CRITICAL_TRAJECTORY_ALGORITHM_NAME,
  CRITICAL_TRAJECTORY_ALGORITHM_VERSION,
  CRITICAL_TRAJECTORY_SCHEMA_VERSION,
  type CriticalActionNode,
  type CriticalEdge,
  type CriticalNode,
  type CriticalPointReason,
  type CriticalStrokeSummary,
  type CriticalTrajectoryArtifactV2,
  type GraphMode,
  type QualityProfileName,
  type QualityThresholds,
} from '../types/criticalTrajectory.types'

// ---------------------------------------------------------------------------
// Thresholds. All stated, all versioned with the algorithm.
// ---------------------------------------------------------------------------

/**
 * A gap between consecutive samples wider than this forces a kept point on both
 * sides, so simplification cannot smooth the recording's temporal structure away.
 *
 * DELIBERATELY NOT CALLED A PAUSE.
 *
 * The project's pause policy is PAUSE_THRESHOLD_MS = 500 in feature extraction,
 * and it measures something else entirely: the pen-up time BETWEEN strokes. This
 * threshold is 120 ms between consecutive samples INSIDE one stroke - a fourth
 * of that, and while the pen is still down. Calling a 120 ms gap a pause would
 * assert a finding on evidence far weaker than the pause definition requires,
 * which is why artifact v1's `pause_boundary` was renamed.
 *
 * INITIAL ENGINEERING THRESHOLD, not a validated constant. At typical sampling
 * rates a sample arrives every 4-16 ms, so 120 ms is roughly an order of
 * magnitude beyond normal spacing.
 */
export const TEMPORAL_GAP_BOUNDARY_MS = 120

/**
 * A turn sharper than this is a corner rather than a curve.
 *
 * INITIAL ENGINEERING THRESHOLD. Measured as the angle between the incoming and
 * outgoing segment directions, so 0 is straight ahead and 180 is a full
 * reversal.
 */
export const DIRECTION_CHANGE_DEGREES = 45

/**
 * A pressure move this large between consecutive samples is a transition.
 *
 * INITIAL ENGINEERING THRESHOLD, on the 0..1 pressure scale. Only ever applies
 * where both samples carry REAL pressure - a mouse records null, and null is
 * never treated as a reading.
 */
export const PRESSURE_CHANGE_DELTA = 0.25

/**
 * Segments shorter than this are ignored when measuring a direction change.
 *
 * Two nearly coincident samples produce a wildly unstable direction, so without
 * this the jitter of a stationary pointer would be reported as a series of
 * sharp corners.
 */
const MIN_DIRECTION_SEGMENT_PX = 0.75

/** The accuracy each profile requires. See the type for the "initial" caveat. */
export const QUALITY_PROFILES: Record<QualityProfileName, QualityThresholds> = {
  high: {
    minimumMaskIoU: 0.98,
    maximumGeometricDeviationPx: 1.5,
    maximumPathLengthErrorRatio: 0.02,
    maximumBoundingBoxErrorRatio: 0.01,
  },
  balanced: {
    minimumMaskIoU: 0.95,
    maximumGeometricDeviationPx: 3,
    maximumPathLengthErrorRatio: 0.05,
    maximumBoundingBoxErrorRatio: 0.02,
  },
  compact: {
    minimumMaskIoU: 0.9,
    maximumGeometricDeviationPx: 6,
    maximumPathLengthErrorRatio: 0.1,
    maximumBoundingBoxErrorRatio: 0.04,
  },
}

export const DEFAULT_QUALITY_PROFILE: QualityProfileName = 'high'

/**
 * Tolerances the search may choose from, coarsest first.
 *
 * A fixed ladder rather than a continuous search: the result must be
 * reproducible, and a bisection on floating point would make the chosen
 * tolerance depend on rounding. The largest tolerance that still meets the
 * profile wins, so the artifact is the smallest one of adequate quality.
 */
const TOLERANCE_LADDER = [4, 3, 2.5, 2, 1.5, 1.25, 1, 0.75, 0.5, 0.35, 0.25, 0.15, 0.1, 0]

// ---------------------------------------------------------------------------
// Mandatory point detection
// ---------------------------------------------------------------------------

function isInsideCanvas(point: PointSample, width: number, height: number): boolean {
  return point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height
}

/** The angle in degrees between the incoming and outgoing directions at `i`. */
function turnAngleDegrees(points: readonly PointSample[], i: number): number | null {
  const previous = points[i - 1]
  const current = points[i]
  const next = points[i + 1]
  if (previous === undefined || current === undefined || next === undefined) return null

  const inX = current.x - previous.x
  const inY = current.y - previous.y
  const outX = next.x - current.x
  const outY = next.y - current.y

  const inLength = Math.hypot(inX, inY)
  const outLength = Math.hypot(outX, outY)
  // Too short to have a reliable direction - see MIN_DIRECTION_SEGMENT_PX.
  if (inLength < MIN_DIRECTION_SEGMENT_PX || outLength < MIN_DIRECTION_SEGMENT_PX) return null

  const cosine = (inX * outX + inY * outY) / (inLength * outLength)
  // Guard the domain: rounding can push this a hair outside [-1, 1].
  const clamped = Math.min(1, Math.max(-1, cosine))
  return (Math.acos(clamped) * 180) / Math.PI
}

/**
 * Every index of `stroke` that must survive simplification, with its reasons.
 *
 * Returned as a map so several reasons can accumulate on one point - a stroke
 * that ends right after a sharp turn should say both.
 */
export function findMandatoryIndices(
  stroke: DrawingStroke,
  canvas: { width: number; height: number },
): Map<number, CriticalPointReason[]> {
  const points = stroke.points
  const reasons = new Map<number, CriticalPointReason[]>()

  const add = (index: number, reason: CriticalPointReason): void => {
    const existing = reasons.get(index)
    if (existing === undefined) {
      reasons.set(index, [reason])
    } else if (!existing.includes(reason)) {
      existing.push(reason)
    }
  }

  if (points.length === 0) return reasons

  if (points.length === 1) {
    // A tap is an observation in its own right and can never be dropped.
    add(0, 'single_point_stroke')
    return reasons
  }

  add(0, 'stroke_start')
  add(points.length - 1, 'stroke_end')

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]
    if (current === undefined) continue

    // --- pause boundaries: both sides of the gap ---------------------------
    const previous = points[i - 1]
    if (previous !== undefined && current.timeMs - previous.timeMs > TEMPORAL_GAP_BOUNDARY_MS) {
      add(i - 1, 'temporal_gap_boundary')
      add(i, 'temporal_gap_boundary')
    }

    // --- sharp turns -------------------------------------------------------
    const angle = turnAngleDegrees(points, i)
    if (angle !== null && angle >= DIRECTION_CHANGE_DEGREES) {
      add(i, 'direction_change')
    }

    // --- pressure transitions, only where pressure is real -----------------
    if (
      previous !== undefined &&
      previous.pressure !== null &&
      current.pressure !== null &&
      Math.abs(current.pressure - previous.pressure) >= PRESSURE_CHANGE_DELTA
    ) {
      add(i, 'pressure_change')
    }

    // --- canvas crossings --------------------------------------------------
    const inside = isInsideCanvas(current, canvas.width, canvas.height)
    if (previous !== undefined) {
      const wasInside = isInsideCanvas(previous, canvas.width, canvas.height)
      if (inside && !wasInside) add(i, 'canvas_entry')
      if (!inside && wasInside) add(i - 1, 'canvas_exit')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// Simplification
// ---------------------------------------------------------------------------

/**
 * Indices kept for one stroke at a given tolerance: the mandatory points plus
 * whatever RDP needs between them.
 */
export function selectStrokeIndices(
  stroke: DrawingStroke,
  canvas: { width: number; height: number },
  tolerancePx: number,
): { indices: number[]; reasons: Map<number, CriticalPointReason[]> } {
  const points = stroke.points
  const reasons = findMandatoryIndices(stroke, canvas)
  if (points.length === 0) return { indices: [], reasons }

  const mandatory = [...reasons.keys()].sort((a, b) => a - b)
  const kept = new Set<number>(mandatory)

  // Simplify each span BETWEEN mandatory points independently, so no mandatory
  // point can be smoothed over and the result does not depend on merge order.
  for (let m = 0; m + 1 < mandatory.length; m += 1) {
    const from = mandatory[m]
    const to = mandatory[m + 1]
    if (from === undefined || to === undefined) continue
    if (to <= from + 1) continue

    const span: Point2D[] = []
    for (let i = from; i <= to; i += 1) {
      const point = points[i]
      if (point === undefined) continue
      span.push({ x: point.x, y: point.y })
    }

    for (const localIndex of simplifyRdpIndices(span, tolerancePx)) {
      const absolute = from + localIndex
      if (!kept.has(absolute)) {
        kept.add(absolute)
        reasons.set(absolute, ['geometric_support'])
      }
    }
  }

  return { indices: [...kept].sort((a, b) => a - b), reasons }
}

/** The points of a stroke as plain 2D coordinates. */
function toPoint2D(points: readonly PointSample[]): Point2D[] {
  return points.map((point) => ({ x: point.x, y: point.y }))
}

interface BoundingBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function boundingBoxOf(points: readonly Point2D[]): BoundingBox | null {
  if (points.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  return { minX, minY, maxX, maxY }
}

// ---------------------------------------------------------------------------
// Quality measurement
// ---------------------------------------------------------------------------

export interface GeometryQuality {
  maskIoU: number | null
  maxGeometricDeviationPx: number | null
  pathLengthErrorRatio: number | null
  boundingBoxErrorRatio: number | null
}

/**
 * Compares a simplification against the raw strokes it came from.
 *
 * All four measures are reported together on purpose: coverage alone can hide a
 * single badly placed point, and deviation alone says nothing about whether the
 * overall extent survived.
 */
export function measureGeometryQuality(
  rawStrokes: readonly DrawingStroke[],
  simplified: ReadonlyArray<{ points: PointSample[]; width: number }>,
  canvas: { width: number; height: number },
): GeometryQuality {
  const rawPoints: Point2D[] = []
  const simplifiedPoints: Point2D[] = []
  let rawLength = 0
  let simplifiedLength = 0
  let worstDeviation = 0

  for (let s = 0; s < rawStrokes.length; s += 1) {
    const raw = rawStrokes[s]
    const simple = simplified[s]
    if (raw === undefined || simple === undefined) continue

    const rawXY = toPoint2D(raw.points)
    const simpleXY = toPoint2D(simple.points)
    rawPoints.push(...rawXY)
    simplifiedPoints.push(...simpleXY)

    // Path length is summed PER STROKE so the pen-up distance between strokes
    // is never counted as travel.
    rawLength += polylineLength(rawXY)
    simplifiedLength += polylineLength(simpleXY)

    worstDeviation = Math.max(worstDeviation, maxDeviationFromPolyline(rawXY, simpleXY))
  }

  const rawMask = rasterizeStrokes(
    rawStrokes.map((stroke) => ({ points: toPoint2D(stroke.points), width: stroke.width })),
    canvas,
  )
  const simplifiedMask = rasterizeStrokes(
    simplified.map((stroke) => ({ points: toPoint2D(stroke.points), width: stroke.width })),
    canvas,
  )

  const rawBox = boundingBoxOf(rawPoints)
  const simplifiedBox = boundingBoxOf(simplifiedPoints)

  let boundingBoxErrorRatio: number | null = null
  if (rawBox !== null && simplifiedBox !== null) {
    // Normalised by the canvas diagonal, so the number means the same thing on
    // any canvas size and can never divide by a zero-width box.
    const diagonal = Math.hypot(canvas.width, canvas.height)
    if (diagonal > 0) {
      const error = Math.max(
        Math.abs(rawBox.minX - simplifiedBox.minX),
        Math.abs(rawBox.minY - simplifiedBox.minY),
        Math.abs(rawBox.maxX - simplifiedBox.maxX),
        Math.abs(rawBox.maxY - simplifiedBox.maxY),
      )
      boundingBoxErrorRatio = error / diagonal
    }
  } else if (rawBox === null && simplifiedBox === null) {
    boundingBoxErrorRatio = 0
  }

  let pathLengthErrorRatio: number | null = null
  if (rawLength > 0) {
    pathLengthErrorRatio = Math.abs(rawLength - simplifiedLength) / rawLength
  } else if (simplifiedLength === 0) {
    // Nothing was drawn and nothing was reconstructed: no error, not a failure.
    pathLengthErrorRatio = 0
  }

  return {
    maskIoU: maskIoU(rawMask, simplifiedMask),
    maxGeometricDeviationPx: rawPoints.length === 0 ? 0 : worstDeviation,
    pathLengthErrorRatio,
    boundingBoxErrorRatio,
  }
}

/** True when every measured value satisfies the profile. */
function meetsThresholds(quality: GeometryQuality, thresholds: QualityThresholds): boolean {
  // A measurement that could not be taken is never counted as a pass.
  if (quality.maskIoU === null || quality.maskIoU < thresholds.minimumMaskIoU) return false
  if (
    quality.maxGeometricDeviationPx === null ||
    quality.maxGeometricDeviationPx > thresholds.maximumGeometricDeviationPx
  ) {
    return false
  }
  if (
    quality.pathLengthErrorRatio === null ||
    quality.pathLengthErrorRatio > thresholds.maximumPathLengthErrorRatio
  ) {
    return false
  }
  if (
    quality.boundingBoxErrorRatio === null ||
    quality.boundingBoxErrorRatio > thresholds.maximumBoundingBoxErrorRatio
  ) {
    return false
  }
  return true
}

/** Explains, in Persian, which measure fell short. */
function describeFailure(quality: GeometryQuality, thresholds: QualityThresholds): string {
  const parts: string[] = []
  if (quality.maskIoU === null || quality.maskIoU < thresholds.minimumMaskIoU) {
    parts.push(`هم‌پوشانی ماسک ${String(quality.maskIoU)} کمتر از حد ${String(thresholds.minimumMaskIoU)}`)
  }
  if (
    quality.maxGeometricDeviationPx === null ||
    quality.maxGeometricDeviationPx > thresholds.maximumGeometricDeviationPx
  ) {
    parts.push(
      `بیشترین انحراف هندسی ${String(quality.maxGeometricDeviationPx)} بیشتر از حد ${String(thresholds.maximumGeometricDeviationPx)}`,
    )
  }
  if (
    quality.pathLengthErrorRatio === null ||
    quality.pathLengthErrorRatio > thresholds.maximumPathLengthErrorRatio
  ) {
    parts.push(`خطای طول مسیر ${String(quality.pathLengthErrorRatio)} بیشتر از حد مجاز`)
  }
  if (
    quality.boundingBoxErrorRatio === null ||
    quality.boundingBoxErrorRatio > thresholds.maximumBoundingBoxErrorRatio
  ) {
    parts.push(`خطای کادر محیطی ${String(quality.boundingBoxErrorRatio)} بیشتر از حد مجاز`)
  }
  return parts.join('؛ ')
}

// ---------------------------------------------------------------------------
// Artifact assembly
// ---------------------------------------------------------------------------

interface Selection {
  tolerancePx: number
  perStroke: Array<{ indices: number[]; reasons: Map<number, CriticalPointReason[]> }>
  simplified: Array<{ points: PointSample[]; width: number }>
  quality: GeometryQuality
  pointCount: number
}

/** Applies one tolerance to every stroke and measures the result. */
function evaluateTolerance(
  session: DrawingSession,
  tolerancePx: number,
): Selection {
  const canvas = session.canvas
  const perStroke = session.strokes.map((stroke) =>
    selectStrokeIndices(stroke, canvas, tolerancePx),
  )

  const simplified = session.strokes.map((stroke, index) => {
    const selection = perStroke[index]
    const indices = selection?.indices ?? []
    return {
      // The ORIGINAL samples, selected - never copies with adjusted values.
      points: indices.map((i) => stroke.points[i]).filter((p): p is PointSample => p !== undefined),
      width: stroke.width,
    }
  })

  return {
    tolerancePx,
    perStroke,
    simplified,
    quality: measureGeometryQuality(session.strokes, simplified, canvas),
    pointCount: simplified.reduce((total, stroke) => total + stroke.points.length, 0),
  }
}

export interface BuildCriticalTrajectoryOptions {
  profile?: QualityProfileName
  /** Overrides the search. Mainly for tests and benchmarking. */
  fixedTolerancePx?: number
  /** Injectable for deterministic tests. */
  now?: () => string
  /**
   * Which slice of the recording to describe. Defaults to `full_process`,
   * which is what a v1 file always was.
   */
  mode?: GraphMode
}

/**
 * Builds the artifact for a session.
 *
 * The tolerance search walks the ladder from coarsest to finest and stops at
 * the FIRST tolerance that meets the profile - that is the largest one, and
 * therefore the fewest points, of adequate quality. If none does, the artifact
 * falls back to every point and reports the failure explicitly rather than
 * shipping a quietly degraded result.
 */
export function buildCriticalTrajectory(
  session: DrawingSession,
  options: BuildCriticalTrajectoryOptions = {},
): CriticalTrajectoryArtifactV2 {
  const profile = options.profile ?? DEFAULT_QUALITY_PROFILE
  const mode: GraphMode = options.mode ?? 'full_process'
  const thresholds = QUALITY_PROFILES[profile]

  /*
    Labels and statuses come from the FULL canonical history in both modes.

    Numbering only the strokes that survived would renumber the drawing every
    time an undo landed, and S02 in the final-visible graph would name a
    different stroke than S02 in the full-process one. Deriving both from the
    append-only order keeps the two graphs readable side by side.
  */
  const statuses = computeStrokeStatuses(session.strokes, session.actions)
  const included = new Set(
    session.strokes
      .filter((stroke) => mode === 'full_process' || statuses.get(stroke.id) === 'visible')
      .map((stroke) => stroke.id),
  )

  let chosen: Selection
  let failureReason: string | null = null

  if (options.fixedTolerancePx !== undefined) {
    chosen = evaluateTolerance(session, options.fixedTolerancePx)
    if (!meetsThresholds(chosen.quality, thresholds)) {
      failureReason = describeFailure(chosen.quality, thresholds)
    }
  } else {
    let best: Selection | null = null
    for (const tolerance of TOLERANCE_LADDER) {
      const candidate = evaluateTolerance(session, tolerance)
      if (meetsThresholds(candidate.quality, thresholds)) {
        best = candidate
        break
      }
      // Remember the finest attempt so a failure still reports real numbers.
      best = candidate
    }
    chosen = best ?? evaluateTolerance(session, 0)
    if (!meetsThresholds(chosen.quality, thresholds)) {
      /*
        Even keeping every point did not satisfy the profile. That is a real
        finding about the metric or the rasterization - most often a stroke
        thinner than one pixel, where centre sampling cannot cover the same
        pixels twice - and it is surfaced, never hidden.
      */
      failureReason = describeFailure(chosen.quality, thresholds)
    }
  }

  const nodes: CriticalNode[] = []
  const edges: CriticalEdge[] = []
  const strokeSummaries: CriticalStrokeSummary[] = []

  session.strokes.forEach((stroke, strokeIndex) => {
    const selection = chosen.perStroke[strokeIndex]
    if (selection === undefined) return
    if (!included.has(stroke.id)) return

    const strokeNodes: CriticalNode[] = []
    for (const pointIndex of selection.indices) {
      const point = stroke.points[pointIndex]
      if (point === undefined) continue

      const reasons = selection.reasons.get(pointIndex) ?? ['geometric_support']
      strokeNodes.push({
        id: `n-${String(strokeIndex)}-${String(pointIndex)}`,
        strokeId: stroke.id,
        sourcePointSequence: point.sequence,
        sourcePointIndex: pointIndex,
        x: point.x,
        y: point.y,
        normalizedX: point.normalizedX,
        normalizedY: point.normalizedY,
        timeMs: point.timeMs,
        // Stable order so the artifact is byte-reproducible.
        reasons: [...reasons].sort(),
      })
    }

    // Temporal edges WITHIN this stroke only. Nothing joins two strokes: the
    // pen was lifted, and a line there would be travel that never happened.
    for (let i = 1; i < strokeNodes.length; i += 1) {
      const from = strokeNodes[i - 1]
      const to = strokeNodes[i]
      if (from === undefined || to === undefined) continue

      const rawSpan = stroke.points.slice(from.sourcePointIndex, to.sourcePointIndex + 1)
      const directDistancePx = Math.hypot(to.x - from.x, to.y - from.y)

      edges.push({
        id: `e-${from.id}-${to.id}`,
        from: from.id,
        to: to.id,
        relationType: 'temporal_path',
        strokeId: stroke.id,
        durationMs: to.timeMs - from.timeMs,
        directDistancePx,
        sourcePathLengthPx: polylineLength(toPoint2D(rawSpan)),
        // Between two kept points the simplified path IS the straight line.
        simplifiedPathLengthPx: directDistancePx,
      })
    }

    const first = strokeNodes[0]
    const last = strokeNodes[strokeNodes.length - 1]
    strokeSummaries.push({
      strokeId: stroke.id,
      // The canonical index, so the label survives any later filtering.
      order: strokeIndex,
      label: buildStrokeLabel(strokeIndex),
      status: statuses.get(stroke.id) ?? 'visible',
      startNodeId: first?.id ?? null,
      endNodeId: last?.id ?? null,
      nodeCount: strokeNodes.length,
      sourcePointCount: stroke.points.length,
      tool: stroke.tool,
      color: stroke.color,
      width: stroke.width,
      startedAtMs: stroke.startedAtMs,
      // The stroke's OWN end time. Simplification can drop the final sample,
      // and rebuilding this from what survived would shorten the stroke.
      endedAtMs: stroke.endedAtMs,
    })

    nodes.push(...strokeNodes)
  })

  /*
    Action nodes.

    Only the history-changing actions become nodes: undo, redo and clear alter
    what is on the canvas. Tool, colour and width changes are recorded in the
    session and are not part of the trajectory's shape, so they are left out
    rather than turned into graph clutter.
  */
  const actionNodes: CriticalActionNode[] = []
  session.actions.forEach((action: DrawingAction, index) => {
    if (action.type !== 'undo' && action.type !== 'redo' && action.type !== 'clear') return
    actionNodes.push({
      id: `a-${String(index)}`,
      sourceActionSequence: action.sequence,
      actionType: action.type,
      timeMs: action.timeMs,
    })
  })

  // Link each action node to the point nodes on either side of it in time, so
  // the timeline order stays readable in the graph.
  for (const actionNode of actionNodes) {
    let before: CriticalNode | null = null
    let after: CriticalNode | null = null
    for (const node of nodes) {
      if (node.timeMs <= actionNode.timeMs) before = node
      else {
        after = node
        break
      }
    }
    if (before !== null) {
      edges.push({
        id: `e-${before.id}-${actionNode.id}`,
        from: before.id,
        to: actionNode.id,
        relationType: 'action_transition',
        strokeId: null,
        durationMs: actionNode.timeMs - before.timeMs,
        directDistancePx: null,
        sourcePathLengthPx: null,
        simplifiedPathLengthPx: null,
      })
    }
    if (after !== null) {
      edges.push({
        id: `e-${actionNode.id}-${after.id}`,
        from: actionNode.id,
        to: after.id,
        relationType: 'action_transition',
        strokeId: null,
        durationMs: after.timeMs - actionNode.timeMs,
        directDistancePx: null,
        sourcePathLengthPx: null,
        simplifiedPathLengthPx: null,
      })
    }
  }

  const rawPointCount = session.strokes.reduce((total, s) => total + s.points.length, 0)
  const rawJsonBytes = new TextEncoder().encode(serializeSession(session)).length

  const artifact: CriticalTrajectoryArtifactV2 = {
    artifactSchemaVersion: CRITICAL_TRAJECTORY_SCHEMA_VERSION,
    artifactType: 'critical_trajectory',
    mode,
    sourceSessionId: session.id,
    sourceSchemaVersion: session.schemaVersion,
    createdAt: (options.now ?? nowIsoTimestamp)(),
    lossy: true,
    algorithm: {
      name: CRITICAL_TRAJECTORY_ALGORITHM_NAME,
      version: CRITICAL_TRAJECTORY_ALGORITHM_VERSION,
      coordinateSpace: 'logical_canvas_px',
      tolerancePx: chosen.tolerancePx,
      qualityProfile: profile,
      maskRendererVersion: MASK_RENDERER_VERSION,
      // Recorded so a file can be interpreted without reading this source.
      thresholds: {
        temporalGapBoundaryMs: TEMPORAL_GAP_BOUNDARY_MS,
        directionChangeDegrees: DIRECTION_CHANGE_DEGREES,
        pressureChangeDelta: PRESSURE_CHANGE_DELTA,
      },
    },
    strokes: strokeSummaries,
    quality: {
      // The FULL history, in both modes: this is what the artifact was derived
      // from, and a final-visible file that reported only its own strokes would
      // hide how much of the recording it left out.
      rawStrokeCount: session.strokes.length,
      rawPointCount,
      criticalPointCount: nodes.length,
      retentionRatio: rawPointCount === 0 ? 0 : nodes.length / rawPointCount,
      rawJsonBytes,
      // Filled in below, once the artifact can be serialized.
      criticalJsonBytes: 0,
      sizeReductionRatio: 0,
      maskIoU: chosen.quality.maskIoU,
      maxGeometricDeviationPx: chosen.quality.maxGeometricDeviationPx,
      pathLengthErrorRatio: chosen.quality.pathLengthErrorRatio,
      boundingBoxErrorRatio: chosen.quality.boundingBoxErrorRatio,
      meetsProfile: failureReason === null,
      qualityFailureReason: failureReason,
    },
    canvas: { width: session.canvas.width, height: session.canvas.height },
    nodes,
    actionNodes,
    edges,
  }

  /*
    The artifact's own size can only be measured once it exists, and writing it
    in changes the size again. Measuring the artifact with the two fields
    present but zeroed keeps that self-reference bounded and reproducible: the
    reported number is within a few bytes of the file actually written, and the
    method is stated rather than pretending to be exact.
  */
  // Two-space indent, matching serializeCriticalTrajectory exactly - measuring
  // compact JSON here would understate the file the user actually receives.
  const measured = new TextEncoder().encode(JSON.stringify(artifact, null, 2)).length
  artifact.quality.criticalJsonBytes = measured
  artifact.quality.sizeReductionRatio =
    rawJsonBytes === 0 ? 0 : 1 - measured / rawJsonBytes

  return artifact
}

/**
 * A stable display label for a stroke: S01, S02, ... S10, S11.
 *
 * Two digits minimum so the common case sorts lexicographically, widening on
 * its own past 99 rather than silently truncating.
 */
export function buildStrokeLabel(order: number): string {
  return `S${String(order + 1).padStart(2, '0')}`
}

/**
 * The filename for a critical trajectory JSON export.
 *
 * The mode is in the name because the two files describe different things and
 * would otherwise be indistinguishable once downloaded.
 */
export function buildCriticalTrajectoryFileName(
  sessionId: string,
  stamp: string,
  mode: GraphMode = 'full_process',
): string {
  const slug = mode === 'final_visible' ? 'final-visible' : 'full-process'
  return `artiscan-${slug}-graph-${sessionId.slice(0, 8)}-${stamp}.json`
}
