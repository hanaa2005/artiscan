/**
 * WEEK 1A - Canvas dimension integrity.
 *
 * THE OBSERVATION
 *
 *     session.canvas.width = 718
 *     point.x              = 721.6
 *     point.normalizedX    = 1
 *
 * Five explanations were possible: a genuine excursion past the edge, pointer
 * capture recording outside movement, a resize during the session, a mismatch
 * between the capture-time and export-time canvas size, or browser zoom / DPR.
 *
 * These tests establish which mechanisms actually produce that shape, so the
 * policy that follows rests on evidence rather than on a guess. Two of the five
 * are confirmed here; the rest are shown NOT to produce it on their own.
 *
 * THE POLICY THE TESTS PIN DOWN
 *
 *   - raw x / y are recorded EXACTLY as captured and are never clamped;
 *   - normalizedX / normalizedY ARE clamped to 0..1, because they exist to
 *     drive rendering at any canvas size and a value of 1.8 would paint off
 *     the surface;
 *   - therefore normalized coordinates are a LOSSY, render-oriented derivation
 *     and raw coordinates are authoritative. Anything asking "was the pointer
 *     outside?" must read raw x / y against the canvas rectangle - which is
 *     exactly what feature extraction already does.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { toNormalized } from './coordinates'
import { toRawSample } from './pointerInput'
import { useDrawingSession, type RawPointerSample } from '../hooks/useDrawingSession'

/** The canvas from the reported session. */
const CANVAS = { width: 718, height: 500 }

function rect(width = CANVAS.width, height = CANVAS.height): DOMRect {
  return { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 } as DOMRect
}

function pointerEvent(clientX: number, clientY: number): PointerEvent {
  return {
    pointerId: 1,
    pointerType: 'mouse',
    timeStamp: 1000,
    clientX,
    clientY,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
  } as PointerEvent
}

function rawSampleAt(x: number, y: number, size = CANVAS): RawPointerSample {
  const { normalizedX, normalizedY } = toNormalized(x, y, size)
  return {
    x,
    y,
    normalizedX,
    normalizedY,
    pressure: null,
    tiltX: null,
    tiltY: null,
    pointerType: 'mouse',
  }
}

describe('canvas dimensions - which mechanism produces x > canvas.width', () => {
  it('CONFIRMED: pointer capture outside the canvas reproduces the exact reported values', () => {
    // No resize, no zoom, no DPR effect. The pointer simply travelled 3.6 px
    // past the right edge while captured, which is what setPointerCapture is
    // for - it keeps the stroke intact instead of truncating it at the border.
    const sample = toRawSample(pointerEvent(721.6, 220.6), rect(), CANVAS)

    expect(sample.x).toBe(721.6)
    expect(sample.normalizedX).toBe(1)
    // The reported shape, reproduced from this mechanism alone.
    expect(sample.x).toBeGreaterThan(CANVAS.width)
  })

  it('CONFIRMED: a resize between capture and export pairs raw pixels with a smaller canvas', () => {
    /*
      buildSession() stamps the canvas size at EXPORT time. A point captured
      well inside a 900 px canvas is therefore paired with a 718 px descriptor
      if the window shrank before the export, and reads as "outside" even
      though the pointer never left the surface.

      The raw data is not damaged - normalizedX was computed against the
      capture-time size and still replays correctly - but the raw-pixel /
      descriptor pairing is only trustworthy when no resize occurred. This is
      recorded as a known limitation rather than papered over.
    */
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      // Captured while the canvas was 900 px wide.
      result.current.beginStroke(rawSampleAt(721.6, 220.6, { width: 900, height: 500 }))
      result.current.endStroke()
    })

    // Exported after the window shrank to 718 px.
    const session = result.current.buildSession(CANVAS)
    const point = session.strokes[0]?.points[0]

    expect(point?.x).toBe(721.6)
    expect(session.canvas.width).toBe(718)
    // Normalized was captured against 900 and is well inside the surface, so
    // replay is unaffected: this is a descriptor-pairing issue, not lost data.
    expect(point?.normalizedX).toBeCloseTo(0.80178, 4)
  })

  it('NOT a cause: drawing in the middle of the canvas', () => {
    const sample = toRawSample(pointerEvent(359, 250), rect(), CANVAS)

    expect(sample.x).toBe(359)
    expect(sample.normalizedX).toBeCloseTo(0.5, 5)
    expect(sample.x).toBeLessThan(CANVAS.width)
  })

  it('NOT a cause: a point exactly on the boundary', () => {
    const sample = toRawSample(pointerEvent(CANVAS.width, CANVAS.height), rect(), CANVAS)

    // Exactly 1, and exactly equal to the width - not beyond it.
    expect(sample.x).toBe(CANVAS.width)
    expect(sample.normalizedX).toBe(1)
    expect(sample.normalizedY).toBe(1)
  })

  it.each([1, 1.25, 2, 3])('NOT a cause: devicePixelRatio %s', (ratio) => {
    /*
      clientX and getBoundingClientRect() are both in CSS pixels, so their
      difference is independent of the device pixel ratio. DPR is recorded in
      the session descriptor as context, and it never enters the coordinate
      maths.
    */
    const original = window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', { value: ratio, configurable: true })
    try {
      const sample = toRawSample(pointerEvent(359, 250), rect(), CANVAS)
      expect(sample.x).toBe(359)
      expect(sample.normalizedX).toBeCloseTo(0.5, 5)
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        value: original,
        configurable: true,
      })
    }
  })

  it('records the devicePixelRatio in the session descriptor', () => {
    const original = window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
    try {
      const { result } = renderHook(() => useDrawingSession())
      expect(result.current.buildSession(CANVAS).canvas.devicePixelRatio).toBe(2)
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        value: original,
        configurable: true,
      })
    }
  })

  it('subtracts the canvas origin, so page scroll and layout offset do not leak in', () => {
    // A canvas 200 px from the left of the viewport: a click at clientX 300 is
    // at canvas x 100, not 300.
    const offsetRect = { ...rect(), left: 200, top: 50 } as DOMRect
    const sample = toRawSample(pointerEvent(300, 150), offsetRect, CANVAS)

    expect(sample.x).toBe(100)
    expect(sample.y).toBe(100)
  })
})

