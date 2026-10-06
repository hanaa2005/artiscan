/**
 * Ramer-Douglas-Peucker simplification.
 *
 * WHAT THIS IS FOR
 *
 * A recorded stroke contains a sample every few milliseconds, most of which lie
 * almost exactly on the line between their neighbours and therefore carry no
 * shape information. RDP keeps the points that define the geometry and drops
 * the ones that only confirm it.
 *
 * WHAT THIS IS NOT
 *
 * It is not a compression of the raw data. The output is a DERIVED artifact and
 * is explicitly lossy; the canonical session keeps every sample. Nothing here
 * writes back to a session, and nothing here rounds, clamps or moves a
 * coordinate - it only ever SELECTS existing points, and returns their indices
 * so the caller can carry the original timing, pressure and sequence across
 * untouched.
 *
 * DETERMINISM
 *
 * The result depends only on the input points and the tolerance. There is no
 * randomness, no floating-point accumulation across calls, and no dependence on
 * iteration order: the recursion always splits at the single farthest point,
 * and ties are broken by the lower index.
 */

export interface Point2D {
  x: number
  y: number
}

/**
 * Perpendicular distance from `point` to the segment `start`-`end`.
 *
 * Distance to the SEGMENT, not to the infinite line: for a stroke that doubles
 * back on itself the infinite line can pass arbitrarily close to a point that
 * is nowhere near the actual path, which would drop a point that carries real
 * shape.
 *
 * When the segment is degenerate (start and end coincide, which happens on a
 * stationary pointer) this reduces to the distance to that single point.
 */
export function perpendicularDistance(
  point: Point2D,
  start: Point2D,
  end: Point2D,
): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy

  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }

  // Projection parameter of `point` onto the segment, clamped to its extent.
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
  if (t < 0) t = 0
  else if (t > 1) t = 1

  const projectedX = start.x + t * dx
  const projectedY = start.y + t * dy
  return Math.hypot(point.x - projectedX, point.y - projectedY)
}

/**
 * True when the tolerance asks for no simplification at all.
 *
 * A zero, negative or non-finite tolerance is treated as "keep everything"
 * rather than as an error. That makes the safe direction the default: a caller
 * that fails to compute a tolerance gets the full-fidelity path, never a
 * silently mangled one.
 */
function keepsEverything(tolerancePx: number): boolean {
  return !Number.isFinite(tolerancePx) || tolerancePx <= 0
}

/**
 * Indices of the points RDP keeps, ascending, always including the first and
 * the last.
 *
 * Returns INDICES rather than points so the caller can look the original sample
 * back up and preserve everything RDP knows nothing about - timestamp, pressure,
 * tilt, pointer type and, most importantly, `sequence`, which is what keeps a
 * derived node traceable to the raw evidence it came from.
 *
 * Implemented with an explicit stack rather than recursion: a 10,000-point
 * stroke of gentle curvature can recurse thousands of levels deep and overflow.
 */
export function simplifyRdpIndices(
  points: readonly Point2D[],
  tolerancePx: number,
): number[] {
  const count = points.length
  if (count <= 2) {
    // Nothing to remove: both endpoints are mandatory by definition.
    return points.map((_, index) => index)
  }
  if (keepsEverything(tolerancePx)) {
    return points.map((_, index) => index)
  }

  /** Marks which indices survive. Endpoints always do. */
  const keep = new Uint8Array(count)
  keep[0] = 1
  keep[count - 1] = 1

  // Half-open ranges [first, last] still to examine.
  const stack: Array<[number, number]> = [[0, count - 1]]

  while (stack.length > 0) {
    const range = stack.pop()
    if (range === undefined) continue
    const [first, last] = range
    if (last <= first + 1) continue

    const start = points[first]
    const end = points[last]
    if (start === undefined || end === undefined) continue

    let farthestIndex = -1
    let farthestDistance = -1

    for (let i = first + 1; i < last; i += 1) {
      const point = points[i]
      if (point === undefined) continue
      const distance = perpendicularDistance(point, start, end)
      // Strictly greater keeps the tie-break at the LOWER index, which is what
      // makes the output independent of scan direction.
      if (distance > farthestDistance) {
        farthestDistance = distance
        farthestIndex = i
      }
    }

    if (farthestIndex === -1 || farthestDistance <= tolerancePx) {
      // Every intermediate point is within tolerance of the chord: the chord
      // represents them all.
      continue
    }

    keep[farthestIndex] = 1
    stack.push([first, farthestIndex])
    stack.push([farthestIndex, last])
  }

  const kept: number[] = []
  for (let i = 0; i < count; i += 1) {
    if (keep[i] === 1) kept.push(i)
  }
  return kept
}

/** Total length of the polyline through `points`, in the same units as the input. */
export function polylineLength(points: readonly Point2D[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1]
    const current = points[i]
    if (previous === undefined || current === undefined) continue
    total += Math.hypot(current.x - previous.x, current.y - previous.y)
  }
  return total
}

/**
 * The greatest distance from any input point to the polyline through `kept`.
 *
 * This is the honest measure of what simplification cost: not the average, and
 * not the tolerance that was requested, but the worst error actually present in
 * the result.
 */
export function maxDeviationFromPolyline(
  points: readonly Point2D[],
  kept: readonly Point2D[],
): number {
  if (points.length === 0 || kept.length === 0) return 0
  if (kept.length === 1) {
    const only = kept[0]
    if (only === undefined) return 0
    let worst = 0
    for (const point of points) {
      worst = Math.max(worst, Math.hypot(point.x - only.x, point.y - only.y))
    }
    return worst
  }

  let worst = 0
  for (const point of points) {
    let best = Number.POSITIVE_INFINITY
    for (let i = 1; i < kept.length; i += 1) {
      const start = kept[i - 1]
      const end = kept[i]
      if (start === undefined || end === undefined) continue
      const distance = perpendicularDistance(point, start, end)
      if (distance < best) best = distance
      // An exact hit cannot be beaten; stop early on long paths.
      if (best === 0) break
    }
    if (best !== Number.POSITIVE_INFINITY && best > worst) worst = best
  }
  return worst
}
