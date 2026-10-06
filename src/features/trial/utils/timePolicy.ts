/**
 * The advisory time policy.
 *
 * ArtiScan does NOT auto-complete a trial when the recommended time elapses.
 * Stopping a recording at a deadline would truncate raw data, and raw data is
 * the one thing this system exists to preserve - a participant who kept drawing
 * for 108 seconds under a 60-second recommendation produced a longer recording,
 * not an invalid one.
 *
 * So the limit is advisory: shown as «زمان پیشنهادی», recorded, and compared
 * here. The measured duration always wins; this module only reports how the two
 * relate.
 *
 * Everything is derived, so an imported result recomputes it exactly like the
 * features and never trusts the stored block.
 */

import type { DrawingTrial, TrialTimePolicy } from '../types/trial.types'

const MS_PER_SECOND = 1000

/**
 * Compares the measured duration against the advisory time.
 *
 * A trial that has not finished has `durationMs === null`; it is reported as a
 * zero actual duration rather than guessed at, because no measurement exists.
 * A non-finite or negative recommendation is treated as "no recommendation" -
 * a nonsensical limit must not manufacture a nonsensical overtime.
 */
export function computeTimePolicy(trial: DrawingTrial): TrialTimePolicy {
  const rawDuration = trial.timing.durationMs
  const actualDurationMs =
    rawDuration !== null && Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : 0

  const rawLimit = trial.timeLimitSeconds
  const hasRecommendation = rawLimit !== null && Number.isFinite(rawLimit) && rawLimit > 0

  if (!hasRecommendation) {
    return {
      recommendedSeconds: null,
      actualDurationMs,
      exceededRecommendedTime: false,
      overtimeMs: 0,
    }
  }

  const recommendedMs = rawLimit * MS_PER_SECOND
  // Exactly at the limit is NOT over it: a trial that finishes on the second
  // met the recommendation.
  const overtimeMs = Math.max(0, actualDurationMs - recommendedMs)

  return {
    recommendedSeconds: rawLimit,
    actualDurationMs,
    exceededRecommendedTime: overtimeMs > 0,
    overtimeMs,
  }
}
