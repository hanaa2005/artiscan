/**
 * Deterministic feature extraction.
 *
 * One pure function turns a canonical DrawingSession into objective numbers.
 * It is the only place that derives anything from a recording, and it obeys
 * four rules without exception:
 *
 * 1. NEVER MUTATE the session. The raw recording is the source of truth; an
 *    analysis that edits its own input destroys the thing it is measuring.
 * 2. NEVER emit NaN or Infinity. A single Infinity from a divide-by-zero
 *    silently poisons every average, maximum and chart downstream, and it is
 *    indistinguishable from a real measurement once it is in a file.
 * 3. Distinguish "no value" from "zero". Absent pressure is `null`, never 0 -
 *    those are different claims and only one of them is true.
 * 4. NO INTERPRETATION. These are counts and distances. The approved roadmap is
 *    explicit that this version performs no psychological interpretation, and
 *    nothing here may drift from that.
 *
 * RAW versus IN-CANVAS
 *
 * Pointer capture keeps recording after the pointer leaves the surface, and
 * week 1 deliberately keeps those samples. That makes "how far did the pen
 * travel" ambiguous, so it is answered twice:
 *
 *   raw*       everything captured, including movement off the surface
 *   inCanvas*  only what was inside the canvas, computed by clipping each
 *              segment against the canvas rectangle
 *
 * The raw data is never altered to produce either one. Note that the session's
 * own `normalizedX`/`normalizedY` are CLAMPED to 0..1 at capture time, so they
 * cannot express outside movement; the raw normalized figures here are computed
 * from the unclamped pixel coordinates instead.
 *
 * Everything is recomputable from the session, which is why an imported result
 * can safely throw its stored features away and rebuild them.
 */

import type {
  DrawingAction,
  DrawingSession,
  DrawingStroke,
  PointSample,
  PointerInputType,
} from '../../drawing/types/drawing.types'
import { computeVisibleStrokeIds } from '../../drawing/utils/strokeVisibility'
import { safeDeltaMs } from '../../drawing/utils/timing'
import type { BoundingBox, DrawingFeatures } from '../types/trial.types'
import {
  clipSegmentToCanvas,
  isOutsidePoint,
  type CanvasRect,
  type Point2D,
} from './canvasGeometry'

/**
 * A gap between two consecutive strokes longer than this counts as a pause.
 *
 * 500 ms sits above ordinary pen-lift-and-reposition movement (roughly
 * 150-300 ms) but below a deliberate stop to think. It is a reporting
 * threshold, NOT a psychological claim: it defines which gaps get counted, and
 * says nothing about why any of them happened.
 *
 * It is a named constant precisely so a later study can change it in one place
 * and state the value it used.
 */
export const PAUSE_THRESHOLD_MS = 500

/** Decimal places kept in derived values, so exports stay readable and stable. */
const PRECISION = 4

/**
 * Rounds to PRECISION decimals, mapping anything non-finite to 0.
 *
 * Every arithmetic result passes through here. It is the single choke point
 * that enforces rule 2 above: no NaN or Infinity can leave this module, even if
 * a future edit introduces a division this file does not currently perform.
 */
function finite(value: number): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** PRECISION
  return Math.round(value * factor) / factor
}

/** Rounds a nullable statistic, preserving null. */
function finiteOrNull(value: number | null): number | null {
  if (value === null) return null
  if (!Number.isFinite(value)) return null
  return finite(value)
}

