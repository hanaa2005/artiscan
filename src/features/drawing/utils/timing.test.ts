import { describe, expect, it } from 'vitest'
import { compareTimeline, formatDurationFa, roundMs, safeDeltaMs } from './timing'

describe('compareTimeline', () => {
  it('orders by timestamp when the timestamps differ', () => {
    expect(compareTimeline({ timeMs: 100, sequence: 9 }, { timeMs: 200, sequence: 1 })).toBeLessThan(
      0,
    )
  })

  it('falls back to sequence when timestamps are equal', () => {
    // The clock is rounded to 0.1 ms, so a fast digitizer produces ties
    // routinely. sequence is the authoritative tie-breaker.
    expect(compareTimeline({ timeMs: 100, sequence: 2 }, { timeMs: 100, sequence: 5 })).toBeLessThan(
      0,
    )
  })

  it('sorts a tied batch into recording order', () => {
    const events = [
      { timeMs: 100, sequence: 3 },
      { timeMs: 100, sequence: 1 },
      { timeMs: 100, sequence: 2 },
    ]
    expect([...events].sort(compareTimeline).map((e) => e.sequence)).toEqual([1, 2, 3])
  })

  it('reports equality only when both keys match', () => {
    expect(compareTimeline({ timeMs: 5, sequence: 5 }, { timeMs: 5, sequence: 5 })).toBe(0)
  })
})

describe('safeDeltaMs', () => {
  it('returns the elapsed time between two samples', () => {
    expect(safeDeltaMs({ timeMs: 100 }, { timeMs: 140 })).toBe(40)
  })

  it('returns null when two samples share a timestamp', () => {
    // A speed calculation would divide by this. Returning 0 would yield
    // Infinity and silently poison any average or maximum built on top of it.
    expect(safeDeltaMs({ timeMs: 100 }, { timeMs: 100 })).toBeNull()
  })

  it('returns null when time appears to go backwards', () => {
    expect(safeDeltaMs({ timeMs: 200 }, { timeMs: 100 })).toBeNull()
  })

  it('returns null for a non-finite timestamp', () => {
    expect(safeDeltaMs({ timeMs: 0 }, { timeMs: Number.NaN })).toBeNull()
    expect(safeDeltaMs({ timeMs: 0 }, { timeMs: Number.POSITIVE_INFINITY })).toBeNull()
  })

  it('never yields Infinity when used as a divisor', () => {
    const distance = 50
    const delta = safeDeltaMs({ timeMs: 10 }, { timeMs: 10 })
    const speed = delta === null ? null : distance / delta
    expect(speed).toBeNull()
  })
})

describe('roundMs', () => {
  it('keeps one tenth of a millisecond', () => {
    expect(roundMs(12.3456)).toBe(12.3)
  })
})

describe('formatDurationFa', () => {
  it('formats minutes and seconds', () => {
    expect(formatDurationFa(65_000)).toBe('1:05')
  })

  it('handles zero and invalid input without throwing', () => {
    expect(formatDurationFa(0)).toBe('0:00')
    expect(formatDurationFa(-1)).toBe('۰:۰۰')
    expect(formatDurationFa(Number.NaN)).toBe('۰:۰۰')
  })
})
