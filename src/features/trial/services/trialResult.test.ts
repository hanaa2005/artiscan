/**
 * Result export, import and the recompute-on-import policy.
 */

import { describe, expect, it } from 'vitest'
import {
  buildTrialResult,
  buildTrialResultFileName,
  deserializeTrialResult,
  serializeTrialResult,
} from './trialResultSerializer'
import { validateTrialResult } from './trialResultValidator'
import {
  makeSession,
  makeStrokeSeries,
  makeUndoAction,
} from '../../drawing/testing/sessionFixture'
import { extractDrawingFeatures } from '../utils/featureExtraction'
import type { DrawingTask, DrawingTrial, DrawingTrialResult } from '../types/trial.types'

const TASK: DrawingTask = {
  id: 'house',
  labelFa: 'خانه',
  labelEn: 'House',
  quickDrawCategory: 'house',
  instructionFa: 'یک خانه بکشید.',
  timeLimitSeconds: 60,
  enabled: true,
}

const TRIAL: DrawingTrial = {
  id: '33333333-3333-4333-8333-333333333333',
  status: 'completed',
  timeLimitSeconds: 60,
  timing: {
    startedAt: '2026-08-13T10:00:00.000Z',
    completedAt: '2026-08-13T10:00:42.000Z',
    durationMs: 42_000,
    countdownSeconds: 3,
  },
}

function makeResult(overrides: Partial<DrawingTrialResult> = {}): DrawingTrialResult {
  const session = makeSession({
    strokes: makeStrokeSeries(3, ['a', 'b', 'c']),
    actions: [makeUndoAction('c', 50)],
  })
  return { ...buildTrialResult(TRIAL, TASK, session), ...overrides }
}

describe('buildTrialResult', () => {
  it('embeds the session unchanged', () => {
    const session = makeSession({ strokes: makeStrokeSeries(2, ['a', 'b']), actions: [] })
    const before = JSON.stringify(session)

    const result = buildTrialResult(TRIAL, TASK, session)

    expect(result.session).toEqual(session)
    expect(JSON.stringify(session)).toBe(before)
  })

  /*
    UPDATED: the wrapper moved to version 2 when the DrawingFeatures contract
    gained the raw/in-canvas split and the advisory-time block. The point of the
    test is unchanged and is in fact demonstrated more sharply now - the two
    numbers move independently, and the SESSION stayed at 2 because recordings
    did not change at all.
  */
  it('stamps the result schema version, not the session one', () => {
    const result = makeResult()

    expect(result.resultSchemaVersion).toBe(2)
    expect(result.session.schemaVersion).toBe(2)
  })

  it('computes features from the embedded session', () => {
    const result = makeResult()
    expect(result.features).toEqual(extractDrawingFeatures(result.session))
  })
})

describe('round trip', () => {
  it('preserves the canonical session exactly', () => {
    const original = makeResult()
    const parsed = deserializeTrialResult(serializeTrialResult(original))

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.session).toEqual(original.session)
  })

  it('preserves trial and task metadata', () => {
    const original = makeResult()
    const parsed = deserializeTrialResult(serializeTrialResult(original))

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.trial).toEqual(original.trial)
    expect(parsed.value.task).toEqual(original.task)
  })

  it('produces identical features on the way back', () => {
    const original = makeResult()
    const parsed = deserializeTrialResult(serializeTrialResult(original))

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.features).toEqual(original.features)
  })

  it('writes pretty-printed JSON', () => {
    const text = serializeTrialResult(makeResult())
    expect(text).toContain('\n')
    expect(text).toContain('  "resultSchemaVersion": 2')
  })
})

/**
 * The policy: stored features are a cache, so they are thrown away and
 * recomputed from the session, which is the source of truth.
 */
