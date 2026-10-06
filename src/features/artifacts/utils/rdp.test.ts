import { describe, expect, it } from 'vitest'
import {
  maxDeviationFromPolyline,
  perpendicularDistance,
  polylineLength,
  simplifyRdpIndices,
  type Point2D,
} from './rdp'

/** Points along a straight horizontal line. */
function straightLine(count: number): Point2D[] {
  return Array.from({ length: count }, (_, i) => ({ x: i * 10, y: 50 }))
}

describe('perpendicularDistance', () => {
  it('measures distance to the segment, not to the infinite line', () => {
    // The point is far beyond the segment's end. Measured against the infinite
    // line it would be 0; against the segment it is the distance to the end.
    const distance = perpendicularDistance({ x: 100, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    expect(distance).toBe(90)
  })

  it('handles a degenerate segment as distance to the point', () => {
    expect(perpendicularDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5)
  })

  it('is zero on the line', () => {
    expect(perpendicularDistance({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0)
  })

  it('measures a simple perpendicular offset', () => {
    expect(perpendicularDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3)
  })
})

describe('simplifyRdpIndices', () => {
  it('keeps everything when there are two points or fewer', () => {
    expect(simplifyRdpIndices([], 5)).toEqual([])
    expect(simplifyRdpIndices([{ x: 0, y: 0 }], 5)).toEqual([0])
    expect(simplifyRdpIndices([{ x: 0, y: 0 }, { x: 9, y: 9 }], 5)).toEqual([0, 1])
  })

  it('reduces a straight line to its endpoints', () => {
    const points = straightLine(20)
    expect(simplifyRdpIndices(points, 1)).toEqual([0, 19])
  })

  it('always keeps the first and last point', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 40 },
      { x: 20, y: 0 },
      { x: 30, y: 35 },
      { x: 40, y: 0 },
    ]
    const kept = simplifyRdpIndices(points, 100)

    // Even an absurdly large tolerance cannot drop the endpoints.
    expect(kept[0]).toBe(0)
    expect(kept[kept.length - 1]).toBe(points.length - 1)
  })

  it('keeps the apex of a zigzag that exceeds the tolerance', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 50 },
      { x: 20, y: 0 },
    ]
    expect(simplifyRdpIndices(points, 5)).toEqual([0, 1, 2])
  })

  it('drops an apex that stays within the tolerance', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0.5 },
      { x: 20, y: 0 },
    ]
    expect(simplifyRdpIndices(points, 5)).toEqual([0, 2])
  })

  it('keeps more points as the tolerance tightens', () => {
    // A quarter circle: genuinely curved, so tolerance directly controls detail.
    const points: Point2D[] = Array.from({ length: 60 }, (_, i) => {
      const angle = (i / 59) * (Math.PI / 2)
      return { x: Math.cos(angle) * 200, y: Math.sin(angle) * 200 }
    })

    const coarse = simplifyRdpIndices(points, 8).length
    const medium = simplifyRdpIndices(points, 2).length
    const fine = simplifyRdpIndices(points, 0.25).length

    expect(coarse).toBeLessThan(medium)
    expect(medium).toBeLessThan(fine)
    expect(fine).toBeLessThanOrEqual(points.length)
  })

  it('respects the tolerance it was given', () => {
    const points: Point2D[] = Array.from({ length: 80 }, (_, i) => {
      const angle = (i / 79) * Math.PI
      return { x: i * 4, y: Math.sin(angle) * 120 }
    })

    for (const tolerance of [0.5, 2, 6]) {
      const kept = simplifyRdpIndices(points, tolerance).map((index) => points[index]!)
      // The guarantee RDP makes: nothing deviates by more than the tolerance.
      expect(maxDeviationFromPolyline(points, kept)).toBeLessThanOrEqual(tolerance + 1e-9)
    }
  })

  it('keeps every point at tolerance zero', () => {
    // Zero means "do not simplify", the safe reading of a missing tolerance.
    const points = straightLine(10)
    expect(simplifyRdpIndices(points, 0)).toEqual(points.map((_, i) => i))
  })

  it('keeps every point for an invalid tolerance', () => {
    const points = straightLine(10)
    const all = points.map((_, i) => i)

    expect(simplifyRdpIndices(points, Number.NaN)).toEqual(all)
    expect(simplifyRdpIndices(points, -5)).toEqual(all)
    expect(simplifyRdpIndices(points, Number.POSITIVE_INFINITY)).toEqual(all)
  })

  it('handles a loop that returns to its own start', () => {
    // A closed circle. Measured against the infinite line the endpoints define,
    // every point would collapse; the segment-distance test keeps the shape.
    const points: Point2D[] = Array.from({ length: 40 }, (_, i) => {
      const angle = (i / 39) * Math.PI * 2
      return { x: 100 + Math.cos(angle) * 80, y: 100 + Math.sin(angle) * 80 }
    })

    const kept = simplifyRdpIndices(points, 2)
    expect(kept.length).toBeGreaterThan(6)
    expect(maxDeviationFromPolyline(points, kept.map((i) => points[i]!))).toBeLessThanOrEqual(2.0001)
  })

  it('keeps an overshoot that doubles back', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 80, y: 0 },
      { x: 40, y: 0 },
    ]
    const kept = simplifyRdpIndices(points, 1)
    // The turn at x=80 is the shape of the gesture and must survive.
    expect(kept).toContain(2)
  })

  it('tolerates exact duplicate points', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 20, y: 20 },
    ]
    expect(() => simplifyRdpIndices(points, 1)).not.toThrow()
    expect(simplifyRdpIndices(points, 1)).toEqual([0, 3])
  })

  it('returns ascending indices without duplicates', () => {
    const points: Point2D[] = Array.from({ length: 200 }, (_, i) => ({
      x: i,
      y: Math.sin(i / 5) * 30,
    }))
    const kept = simplifyRdpIndices(points, 1)

    for (let i = 1; i < kept.length; i += 1) {
      expect(kept[i]!).toBeGreaterThan(kept[i - 1]!)
    }
  })

  it('is deterministic', () => {
    const points: Point2D[] = Array.from({ length: 300 }, (_, i) => ({
      x: i * 1.7,
      y: Math.sin(i / 7) * 45 + Math.cos(i / 3) * 12,
    }))
    expect(simplifyRdpIndices(points, 1.5)).toEqual(simplifyRdpIndices(points, 1.5))
  })

  it('does not mutate its input', () => {
    const points: Point2D[] = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i % 7 }))
    const before = JSON.parse(JSON.stringify(points)) as Point2D[]

    simplifyRdpIndices(points, 2)

    expect(points).toEqual(before)
  })

  it('does not overflow the stack on a long gently curved stroke', () => {
    // Recursion depth grows with the number of split points; 10k samples of
    // slight curvature is exactly the shape that used to blow the stack.
    const points: Point2D[] = Array.from({ length: 10_000 }, (_, i) => ({
      x: i * 0.1,
      y: Math.sin(i / 500) * 100,
    }))

    expect(() => simplifyRdpIndices(points, 0.01)).not.toThrow()
  })
})