/** Euclidean distance between two points in pixel space. */
function pixelDistance(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/**
 * The same distance measured in canvas fractions.
 *
 * Deliberately computed from the pixel coordinates rather than the recorded
 * normalized ones: those are clamped, so they would silently erase exactly the
 * outside movement this figure is meant to include.
 */
function normalizedDistance(a: Point2D, b: Point2D, canvas: CanvasRect): number {
  const dx = (b.x - a.x) / canvas.width
  const dy = (b.y - a.y) / canvas.height
  return Math.hypot(dx, dy)
}

/** An all-zero feature set, used for an empty session and as the base to fill in. */
export function createEmptyFeatures(): DrawingFeatures {
  return {
    totalStrokeCount: 0,
    visibleStrokeCount: 0,
    penStrokeCount: 0,
    eraserStrokeCount: 0,
    totalPointCount: 0,

    insideCanvasPointCount: 0,
    outsideCanvasPointCount: 0,
    outsideCanvasPointRatio: 0,
    strokeWithOutsidePointsCount: 0,

    durationMs: 0,

    rawPathLengthPx: 0,
    rawPathLengthNormalized: 0,
    rawBoundingBox: null,

    inCanvasPathLengthPx: 0,
    inCanvasPathLengthNormalized: 0,
    inCanvasBoundingBox: null,
    visibleCanvasCoverageRatio: 0,

    totalPathLengthPx: 0,
    totalPathLengthNormalized: 0,
    boundingBox: null,
    boundingBoxNormalized: null,
    canvasCoverageRatio: 0,

    undoCount: 0,
    redoCount: 0,
    clearCount: 0,
    toolChangeCount: 0,
    colorChangeCount: 0,
    widthChangeCount: 0,

    pressureSampleCount: 0,
    minPressure: null,
    maxPressure: null,
    meanPressure: null,

    validRawSpeedSampleCount: 0,
    meanRawSpeedNormalizedPerSecond: 0,
    maxRawSpeedNormalizedPerSecond: 0,
    validInCanvasSpeedSampleCount: 0,
    meanInCanvasSpeedNormalizedPerSecond: 0,
    maxInCanvasSpeedNormalizedPerSecond: 0,
    validSpeedSampleCount: 0,
    meanSpeedNormalizedPerSecond: 0,
    maxSpeedNormalizedPerSecond: 0,

    pauseCount: 0,
    totalPauseMs: 0,
    longestPauseMs: 0,
  }
}

/** Accumulates min/max over a stream of values without allocating an array. */
interface Extent {
  min: number
  max: number
  seen: boolean
}

function newExtent(): Extent {
  return { min: 0, max: 0, seen: false }
}

function observe(extent: Extent, value: number): void {
  if (!Number.isFinite(value)) return
  if (!extent.seen) {
    extent.min = value
    extent.max = value
    extent.seen = true
    return
  }
  if (value < extent.min) extent.min = value
  if (value > extent.max) extent.max = value
}

function toBoundingBox(x: Extent, y: Extent): BoundingBox | null {
  if (!x.seen || !y.seen) return null
  return {
    minX: finite(x.min),
    minY: finite(y.min),
    maxX: finite(x.max),
    maxY: finite(y.max),
    width: finite(x.max - x.min),
    height: finite(y.max - y.min),
  }
}

/** Expresses a pixel bounding box as canvas fractions, without clamping. */
function toNormalizedBox(box: BoundingBox | null, canvas: CanvasRect): BoundingBox | null {
  if (box === null) return null
  return {
    minX: finite(box.minX / canvas.width),
    minY: finite(box.minY / canvas.height),
    maxX: finite(box.maxX / canvas.width),
    maxY: finite(box.maxY / canvas.height),
    width: finite(box.width / canvas.width),
    height: finite(box.height / canvas.height),
  }
}

/** Tallies the action log by type. */
function countActions(actions: readonly DrawingAction[]) {
  const counts = {
    undoCount: 0,
    redoCount: 0,
    clearCount: 0,
    toolChangeCount: 0,
    colorChangeCount: 0,
    widthChangeCount: 0,
  }

  for (const action of actions) {
    switch (action.type) {
      case 'undo':
        counts.undoCount += 1
        break
      case 'redo':
        counts.redoCount += 1
        break
      case 'clear':
        counts.clearCount += 1
        break
      case 'tool_change':
        counts.toolChangeCount += 1
        break
      case 'color_change':
        counts.colorChangeCount += 1
        break
      case 'width_change':
        counts.widthChangeCount += 1
        break
      default:
        break
    }
  }

  return counts
}

/**
 * Gaps BETWEEN strokes: the pen-up time from one stroke ending to the next
 * beginning.
 *
 * Deliberately not the gaps between samples inside a stroke - while the pen is
 * down there is no pause, only slow movement, and counting those would conflate
 * hesitating with drawing carefully.
 *
 * Strokes are compared in canonical creation order, which is the order the
 * append-only history already guarantees.
 */
function computePauses(strokes: readonly DrawingStroke[]) {
  let pauseCount = 0
  let totalPauseMs = 0
  let longestPauseMs = 0

  for (let i = 1; i < strokes.length; i += 1) {
    const previous = strokes[i - 1]
    const current = strokes[i]
    if (previous === undefined || current === undefined) continue

    const gap = current.startedAtMs - previous.endedAtMs
    // A non-positive gap means the strokes touch or overlap - not a pause.
    if (!Number.isFinite(gap) || gap <= PAUSE_THRESHOLD_MS) continue

    pauseCount += 1
    totalPauseMs += gap
    if (gap > longestPauseMs) longestPauseMs = gap
  }

  return { pauseCount, totalPauseMs, longestPauseMs }
}

/**
 * The distinct pointer types the browser reported during this session.
 *
 * NOT a feature and deliberately not part of DrawingFeatures: it is a label
 * copied from the Pointer Events API, not a measurement. It is also not
 * evidence about the hardware - Chrome's device emulation reports `touch` while
 * a physical mouse is being used. See docs/trial-schema.md.
 */
export function collectPointerTypes(session: DrawingSession): PointerInputType[] {
  const seen = new Set<PointerInputType>()
  for (const stroke of session.strokes) {
    for (const point of stroke.points) {
      seen.add(point.pointerType)
    }
  }
  return [...seen]
}

/** Running totals for one of the two geometries. */
interface PathAccumulator {
  lengthPx: number
  lengthNormalized: number
  speedSamples: number
  speedSum: number
  maxSpeed: number
  x: Extent
  y: Extent
}

function newPathAccumulator(): PathAccumulator {
  return {
    lengthPx: 0,
    lengthNormalized: 0,
    speedSamples: 0,
    speedSum: 0,
    maxSpeed: 0,
    x: newExtent(),
    y: newExtent(),
  }
}

function observeSpeed(accumulator: PathAccumulator, speed: number): void {
  if (!Number.isFinite(speed)) return
  accumulator.speedSamples += 1
  accumulator.speedSum += speed
  if (speed > accumulator.maxSpeed) accumulator.maxSpeed = speed
}

function meanSpeed(accumulator: PathAccumulator): number {
  return accumulator.speedSamples > 0 ? accumulator.speedSum / accumulator.speedSamples : 0
}

/**
 * Extracts every derived feature from a session.
 *
 * The session is read-only throughout: no array is sorted in place, no object
 * is written to. Callers can hand in their live state safely.
 */
export function extractDrawingFeatures(session: DrawingSession): DrawingFeatures {
  const features = createEmptyFeatures()
  const { strokes, actions } = session

  // A degenerate canvas would turn every normalization into a division by zero.
  // The validator already rejects such a session, but the guard keeps this
  // function safe for any caller.
  const canvas: CanvasRect = {
    width: Number.isFinite(session.canvas.width) && session.canvas.width > 0 ? session.canvas.width : 1,
    height:
      Number.isFinite(session.canvas.height) && session.canvas.height > 0
        ? session.canvas.height
        : 1,
  }

  Object.assign(features, countActions(actions))

  features.totalStrokeCount = strokes.length
  features.visibleStrokeCount = computeVisibleStrokeIds(strokes, actions).size

  const raw = newPathAccumulator()
  const inCanvas = newPathAccumulator()

  let pointCount = 0
  let insidePointCount = 0
  let outsidePointCount = 0
  let strokeWithOutsidePointsCount = 0
  let maxTimeMs = 0

  let pressureSampleCount = 0
  let pressureSum = 0
  const pressure = newExtent()

  for (const stroke of strokes) {
    if (stroke.tool === 'eraser') {
      features.eraserStrokeCount += 1
    } else {
      features.penStrokeCount += 1
    }

    if (stroke.endedAtMs > maxTimeMs) maxTimeMs = stroke.endedAtMs

    const points = stroke.points
    pointCount += points.length
    let strokeHasOutsidePoint = false

    for (let i = 0; i < points.length; i += 1) {
      const point = points[i]
      if (point === undefined) continue

      observe(raw.x, point.x)
      observe(raw.y, point.y)
      if (point.timeMs > maxTimeMs) maxTimeMs = point.timeMs

      if (isOutsidePoint(point, canvas)) {
        outsidePointCount += 1
        strokeHasOutsidePoint = true
      } else {
        insidePointCount += 1
        // An isolated point inside the canvas is visible geometry - a dot -
        // so it bounds the in-canvas box even though it spans no segment.
        observe(inCanvas.x, point.x)
        observe(inCanvas.y, point.y)
      }

      if (point.pressure !== null && Number.isFinite(point.pressure)) {
        pressureSampleCount += 1
        pressureSum += point.pressure
        observe(pressure, point.pressure)
      }

      // Distance and speed both need a preceding sample, so the first point of
      // each stroke contributes neither. A single-point stroke is therefore
      // counted and bounded, but adds zero length - which is correct: a dot
      // covers no distance.
      const previous: PointSample | undefined = i > 0 ? points[i - 1] : undefined
      if (previous === undefined) continue

      // --- raw geometry: everything the pointer did -------------------------
      const rawStepPx = pixelDistance(previous, point)
      const rawStepNormalized = normalizedDistance(previous, point, canvas)
      raw.lengthPx += rawStepPx
      raw.lengthNormalized += rawStepNormalized

      // --- in-canvas geometry: only the part on the surface -----------------
      // Clipping happens in PIXEL space and the clipped endpoints are
      // normalized afterwards, so the normalized figure describes the same
      // geometry the pixel figure does.
      const clipped = clipSegmentToCanvas(previous, point, canvas)
      let visibleFraction = 0
      if (clipped !== null) {
        visibleFraction = clipped.t1 - clipped.t0
        inCanvas.lengthPx += pixelDistance(clipped.from, clipped.to)
        inCanvas.lengthNormalized += normalizedDistance(clipped.from, clipped.to, canvas)
        // A crossing segment contributes its real intersection points to the
        // visible bounding box, even when neither endpoint was inside.
        observe(inCanvas.x, clipped.from.x)
        observe(inCanvas.y, clipped.from.y)
        observe(inCanvas.x, clipped.to.x)
        observe(inCanvas.y, clipped.to.y)
      }

      // safeDeltaMs returns null for dt <= 0. Two samples can legitimately share
      // a timestamp - the clock is rounded to 0.1 ms - and dividing by that gap
      // would yield Infinity, so those intervals are skipped rather than
      // contributing a fabricated speed.
      const deltaMs = safeDeltaMs(previous, point)
      if (deltaMs === null) continue

      observeSpeed(raw, (rawStepNormalized / deltaMs) * 1000)

      // Time is allocated proportionally to the fraction of the segment that is
      // inside: the visible part took that share of the interval. A segment that
      // merely grazes a corner therefore reports the same rate as the segment as
      // a whole, instead of an artificial spike from dividing a tiny distance by
      // the whole interval.
      if (clipped === null || visibleFraction <= 0) continue
      const visibleDeltaMs = deltaMs * visibleFraction
      if (!(visibleDeltaMs > 0)) continue
      const visibleStepNormalized = normalizedDistance(clipped.from, clipped.to, canvas)
      observeSpeed(inCanvas, (visibleStepNormalized / visibleDeltaMs) * 1000)
    }

    if (strokeHasOutsidePoint) strokeWithOutsidePointsCount += 1
  }

  for (const action of actions) {
    if (action.timeMs > maxTimeMs) maxTimeMs = action.timeMs
  }

  features.totalPointCount = pointCount
  features.insideCanvasPointCount = insidePointCount
  features.outsideCanvasPointCount = outsidePointCount
  features.outsideCanvasPointRatio = pointCount > 0 ? finite(outsidePointCount / pointCount) : 0
  features.strokeWithOutsidePointsCount = strokeWithOutsidePointsCount
  features.durationMs = finite(maxTimeMs)

  // --- raw ----------------------------------------------------------------
  const rawBox = toBoundingBox(raw.x, raw.y)
  features.rawPathLengthPx = finite(raw.lengthPx)
  features.rawPathLengthNormalized = finite(raw.lengthNormalized)
  features.rawBoundingBox = rawBox

  // --- in-canvas ----------------------------------------------------------
  const inCanvasBox = toBoundingBox(inCanvas.x, inCanvas.y)
  features.inCanvasPathLengthPx = finite(inCanvas.lengthPx)
  features.inCanvasPathLengthNormalized = finite(inCanvas.lengthNormalized)
  features.inCanvasBoundingBox = inCanvasBox
  // Coverage comes from the VISIBLE box, so movement off the surface can no
  // longer inflate it to 100%. It is bounding-box coverage, not painted area.
  const normalizedVisibleBox = toNormalizedBox(inCanvasBox, canvas)
  features.visibleCanvasCoverageRatio =
    normalizedVisibleBox === null
      ? 0
      : finite(normalizedVisibleBox.width * normalizedVisibleBox.height)

  // --- documented aliases -------------------------------------------------
  features.totalPathLengthPx = features.rawPathLengthPx
  features.totalPathLengthNormalized = features.rawPathLengthNormalized
  features.boundingBox = rawBox
  features.boundingBoxNormalized = toNormalizedBox(rawBox, canvas)
  features.canvasCoverageRatio = features.visibleCanvasCoverageRatio

  // --- pressure -----------------------------------------------------------
  features.pressureSampleCount = pressureSampleCount
  if (pressureSampleCount > 0) {
    features.minPressure = finiteOrNull(pressure.min)
    features.maxPressure = finiteOrNull(pressure.max)
    features.meanPressure = finiteOrNull(pressureSum / pressureSampleCount)
  }

  // --- speed --------------------------------------------------------------
  features.validRawSpeedSampleCount = raw.speedSamples
  features.meanRawSpeedNormalizedPerSecond = finite(meanSpeed(raw))
  features.maxRawSpeedNormalizedPerSecond = finite(raw.maxSpeed)
  features.validInCanvasSpeedSampleCount = inCanvas.speedSamples
  features.meanInCanvasSpeedNormalizedPerSecond = finite(meanSpeed(inCanvas))
  features.maxInCanvasSpeedNormalizedPerSecond = finite(inCanvas.maxSpeed)
  features.validSpeedSampleCount = features.validRawSpeedSampleCount
  features.meanSpeedNormalizedPerSecond = features.meanRawSpeedNormalizedPerSecond
  features.maxSpeedNormalizedPerSecond = features.maxRawSpeedNormalizedPerSecond

  // --- pauses -------------------------------------------------------------
  const pauses = computePauses(strokes)
  features.pauseCount = pauses.pauseCount
  features.totalPauseMs = finite(pauses.totalPauseMs)
  features.longestPauseMs = finite(pauses.longestPauseMs)

  return features
}
