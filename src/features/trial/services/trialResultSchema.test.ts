/**
 * Strict feature-block validation, and reading result schema 1 and 2.
 *
 * THE DEFECT THIS PINS DOWN: the old shape check walked only the entries that
 * happened to be present, so an empty `{}` passed as a healthy feature block.
 * A truncated export was indistinguishable from a complete one.
 *
 * The check is now exhaustive for the current schema and lenient for version 1,
 * which is safe precisely because the values are discarded and recomputed
 * either way.
 */

import { describe, expect, it } from 'vitest'
import { validateTrialResult } from './trialResultValidator'
import { buildTrialResult } from './trialResultSerializer'
import {
  CURRENT_RESULT_SCHEMA_VERSION,
  LEGACY_RESULT_SCHEMA_VERSION,
  type DrawingTask,
  type DrawingTrial,
} from '../types/trial.types'
import { extractDrawingFeatures } from '../utils/featureExtraction'
import { makeSession, makeStrokeSeries } from '../../drawing/testing/sessionFixture'
import { TASK_CATALOG } from '../data/taskCatalog'

/** noUncheckedIndexedAccess makes the first catalog entry `| undefined`. */
function firstTask(): DrawingTask {
  const task = TASK_CATALOG[0]
  if (task === undefined) throw new Error('the task catalog must not be empty')
  return task
}

const TASK = firstTask()

const TRIAL: DrawingTrial = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  status: 'completed',
  timeLimitSeconds: 60,
  timing: {
    startedAt: '2026-08-13T10:00:00.000Z',
    completedAt: '2026-08-13T10:01:48.000Z',
    durationMs: 108_000,
    countdownSeconds: 3,
  },
}

function session() {
  return makeSession({ strokes: makeStrokeSeries(2, ['a', 'b']), actions: [] })
}

/** A current-schema result, as a plain JSON-shaped object. */
function currentResult(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(buildTrialResult(TRIAL, TASK, session())))
}

/** The same trial expressed the way result schema 1 wrote it. */
function legacyResult(): Record<string, unknown> {
  const result = currentResult()
  result['resultSchemaVersion'] = LEGACY_RESULT_SCHEMA_VERSION
  delete result['timePolicy']
  // Version 1 carried only this smaller set of features.
  result['features'] = {
    totalStrokeCount: 2,
    visibleStrokeCount: 2,
    penStrokeCount: 2,
    eraserStrokeCount: 0,
    totalPointCount: 6,
    durationMs: 120,
    totalPathLengthPx: 500,
    totalPathLengthNormalized: 0.7,
    boundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 },
    boundingBoxNormalized: null,
    canvasCoverageRatio: 1,
    undoCount: 0,
    redoCount: 0,
    clearCount: 0,
    toolChangeCount: 0,
    colorChangeCount: 0,
    widthChangeCount: 0,
    pressureSampleCount: 0,
    minPressure: null,
    maxPressure: null,
    meanPressure: null,
    validSpeedSampleCount: 3,
    meanSpeedNormalizedPerSecond: 0.2,
    maxSpeedNormalizedPerSecond: 0.4,
    pauseCount: 0,
    totalPauseMs: 0,
    longestPauseMs: 0,
  }
  return result
}

