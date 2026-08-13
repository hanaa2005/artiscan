/**
 * Session timing.
 *
 * HARD RULE: pen movement is timed with performance.now(), never Date.now().
 *
 * Why: Date.now() reads the wall clock, which can jump backwards or forwards
 * (NTP sync, user changing the clock, daylight saving). performance.now() is a
 * monotonic high-resolution clock that only ever moves forward, which is what
 * you need when the time between two points is the measurement itself.
 *
 * Date.now() is used in exactly one place: producing the ISO `createdAt` label,
 * which is a calendar annotation, not a measurement.
 */

export interface SessionClock {
  /** Milliseconds elapsed since the clock was created, rounded to 0.1 ms. */
  elapsedMs(): number
  /** The performance.now() value captured at session start. */
  readonly originMs: number
}

/**
 * Starts a new monotonic clock.
 *
 * `alreadyElapsedMs` shifts the origin backwards. That is what makes it
 * possible to import a session that already contains 30 seconds of events and
 * keep drawing: the next point is timed at 30s+, not back at 0.
 */
export function createSessionClock(alreadyElapsedMs = 0): SessionClock {
  const originMs = performance.now() - alreadyElapsedMs
  return {
    originMs,
    elapsedMs(): number {
      return roundMs(performance.now() - originMs)
    },
  }
}

/**
 * Rounds to one tenth of a millisecond.
 * Sub-0.1 ms precision is noise for this purpose and would bloat the JSON file
 * with 15-digit floats for no analytical benefit.
 */
export function roundMs(value: number): number {
  return Math.round(value * 10) / 10
}

/** Formats a duration as `m:ss.d` for the debug panel. */
export function formatDurationFa(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '۰:۰۰'
  }
  const totalSeconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * Orders two recorded events.
 *
 * THE TIMELINE CONTRACT, in one function:
 * `timeMs` is monotonic non-decreasing, so it orders events correctly almost
 * always. But it is rounded to 0.1 ms, and a fast digitizer can deliver several
 * coalesced samples inside one tenth of a millisecond - so ties are real and
 * routine, not a corner case. When they happen `sequence` decides, because it
 * comes from a single counter that strictly increases and can never tie.
 *
 * Any code that needs chronological order must sort with this, never with
 * `timeMs` alone.
 */
export function compareTimeline(
  a: { timeMs: number; sequence: number },
  b: { timeMs: number; sequence: number },
): number {
  if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs
  return a.sequence - b.sequence
}

/**
 * The time elapsed between two consecutive events, or null when that interval
 * cannot support a rate calculation.
 *
 * Why this exists: every speed, velocity or acceleration feature planned for
 * later weeks divides by this interval. Two recorded points can legitimately
 * share a timestamp (see compareTimeline), and dividing a distance by a zero
 * interval yields Infinity - a value that silently poisons an average, a
 * maximum or a chart the moment it appears.
 *
 * Returning null forces the caller to decide what to do with an unmeasurable
 * interval, instead of letting Infinity leak into the dataset.
 */
export function safeDeltaMs(
  previous: { timeMs: number },
  next: { timeMs: number },
): number | null {
  const delta = next.timeMs - previous.timeMs
  if (!Number.isFinite(delta) || delta <= 0) return null
  return delta
}

/** ISO 8601 wall-clock label. Calendar annotation only - never a measurement. */
export function nowIsoTimestamp(): string {
  return new Date().toISOString()
}

/** Short `YYYY-MM-DD` stamp used in exported file names. */
export function todayFileStamp(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = (now.getMonth() + 1).toString().padStart(2, '0')
  const day = now.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}
