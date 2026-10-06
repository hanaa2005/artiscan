/**
 * The two new PNG artifacts, and the line between them.
 *
 *   RECONSTRUCTION MASK  black background, white path, nothing else. Meant to
 *                        be compared pixel by pixel, by a machine.
 *   CRITICAL TRAJECTORY  the simplified path with markers, colours and a
 *                        legend. Meant to be looked at, by a person.
 *
 * NEITHER OF THEM IS clean.png. The clean export renders the drawing as the
 * participant made it and is untouched by this file - no marker, no node id, no
 * legend ever reaches it. Mixing diagnostic overlay into the artifact that
 * represents the drawing itself would make the record unusable as a record.
 *
 * Both renderers work in the session's LOGICAL canvas space and are independent
 * of device pixel ratio: a diagnostic image that changed size with the reader's
 * monitor could not be compared with anything.
 */

import type {
  CriticalNode,
  CriticalPointReason,
  CriticalTrajectoryArtifactV2,
  GraphMode,
} from '../types/criticalTrajectory.types'
import type { StrokeStatus } from '../../drawing/utils/strokeVisibility'
import type { DrawingSession } from '../../drawing/types/drawing.types'

/** Bumped when the pixels this file produces change meaning. */
export const ARTIFACT_PNG_RENDERER_VERSION = 'artifact-png-2'

/** Everything needed to reproduce a mask exactly. Recorded in the sidecar. */
export interface MaskRenderPolicy {
  sourceCanvasSize: { width: number; height: number }
  outputMaskSize: { width: number; height: number }
  /** How the source was mapped onto the output. */
  scalePolicy: 'identity' | 'uniform_fit'
  /** How stroke widths were treated. */
  strokeWidthPolicy: 'source_width_scaled'
  rendererVersion: string
  lineCap: 'round'
  lineJoin: 'round'
  antiAliasing: 'browser_default'
}

export interface MaskRenderOptions {
  /**
   * Output size. Defaults to the logical canvas, i.e. no resampling at all.
   *
   * A fixed-size mask for later machine learning is a DIFFERENT artifact with a
   * different meaning, so asking for one is explicit and is recorded in the
   * returned policy. Nothing is ever silently resized.
   */
  outputSize?: { width: number; height: number }
}

/** A rendered PNG plus the policy that produced it. */
export interface RenderedMask {
  blob: Blob
  policy: MaskRenderPolicy
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('ساخت تصویر PNG ناموفق بود.'))
        return
      }
      resolve(blob)
    }, 'image/png')
  })
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('امکان ساخت بوم خروجی وجود ندارد.')
  }
  return context
}

/**
 * Renders the reconstruction mask.
 *
 * Strictly two-tone by intent: pure black ground, pure white ink, no text, no
 * marker, no stroke colour. The browser still anti-aliases the edges, which is
 * why the policy records `antiAliasing: 'browser_default'` and why the IoU
 * figures in the quality block come from the pure rasterizer in
 * utils/rasterMask.ts rather than from these pixels.
 */
export async function renderReconstructionMaskPng(
  artifact: CriticalTrajectoryArtifactV2,
  session: DrawingSession,
  options: MaskRenderOptions = {},
): Promise<RenderedMask> {
  const source = { width: artifact.canvas.width, height: artifact.canvas.height }
  const output = options.outputSize ?? source

  // Uniform scale so the shape is never distorted, whatever output was asked for.
  const scale = Math.min(output.width / source.width, output.height / source.height)

  const canvas = createCanvas(output.width, output.height)
  const context = context2d(canvas)

  context.fillStyle = '#000000'
  context.fillRect(0, 0, canvas.width, canvas.height)

  context.strokeStyle = '#ffffff'
  context.fillStyle = '#ffffff'
  context.lineCap = 'round'
  context.lineJoin = 'round'

  // Group the artifact's nodes back into their strokes: the mask shows the
  // RECONSTRUCTED path, which is what the quality numbers describe.
  const byStroke = new Map<string, Array<{ x: number; y: number }>>()
  for (const node of artifact.nodes) {
    const list = byStroke.get(node.strokeId) ?? []
    list.push({ x: node.x * scale, y: node.y * scale })
    byStroke.set(node.strokeId, list)
  }

  const widthOf = new Map(session.strokes.map((stroke) => [stroke.id, stroke.width]))

  for (const [strokeId, points] of byStroke) {
    // Widths come from the raw stroke, scaled with the geometry.
    context.lineWidth = Math.max(1, (widthOf.get(strokeId) ?? 4) * scale)

    if (points.length === 1) {
      // A tap must appear, or the mask would omit a real observation.
      const only = points[0]!
      context.beginPath()
      context.arc(only.x, only.y, context.lineWidth / 2, 0, Math.PI * 2)
      context.fill()
      continue
    }

    context.beginPath()
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y)
      else context.lineTo(point.x, point.y)
    })
    context.stroke()
  }

  return {
    blob: await toBlob(canvas),
    policy: {
      sourceCanvasSize: source,
      outputMaskSize: { width: canvas.width, height: canvas.height },
      scalePolicy: options.outputSize === undefined ? 'identity' : 'uniform_fit',
      strokeWidthPolicy: 'source_width_scaled',
      rendererVersion: ARTIFACT_PNG_RENDERER_VERSION,
      lineCap: 'round',
      lineJoin: 'round',
      antiAliasing: 'browser_default',
    },
  }
}

