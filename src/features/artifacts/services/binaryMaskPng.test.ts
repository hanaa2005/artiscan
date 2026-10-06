/**
 * The binary mask contract.
 *
 * The claim this file defends is narrow and absolute: every channel of every
 * pixel is 0 or 255. A mask with a grey fringe is an anti-aliased image wearing
 * the word "binary", and downstream code that thresholds it would be making up
 * its own answer at every edge.
 *
 * The byte assertions run against `maskToRgbaBytes`, which is exactly what the
 * encoder hands to `putImageData`. jsdom has no 2D context, so the PNG encode
 * step itself is verified in Chrome - see docs/graph-mask-manual-test-checklist.md.
 */

import { describe, expect, it } from 'vitest'
import {
  MASK_BACKGROUND_VALUE,
  MASK_FOREGROUND_VALUE,
  buildBinaryMask,
  buildBinaryMaskFileName,
  maskToRgbaBytes,
  selectStrokesForMode,
} from './binaryMaskPng'
import {
  makeClearAction,
  makePoint,
  makeSession,
  makeStroke,
  makeUndoAction,
} from '../../drawing/testing/sessionFixture'
import type { DrawingSession, PointSample } from '../../drawing/types/drawing.types'

const CANVAS = { width: 40, height: 20, devicePixelRatio: 1 }

function pointAt(sequence: number, x: number, y: number): PointSample {
  return makePoint({
    sequence,
    timeMs: sequence * 10,
    x,
    y,
    normalizedX: Math.min(1, Math.max(0, x / CANVAS.width)),
    normalizedY: Math.min(1, Math.max(0, y / CANVAS.height)),
  })
}

function strokeOf(id: string, order: number, points: PointSample[], width = 2) {
  const first = points[0]
  const last = points[points.length - 1]
  return makeStroke({
    id,
    order,
    width,
    points,
    startedAtMs: first?.timeMs ?? 0,
    endedAtMs: last?.timeMs ?? 0,
  })
}

/** A two-stroke session on the small canvas. */
function twoStrokeSession(extra: Partial<DrawingSession> = {}): DrawingSession {
  return makeSession({
    canvas: CANVAS,
    strokes: [
      strokeOf('a', 0, [pointAt(1, 5, 5), pointAt(2, 15, 5)]),
      strokeOf('b', 1, [pointAt(3, 5, 15), pointAt(4, 15, 15)]),
    ],
    actions: [],
    ...extra,
  })
}

describe('binary mask - pixel value contract', () => {
  it('emits only 0 and 255 in every colour channel', () => {
    const bytes = maskToRgbaBytes(buildBinaryMask(twoStrokeSession(), 'full_process'))

    for (let i = 0; i < bytes.length; i += 4) {
      for (const channel of [0, 1, 2]) {
        const value = bytes[i + channel]
        expect(value === MASK_BACKGROUND_VALUE || value === MASK_FOREGROUND_VALUE).toBe(true)
      }
    }
  })

  it('contains none of the intermediate values an anti-aliased edge produces', () => {
    const bytes = maskToRgbaBytes(buildBinaryMask(twoStrokeSession(), 'full_process'))
    const seen = new Set(bytes)

    for (const forbidden of [1, 64, 127, 200, 254]) {
      expect(seen.has(forbidden)).toBe(false)
    }
  })

  it('uses exactly two distinct greyscale values across the whole image', () => {
    const bytes = maskToRgbaBytes(buildBinaryMask(twoStrokeSession(), 'full_process'))
    const greys = new Set<number>()
    for (let i = 0; i < bytes.length; i += 4) {
      const value = bytes[i]
      if (value !== undefined) greys.add(value)
    }

    expect([...greys].sort((a, b) => a - b)).toEqual([0, 255])
  })

  it('is fully opaque everywhere - no transparency to read as a third tone', () => {
    const bytes = maskToRgbaBytes(buildBinaryMask(twoStrokeSession(), 'full_process'))
    for (let i = 3; i < bytes.length; i += 4) {
      expect(bytes[i]).toBe(255)
    }
  })

  it('keeps the three channels of a pixel identical, so the file is truly greyscale', () => {
    const bytes = maskToRgbaBytes(buildBinaryMask(twoStrokeSession(), 'full_process'))
    for (let i = 0; i < bytes.length; i += 4) {
      expect(bytes[i + 1]).toBe(bytes[i])
      expect(bytes[i + 2]).toBe(bytes[i])
    }
  })
})

