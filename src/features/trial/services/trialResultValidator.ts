/**
 * Validation for imported DrawingTrialResult files.
 *
 * THE POLICY ON IMPORTED FEATURES: recompute, never trust.
 *
 * The brief offered two options - compare stored features against recomputed
 * ones within a tolerance, or discard and recompute. This module recomputes,
 * for three reasons:
 *
 * 1. Features are a CACHE, not data. The session is the source of truth and it
 *    is validated in full, so the stored numbers add no information - only a
 *    second thing that can be wrong.
 * 2. Tolerance comparison needs a tolerance per field, and picking those is
 *    guesswork that quietly turns into policy. Reject too eagerly and a file
 *    written by a slightly older build becomes unreadable; reject too loosely
 *    and the check stops meaning anything.
 * 3. Recomputing makes results self-healing. When a formula is corrected, every
 *    existing file yields the corrected numbers on import, with no migration.
 *
 * Stored features are still SHAPE-checked, because a file whose features are
 * structurally broken signals a corrupt export worth reporting. They are simply
 * not used afterwards. The shape check is STRICT for the current schema: an
 * empty `{}` used to pass, because only the fields that happened to be present
 * were examined - a file missing every feature looked as healthy as a complete
 * one.
 *
 * VERSION COMPATIBILITY
 *
 * Result schema 2 is written; results schema 1 and 2 are read. A v1 file has a
 * smaller feature block with three fields whose meaning later changed, so its
 * features are shape-checked LENIENTLY and then discarded like any other - the
 * recomputation is what makes reading old files safe. The embedded
 * DrawingSession is validated identically in both cases and is never modified
 * to "upgrade" the wrapper around it.
 *
 * Nothing here throws; every failure returns a readable Persian message.
 */

import { validateSession } from '../../drawing/services/drawingValidator'
import type { DrawingSession, ParseResult } from '../../drawing/types/drawing.types'
import {
  CURRENT_RESULT_SCHEMA_VERSION,
  LEGACY_RESULT_SCHEMA_VERSION,
  type DrawingFeatures,
  type DrawingTask,
  type DrawingTrial,
  type DrawingTrialResult,
  type TrialStatus,
} from '../types/trial.types'
import { extractDrawingFeatures } from '../utils/featureExtraction'
import { computeTimePolicy } from '../utils/timePolicy'

const VALID_TRIAL_STATUSES: readonly string[] = [
  'idle',
  'instructions',
  'countdown',
  'drawing',
  'completed',
  'cancelled',
]

/** What kind of value each feature field must hold. */
type FeatureFieldKind =
  /** A finite number. Never null. */
  | 'number'
  /** A finite number, or null when the input genuinely lacked the samples. */
  | 'nullableNumber'
  /** A complete BoundingBox, or null when there is no geometry. */
  | 'nullableBox'

/**
 * The exhaustive contract for the current feature block.
 *
 * Typed as `Record<keyof DrawingFeatures, ...>`, so adding a field to
 * DrawingFeatures without describing it here is a COMPILE error rather than a
 * silently unvalidated field.
 */