/** Colour per reason. Diagnostic only - these never appear in clean.png. */
const REASON_COLORS: Record<CriticalPointReason, string> = {
  stroke_start: '#2f9e44',
  stroke_end: '#e03131',
  single_point_stroke: '#f08c00',
  temporal_gap_boundary: '#1971c2',
  direction_change: '#9c36b5',
  pressure_change: '#0c8599',
  canvas_entry: '#5c940d',
  canvas_exit: '#c2255c',
  geometric_support: '#868e96',
}

/** The reason a node is coloured by: the first one that is not mere support. */
function primaryReason(reasons: readonly CriticalPointReason[]): CriticalPointReason {
  const meaningful = reasons.find((reason) => reason !== 'geometric_support')
  return meaningful ?? 'geometric_support'
}

/**
 * How each stroke status is drawn.
 *
 * Colour is NEVER the only signal. Line style and opacity carry the same
 * information, so the graph stays readable in greyscale, in print, and to a
 * reader with a colour vision deficiency.
 */
const STATUS_STYLES: Record<
  StrokeStatus,
  { color: string; dash: number[]; alpha: number; lineWidth: number; labelFa: string }
> = {
  visible: { color: '#1c7ed6', dash: [], alpha: 1, lineWidth: 2, labelFa: 'قابل مشاهده' },
  cleared: { color: '#e8590c', dash: [7, 4], alpha: 0.5, lineWidth: 1.5, labelFa: 'پاک‌شده' },
  undone: { color: '#868e96', dash: [1.5, 3], alpha: 0.5, lineWidth: 1.5, labelFa: 'واگردشده' },
}

/** At most this many direction arrows per stroke, however long it is. */
const MAX_ARROWS_PER_STROKE = 3

/** A stroke shorter than this in pixels gets no arrow - it would be illegible. */
const MIN_ARROW_SEGMENT_PX = 14

/** Draws a small filled arrow head at (x, y) pointing along (dx, dy). */
function drawArrowHead(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  dx: number,
  dy: number,
  size: number,
): void {
  const length = Math.hypot(dx, dy)
  if (length === 0) return
  const ux = dx / length
  const uy = dy / length
  // Perpendicular, for the two barbs.
  const px = -uy
  const py = ux

  context.beginPath()
  context.moveTo(x, y)
  context.lineTo(x - ux * size + px * size * 0.5, y - uy * size + py * size * 0.5)
  context.lineTo(x - ux * size - px * size * 0.5, y - uy * size - py * size * 0.5)
  context.closePath()
  context.fill()
}

export interface CriticalPngOptions {
  /**
   * Draw the per-node critical-point markers, coloured by why each was kept.
   *
   * OFF by default. They are a simplification diagnostic, and on a dense
   * trajectory they bury the thing this image is for - the order, direction and
   * fate of the strokes - under a smear of dots.
   */
  showReasonMarkers?: boolean
  /** Draw the legend. On by default. */
  showLegend?: boolean
  /** Draw the S01/S02 stroke labels. On by default. */
  showStrokeLabels?: boolean
  /** Draw direction arrows along each stroke. On by default. */
  showDirection?: boolean
}

/**
 * Renders the process graph.
 *
 * WHAT THIS IMAGE HAS TO ANSWER
 *
 *   which stroke is which      -> a stable S01/S02 label at each start
 *   in what order              -> the labels are the canonical order
 *   in which direction         -> arrows along the path
 *   where each began and ended -> distinct start and end markers
 *   what became of it          -> line style and opacity per status
 *
 * WHAT IT MUST NOT DO
 *
 * Draw a line between two strokes. The pen was lifted in between, so any mark
 * there is travel that never touched the surface. Undo, redo and clear likewise
 * get no spatial representation at all: they happened in time, not in a place.
 *
 * Points recorded outside the canvas are drawn in a margin around the surface
 * rather than clipped away - they are part of what happened, and hiding them
 * would misrepresent the recording.
 */