describe('binary mask - dimensions', () => {
  it('is exactly the logical canvas, never scaled', () => {
    const mask = buildBinaryMask(twoStrokeSession(), 'full_process')

    expect(mask.width).toBe(CANVAS.width)
    expect(mask.height).toBe(CANVAS.height)
    expect(mask.data.length).toBe(CANVAS.width * CANVAS.height)
  })

  it('produces one RGBA quad per pixel', () => {
    const mask = buildBinaryMask(twoStrokeSession(), 'full_process')
    expect(maskToRgbaBytes(mask).length).toBe(mask.width * mask.height * 4)
  })

  it('survives a session whose strokes lie entirely outside the canvas', () => {
    const session = makeSession({
      canvas: CANVAS,
      strokes: [strokeOf('a', 0, [pointAt(1, -80, -80), pointAt(2, -60, -70)])],
      actions: [],
    })
    const mask = buildBinaryMask(session, 'full_process')

    // Correct dimensions, and nothing painted: the geometry is clipped away,
    // never allowed to resize the image.
    expect(mask.width).toBe(CANVAS.width)
    expect(mask.height).toBe(CANVAS.height)
    expect(mask.data.some((value) => value !== 0)).toBe(false)
  })

  it('paints the visible part of a stroke that crosses the boundary', () => {
    const session = makeSession({
      canvas: CANVAS,
      strokes: [strokeOf('a', 0, [pointAt(1, -30, 10), pointAt(2, 70, 10)])],
      actions: [],
    })
    const mask = buildBinaryMask(session, 'full_process')

    expect(mask.data.some((value) => value !== 0)).toBe(true)
  })

  it('paints a stroke drawn exactly on the boundary', () => {
    const session = makeSession({
      canvas: CANVAS,
      strokes: [strokeOf('a', 0, [pointAt(1, 0, 0), pointAt(2, 0, 19)])],
      actions: [],
    })
    expect(buildBinaryMask(session, 'full_process').data.some((v) => v !== 0)).toBe(true)
  })

  it('makes a wider stroke cover more pixels', () => {
    const thin = makeSession({
      canvas: CANVAS,
      strokes: [strokeOf('a', 0, [pointAt(1, 5, 10), pointAt(2, 35, 10)], 1)],
      actions: [],
    })
    const thick = makeSession({
      canvas: CANVAS,
      strokes: [strokeOf('a', 0, [pointAt(1, 5, 10), pointAt(2, 35, 10)], 6)],
      actions: [],
    })

    const thinCount = buildBinaryMask(thin, 'full_process').data.filter((v) => v !== 0).length
    const thickCount = buildBinaryMask(thick, 'full_process').data.filter((v) => v !== 0).length
    expect(thickCount).toBeGreaterThan(thinCount)
  })
})

describe('binary mask - full process versus final visible', () => {
  it('covers every stroke in full_process mode', () => {
    expect(selectStrokesForMode(twoStrokeSession(), 'full_process')).toHaveLength(2)
  })

  it('drops an undone stroke from final_visible but keeps it in full_process', () => {
    const session = twoStrokeSession({ actions: [makeUndoAction('b', 100)] })

    expect(selectStrokesForMode(session, 'full_process')).toHaveLength(2)
    const visible = selectStrokesForMode(session, 'final_visible')
    expect(visible).toHaveLength(1)
    expect(visible[0]?.id).toBe('a')
  })

  it('drops cleared strokes from final_visible but keeps them in full_process', () => {
    const session = twoStrokeSession({ actions: [makeClearAction(['a', 'b'], 100)] })

    expect(selectStrokesForMode(session, 'full_process')).toHaveLength(2)
    expect(selectStrokesForMode(session, 'final_visible')).toHaveLength(0)
  })

  it('paints strictly fewer pixels in final_visible when something was undone', () => {
    const session = twoStrokeSession({ actions: [makeUndoAction('b', 100)] })

    const full = buildBinaryMask(session, 'full_process').data.filter((v) => v !== 0).length
    const final = buildBinaryMask(session, 'final_visible').data.filter((v) => v !== 0).length
    expect(final).toBeLessThan(full)
    expect(final).toBeGreaterThan(0)
  })

  it('produces an empty final_visible mask after a clear, without failing', () => {
    const session = twoStrokeSession({ actions: [makeClearAction(['a', 'b'], 100)] })
    const mask = buildBinaryMask(session, 'final_visible')

    expect(mask.width).toBe(CANVAS.width)
    expect(mask.data.some((value) => value !== 0)).toBe(false)
  })

  it('produces identical masks in both modes when nothing was hidden', () => {
    const session = twoStrokeSession()

    expect(buildBinaryMask(session, 'final_visible').data).toEqual(
      buildBinaryMask(session, 'full_process').data,
    )
  })

  it('keeps a stroke visible in final_visible after undo then redo', () => {
    const session = twoStrokeSession({
      actions: [makeUndoAction('b', 100), { sequence: 900, timeMs: 200, type: 'redo', payload: { strokeId: 'b' } }],
    })
    expect(selectStrokesForMode(session, 'final_visible')).toHaveLength(2)
  })
})

describe('binary mask - purity and determinism', () => {
  it('never mutates the session', () => {
    const session = twoStrokeSession({ actions: [makeUndoAction('b', 100)] })
    const before = structuredClone(session)

    buildBinaryMask(session, 'full_process')
    buildBinaryMask(session, 'final_visible')

    expect(session).toEqual(before)
  })

  it('produces identical output from identical input', () => {
    const session = twoStrokeSession()

    expect(buildBinaryMask(session, 'full_process').data).toEqual(
      buildBinaryMask(session, 'full_process').data,
    )
  })

  it('handles an empty session', () => {
    const session = makeSession({ canvas: CANVAS, strokes: [], actions: [] })
    const mask = buildBinaryMask(session, 'full_process')

    expect(mask.width).toBe(CANVAS.width)
    expect(mask.data.some((value) => value !== 0)).toBe(false)
  })

  it('handles a single-point stroke as a dot rather than nothing', () => {
    const session = makeSession({
      canvas: CANVAS,
      strokes: [strokeOf('a', 0, [pointAt(1, 20, 10)], 4)],
      actions: [],
    })
    expect(buildBinaryMask(session, 'full_process').data.some((v) => v !== 0)).toBe(true)
  })
})

describe('binary mask - file naming', () => {
  it('names the two modes distinctly', () => {
    const full = buildBinaryMaskFileName('abcdef1234', '1405-05-27', 'full_process')
    const final = buildBinaryMaskFileName('abcdef1234', '1405-05-27', 'final_visible')

    expect(full).toBe('artiscan-full-process-binary-mask-abcdef12-1405-05-27.png')
    expect(final).toBe('artiscan-final-visible-binary-mask-abcdef12-1405-05-27.png')
    expect(full).not.toBe(final)
  })

  it('says "binary" in the name only for this renderer', () => {
    expect(buildBinaryMaskFileName('a', 's', 'full_process')).toContain('binary-mask')
  })
})
