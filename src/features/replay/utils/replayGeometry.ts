/**
 * Logical canvas versus visual canvas.
 *
 * LOGICAL is the surface the session was recorded on: `session.canvas`, fixed
 * for the lifetime of the recording. Every raw coordinate in the file belongs
 * to it.
 *
 * VISUAL is however many pixels the replay panel happens to have right now. It
 * changes with the window, the sidebar, the device.
 *
 * The mapping between them is derived, never stored, and never written back. It
 * exists only so the same recording can be shown at any size without distorting
 * it - which is why it always preserves the aspect ratio rather than stretching
 * to fill.
 *
 * Device pixel ratio does not appear here at all. DPR affects how many physical
 * pixels are rasterised for a given CSS pixel - a quality setting - and must not
 * touch the meaning of a coordinate.
 */

import type { CanvasDescriptor } from '../../drawing/types/drawing.types'
import type { Size } from '../../drawing/utils/coordinates'

export interface VisualCanvas {
  /** The size to render at, in display pixels. */
  size: Size
  /**
   * Display pixels per logical pixel.
   *
   * Used to scale stroke widths, which are recorded in logical pixels: without
   * it a 20 px brush would stay 20 px wide in a half-size panel and swamp the
   * drawing.
   */
  scale: number
}

/** A degenerate box that renders nothing, rather than dividing by zero. */
const EMPTY: VisualCanvas = { size: { width: 0, height: 0 }, scale: 1 }

/**
 * Fits the logical canvas inside the available box, preserving its shape.
 *
 * The result is letterboxed rather than stretched: a square recording shown in
 * a wide panel stays square. Stretching would change the drawing - an ellipse
 * the participant drew as a circle is a different observation.
 *
 * The logical canvas is never scaled UP past the available box, but it is
 * scaled down freely; a recording larger than the panel is shown whole rather
 * than cropped, because a cropped replay would silently hide strokes.
 */
export function computeVisualCanvas(
  logical: Pick<CanvasDescriptor, 'width' | 'height'>,
  available: Size,
): VisualCanvas {
  const logicalWidth = logical.width
  const logicalHeight = logical.height

  if (
    !Number.isFinite(logicalWidth) ||
    !Number.isFinite(logicalHeight) ||
    logicalWidth <= 0 ||
    logicalHeight <= 0 ||
    !Number.isFinite(available.width) ||
    !Number.isFinite(available.height) ||
    available.width <= 0 ||
    available.height <= 0
  ) {
    return EMPTY
  }

  // The tighter of the two constraints decides, which is what keeps the whole
  // recording inside the box on both axes.
  const scale = Math.min(available.width / logicalWidth, available.height / logicalHeight)

  return {
    size: {
      width: logicalWidth * scale,
      height: logicalHeight * scale,
    },
    scale,
  }
}

/** Formats a millisecond duration as `m:ss.d`, for the replay time readout. */
export function formatReplayTime(timeMs: number): string {
  const safe = Number.isFinite(timeMs) && timeMs > 0 ? timeMs : 0
  const totalSeconds = safe / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60
  // One decimal: replay is scrubbed at a granularity where tenths matter.
  const secondsText = seconds.toFixed(1).padStart(4, '0')
  return `${String(minutes)}:${secondsText}`
}
