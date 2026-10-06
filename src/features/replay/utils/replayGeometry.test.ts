/**
 * The logical/visual split.
 *
 * Closing a week-1B gap: this mapping shipped untested, and week 1C's mask and
 * diagnostic PNGs are rendered through the same logical-canvas policy, so it
 * needs to be pinned down before anything is built on top of it.
 */

import { describe, expect, it } from 'vitest'
import { computeVisualCanvas, formatReplayTime } from './replayGeometry'

describe('computeVisualCanvas', () => {
  it('scales down to fit a smaller box, preserving the shape', () => {
    const visual = computeVisualCanvas({ width: 800, height: 600 }, { width: 400, height: 400 })

    // Width is the tighter constraint: 400/800 = 0.5.
    expect(visual.scale).toBe(0.5)
    expect(visual.size).toEqual({ width: 400, height: 300 })
  })

  it('is limited by height when height is the tighter constraint', () => {
    const visual = computeVisualCanvas({ width: 800, height: 600 }, { width: 1600, height: 300 })

    expect(visual.scale).toBe(0.5)
    expect(visual.size).toEqual({ width: 400, height: 300 })
  })

  it('never stretches: the aspect ratio always survives', () => {
    const logical = { width: 500, height: 500 }
    // A deliberately wide box. A square recording must stay square, or an
    // ellipse the participant drew as a circle becomes a different observation.
    const visual = computeVisualCanvas(logical, { width: 1000, height: 200 })

    expect(visual.size.width).toBe(visual.size.height)
  })

  it.each([
    [{ width: 800, height: 600 }, { width: 300, height: 900 }],
    [{ width: 1024, height: 768 }, { width: 640, height: 480 }],
    [{ width: 300, height: 900 }, { width: 500, height: 500 }],
  ])('preserves the aspect ratio for %o in %o', (logical, available) => {
    const visual = computeVisualCanvas(logical, available)

    const logicalRatio = logical.width / logical.height
    const visualRatio = visual.size.width / visual.size.height
    expect(visualRatio).toBeCloseTo(logicalRatio, 10)
  })

  it('shows the whole recording rather than cropping it', () => {
    const visual = computeVisualCanvas({ width: 2000, height: 1000 }, { width: 500, height: 500 })

    expect(visual.size.width).toBeLessThanOrEqual(500)
    expect(visual.size.height).toBeLessThanOrEqual(500)
  })

  it('scales up when the box is larger than the recording', () => {
    const visual = computeVisualCanvas({ width: 200, height: 100 }, { width: 800, height: 800 })

    expect(visual.scale).toBe(4)
    expect(visual.size).toEqual({ width: 800, height: 400 })
  })

  it('returns an empty box for a degenerate logical canvas instead of dividing by zero', () => {
    for (const logical of [
      { width: 0, height: 600 },
      { width: 800, height: 0 },
      { width: -100, height: 600 },
      { width: Number.NaN, height: 600 },
    ]) {
      const visual = computeVisualCanvas(logical, { width: 400, height: 400 })
      expect(visual.size).toEqual({ width: 0, height: 0 })
    }
  })

  it('returns an empty box before the container has been laid out', () => {
    const visual = computeVisualCanvas({ width: 800, height: 600 }, { width: 0, height: 0 })
    expect(visual.size).toEqual({ width: 0, height: 0 })
  })

  it('never produces NaN or Infinity', () => {
    const cases: Array<[{ width: number; height: number }, { width: number; height: number }]> = [
      [{ width: 800, height: 600 }, { width: 400, height: 300 }],
      [{ width: 1, height: 1 }, { width: 1000, height: 1000 }],
      [{ width: 0, height: 0 }, { width: 0, height: 0 }],
      [{ width: 800, height: 600 }, { width: Number.POSITIVE_INFINITY, height: 300 }],
    ]

    for (const [logical, available] of cases) {
      const visual = computeVisualCanvas(logical, available)
      expect(Number.isFinite(visual.size.width)).toBe(true)
      expect(Number.isFinite(visual.size.height)).toBe(true)
      expect(Number.isFinite(visual.scale)).toBe(true)
    }
  })

  it('is deterministic', () => {
    const a = computeVisualCanvas({ width: 813, height: 577 }, { width: 461, height: 322 })
    const b = computeVisualCanvas({ width: 813, height: 577 }, { width: 461, height: 322 })
    expect(a).toEqual(b)
  })

  it('does not depend on device pixel ratio', () => {
    /*
      DPR decides how many physical pixels rasterise one CSS pixel - a quality
      setting. It must never change what a coordinate MEANS, so it is not an
      input here at all. This test documents that by construction.
    */
    const original = window.devicePixelRatio
    const results = []
    for (const dpr of [1, 1.25, 2, 3]) {
      Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true })
      results.push(computeVisualCanvas({ width: 800, height: 600 }, { width: 400, height: 400 }))
    }
    Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true })

    for (const result of results) {
      expect(result).toEqual(results[0])
    }
  })
})

describe('formatReplayTime', () => {
  it.each([
    [0, '0:00.0'],
    [450, '0:00.5'],
    [1500, '0:01.5'],
    [61_200, '1:01.2'],
    [125_000, '2:05.0'],
  ])('formats %sms as %s', (input, expected) => {
    expect(formatReplayTime(input)).toBe(expected)
  })

  it('treats negative and non-finite input as zero', () => {
    expect(formatReplayTime(-100)).toBe('0:00.0')
    expect(formatReplayTime(Number.NaN)).toBe('0:00.0')
    expect(formatReplayTime(Number.POSITIVE_INFINITY)).toBe('0:00.0')
  })
})