const FEATURE_FIELD_SPEC: Readonly<Record<keyof DrawingFeatures, FeatureFieldKind>> = {
  totalStrokeCount: 'number',
  visibleStrokeCount: 'number',
  penStrokeCount: 'number',
  eraserStrokeCount: 'number',
  totalPointCount: 'number',

  insideCanvasPointCount: 'number',
  outsideCanvasPointCount: 'number',
  outsideCanvasPointRatio: 'number',
  strokeWithOutsidePointsCount: 'number',

  durationMs: 'number',

  rawPathLengthPx: 'number',
  rawPathLengthNormalized: 'number',
  rawBoundingBox: 'nullableBox',

  inCanvasPathLengthPx: 'number',
  inCanvasPathLengthNormalized: 'number',
  inCanvasBoundingBox: 'nullableBox',
  visibleCanvasCoverageRatio: 'number',

  totalPathLengthPx: 'number',
  totalPathLengthNormalized: 'number',
  boundingBox: 'nullableBox',
  boundingBoxNormalized: 'nullableBox',
  canvasCoverageRatio: 'number',

  undoCount: 'number',
  redoCount: 'number',
  clearCount: 'number',
  toolChangeCount: 'number',
  colorChangeCount: 'number',
  widthChangeCount: 'number',

  pressureSampleCount: 'number',
  minPressure: 'nullableNumber',
  maxPressure: 'nullableNumber',
  meanPressure: 'nullableNumber',

  validRawSpeedSampleCount: 'number',
  meanRawSpeedNormalizedPerSecond: 'number',
  maxRawSpeedNormalizedPerSecond: 'number',
  validInCanvasSpeedSampleCount: 'number',
  meanInCanvasSpeedNormalizedPerSecond: 'number',
  maxInCanvasSpeedNormalizedPerSecond: 'number',
  validSpeedSampleCount: 'number',
  meanSpeedNormalizedPerSecond: 'number',
  maxSpeedNormalizedPerSecond: 'number',

  pauseCount: 'number',
  totalPauseMs: 'number',
  longestPauseMs: 'number',
}

/** Every member a BoundingBox must have, and nothing else. */
const BOUNDING_BOX_MEMBERS: readonly string[] = [
  'minX',
  'minY',
  'maxX',
  'maxY',
  'width',
  'height',
]

/** Feature fields that were legitimately null in a result-schema-1 file. */
const LEGACY_NULLABLE_FEATURE_FIELDS: readonly string[] = [
  'minPressure',
  'maxPressure',
  'meanPressure',
  'boundingBox',
  'boundingBoxNormalized',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/** True when the string parses as a real calendar timestamp. */
function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  return Number.isFinite(Date.parse(value))
}

function validateTask(raw: unknown): ParseResult<DrawingTask> {
  if (!isRecord(raw)) {
    return fail('اطلاعات تکلیف در فایل وجود ندارد.')
  }
  if (typeof raw['id'] !== 'string' || raw['id'].length === 0) {
    return fail('شناسه تکلیف نامعتبر است.')
  }
  if (typeof raw['labelFa'] !== 'string' || typeof raw['labelEn'] !== 'string') {
    return fail('برچسب فارسی یا انگلیسی تکلیف نامعتبر است.')
  }
  if (typeof raw['quickDrawCategory'] !== 'string') {
    return fail('دسته QuickDraw تکلیف نامعتبر است.')
  }
  if (typeof raw['instructionFa'] !== 'string') {
    return fail('متن دستورالعمل تکلیف نامعتبر است.')
  }

  const timeLimit = raw['timeLimitSeconds']
  if (timeLimit !== null && (!isFiniteNumber(timeLimit) || timeLimit <= 0)) {
    return fail('زمان پیشنهادی تکلیف باید عددی مثبت یا null باشد.')
  }
  if (typeof raw['enabled'] !== 'boolean') {
    return fail('وضعیت فعال بودن تکلیف نامعتبر است.')
  }

  return {
    ok: true,
    value: {
      id: raw['id'],
      labelFa: raw['labelFa'],
      labelEn: raw['labelEn'],
      quickDrawCategory: raw['quickDrawCategory'],
      instructionFa: raw['instructionFa'],
      timeLimitSeconds: timeLimit === null ? null : timeLimit,
      enabled: raw['enabled'],
    },
  }
}