describe('strict feature-block validation', () => {
  it('accepts a complete, valid feature block', () => {
    const parsed = validateTrialResult(currentResult())
    expect(parsed.ok).toBe(true)
  })

  it('REJECTS an empty feature object', () => {
    // The exact regression: `{}` used to pass, because only present entries
    // were examined.
    const raw = currentResult()
    raw['features'] = {}

    const parsed = validateTrialResult(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('وجود ندارد')
  })

  it('rejects a block missing a single field', () => {
    const raw = currentResult()
    const features = raw['features'] as Record<string, unknown>
    delete features['inCanvasPathLengthPx']

    const parsed = validateTrialResult(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('inCanvasPathLengthPx')
  })

  it('rejects an unknown extra field within the same schema version', () => {
    const raw = currentResult()
    const features = raw['features'] as Record<string, unknown>
    features['creativityScore'] = 0.9

    const parsed = validateTrialResult(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('creativityScore')
  })

  it('rejects null in a field that is never nullable', () => {
    const raw = currentResult()
    const features = raw['features'] as Record<string, unknown>
    features['totalPointCount'] = null

    const parsed = validateTrialResult(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('totalPointCount')
  })

  it('accepts null in the documented nullable fields', () => {
    const raw = currentResult()
    const features = raw['features'] as Record<string, unknown>
    for (const key of [
      'minPressure',
      'maxPressure',
      'meanPressure',
      'boundingBox',
      'boundingBoxNormalized',
      'rawBoundingBox',
      'inCanvasBoundingBox',
    ]) {
      features[key] = null
    }

    expect(validateTrialResult(raw).ok).toBe(true)
  })

  it('rejects a bounding box that is missing a member', () => {
    const raw = currentResult()
    const features = raw['features'] as Record<string, unknown>
    features['rawBoundingBox'] = { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10 }

    const parsed = validateTrialResult(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('height')
  })

  it('rejects a bounding box with a non-finite member', () => {
    const raw = currentResult()
    const features = raw['features'] as Record<string, unknown>
    features['rawBoundingBox'] = {
      minX: 0,
      minY: 0,
      maxX: 10,
      maxY: 10,
      width: 10,
      height: 'tall',
    }

    expect(validateTrialResult(raw).ok).toBe(false)
  })

  it('rejects an array where a bounding box is required', () => {
    const raw = currentResult()
    const features = raw['features'] as Record<string, unknown>
    features['inCanvasBoundingBox'] = [0, 0, 10, 10]

    expect(validateTrialResult(raw).ok).toBe(false)
  })

  it('rejects an array in place of the whole feature block', () => {
    const raw = currentResult()
    raw['features'] = []

    expect(validateTrialResult(raw).ok).toBe(false)
  })

  it('accepts correctly shaped but TAMPERED values, and recomputes them', () => {
    // Shape is a corruption check, not a truth check. Wrong-but-well-formed
    // numbers are simply replaced, because the session is the source of truth.
    const raw = currentResult()
    const features = raw['features'] as Record<string, unknown>
    features['totalStrokeCount'] = 9999
    features['visibleCanvasCoverageRatio'] = 1
    features['pauseCount'] = 42

    const parsed = validateTrialResult(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const truth = extractDrawingFeatures(parsed.value.session)
    expect(parsed.value.features).toEqual(truth)
    expect(parsed.value.features.totalStrokeCount).toBe(2)
    expect(parsed.value.features.pauseCount).not.toBe(42)
  })
})

describe('result schema versioning', () => {
  it('writes the current version', () => {
    expect(buildTrialResult(TRIAL, TASK, session()).resultSchemaVersion).toBe(
      CURRENT_RESULT_SCHEMA_VERSION,
    )
    expect(CURRENT_RESULT_SCHEMA_VERSION).toBe(2)
  })

  it('keeps the embedded DrawingSession at schema 2 - the recording did not change', () => {
    const result = buildTrialResult(TRIAL, TASK, session())
    expect(result.session.schemaVersion).toBe(2)
  })

  it('reads a result-schema-1 file', () => {
    const parsed = validateTrialResult(legacyResult())
    expect(parsed.ok).toBe(true)
  })

  it('upgrades a v1 file to current features without touching its session', () => {
    const original = session()
    const parsed = validateTrialResult(legacyResult())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.resultSchemaVersion).toBe(CURRENT_RESULT_SCHEMA_VERSION)
    // The session is returned exactly as recorded: reading an old wrapper never
    // rewrites the recording inside it.
    expect(parsed.value.session).toEqual(original)
    expect(parsed.value.session.schemaVersion).toBe(2)
  })

  it('ignores the stored v1 features entirely', () => {
    const parsed = validateTrialResult(legacyResult())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    // The v1 block claimed 100% coverage and 500px of travel; both are replaced.
    expect(parsed.value.features).toEqual(extractDrawingFeatures(parsed.value.session))
    expect(parsed.value.features.totalPathLengthPx).not.toBe(500)
    // Fields that did not exist in v1 are present and finite.
    expect(Number.isFinite(parsed.value.features.outsideCanvasPointRatio)).toBe(true)
    expect(Number.isFinite(parsed.value.features.inCanvasPathLengthPx)).toBe(true)
  })

  it('preserves task, trial and session identity across a v1 import', () => {
    const parsed = validateTrialResult(legacyResult())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.trial.id).toBe(TRIAL.id)
    expect(parsed.value.task.id).toBe(TASK.id)
    expect(parsed.value.session.id).toBe(session().id)
  })

  it('derives the time policy for a v1 file that never carried one', () => {
    const parsed = validateTrialResult(legacyResult())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.timePolicy.recommendedSeconds).toBe(60)
    expect(parsed.value.timePolicy.actualDurationMs).toBe(108_000)
    expect(parsed.value.timePolicy.exceededRecommendedTime).toBe(true)
    expect(parsed.value.timePolicy.overtimeMs).toBe(48_000)
  })

  it('still validates the embedded session of a v1 file in full', () => {
    const raw = legacyResult()
    const embedded = raw['session'] as Record<string, unknown>
    embedded['strokes'] = 'not an array'

    const parsed = validateTrialResult(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('جلسه نقاشی داخل فایل معتبر نیست')
  })

  it('does not apply the strict field list to a v1 file', () => {
    // A v1 block genuinely lacks the schema-2 fields; rejecting it for that
    // would make every previously exported result unreadable.
    const parsed = validateTrialResult(legacyResult())
    expect(parsed.ok).toBe(true)
  })

  it('rejects any version it does not know', () => {
    for (const version of [0, 3, 99, '2', null]) {
      const raw = currentResult()
      raw['resultSchemaVersion'] = version
      const parsed = validateTrialResult(raw)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.error).toContain('پشتیبانی نمی‌شود')
    }
  })
})
