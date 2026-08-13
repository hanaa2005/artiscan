import { describe, expect, it } from 'vitest'
import {
  clamp,
  fromNormalized,
  roundNormalized,
  toKonvaPoints,
  toNormalized,
} from './coordinates'

const SIZE = { width: 800, height: 400 }

describe('clamp', () => {
  it('keeps a value that is already inside the range', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5)
  })

  it('pulls values back to the boundaries', () => {
    expect(clamp(-3, 0, 1)).toBe(0)
    expect(clamp(9, 0, 1)).toBe(1)
  })

  it('maps NaN to the lower bound instead of propagating it', () => {
    expect(clamp(Number.NaN, 0, 1)).toBe(0)
  })
})

describe('toNormalized', () => {
  it('maps a pixel coordinate into the 0..1 range', () => {
    expect(toNormalized(400, 100, SIZE)).toEqual({ normalizedX: 0.5, normalizedY: 0.25 })
  })

  it('maps the corners to exactly 0 and 1', () => {
    expect(toNormalized(0, 0, SIZE)).toEqual({ normalizedX: 0, normalizedY: 0 })
    expect(toNormalized(800, 400, SIZE)).toEqual({ normalizedX: 1, normalizedY: 1 })
  })

  it('clamps coordinates captured outside the canvas during pointer capture', () => {
    // While a stroke is captured the pointer can leave the canvas entirely.
    expect(toNormalized(-120, 900, SIZE)).toEqual({ normalizedX: 0, normalizedY: 1 })
  })

  it('returns zeros instead of NaN when the canvas has no size yet', () => {
    const result = toNormalized(50, 50, { width: 0, height: 0 })
    expect(result).toEqual({ normalizedX: 0, normalizedY: 0 })
    expect(Number.isNaN(result.normalizedX)).toBe(false)
  })
})

describe('fromNormalized', () => {
  it('is the inverse of toNormalized', () => {
    const original = { x: 321, y: 87 }
    const normalized = toNormalized(original.x, original.y, SIZE)
    const restored = fromNormalized(normalized.normalizedX, normalized.normalizedY, SIZE)
    expect(restored.x).toBeCloseTo(original.x, 5)
    expect(restored.y).toBeCloseTo(original.y, 5)
  })

  it('reproduces the same relative position on a differently sized canvas', () => {
    // This is what makes a drawing survive a window resize and an import on
    // another screen: the same normalized point stays at the same relative spot.
    const normalized = toNormalized(400, 200, SIZE)
    const onSmallScreen = fromNormalized(
      normalized.normalizedX,
      normalized.normalizedY,
      { width: 400, height: 200 },
    )
    expect(onSmallScreen).toEqual({ x: 200, y: 100 })
  })
})

describe('toKonvaPoints', () => {
  it('flattens normalized points into scaled [x, y, x, y] pairs', () => {
    const points = [
      { normalizedX: 0, normalizedY: 0 },
      { normalizedX: 0.5, normalizedY: 1 },
    ]
    expect(toKonvaPoints(points, SIZE)).toEqual([0, 0, 400, 400])
  })

  it('returns an empty array for an empty stroke', () => {
    expect(toKonvaPoints([], SIZE)).toEqual([])
  })
})

describe('roundNormalized', () => {
  it('keeps five decimals, which is sub-pixel on any real screen', () => {
    expect(roundNormalized(0.1234567)).toBe(0.12346)
  })
})
