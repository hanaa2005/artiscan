/**
 * True binary masks, in both modes.
 *
 * WHY THIS IS NOT THE OTHER MASK RENDERER
 *
 * `renderReconstructionMaskPng` draws paths onto a canvas, and the browser
 * anti-aliases every edge it draws. Its policy says so, and its numbers are not
 * used for measurement - but the pixels it produces run the whole 0..255 range
 * along every stroke boundary. A file like that must never be called binary.
 *
 * This renderer never draws. It rasterizes with the pure, deterministic
 * coverage model in utils/rasterMask (centre sampling against a capsule chain),
 * expands the result to bytes, and writes it straight into the canvas with
 * `putImageData` - which copies pixels verbatim and cannot introduce an
 * intermediate value. PNG is lossless, so what comes out is exactly what went
 * in: every channel of every pixel is 0 or 255, and nothing else.
 *
 * TWO MASKS, TWO QUESTIONS
 *
 *   full_process   every stroke in the append-only history, whatever became of
 *                  it - the shape of everything that was drawn.
 *   final_visible  only the strokes still painted at the end - the shape of the
 *                  finished drawing, matching the final replay state and the
 *                  clean PNG.
 *
 * Neither mask is evidence in itself. Both are lossy, derived pictures of a
 * session that remains the source of truth.
 */

import type { DrawingSession, DrawingStroke } from '../../drawing/types/drawing.types'
import { computeVisibleStrokes } from '../../drawing/utils/strokeVisibility'
import { rasterizeStrokes, MASK_RENDERER_VERSION, type BinaryMask } from '../utils/rasterMask'
import type { GraphMode } from '../types/criticalTrajectory.types'

/** Bumped when the pixels this file produces change meaning. */
export const BINARY_MASK_RENDERER_VERSION = 'binary-mask-1'

/**
 * The two values a channel may hold. Stated as constants because the whole
 * contract of this file is that nothing between them ever appears.
 */
export const MASK_BACKGROUND_VALUE = 0
export const MASK_FOREGROUND_VALUE = 255

/** Everything needed to reproduce a binary mask exactly. */
export interface BinaryMaskPolicy {
  rendererVersion: string
  coverageModelVersion: string
  mode: GraphMode
  /** Pixel dimensions, always the session's logical canvas. */
  width: number
  height: number
  /** Ink. Written to R, G and B alike, with alpha 255. */
  foregroundValue: number
  /** Everything else. Fully opaque, so the file has no transparency at all. */
  backgroundValue: number
  /**
   * Stated explicitly: there is none, by construction rather than by threshold.
   * No edge is ever softened, so no threshold is needed to harden it again.
   */
  antiAliasing: 'none'
  /** How out-of-canvas geometry is treated. */
  outOfBoundsPolicy: 'clipped_to_canvas'
  /** Strokes that contributed ink. */
  strokeCount: number
  /** Foreground pixels, for a cheap sanity check against the image. */
  coveredPixelCount: number
}

export interface RenderedBinaryMask {
  blob: Blob
  policy: BinaryMaskPolicy
}

/** The strokes a mode covers. Pure; never mutates the session. */
export function selectStrokesForMode(
  session: DrawingSession,
  mode: GraphMode,
): readonly DrawingStroke[] {
  return mode === 'final_visible'
    ? computeVisibleStrokes(session.strokes, session.actions)
    : session.strokes
}

/**
 * Rasterizes a session into a binary mask.
 *
 * Eraser strokes are treated as ink like any other stroke. A mask answers
 * "where did the pen go", and an eraser stroke is somewhere the pen went; the
 * question of what the drawing LOOKS like is answered by the clean PNG, which
 * composites properly. Conflating the two here would make the mask silently
 * disagree with the stroke count beside it.
 */
export function buildBinaryMask(session: DrawingSession, mode: GraphMode): BinaryMask {
  const strokes = selectStrokesForMode(session, mode)
  return rasterizeStrokes(
    strokes.map((stroke) => ({
      points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
      width: stroke.width,
    })),
    { width: session.canvas.width, height: session.canvas.height },
  )
}

/** Counts foreground pixels in a mask. */
function countForeground(mask: BinaryMask): number {
  let total = 0
  for (const value of mask.data) {
    if (value !== 0) total += 1
  }
  return total
}

/**
 * Expands a coverage mask to RGBA bytes.
 *
 * Exported so a test can assert the byte contract WITHOUT decoding a PNG:
 * the encoder below writes exactly these bytes and PNG does not change them.
 */
export function maskToRgbaBytes(mask: BinaryMask): Uint8ClampedArray {
  const bytes = new Uint8ClampedArray(mask.width * mask.height * 4)
  for (let i = 0; i < mask.data.length; i += 1) {
    const value = mask.data[i] === 0 ? MASK_BACKGROUND_VALUE : MASK_FOREGROUND_VALUE
    const offset = i * 4
    bytes[offset] = value
    bytes[offset + 1] = value
    bytes[offset + 2] = value
    // Fully opaque everywhere: a transparent background would let a viewer's
    // own backdrop show through and make the file look like it has more than
    // two tones.
    bytes[offset + 3] = 255
  }
  return bytes
}

/**
 * Renders a binary mask PNG for one mode.
 *
 * Never scaled: the output is always the session's logical canvas, pixel for
 * pixel. Resampling is precisely what would reintroduce intermediate values.
 */
export async function renderBinaryMaskPng(
  session: DrawingSession,
  mode: GraphMode,
): Promise<RenderedBinaryMask> {
  const mask = buildBinaryMask(session, mode)

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, mask.width)
  canvas.height = Math.max(1, mask.height)
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('امکان ساخت بوم خروجی وجود ندارد.')
  }

  // putImageData writes the bytes verbatim - no compositing, no smoothing, no
  // alpha blending. This is the step that makes the binary guarantee hold.
  const image = context.createImageData(canvas.width, canvas.height)
  image.data.set(maskToRgbaBytes(mask))
  context.putImageData(image, 0, 0)

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result === null) {
        reject(new Error('ساخت تصویر PNG ناموفق بود.'))
        return
      }
      resolve(result)
    }, 'image/png')
  })

  return {
    blob,
    policy: {
      rendererVersion: BINARY_MASK_RENDERER_VERSION,
      coverageModelVersion: MASK_RENDERER_VERSION,
      mode,
      width: mask.width,
      height: mask.height,
      foregroundValue: MASK_FOREGROUND_VALUE,
      backgroundValue: MASK_BACKGROUND_VALUE,
      antiAliasing: 'none',
      outOfBoundsPolicy: 'clipped_to_canvas',
      strokeCount: selectStrokesForMode(session, mode).length,
      coveredPixelCount: countForeground(mask),
    },
  }
}

/** The filename for a binary mask, with its mode. */
export function buildBinaryMaskFileName(
  sessionId: string,
  stamp: string,
  mode: GraphMode,
): string {
  const slug = mode === 'final_visible' ? 'final-visible' : 'full-process'
  return `artiscan-${slug}-binary-mask-${sessionId.slice(0, 8)}-${stamp}.png`
}
