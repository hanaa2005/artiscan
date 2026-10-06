/**
 * Canvas geometry: what part of the recorded path was actually inside the
 * drawing surface.
 *
 * WHY THIS MODULE EXISTS
 *
 * Pointer capture keeps delivering samples after the pointer leaves the canvas,
 * and week 1 deliberately keeps them: the raw log records what the hand did, not
 * what the screen showed. That is the right choice for research data, but it
 * means two different questions get two different answers:
 *
 *   RAW       - the complete captured pointer path, including everything that
 *               happened outside the surface.
 *   IN-CANVAS - only the part a viewer could actually see being drawn.
 *
 * Neither is more correct; they measure different things. This module computes
 * the second one WITHOUT touching the recording, so both can be reported side by
 * side and neither is silently mistaken for the other.
 *
 * THE SUBTLETY THAT MOTIVATES THE CLIPPING
 *
 * A segment can cross the canvas while BOTH of its endpoints are outside it -
 * think of a stroke swept across the surface from left to right, sampled coarsely.
 * Discarding every segment with an outside endpoint would throw that visible line
 * away. So each segment is clipped against the canvas rectangle with
 * Liang-Barsky, and only the portion genuinely inside is counted.
 *
 * Nothing here mutates its input.
 */

/** A point in canvas pixel space. */
export interface Point2D {
  x: number
  y: number
}

/** The drawing surface, in pixels. */
export interface CanvasRect {
  width: number
  height: number
}

/**
 * Whether a point lies outside the canvas rectangle.
 *
 * The boundary itself counts as INSIDE: a sample at exactly x === width is the
 * last visible pixel column, not a miss. Non-finite coordinates are treated as
 * outside - they cannot be drawn anywhere.
 */
export function isOutsidePoint(point: Point2D, canvas: CanvasRect): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return true
  return point.x < 0 || point.x > canvas.width || point.y < 0 || point.y > canvas.height
}

/** The visible portion of a segment, expressed both as parameters and endpoints. */
export interface ClippedSegment {
  /**
   * Where the visible part begins and ends along the original segment, as a
   * fraction from `a` (0) to `b` (1).
   *
   * These are what make proportional time allocation possible: the visible part
   * of the segment took `(t1 - t0)` of the interval between the two samples.
   */
  t0: number
  t1: number
  /** The clipped endpoints in pixel space. */
  from: Point2D
  to: Point2D
}

/** Interpolates along the segment a -> b. */
function at(a: Point2D, b: Point2D, t: number): Point2D {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/**
 * Clips the segment a -> b against the canvas rectangle (Liang-Barsky).
 *
 * Returns null when no part of the segment is inside.
 *
 * Liang-Barsky is chosen because it is deterministic, allocation-free and gives
 * the parameter range directly - which is exactly what the time allocation
 * needs. The algorithm walks the four boundaries, each expressed as
 * `p * t <= q`:
 *
 *   p < 0  the segment enters through this boundary  -> raises t0
 *   p > 0  the segment leaves through this boundary  -> lowers t1
 *   p == 0 the segment is parallel to it; q < 0 means it lies entirely outside
 *
 * A zero-length segment (a === b) has p == 0 on all four boundaries, so it
 * survives exactly when the point is inside - which is the correct answer.
 */
export function clipSegmentToCanvas(
  a: Point2D,
  b: Point2D,
  canvas: CanvasRect,
): ClippedSegment | null {
  if (
    !Number.isFinite(a.x) ||
    !Number.isFinite(a.y) ||
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y)
  ) {
    return null
  }
  if (!(canvas.width > 0) || !(canvas.height > 0)) return null

  const dx = b.x - a.x
  const dy = b.y - a.y

  const p = [-dx, dx, -dy, dy]
  const q = [a.x - 0, canvas.width - a.x, a.y - 0, canvas.height - a.y]

  let t0 = 0
  let t1 = 1

  for (let i = 0; i < 4; i += 1) {
    const pi = p[i]
    const qi = q[i]
    if (pi === undefined || qi === undefined) return null

    if (pi === 0) {
      // Parallel to this boundary: either always inside it, or never.
      if (qi < 0) return null
      continue
    }

    const r = qi / pi
    if (pi < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }

  if (t1 < t0) return null

  return { t0, t1, from: at(a, b, t0), to: at(a, b, t1) }
}
