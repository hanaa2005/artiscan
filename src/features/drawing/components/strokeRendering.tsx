/**
 * How a stroke looks. One definition, used by capture AND replay.
 *
 * WHY THIS IS SHARED
 *
 * Replay has to produce the same picture as the live canvas and the exported
 * PNG. If the two renderers each decided their own line cap, tension or eraser
 * compositing, the replayed final frame would drift from the drawing it claims
 * to reconstruct - and the difference would be invisible until someone compared
 * an export with a replay. So both import from here.
 *
 * Geometry comes from the NORMALIZED coordinates, multiplied by whatever size
 * the surface currently is. That is what makes the same stroke data render
 * correctly on the capture canvas, in a smaller replay panel, and in a 2x PNG.
 */

import { memo } from 'react'
import { Line } from 'react-konva'
import type { DrawingTool } from '../types/drawing.types'
import { toKonvaPoints, type NormalizedPoint, type Size } from '../utils/coordinates'
import { LINE_STYLE } from '../utils/strokeStyle'

export interface StrokeAppearance {
  tool: DrawingTool
  color: string
  /** Line width in LOGICAL canvas pixels. */
  width: number
}

interface StrokeLineProps extends StrokeAppearance {
  points: readonly NormalizedPoint[]
  /** The surface to paint on, in display pixels. */
  size: Size
  /**
   * Display pixels per logical pixel.
   *
   * The recorded width is in the logical canvas's pixels, so replaying into a
   * smaller panel has to scale it or a 20 px brush would look enormous. 1 on
   * the capture canvas, where logical and display sizes are the same thing.
   */
  widthScale?: number
}

/**
 * One stroke.
 *
 * The eraser is drawn with the `destination-out` composite operation: instead
 * of painting a colour it removes whatever is already on the layer. That is why
 * the eraser must live in the SAME layer as the ink - a separate layer would
 * only erase its own (empty) canvas.
 */
export const StrokeLine = memo(function StrokeLine({
  points,
  tool,
  color,
  width,
  size,
  widthScale = 1,
}: StrokeLineProps): React.JSX.Element {
  const isEraser = tool === 'eraser'
  return (
    <Line
      points={toKonvaPoints(points, size)}
      stroke={isEraser ? '#000000' : color}
      strokeWidth={Math.max(0.1, width * widthScale)}
      globalCompositeOperation={isEraser ? 'destination-out' : 'source-over'}
      {...LINE_STYLE}
    />
  )
})
