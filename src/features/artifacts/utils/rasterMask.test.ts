import { describe, expect, it } from 'vitest'
import {
  countCovered,
  createEmptyMask,
  maskIoU,
  rasterizeStrokes,
  type BinaryMask,
} from './rasterMask'

const SIZE = { width: 40, height: 40 }

/** Reads a pixel, for pinpoint assertions about coverage. */
function pixelAt(mask: BinaryMask, x: number, y: number): number {
  return mask.data[y * mask.width + x] ?? 0
}

describe('rasterizeStrokes', () => {
  it('produces an all-zero mask for no strokes', () => {
    const mask = rasterizeStrokes([], SIZE)
    expect(mask.width).toBe(40)
    expect(mask.height).toBe(40)
    expect(countCovered(mask)).toBe(0)
  })

  it('paints a dot for a single-point stroke', () => {
    // A tap is a real observation; it must not vanish from the comparison.
    const mask = rasterizeStrokes([{ points: [{ x: 20, y: 20 }], width: 6 }], SIZE)

    expect(countCovered(mask)).toBeGreaterThan(0)
    expect(pixelAt(mask, 20, 20)).toBe(1)
  })

  it('paints a horizontal line of about the requested thickness', () => {
    const mask = rasterizeStrokes(
      [{ points: [{ x: 5, y: 20 }, { x: 35, y: 20 }], width: 4 }],
      SIZE,
    )

    // Column in the middle of the run: centres within radius 2 of y=20.
    let column = 0
    for (let y = 0; y < 40; y += 1) {
      if (pixelAt(mask, 20, y) === 1) column += 1
    }
    expect(column).toBeGreaterThanOrEqual(3)
    expect(column).toBeLessThanOrEqual(5)
  })

  it('gives a hairline stroke some coverage rather than none', () => {
    const mask = rasterizeStrokes(
      [{ points: [{ x: 5, y: 10 }, { x: 35, y: 10 }], width: 0 }],
      SIZE,
    )
    expect(countCovered(mask)).toBeGreaterThan(0)
  })

  it('clips points outside the canvas without bending the path', () => {
    /*
      The segment runs well past the right edge. The part inside must be drawn
      exactly where it belongs - clamping the far endpoint onto the edge would
      pull the whole line and invent geometry that was never drawn.
    */
    const mask = rasterizeStrokes(
      [{ points: [{ x: 20, y: 20 }, { x: 400, y: 20 }], width: 4 }],
      SIZE,
    )

    expect(pixelAt(mask, 39, 20)).toBe(1)
    // The path is horizontal, so nothing may appear off that row's band.
    expect(pixelAt(mask, 39, 0)).toBe(0)
    expect(pixelAt(mask, 39, 39)).toBe(0)
  })

  it('draws nothing for a stroke entirely outside the canvas', () => {
    const mask = rasterizeStrokes(
      [{ points: [{ x: 200, y: 200 }, { x: 300, y: 300 }], width: 4 }],
      SIZE,
    )
    expect(countCovered(mask)).toBe(0)
  })

  it('is deterministic', () => {
    const strokes = [
      { points: [{ x: 3, y: 3 }, { x: 30, y: 22 }, { x: 12, y: 36 }], width: 5 },
    ]
    const a = rasterizeStrokes(strokes, SIZE)
    const b = rasterizeStrokes(strokes, SIZE)
    expect(Array.from(a.data)).toEqual(Array.from(b.data))
  })

  it('does not mutate its input', () => {
    const strokes = [{ points: [{ x: 1, y: 1 }, { x: 20, y: 20 }], width: 3 }]
    const before = JSON.parse(JSON.stringify(strokes)) as typeof strokes

    rasterizeStrokes(strokes, SIZE)

    expect(strokes).toEqual(before)
  })

  it('produces only 0 and 1 - the mask is strictly binary', () => {
    const mask = rasterizeStrokes(
      [{ points: [{ x: 2, y: 2 }, { x: 37, y: 33 }], width: 7 }],
      SIZE,
    )
    for (const value of mask.data) {
      expect(value === 0 || value === 1).toBe(true)
    }
  })

  it('handles a zero-sized canvas without throwing', () => {
    const mask = rasterizeStrokes(
      [{ points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], width: 2 }],
      { width: 0, height: 0 },
    )
    expect(mask.data).toHaveLength(0)
  })

  it('covers the union of overlapping strokes without double counting', () => {
    const single = rasterizeStrokes(
      [{ points: [{ x: 5, y: 20 }, { x: 35, y: 20 }], width: 4 }],
      SIZE,
    )
    const doubled = rasterizeStrokes(
      [
        { points: [{ x: 5, y: 20 }, { x: 35, y: 20 }], width: 4 },
        { points: [{ x: 5, y: 20 }, { x: 35, y: 20 }], width: 4 },
      ],
      SIZE,
    )
    expect(countCovered(doubled)).toBe(countCovered(single))
  })
})

