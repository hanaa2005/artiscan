/**
 * Coordinate conversion.
 *
 * The canvas is responsive, so its pixel size changes whenever the window is
 * resized. Raw pixel coordinates alone would therefore be meaningless later.
 * We store normalized (0..1) coordinates alongside the raw ones and always
 * RENDER from the normalized values multiplied by the CURRENT canvas size.
 *
 * That single decision is what makes the drawing survive a resize and makes an
 * imported session reproduce identically on a differently sized screen.
 */

export interface Size {
  width: number
  height: number
}

export interface NormalizedPoint {
  normalizedX: number
  normalizedY: number
}

/** Clamps a value into the inclusive [min, max] range. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Converts canvas pixel coordinates to the 0..1 range.
 *
 * Clamping matters here: while a stroke is captured with setPointerCapture the
 * pointer can travel OUTSIDE the canvas and still deliver events. Without a
 * clamp we would record values like -0.3 or 1.8 and later fail validation.
 *
 * A zero-sized canvas (before first layout) would divide by zero, so it maps
 * everything to 0 instead of producing NaN/Infinity.
 */
export function toNormalized(x: number, y: number, size: Size): NormalizedPoint {
  const normalizedX = size.width > 0 ? clamp(x / size.width, 0, 1) : 0
  const normalizedY = size.height > 0 ? clamp(y / size.height, 0, 1) : 0
  return { normalizedX, normalizedY }
}

/** Converts a normalized point back to pixels for the current canvas size. */
export function fromNormalized(
  normalizedX: number,
  normalizedY: number,
  size: Size,
): { x: number; y: number } {
  return {
    x: normalizedX * size.width,
    y: normalizedY * size.height,
  }
}

/**
 * Flattens a list of normalized points into the flat `[x0, y0, x1, y1, ...]`
 * array that Konva's Line shape expects, scaled to the current canvas size.
 */
export function toKonvaPoints(
  points: readonly NormalizedPoint[],
  size: Size,
): number[] {
  const flat: number[] = new Array<number>(points.length * 2)
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]
    if (point === undefined) continue
    flat[i * 2] = point.normalizedX * size.width
    flat[i * 2 + 1] = point.normalizedY * size.height
  }
  return flat
}

/** Rounds a pixel coordinate to 0.01 px to keep the exported JSON compact. */
export function roundPixel(value: number): number {
  return Math.round(value * 100) / 100
}

/** Rounds a normalized coordinate to 5 decimals (sub-pixel on any real screen). */
export function roundNormalized(value: number): number {
  return Math.round(value * 100000) / 100000
}
