/**
 * Segment clipping.
 *
 * The case that matters most is the one a naive implementation gets wrong: a
 * segment whose endpoints are BOTH outside the canvas but which crosses it
 * anyway. Discarding it would silently delete a visible line from the analysis.
 */

import { describe, expect, it } from 'vitest'
import { clipSegmentToCanvas, isOutsidePoint } from './canvasGeometry'

const CANVAS = { width: 100, height: 100 }

describe('isOutsidePoint', () => {
  it('treats a point inside the rectangle as inside', () => {
    expect(isOutsidePoint({ x: 50, y: 50 }, CANVAS)).toBe(false)
  })

  it('treats every boundary as INSIDE - the edge is the last visible pixel', () => {
    expect(isOutsidePoint({ x: 0, y: 50 }, CANVAS)).toBe(false)
    expect(isOutsidePoint({ x: 100, y: 50 }, CANVAS)).toBe(false)
    expect(isOutsidePoint({ x: 50, y: 0 }, CANVAS)).toBe(false)
    expect(isOutsidePoint({ x: 50, y: 100 }, CANVAS)).toBe(false)
    expect(isOutsidePoint({ x: 0, y: 0 }, CANVAS)).toBe(false)
    expect(isOutsidePoint({ x: 100, y: 100 }, CANVAS)).toBe(false)
  })

  it('detects negative coordinates', () => {
    expect(isOutsidePoint({ x: -1, y: 50 }, CANVAS)).toBe(true)
    expect(isOutsidePoint({ x: 50, y: -0.5 }, CANVAS)).toBe(true)
  })

  it('detects coordinates beyond the canvas', () => {
    expect(isOutsidePoint({ x: 101, y: 50 }, CANVAS)).toBe(true)
    expect(isOutsidePoint({ x: 50, y: 100.1 }, CANVAS)).toBe(true)
  })

  it('treats non-finite coordinates as outside - they cannot be drawn anywhere', () => {
    expect(isOutsidePoint({ x: Number.NaN, y: 10 }, CANVAS)).toBe(true)
    expect(isOutsidePoint({ x: 10, y: Number.POSITIVE_INFINITY }, CANVAS)).toBe(true)
  })
})

describe('clipSegmentToCanvas', () => {
  it('keeps a fully inside segment whole', () => {
    const clipped = clipSegmentToCanvas({ x: 10, y: 10 }, { x: 90, y: 90 }, CANVAS)
    expect(clipped).not.toBeNull()
    expect(clipped?.t0).toBe(0)
    expect(clipped?.t1).toBe(1)
    expect(clipped?.from).toEqual({ x: 10, y: 10 })
    expect(clipped?.to).toEqual({ x: 90, y: 90 })
  })

  it('clips a segment with one endpoint outside', () => {
    const clipped = clipSegmentToCanvas({ x: 50, y: 50 }, { x: 150, y: 50 }, CANVAS)
    expect(clipped).not.toBeNull()
    expect(clipped?.from).toEqual({ x: 50, y: 50 })
    expect(clipped?.to.x).toBeCloseTo(100, 6)
    // Half the segment is inside, so half the parameter range survives.
    expect(clipped?.t1).toBeCloseTo(0.5, 6)
  })

  it('rejects a segment that is entirely outside and never crosses', () => {
    expect(clipSegmentToCanvas({ x: -50, y: -50 }, { x: -10, y: -10 }, CANVAS)).toBeNull()
    expect(clipSegmentToCanvas({ x: 200, y: 10 }, { x: 300, y: 90 }, CANVAS)).toBeNull()
  })

  it('rejects a segment running parallel just outside a boundary', () => {
    expect(clipSegmentToCanvas({ x: -5, y: 10 }, { x: -5, y: 90 }, CANVAS)).toBeNull()
  })

  it('KEEPS the crossing part of a segment whose endpoints are BOTH outside', () => {
    // Sweeping right across the middle of the canvas: nothing but the crossing
    // part is visible, and a naive "drop anything with an outside endpoint"
    // rule would lose the whole line.
    const clipped = clipSegmentToCanvas({ x: -100, y: 50 }, { x: 200, y: 50 }, CANVAS)
    expect(clipped).not.toBeNull()
    expect(clipped?.from.x).toBeCloseTo(0, 6)
    expect(clipped?.to.x).toBeCloseTo(100, 6)
    expect(clipped?.from.y).toBeCloseTo(50, 6)
  })

  it('clips a diagonal crossing from outside to outside', () => {
    const clipped = clipSegmentToCanvas({ x: -50, y: -50 }, { x: 150, y: 150 }, CANVAS)
    expect(clipped).not.toBeNull()
    expect(clipped?.from.x).toBeCloseTo(0, 6)
    expect(clipped?.from.y).toBeCloseTo(0, 6)
    expect(clipped?.to.x).toBeCloseTo(100, 6)
    expect(clipped?.to.y).toBeCloseTo(100, 6)
  })

  it('keeps a zero-length segment when the point is inside, drops it when outside', () => {
    const inside = clipSegmentToCanvas({ x: 40, y: 40 }, { x: 40, y: 40 }, CANVAS)
    expect(inside).not.toBeNull()
    expect(inside?.t0).toBe(0)
    expect(inside?.t1).toBe(1)

    expect(clipSegmentToCanvas({ x: -40, y: 40 }, { x: -40, y: 40 }, CANVAS)).toBeNull()
  })

  it('keeps a segment lying exactly along a boundary', () => {
    const clipped = clipSegmentToCanvas({ x: 0, y: 10 }, { x: 0, y: 90 }, CANVAS)
    expect(clipped).not.toBeNull()
    expect(clipped?.t0).toBe(0)
    expect(clipped?.t1).toBe(1)
  })

  it('returns null for a degenerate canvas rather than dividing by zero', () => {
    expect(clipSegmentToCanvas({ x: 0, y: 0 }, { x: 1, y: 1 }, { width: 0, height: 10 })).toBeNull()
  })

  it('returns null for non-finite coordinates', () => {
    expect(
      clipSegmentToCanvas({ x: Number.NaN, y: 0 }, { x: 50, y: 50 }, CANVAS),
    ).toBeNull()
  })
})