function validateTrial(raw: unknown): ParseResult<DrawingTrial> {
  if (!isRecord(raw)) {
    return fail('اطلاعات جلسه آزمون در فایل وجود ندارد.')
  }
  if (typeof raw['id'] !== 'string' || raw['id'].length === 0) {
    return fail('شناسه آزمون نامعتبر است.')
  }

  const status = raw['status']
  if (typeof status !== 'string' || !VALID_TRIAL_STATUSES.includes(status)) {
    return fail('وضعیت آزمون نامعتبر است.')
  }
  // Only a finished trial produces a result. Importing a cancelled or
  // half-finished one would present an incomplete recording as a real outcome.
  if (status !== 'completed') {
    return fail(
      `فقط آزمون تکمیل‌شده قابل وارد کردن است؛ وضعیت این فایل «${status}» است.`,
    )
  }

  const timing = raw['timing']
  if (!isRecord(timing)) {
    return fail('اطلاعات زمانی آزمون در فایل وجود ندارد.')
  }
  if (!isValidIsoTimestamp(timing['startedAt'])) {
    return fail('زمان شروع آزمون نامعتبر است.')
  }
  if (!isValidIsoTimestamp(timing['completedAt'])) {
    return fail('زمان پایان آزمون نامعتبر است.')
  }

  const startedMs = Date.parse(timing['startedAt'])
  const completedMs = Date.parse(timing['completedAt'])
  if (completedMs < startedMs) {
    return fail('زمان پایان آزمون قبل از زمان شروع آن است.')
  }

  const durationMs = timing['durationMs']
  if (!isFiniteNumber(durationMs) || durationMs < 0) {
    return fail('مدت زمان آزمون نامعتبر است.')
  }

  const countdownSeconds = timing['countdownSeconds']
  if (!isFiniteNumber(countdownSeconds) || countdownSeconds < 0) {
    return fail('مدت شمارش معکوس نامعتبر است.')
  }

  const timeLimit = raw['timeLimitSeconds']
  if (timeLimit !== null && (!isFiniteNumber(timeLimit) || timeLimit <= 0)) {
    return fail('زمان پیشنهادی آزمون باید عددی مثبت یا null باشد.')
  }

  return {
    ok: true,
    value: {
      id: raw['id'],
      status: status as TrialStatus,
      timeLimitSeconds: timeLimit === null ? null : timeLimit,
      timing: {
        startedAt: timing['startedAt'],
        completedAt: timing['completedAt'],
        durationMs,
        countdownSeconds,
      },
    },
  }
}

/** Checks one bounding box: present, complete, and finite throughout. */
function validateBoundingBox(key: string, value: unknown): ParseResult<true> {
  if (!isRecord(value)) {
    return fail(`ویژگی «${key}» باید یک کادر محیطی یا null باشد.`)
  }
  for (const member of BOUNDING_BOX_MEMBERS) {
    if (!(member in value)) {
      return fail(`عضو «${member}» در کادر محیطی «${key}» وجود ندارد.`)
    }
    if (!isFiniteNumber(value[member])) {
      return fail(`مقدار «${member}» در کادر محیطی «${key}» عددی متناهی نیست.`)
    }
  }
  for (const member of Object.keys(value)) {
    if (!BOUNDING_BOX_MEMBERS.includes(member)) {
      return fail(`عضو ناشناخته «${member}» در کادر محیطی «${key}» وجود دارد.`)
    }
  }
  return { ok: true, value: true }
}

/**
 * STRICT shape check for a current-schema feature block.
 *
 * Every documented field must be present with the right kind, and no
 * undocumented field may appear. Both halves matter: a missing field means the
 * export was truncated, and an unexpected one means the file was produced by
 * something that does not agree with this schema version - either way the
 * honest answer is to say so rather than quietly accept it.
 */
function validateFeatureShapeStrict(raw: unknown): ParseResult<true> {
  if (!isRecord(raw)) {
    return fail('بخش ویژگی‌های استخراج‌شده در فایل وجود ندارد یا ساختار درستی ندارد.')
  }

  for (const [key, kind] of Object.entries(FEATURE_FIELD_SPEC)) {
    if (!(key in raw)) {
      return fail(`ویژگی «${key}» در فایل وجود ندارد.`)
    }
    const value = raw[key]

    if (kind === 'number') {
      if (!isFiniteNumber(value)) {
        return fail(`ویژگی «${key}» باید عددی متناهی باشد و نمی‌تواند null باشد.`)
      }
      continue
    }

    if (kind === 'nullableNumber') {
      if (value === null) continue
      if (!isFiniteNumber(value)) {
        return fail(`ویژگی «${key}» باید عددی متناهی یا null باشد.`)
      }
      continue
    }

    if (value === null) continue
    const boxResult = validateBoundingBox(key, value)
    if (!boxResult.ok) return boxResult
  }

  for (const key of Object.keys(raw)) {
    if (!(key in FEATURE_FIELD_SPEC)) {
      return fail(
        `ویژگی ناشناخته «${key}» در فایل وجود دارد؛ این فایل با نسخه ${CURRENT_RESULT_SCHEMA_VERSION} سازگار نیست.`,
      )
    }
  }

  return { ok: true, value: true }
}