describe('polylineLength', () => {
  it('is zero for zero or one point', () => {
    expect(polylineLength([])).toBe(0)
    expect(polylineLength([{ x: 5, y: 5 }])).toBe(0)
  })

  it('sums segment lengths', () => {
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 14 }])).toBe(15)
  })
})

describe('maxDeviationFromPolyline', () => {
  it('is zero when every point is kept', () => {
    const points = [{ x: 0, y: 0 }, { x: 5, y: 9 }, { x: 12, y: 3 }]
    expect(maxDeviationFromPolyline(points, points)).toBe(0)
  })

  it('reports the worst deviation, not the average', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 1 },
      { x: 10, y: 20 },
      { x: 20, y: 0 },
    ]
    // Against the chord set {first, last} the point at y=20 is the worst.
    const deviation = maxDeviationFromPolyline(points, [points[0]!, points[3]!])
    expect(deviation).toBeCloseTo(20, 5)
  })

  it('handles a single kept point', () => {
    const points = [{ x: 0, y: 0 }, { x: 3, y: 4 }]
    expect(maxDeviationFromPolyline(points, [{ x: 0, y: 0 }])).toBe(5)
  })

  it('is zero for empty input', () => {
    expect(maxDeviationFromPolyline([], [])).toBe(0)
  })
})
