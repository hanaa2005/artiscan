/**
 * The advisory time policy.
 *
 * The measured duration is authoritative in every case: no branch here may ever
 * change it.
 */

import { describe, expect, it } from 'vitest'
import { computeTimePolicy } from './timePolicy'
import type { DrawingTrial } from '../types/trial.types'

function makeTrial(durationMs: number | null, timeLimitSeconds: number | null): DrawingTrial {
  return {
    id: 'trial-1',
    status: 'completed',
    timeLimitSeconds,
    timing: {
      startedAt: '2026-08-13T10:00:00.000Z',
      completedAt: '2026-08-13T10:01:00.000Z',
      durationMs,
      countdownSeconds: 3,
    },
  }
}

describe('computeTimePolicy', () => {
  it('reports no recommendation for an untimed task', () => {
    expect(computeTimePolicy(makeTrial(45_000, null))).toEqual({
      recommendedSeconds: null,
      actualDurationMs: 45_000,
      exceededRecommendedTime: false,
      overtimeMs: 0,
    })
  })

  it('reports no overtime below the recommended time', () => {
    const policy = computeTimePolicy(makeTrial(45_000, 60))
    expect(policy.exceededRecommendedTime).toBe(false)
    expect(policy.overtimeMs).toBe(0)
    expect(policy.recommendedSeconds).toBe(60)
  })

  it('treats landing EXACTLY on the limit as meeting it, not exceeding it', () => {
    const policy = computeTimePolicy(makeTrial(60_000, 60))
    expect(policy.exceededRecommendedTime).toBe(false)
    expect(policy.overtimeMs).toBe(0)
  })

  it('reports the overtime above the recommended time', () => {
    // The real 108-second run against a 60-second recommendation.
    const policy = computeTimePolicy(makeTrial(108_000, 60))
    expect(policy.exceededRecommendedTime).toBe(true)
    expect(policy.overtimeMs).toBe(48_000)
  })

  it('never adjusts the actual duration, however far over it runs', () => {
    expect(computeTimePolicy(makeTrial(500_000, 60)).actualDurationMs).toBe(500_000)
    expect(computeTimePolicy(makeTrial(1, 60)).actualDurationMs).toBe(1)
  })

  it('treats an unfinished trial as zero measured time rather than guessing', () => {
    const policy = computeTimePolicy(makeTrial(null, 60))
    expect(policy.actualDurationMs).toBe(0)
    expect(policy.exceededRecommendedTime).toBe(false)
  })

  it('rejects a nonsensical recommendation instead of manufacturing overtime', () => {
    for (const bad of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      const policy = computeTimePolicy(makeTrial(90_000, bad))
      expect(policy.recommendedSeconds).toBeNull()
      expect(policy.exceededRecommendedTime).toBe(false)
      expect(policy.overtimeMs).toBe(0)
    }
  })

  it('rejects a nonsensical duration instead of propagating it', () => {
    for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY, -5]) {
      const policy = computeTimePolicy(makeTrial(bad, 60))
      expect(policy.actualDurationMs).toBe(0)
      expect(Number.isFinite(policy.overtimeMs)).toBe(true)
    }
  })
})