export async function renderCriticalTrajectoryPng(
  artifact: CriticalTrajectoryArtifactV2,
  options: CriticalPngOptions = {},
): Promise<Blob> {
  const showReasonMarkers = options.showReasonMarkers ?? false
  const showLegend = options.showLegend ?? true
  const showStrokeLabels = options.showStrokeLabels ?? true
  const showDirection = options.showDirection ?? true

  // A margin so out-of-canvas excursions remain visible.
  const margin = 40
  const source = artifact.canvas

  /*
    The legend gets a band of its own ABOVE the drawing, and the image grows to
    make room for it.

    The first version drew the legend over the top-left corner of the plot at a
    fixed offset, and Chrome verification showed exactly what that costs: on a
    session whose first stroke runs along the top of the canvas, the legend sat
    on top of that stroke and collided with its `S01` label. A legend that
    obscures the thing it explains is worse than no legend, and the overlap is
    invisible to every test that only reads the artifact.

    The height is computed from the lines that will actually be drawn - the
    statuses present, and whether a direction key is wanted - so an image with
    one status does not reserve space for three.
  */
  const presentStatuses = new Set(artifact.strokes.map((stroke) => stroke.status))
  const legendKeyLines =
    presentStatuses.size + 1 + (showDirection ? 1 : 0) // statuses + start/end + direction
  const legendHeight = showLegend ? 16 + 16 + legendKeyLines * 15 + 8 : 0
  const topOffset = showLegend ? legendHeight + 12 : margin

  const canvas = createCanvas(source.width + margin * 2, source.height + topOffset + margin)
  const context = context2d(canvas)

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)

  // The canvas rectangle, so "inside" and "outside" are visible at a glance.
  context.strokeStyle = '#dee2e6'
  context.lineWidth = 1
  context.setLineDash([])
  context.strokeRect(margin + 0.5, topOffset + 0.5, source.width, source.height)

  const project = (x: number, y: number): [number, number] => [x + margin, y + topOffset]

  const byStroke = new Map<string, CriticalNode[]>()
  for (const node of artifact.nodes) {
    const list = byStroke.get(node.strokeId) ?? []
    list.push(node)
    byStroke.set(node.strokeId, list)
  }

  context.lineCap = 'round'
  context.lineJoin = 'round'

  /*
    Strokes are drawn in canonical order, and each one is drawn completely
    before the next begins. Nothing is ever carried across the boundary: every
    path starts with its own beginPath(), so no line can appear between the end
    of one stroke and the start of the next.
  */
  for (const summary of artifact.strokes) {
    const nodes = byStroke.get(summary.strokeId) ?? []
    if (nodes.length === 0) continue

    const style = STATUS_STYLES[summary.status]

    // --- the path --------------------------------------------------------
    if (nodes.length >= 2) {
      context.save()
      context.globalAlpha = style.alpha
      context.strokeStyle = style.color
      context.lineWidth = style.lineWidth
      context.setLineDash(style.dash)
      context.beginPath()
      nodes.forEach((node, index) => {
        const [x, y] = project(node.x, node.y)
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      context.stroke()
      context.restore()
    }

    // --- direction arrows -------------------------------------------------
    if (showDirection && nodes.length >= 2) {
      context.save()
      context.globalAlpha = style.alpha
      context.fillStyle = style.color
      context.setLineDash([])

      const segmentCount = nodes.length - 1
      const wanted = Math.min(MAX_ARROWS_PER_STROKE, segmentCount)
      const seen = new Set<number>()
      for (let i = 0; i < wanted; i += 1) {
        // Evenly spaced along the segment list, so a long stroke does not get
        // its arrows bunched at one end.
        const index = Math.floor(((i + 0.5) / wanted) * segmentCount)
        if (seen.has(index)) continue
        seen.add(index)

        const from = nodes[index]
        const to = nodes[index + 1]
        if (from === undefined || to === undefined) continue

        const [fx, fy] = project(from.x, from.y)
        const [tx, ty] = project(to.x, to.y)
        const dx = tx - fx
        const dy = ty - fy
        // Too short to carry a readable head; an arrow here would be a blob.
        if (Math.hypot(dx, dy) < MIN_ARROW_SEGMENT_PX) continue

        // The head sits at the segment midpoint, pointing the way the pen went.
        drawArrowHead(context, fx + dx / 2, fy + dy / 2, dx, dy, 7)
      }
      context.restore()
    }

    // --- start and end ----------------------------------------------------
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    context.save()
    context.globalAlpha = style.alpha
    context.setLineDash([])

    if (first !== undefined) {
      const [x, y] = project(first.x, first.y)
      // Start: a filled disc.
      context.fillStyle = '#2f9e44'
      context.beginPath()
      context.arc(x, y, 5, 0, Math.PI * 2)
      context.fill()
      context.strokeStyle = '#1b1b1b'
      context.lineWidth = 1
      context.stroke()
    }

    if (last !== undefined && nodes.length >= 2) {
      const [x, y] = project(last.x, last.y)
      // End: a square, so start and end differ by SHAPE and not only by colour.
      context.fillStyle = '#e03131'
      context.fillRect(x - 4, y - 4, 8, 8)
      context.strokeStyle = '#1b1b1b'
      context.lineWidth = 1
      context.strokeRect(x - 4, y - 4, 8, 8)
    }
    context.restore()

    // --- the label --------------------------------------------------------
    if (showStrokeLabels && first !== undefined) {
      const [x, y] = project(first.x, first.y)
      context.save()
      context.font = 'bold 12px sans-serif'
      // A white halo keeps the label readable over the drawing beneath it.
      context.lineWidth = 3
      context.strokeStyle = '#ffffff'
      context.strokeText(summary.label, x + 8, y - 8)
      context.fillStyle = '#1b1b1b'
      context.fillText(summary.label, x + 8, y - 8)
      context.restore()
    }
  }

  // --- optional per-node simplification diagnostic ------------------------
  if (showReasonMarkers) {
    context.save()
    context.setLineDash([])
    for (const node of artifact.nodes) {
      const [x, y] = project(node.x, node.y)
      const reason = primaryReason(node.reasons)
      context.fillStyle = REASON_COLORS[reason]
      context.beginPath()
      context.arc(x, y, reason === 'geometric_support' ? 2 : 3.5, 0, Math.PI * 2)
      context.fill()
    }
    context.restore()
  }

  // --- legend -------------------------------------------------------------
  if (showLegend) {
    context.save()
    context.setLineDash([])
    context.font = '11px sans-serif'
    context.textAlign = 'left'

    let lineY = 16
    const title =
      artifact.mode === 'final_visible'
        ? 'Final visible graph - strokes on the canvas at the end'
        : 'Full process graph - every recorded stroke'
    context.fillStyle = '#1b1b1b'
    context.font = 'bold 11px sans-serif'
    context.fillText(title, 10, lineY)
    context.font = '11px sans-serif'
    lineY += 16

    // Only the statuses actually present, so the legend never claims a
    // category this image does not contain. Same set the band height above was
    // computed from, so the two can never disagree.
    for (const status of ['visible', 'cleared', 'undone'] as const) {
      if (!presentStatuses.has(status)) continue
      const style = STATUS_STYLES[status]
      context.save()
      context.globalAlpha = style.alpha
      context.strokeStyle = style.color
      context.lineWidth = style.lineWidth
      context.setLineDash(style.dash)
      context.beginPath()
      context.moveTo(10, lineY - 4)
      context.lineTo(40, lineY - 4)
      context.stroke()
      context.restore()

      context.fillStyle = '#1b1b1b'
      context.fillText(`${status} (${style.labelFa})`, 46, lineY)
      lineY += 15
    }

    // Start / end key.
    context.fillStyle = '#2f9e44'
    context.beginPath()
    context.arc(16, lineY - 4, 5, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#1b1b1b'
    context.fillText('start', 26, lineY)
    context.fillStyle = '#e03131'
    context.fillRect(66, lineY - 8, 8, 8)
    context.fillStyle = '#1b1b1b'
    context.fillText('end', 80, lineY)
    lineY += 15

    if (showDirection) {
      context.fillStyle = '#1b1b1b'
      drawArrowHead(context, 22, lineY - 4, 12, 0, 7)
      context.fillText('direction of travel', 30, lineY)
      lineY += 15
    }

    context.fillStyle = '#495057'
    context.fillText('S01, S02, ... = stroke order in the recording', 10, lineY)
    context.restore()
  }

  return toBlob(canvas)
}

export function buildMaskFileName(sessionId: string, stamp: string): string {
  return `artiscan-reconstruction-mask-${sessionId.slice(0, 8)}-${stamp}.png`
}

/**
 * The filename for a process graph PNG.
 *
 * The mode is part of the name: the two images answer different questions and
 * would otherwise be indistinguishable in a downloads folder.
 */
export function buildCriticalPngFileName(
  sessionId: string,
  stamp: string,
  mode: GraphMode = 'full_process',
): string {
  const slug = mode === 'final_visible' ? 'final-visible' : 'full-process'
  return `artiscan-${slug}-graph-${sessionId.slice(0, 8)}-${stamp}.png`
}