describe('maskIoU', () => {
  it('is 1 for identical masks', () => {
    const strokes = [{ points: [{ x: 5, y: 5 }, { x: 30, y: 28 }], width: 5 }]
    const a = rasterizeStrokes(strokes, SIZE)
    const b = rasterizeStrokes(strokes, SIZE)
    expect(maskIoU(a, b)).toBe(1)
  })

  it('is 0 for completely disjoint masks', () => {
    const a = rasterizeStrokes([{ points: [{ x: 2, y: 2 }, { x: 8, y: 2 }], width: 2 }], SIZE)
    const b = rasterizeStrokes([{ points: [{ x: 2, y: 35 }, { x: 8, y: 35 }], width: 2 }], SIZE)
    expect(maskIoU(a, b)).toBe(0)
  })

  it('is 1 when both masks are empty - the stated policy', () => {
    // Two reconstructions that both draw nothing agree perfectly. Reporting 0
    // would flag a failure where there is no disagreement at all.
    expect(maskIoU(createEmptyMask(SIZE), createEmptyMask(SIZE))).toBe(1)
  })

  it('is 0 when exactly one mask is empty - the stated policy', () => {
    const drawn = rasterizeStrokes([{ points: [{ x: 5, y: 5 }, { x: 20, y: 20 }], width: 4 }], SIZE)
    expect(maskIoU(drawn, createEmptyMask(SIZE))).toBe(0)
    expect(maskIoU(createEmptyMask(SIZE), drawn)).toBe(0)
  })

  it('returns null for masks of different sizes rather than a fake number', () => {
    const a = createEmptyMask({ width: 10, height: 10 })
    const b = createEmptyMask({ width: 20, height: 10 })
    expect(maskIoU(a, b)).toBeNull()
  })

  it('is between 0 and 1 for partial overlap, and symmetric', () => {
    const a = rasterizeStrokes([{ points: [{ x: 5, y: 20 }, { x: 25, y: 20 }], width: 4 }], SIZE)
    const b = rasterizeStrokes([{ points: [{ x: 15, y: 20 }, { x: 35, y: 20 }], width: 4 }], SIZE)

    const iou = maskIoU(a, b)
    expect(iou).not.toBeNull()
    expect(iou!).toBeGreaterThan(0)
    expect(iou!).toBeLessThan(1)
    expect(maskIoU(b, a)).toBe(iou)
  })

  it('never yields NaN or Infinity', () => {
    const cases: Array<[BinaryMask, BinaryMask]> = [
      [createEmptyMask(SIZE), createEmptyMask(SIZE)],
      [
        rasterizeStrokes([{ points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], width: 1 }], SIZE),
        createEmptyMask(SIZE),
      ],
      [createEmptyMask({ width: 0, height: 0 }), createEmptyMask({ width: 0, height: 0 })],
    ]

    for (const [a, b] of cases) {
      const iou = maskIoU(a, b)
      expect(iou === null || Number.isFinite(iou)).toBe(true)
    }
  })

  it('scores a close simplification higher than a crude one', () => {
    // The property the quality gate depends on: a reconstruction that follows
    // the original more closely must score higher.
    const original = Array.from({ length: 40 }, (_, i) => ({
      x: 2 + i,
      y: 20 + Math.sin(i / 4) * 8,
    }))
    const close = original.filter((_, i) => i % 2 === 0)
    const crude = [original[0]!, original[original.length - 1]!]

    const truth = rasterizeStrokes([{ points: original, width: 5 }], SIZE)
    const closeIoU = maskIoU(truth, rasterizeStrokes([{ points: close, width: 5 }], SIZE))!
    const crudeIoU = maskIoU(truth, rasterizeStrokes([{ points: crude, width: 5 }], SIZE))!

    expect(closeIoU).toBeGreaterThan(crudeIoU)
  })
})