/**
 * LENIENT shape check for a result-schema-1 feature block.
 *
 * A v1 file predates most of the fields above, so requiring them would reject
 * every previously exported result. Only what is present is checked - which is
 * safe here precisely because the values are discarded and recomputed a moment
 * later, and because the SESSION is validated in full either way.
 */
function validateFeatureShapeLegacy(raw: unknown): ParseResult<true> {
  if (!isRecord(raw)) {
    return fail('بخش ویژگی‌های استخراج‌شده در فایل وجود ندارد.')
  }

  for (const [key, value] of Object.entries(raw)) {
    if (value === null) {
      if (LEGACY_NULLABLE_FEATURE_FIELDS.includes(key)) continue
      return fail(`ویژگی «${key}» نمی‌تواند null باشد.`)
    }
    if (isRecord(value)) {
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (!isFiniteNumber(innerValue)) {
          return fail(`مقدار «${innerKey}» در ویژگی «${key}» عددی متناهی نیست.`)
        }
      }
      continue
    }
    if (!isFiniteNumber(value)) {
      return fail(`ویژگی «${key}» باید عددی متناهی باشد؛ مقدار NaN یا Infinity مجاز نیست.`)
    }
  }

  return { ok: true, value: true }
}

/**
 * Validates a parsed result and returns it with FRESHLY COMPUTED features.
 *
 * The returned object's `features` and `timePolicy` never come from the file.
 */
export function validateTrialResult(raw: unknown): ParseResult<DrawingTrialResult> {
  if (!isRecord(raw)) {
    return fail('فایل انتخاب‌شده یک نتیجه آزمون معتبر نیست.')
  }

  const version = raw['resultSchemaVersion']
  if (version === undefined) {
    return fail(
      'فیلد resultSchemaVersion در فایل وجود ندارد؛ این فایل خروجی آزمون ArtiScan نیست.',
    )
  }
  if (version !== CURRENT_RESULT_SCHEMA_VERSION && version !== LEGACY_RESULT_SCHEMA_VERSION) {
    return fail(
      `نسخه Schema نتیجه (${String(version)}) پشتیبانی نمی‌شود؛ این نسخه فقط نسخه‌های ${LEGACY_RESULT_SCHEMA_VERSION} و ${CURRENT_RESULT_SCHEMA_VERSION} را می‌خواند.`,
    )
  }
  const isLegacy = version === LEGACY_RESULT_SCHEMA_VERSION

  const taskResult = validateTask(raw['task'])
  if (!taskResult.ok) return taskResult

  const trialResult = validateTrial(raw['trial'])
  if (!trialResult.ok) return trialResult

  const featureShape = isLegacy
    ? validateFeatureShapeLegacy(raw['features'])
    : validateFeatureShapeStrict(raw['features'])
  if (!featureShape.ok) return featureShape

  // The embedded session goes through the FULL week-1 validator: shape,
  // structure, merged timeline, referential and semantic integrity. A result is
  // only as trustworthy as the recording inside it. It is returned exactly as
  // recorded - reading an old wrapper never rewrites the session inside it.
  const sessionResult = validateSession(raw['session'])
  if (!sessionResult.ok) {
    return fail(`جلسه نقاشی داخل فایل معتبر نیست: ${sessionResult.error}`)
  }

  const session: DrawingSession = sessionResult.value
  const features: DrawingFeatures = extractDrawingFeatures(session)

  return {
    ok: true,
    value: {
      resultSchemaVersion: CURRENT_RESULT_SCHEMA_VERSION,
      trial: trialResult.value,
      task: taskResult.value,
      session,
      features,
      timePolicy: computeTimePolicy(trialResult.value),
    },
  }
}
