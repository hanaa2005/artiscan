/**
 * A pure, deterministic binary rasterizer.
 *
 * WHY NOT USE A CANVAS
 *
 * Reconstruction quality is measured by comparing what the full path covers
 * with what the simplified path covers. That comparison has to be reproducible
 * and has to run in the test suite, and a DOM canvas gives neither: jsdom has
 * no 2D context at all, and real browsers differ in anti-aliasing, so the same
 * session would score differently on different machines. So the mask used for
 * MEASUREMENT is computed here, in plain arithmetic, with no platform in the
 * loop.
 *
 * The PNG the user downloads is rendered separately through a real canvas. The
 * two are deliberately allowed to differ in anti-aliasing; the numbers in the
 * quality report come from this one, which is why the report is reproducible.
 *
 * THE COVERAGE MODEL
 *
 * A stroke is the set of points within `width / 2` of its polyline - a chain of
 * capsules. That corresponds exactly to round caps and round joins, which is
 * what the renderer uses (see utils/strokeStyle.ts), so the measured mask and
 * the drawn picture describe the same shape.
 *
 * A pixel is covered when its CENTRE lies inside that set. Centre sampling is a
 * choice, not an approximation of anti-aliasing: it is binary, deterministic,
 * and symmetric, which is what an IoU comparison needs.
 */

import type { Point2D } from './rdp'

/** Version of the coverage model above. Recorded in artifacts that depend on it. */
export const MASK_RENDERER_VERSION = 'centre-sample-capsule-1'

export interface BinaryMask {
  width: number
  height: number
  /** One byte per pixel, row-major: 1 covered, 0 not. */
  data: Uint8Array
}

export interface MaskStroke {
  points: readonly Point2D[]
  /** Line width in the same pixel space as `points`. */
  width: number
}

export interface MaskSize {
  width: number
  height: number
}

/** An all-zero mask of the given size. */
export function createEmptyMask(size: MaskSize): BinaryMask {
  const width = Math.max(0, Math.floor(size.width))
  const height = Math.max(0, Math.floor(size.height))
  return { width, height, data: new Uint8Array(width * height) }
}

/** Squared distance from a point to a segment. Squared to avoid a sqrt per pixel. */
function distanceSquaredToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy

  let t = 0
  if (lengthSquared > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared
    if (t < 0) t = 0
    else if (t > 1) t = 1
  }

  const cx = ax + t * dx
  const cy = ay + t * dy
  const ex = px - cx
  const ey = py - cy
  return ex * ex + ey * ey
}

/**
 * Paints one capsule (a segment thickened by `radius`) into the mask.
 *
 * Only the pixels in the segment's bounding box are examined, so cost scales
 * with the ink drawn rather than with the size of the canvas.
 */
function paintCapsule(
  mask: BinaryMask,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): void {
  const radiusSquared = radius * radius

  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radius))
  const maxX = Math.min(mask.width - 1, Math.ceil(Math.max(ax, bx) + radius))
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - radius))
  const maxY = Math.min(mask.height - 1, Math.ceil(Math.max(ay, by) + radius))

  for (let y = minY; y <= maxY; y += 1) {
    // Pixel centres, hence the +0.5.
    const centreY = y + 0.5
    const rowOffset = y * mask.width
    for (let x = minX; x <= maxX; x += 1) {
      if (mask.data[rowOffset + x] === 1) continue
      const centreX = x + 0.5
      if (distanceSquaredToSegment(centreX, centreY, ax, ay, bx, by) <= radiusSquared) {
        mask.data[rowOffset + x] = 1
      }
    }
  }
}

/**
 * Rasterizes strokes into a binary mask.
 *
 * Points outside the canvas are NOT discarded and NOT clamped: the segment is
 * drawn as recorded and simply contributes only the part that falls inside the
 * raster. Clamping would bend the path along the edge and invent geometry that
 * was never drawn, which would then be scored as if it had been.
 *
 * A single-point stroke paints a dot - it is a real observation and must appear
 * in the mask, or a tap would score as missing ink.
 */
export function rasterizeStrokes(
  strokes: readonly MaskStroke[],
  size: MaskSize,
): BinaryMask {
  const mask = createEmptyMask(size)
  if (mask.width === 0 || mask.height === 0) return mask

  for (const stroke of strokes) {
    const points = stroke.points
    if (points.length === 0) continue

    // A hairline still has to cover something, or a 0-width stroke would be
    // invisible to the comparison rather than merely thin.
    const radius = Math.max(0.5, stroke.width / 2)

    if (points.length === 1) {
      const only = points[0]
      if (only === undefined) continue
      paintCapsule(mask, only.x, only.y, only.x, only.y, radius)
      continue
    }

    for (let i = 1; i < points.length; i += 1) {
      const previous = points[i - 1]
      const current = points[i]
      if (previous === undefined || current === undefined) continue
      paintCapsule(mask, previous.x, previous.y, current.x, current.y, radius)
    }
  }

  return mask
}

/** How many pixels the mask covers. */
export function countCovered(mask: BinaryMask): number {
  let total = 0
  for (let i = 0; i < mask.data.length; i += 1) {
    if (mask.data[i] === 1) total += 1
  }
  return total
}

/**
 * Intersection over union of two masks of identical size.
 *
 * THE EMPTY POLICY, stated explicitly because it is a real decision:
 * - both empty  -> 1. Two reconstructions that both draw nothing agree
 *                  perfectly; scoring that as 0 would report a failure where
 *                  there is no disagreement.
 * - one empty   -> 0. Total disagreement.
 * Sizes that differ are not comparable and yield null rather than a number that
 * would look like a measurement.
 */
export function maskIoU(a: BinaryMask, b: BinaryMask): number | null {
  if (a.width !== b.width || a.height !== b.height) return null

  let intersection = 0
  let union = 0
  for (let i = 0; i < a.data.length; i += 1) {
    const inA = a.data[i] === 1
    const inB = b.data[i] === 1
    if (inA && inB) intersection += 1
    if (inA || inB) union += 1
  }

  if (union === 0) return 1
  return intersection / union
}