describe('canvas dimensions - the raw / normalized contract', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('never clamps raw coordinates, in any direction', () => {
    const beyondRight = toRawSample(pointerEvent(900, 250), rect(), CANVAS)
    const beforeLeft = toRawSample(pointerEvent(-120, -35), rect(), CANVAS)

    expect(beyondRight.x).toBe(900)
    expect(beforeLeft.x).toBe(-120)
    expect(beforeLeft.y).toBe(-35)
  })

  it('clamps normalized coordinates in both directions', () => {
    const beyondRight = toRawSample(pointerEvent(900, 900), rect(), CANVAS)
    const beforeLeft = toRawSample(pointerEvent(-120, -35), rect(), CANVAS)

    expect(beyondRight.normalizedX).toBe(1)
    expect(beyondRight.normalizedY).toBe(1)
    expect(beforeLeft.normalizedX).toBe(0)
    expect(beforeLeft.normalizedY).toBe(0)
  })

  it('keeps "the pointer was outside" recoverable from the stored session', () => {
    // The clamped normalized value hides the excursion; the raw value does not.
    // Any consumer that needs the truth reads raw against canvas - which is
    // what outsideCanvasPointCount already does.
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginStroke(rawSampleAt(300, 250))
      result.current.extendStroke([rawSampleAt(721.6, 220.6)])
      result.current.endStroke()
    })

    const session = result.current.buildSession(CANVAS)
    const points = session.strokes[0]?.points ?? []
    const outside = points.filter(
      (point) =>
        point.x < 0 ||
        point.y < 0 ||
        point.x > session.canvas.width ||
        point.y > session.canvas.height,
    )

    expect(points).toHaveLength(2)
    expect(outside).toHaveLength(1)
    expect(outside[0]?.x).toBe(721.6)
  })

  it('preserves a stroke that starts inside and is dragged outside', () => {
    // Pointer capture keeps delivering events; not one of them may be dropped.
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginStroke(rawSampleAt(700, 250))
      result.current.extendStroke([
        rawSampleAt(715, 250),
        rawSampleAt(730, 250),
        rawSampleAt(760, 255),
      ])
      result.current.endStroke()
    })

    const points = result.current.strokes[0]?.points ?? []
    expect(points.map((point) => point.x)).toEqual([700, 715, 730, 760])
  })

  it('does not retroactively make a boundary point outside when the canvas shrinks', () => {
    /*
      A point captured exactly on the edge of a 900 px canvas keeps its raw x of
      900 and its normalizedX of 1. Re-exported against a 718 px canvas its raw
      value now exceeds the descriptor - which is precisely why REPLAY reads the
      normalized value, and why the normalized value is the resize-safe one.
    */
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginStroke(rawSampleAt(900, 250, { width: 900, height: 500 }))
      result.current.endStroke()
    })

    const point = result.current.buildSession(CANVAS).strokes[0]?.points[0]
    expect(point?.normalizedX).toBe(1)
    expect(point?.x).toBe(900)
  })

  it('maps a zero-sized canvas to 0 rather than NaN', () => {
    // Before first layout the container measures 0x0; dividing by it must not
    // poison the record with NaN or Infinity.
    const sample = toRawSample(pointerEvent(50, 50), rect(0, 0), { width: 0, height: 0 })

    expect(sample.normalizedX).toBe(0)
    expect(sample.normalizedY).toBe(0)
    expect(Number.isFinite(sample.x)).toBe(true)
  })
})