describe('imported features are recomputed, never trusted', () => {
  it('ignores tampered feature values', () => {
    const original = makeResult()
    const tampered = {
      ...original,
      features: { ...original.features, totalStrokeCount: 9999, pauseCount: 4242 },
    }

    const parsed = validateTrialResult(JSON.parse(JSON.stringify(tampered)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    // The recomputed values win over whatever the file claimed.
    expect(parsed.value.features.totalStrokeCount).toBe(3)
    expect(parsed.value.features.pauseCount).toBe(original.features.pauseCount)
  })

  it('recovers correct features from a file whose features are all zero', () => {
    // Simulates an export written by a buggy build: the session is intact, so
    // the numbers can simply be rebuilt.
    const original = makeResult()
    const zeroed = {
      ...original,
      features: Object.fromEntries(
        Object.entries(original.features).map(([key, value]) => [
          key,
          typeof value === 'number' ? 0 : value,
        ]),
      ),
    }

    const parsed = validateTrialResult(JSON.parse(JSON.stringify(zeroed)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.features).toEqual(original.features)
  })

  it('still rejects a structurally broken feature block', () => {
    // A NaN cannot survive JSON, so this is what a corrupt export looks like.
    const original = makeResult()
    const broken = { ...original, features: { ...original.features, durationMs: null } }

    const parsed = validateTrialResult(JSON.parse(JSON.stringify(broken)))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('durationMs')
  })

  it('accepts null for the documented nullable fields', () => {
    const session = makeSession({ strokes: [], actions: [] })
    const result = buildTrialResult(TRIAL, TASK, session)

    expect(result.features.minPressure).toBeNull()
    expect(result.features.boundingBox).toBeNull()

    const parsed = deserializeTrialResult(serializeTrialResult(result))
    expect(parsed.ok).toBe(true)
  })
})

describe('validation - rejections', () => {
  function expectRejected(raw: unknown): string {
    const result = validateTrialResult(raw)
    expect(result.ok).toBe(false)
    return result.ok ? '' : result.error
  }

  it('rejects a non-object', () => {
    for (const value of [null, 42, 'x', [1, 2]]) {
      expect(validateTrialResult(value).ok).toBe(false)
    }
  })

  it('rejects a missing result schema version', () => {
    const { resultSchemaVersion: _drop, ...rest } = makeResult()
    expect(expectRejected(rest)).toContain('resultSchemaVersion')
  })

  // UPDATED: version 2 is now the CURRENT version, so the unsupported case has
  // to be a version that has never been written - 3.
  it('rejects an unsupported result schema version', () => {
    expect(expectRejected({ ...makeResult(), resultSchemaVersion: 3 })).toContain(
      'پشتیبانی نمی‌شود',
    )
  })

  it('rejects a trial that is not completed', () => {
    // A cancelled trial produced no outcome; presenting it as one would be a lie.
    const result = makeResult()
    const cancelled = { ...result, trial: { ...result.trial, status: 'cancelled' } }
    expect(expectRejected(cancelled)).toContain('تکمیل‌شده')
  })

  it('rejects completion earlier than start', () => {
    const result = makeResult()
    const backwards = {
      ...result,
      trial: {
        ...result.trial,
        timing: { ...result.trial.timing, completedAt: '2026-08-13T09:00:00.000Z' },
      },
    }
    expect(expectRejected(backwards)).toContain('قبل از زمان شروع')
  })

  it('accepts completion equal to start', () => {
    // An instant trial is unusual but not invalid.
    const result = makeResult()
    const instant = {
      ...result,
      trial: {
        ...result.trial,
        timing: {
          ...result.trial.timing,
          completedAt: result.trial.timing.startedAt,
          durationMs: 0,
        },
      },
    }
    expect(validateTrialResult(JSON.parse(JSON.stringify(instant))).ok).toBe(true)
  })

  it('rejects an unparseable timestamp', () => {
    const result = makeResult()
    const bad = {
      ...result,
      trial: { ...result.trial, timing: { ...result.trial.timing, startedAt: 'yesterday' } },
    }
    expect(expectRejected(bad)).toContain('زمان شروع')
  })

  it('rejects a negative duration', () => {
    const result = makeResult()
    const bad = {
      ...result,
      trial: { ...result.trial, timing: { ...result.trial.timing, durationMs: -1 } },
    }
    expect(expectRejected(bad)).toContain('مدت زمان')
  })

  it('rejects missing task metadata', () => {
    const { task: _drop, ...rest } = makeResult()
    expect(expectRejected(rest)).toContain('تکلیف')
  })

  it('rejects a task with an empty id', () => {
    const result = makeResult()
    expect(expectRejected({ ...result, task: { ...result.task, id: '' } })).toContain('شناسه')
  })

  it('rejects a task whose time limit is zero or negative', () => {
    const result = makeResult()
    expect(
      expectRejected({ ...result, task: { ...result.task, timeLimitSeconds: 0 } }),
    ).toContain('زمان پیشنهادی')
  })

  it('accepts a task with no time limit', () => {
    const result = makeResult()
    const untimed = {
      ...result,
      task: { ...result.task, timeLimitSeconds: null },
      trial: { ...result.trial, timeLimitSeconds: null },
    }
    expect(validateTrialResult(JSON.parse(JSON.stringify(untimed))).ok).toBe(true)
  })

  it('runs the embedded session through the full week-1 validator', () => {
    // An undo naming a stroke that does not exist is caught by the session
    // validator, and the failure is reported rather than swallowed.
    const result = makeResult()
    const corrupt = {
      ...result,
      session: { ...result.session, actions: [makeUndoAction('ghost', 90)] },
    }
    expect(expectRejected(corrupt)).toContain('جلسه نقاشی داخل فایل معتبر نیست')
  })

  it('reports malformed JSON without throwing', () => {
    const parsed = deserializeTrialResult('{ not json')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('JSON')
  })
})

describe('buildTrialResultFileName', () => {
  it('includes the task id, a short trial id and the date', () => {
    expect(buildTrialResultFileName(makeResult(), '2026-08-13')).toBe(
      'artiscan-trial-house-33333333-2026-08-13.json',
    )
  })
})

/**
 * STRICT feature-block validation.
 *
 * The previous check only examined the fields that happened to be present, so
 * an empty `{}` passed as readily as a complete block: a file whose entire
 * analysis section had been lost looked exactly as healthy as a good one.
 *
 * The shape is checked even though the values are then thrown away, because a
 * structurally broken block means the EXPORT went wrong, and saying so is more
 * useful than silently overwriting it.
 */
describe('strict feature-block validation', () => {
  /** A serializable v2 result with the features replaced wholesale. */
  function withFeatures(features: unknown): unknown {
    return { ...JSON.parse(JSON.stringify(makeResult())), features }
  }

  it('rejects an empty feature object', () => {
    const parsed = validateTrialResult(withFeatures({}))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('وجود ندارد')
  })

  it('rejects a feature block missing a single field', () => {
    const complete = makeResult().features as unknown as Record<string, unknown>
    const incomplete = { ...complete }
    delete incomplete['inCanvasPathLengthPx']

    const parsed = validateTrialResult(withFeatures(incomplete))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('inCanvasPathLengthPx')
  })

  it('rejects an unknown extra field within the same schema version', () => {
    const parsed = validateTrialResult(
      withFeatures({ ...makeResult().features, mysteryScore: 7 }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('mysteryScore')
  })

  it('rejects null in a field that is not allowed to be null', () => {
    const parsed = validateTrialResult(
      withFeatures({ ...makeResult().features, totalStrokeCount: null }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('totalStrokeCount')
  })

  it('accepts null in the documented nullable fields', () => {
    const parsed = validateTrialResult(
      withFeatures({
        ...makeResult().features,
        minPressure: null,
        maxPressure: null,
        meanPressure: null,
        rawBoundingBox: null,
        inCanvasBoundingBox: null,
        boundingBox: null,
        boundingBoxNormalized: null,
      }),
    )
    expect(parsed.ok).toBe(true)
  })

  it('rejects a bounding box missing a member', () => {
    const parsed = validateTrialResult(
      withFeatures({
        ...makeResult().features,
        rawBoundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10 },
      }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('height')
  })

  it('rejects a bounding box whose member is not a finite number', () => {
    const parsed = validateTrialResult(
      withFeatures({
        ...makeResult().features,
        rawBoundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 'wide', height: 10 },
      }),
    )
    expect(parsed.ok).toBe(false)
  })

  it('rejects an array where a bounding box is required', () => {
    const parsed = validateTrialResult(
      withFeatures({ ...makeResult().features, rawBoundingBox: [0, 0, 10, 10] }),
    )
    expect(parsed.ok).toBe(false)
  })

  it('rejects an array where the whole feature block is required', () => {
    const parsed = validateTrialResult(withFeatures([]))
    expect(parsed.ok).toBe(false)
  })

  it('accepts a complete, valid feature block', () => {
    expect(validateTrialResult(withFeatures(makeResult().features)).ok).toBe(true)
  })

  it('accepts correctly shaped but TAMPERED values, and replaces them', () => {
    const genuine = makeResult()
    const tampered = withFeatures({
      ...genuine.features,
      totalStrokeCount: 9999,
      rawPathLengthPx: 123456,
      visibleCanvasCoverageRatio: 1,
    })

    const parsed = validateTrialResult(tampered)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    // The shape was fine, so the file is readable - and the numbers are then
    // recomputed from the session, which is the only thing actually trusted.
    expect(parsed.value.features).toEqual(extractDrawingFeatures(parsed.value.session))
    expect(parsed.value.features.totalStrokeCount).toBe(3)
  })
})

/**
 * RESULT SCHEMA VERSIONING.
 *
 * Version 2 exists because the FEATURE contract changed - raw versus in-canvas
 * geometry, and the advisory-time block. The embedded DrawingSession did not
 * change and stays at schemaVersion 2; bumping it would falsely imply that
 * recordings need migrating.
 */
describe('result schema v1 compatibility', () => {
  /** A file as result schema 1 would have written it. */
  function makeLegacyFile(): Record<string, unknown> {
    const current = JSON.parse(JSON.stringify(makeResult())) as Record<string, unknown>
    const features = current['features'] as Record<string, unknown>

    // The v1 feature block: the 28 fields that existed then, and no others.
    const legacyFeatures: Record<string, unknown> = {}
    for (const key of [
      'totalStrokeCount',
      'visibleStrokeCount',
      'penStrokeCount',
      'eraserStrokeCount',
      'totalPointCount',
      'durationMs',
      'totalPathLengthPx',
      'totalPathLengthNormalized',
      'boundingBox',
      'boundingBoxNormalized',
      'canvasCoverageRatio',
      'undoCount',
      'redoCount',
      'clearCount',
      'toolChangeCount',
      'colorChangeCount',
      'widthChangeCount',
      'pressureSampleCount',
      'minPressure',
      'maxPressure',
      'meanPressure',
      'validSpeedSampleCount',
      'meanSpeedNormalizedPerSecond',
      'maxSpeedNormalizedPerSecond',
      'pauseCount',
      'totalPauseMs',
      'longestPauseMs',
    ]) {
      legacyFeatures[key] = features[key]
    }

    return {
      resultSchemaVersion: 1,
      trial: current['trial'],
      task: current['task'],
      session: current['session'],
      features: legacyFeatures,
      // v1 had no timePolicy block at all.
    }
  }

  it('reads a result-schema-1 file', () => {
    const parsed = validateTrialResult(makeLegacyFile())
    expect(parsed.ok).toBe(true)
  })

  it('upgrades the WRAPPER version without touching the embedded session', () => {
    const legacy = makeLegacyFile()
    const parsed = validateTrialResult(legacy)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.resultSchemaVersion).toBe(2)
    // The recording is returned exactly as it was recorded.
    expect(parsed.value.session).toEqual(legacy['session'])
    expect(parsed.value.session.schemaVersion).toBe(2)
  })

  it('ignores the stored v1 features and recomputes the current ones', () => {
    const legacy = makeLegacyFile()
    // v1 files cannot contain the new fields, and the old ones meant something
    // slightly different - so none of them is read.
    ;(legacy['features'] as Record<string, unknown>)['totalStrokeCount'] = 42

    const parsed = validateTrialResult(legacy)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.features).toEqual(extractDrawingFeatures(parsed.value.session))
    expect(parsed.value.features.totalStrokeCount).toBe(3)
    expect(parsed.value.features.inCanvasPathLengthPx).toBeGreaterThanOrEqual(0)
  })

  it('preserves the task, trial and session identities across the upgrade', () => {
    const legacy = makeLegacyFile()
    const parsed = validateTrialResult(legacy)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.task.id).toBe(TASK.id)
    expect(parsed.value.trial.id).toBe(TRIAL.id)
    expect(parsed.value.session.id).toBe(makeResult().session.id)
  })

  it('rebuilds the missing timePolicy block from the trial', () => {
    const parsed = validateTrialResult(makeLegacyFile())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.timePolicy).toEqual({
      recommendedSeconds: 60,
      actualDurationMs: 42_000,
      exceededRecommendedTime: false,
      overtimeMs: 0,
    })
  })

  it('still validates the embedded session of a v1 file in full', () => {
    const legacy = makeLegacyFile()
    const session = legacy['session'] as Record<string, unknown>
    session['strokes'] = 'not an array'

    const parsed = validateTrialResult(legacy)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('جلسه نقاشی داخل فایل معتبر نیست')
  })

  it('rejects a wrapper version it has never written or read', () => {
    const parsed = validateTrialResult({ ...makeLegacyFile(), resultSchemaVersion: 3 })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('پشتیبانی نمی‌شود')
  })

  it('writes result schema 2 for every new export', () => {
    const result = makeResult()
    expect(result.resultSchemaVersion).toBe(2)
    expect(JSON.parse(serializeTrialResult(result)).resultSchemaVersion).toBe(2)
  })
})

/** The advisory-time block travels with the result and is recomputed on import. */
describe('advisory time in the result', () => {
  it('includes the time policy in a freshly built result', () => {
    expect(makeResult().timePolicy).toEqual({
      recommendedSeconds: 60,
      actualDurationMs: 42_000,
      exceededRecommendedTime: false,
      overtimeMs: 0,
    })
  })

  it('reports overtime for a trial that ran past the recommendation', () => {
    const longTrial: DrawingTrial = {
      ...TRIAL,
      timing: { ...TRIAL.timing, durationMs: 108_000 },
    }
    const result = buildTrialResult(
      longTrial,
      TASK,
      makeSession({ strokes: makeStrokeSeries(1, ['a']), actions: [] }),
    )

    expect(result.timePolicy.exceededRecommendedTime).toBe(true)
    expect(result.timePolicy.overtimeMs).toBe(48_000)
    // The measured duration is untouched by the comparison.
    expect(result.trial.timing.durationMs).toBe(108_000)
  })

  it('recomputes the time policy on import rather than trusting the file', () => {
    const tampered = JSON.parse(serializeTrialResult(makeResult()))
    tampered.timePolicy = { recommendedSeconds: 1, actualDurationMs: 1, exceededRecommendedTime: true, overtimeMs: 999 }

    const parsed = validateTrialResult(tampered)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.timePolicy.overtimeMs).toBe(0)
    expect(parsed.value.timePolicy.actualDurationMs).toBe(42_000)
  })
})
