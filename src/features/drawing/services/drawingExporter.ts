/**
 * File downloads: session JSON and flattened PNG.
 *
 * Nothing here touches React - it only receives plain data plus (for PNG) a
 * Konva stage, so it can be reasoned about and replaced independently.
 */

import type Konva from 'konva'
import type { DrawingSession } from '../types/drawing.types'
import { buildSessionFileName, serializeSession } from './drawingSerializer'
import { todayFileStamp } from '../utils/timing'

/** Resolution multiplier for the exported PNG. */
const PNG_PIXEL_RATIO = 2

/**
 * Triggers a browser download for a Blob.
 * The object URL is revoked afterwards, otherwise the blob would stay in memory
 * for the whole lifetime of the page.
 */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/** Downloads the full session as pretty-printed JSON. */
export function downloadSessionJson(session: DrawingSession): void {
  const text = serializeSession(session)
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  downloadBlob(blob, buildSessionFileName(session, todayFileStamp()))
}

/**
 * Downloads the current picture as a PNG with a solid white background.
 *
 * Why the extra offscreen canvas instead of `stage.toDataURL()`:
 * the eraser is implemented with the `destination-out` composite operation,
 * which does not paint white - it makes pixels TRANSPARENT. Exporting the stage
 * directly would produce a PNG with transparent holes, which look black or
 * checkered in most viewers.
 *
 * So we paint white first, then composite the stage on top. The erased areas
 * then correctly show the white background through.
 */
export function downloadStagePng(stage: Konva.Stage, session: DrawingSession): void {
  const source = stage.toCanvas({ pixelRatio: PNG_PIXEL_RATIO })

  const output = document.createElement('canvas')
  output.width = source.width
  output.height = source.height

  const context = output.getContext('2d')
  if (context === null) {
    throw new Error('امکان ساخت بوم خروجی وجود ندارد.')
  }

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, output.width, output.height)
  context.drawImage(source, 0, 0)

  const shortId = session.id.slice(0, 8)
  const fileName = `artiscan-drawing-${shortId}-${todayFileStamp()}.png`

  output.toBlob((blob) => {
    if (blob === null) return
    downloadBlob(blob, fileName)
  }, 'image/png')
}
