/**
 * Building, serializing and reading DrawingTrialResult files.
 *
 * The important decision lives in `deserializeTrialResult`: imported features
 * are DISCARDED and recomputed from the canonical session. See the validator
 * for the reasoning.
 */

import type { ParseResult } from '../../drawing/types/drawing.types'
import type { DrawingSession } from '../../drawing/types/drawing.types'
import {
  CURRENT_RESULT_SCHEMA_VERSION,
  type DrawingTask,
  type DrawingTrial,
  type DrawingTrialResult,
} from '../types/trial.types'
import { extractDrawingFeatures } from '../utils/featureExtraction'
import { computeTimePolicy } from '../utils/timePolicy'
import { validateTrialResult } from './trialResultValidator'

/**
 * Assembles a result from a finished trial.
 *
 * The session is embedded UNCHANGED - not re-serialized, not normalized, not
 * trimmed. Features are computed here so the exported file carries a readable
 * summary, but they remain a cache: the session alone is sufficient.
 */
export function buildTrialResult(
  trial: DrawingTrial,
  task: DrawingTask,
  session: DrawingSession,
): DrawingTrialResult {
  return {
    resultSchemaVersion: CURRENT_RESULT_SCHEMA_VERSION,
    trial,
    task,
    session,
    features: extractDrawingFeatures(session),
    timePolicy: computeTimePolicy(trial),
  }
}

/** Serializes a result to pretty-printed, human-readable JSON. */
export function serializeTrialResult(result: DrawingTrialResult): string {
  return JSON.stringify(result, null, 2)
}

/**
 * Parses JSON text into a validated result whose features have been recomputed.
 *
 * JSON.parse throws on malformed text, so it is wrapped: a truncated file must
 * produce a readable Persian message, never an unhandled exception.
 */
export function deserializeTrialResult(text: string): ParseResult<DrawingTrialResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ok: false,
      error: 'فایل انتخاب‌شده یک JSON معتبر نیست و قابل خواندن نبود.',
    }
  }
  return validateTrialResult(parsed)
}

/** Builds the download file name, e.g. `artiscan-trial-house-a1b2c3d4-2026-08-13.json`. */
export function buildTrialResultFileName(
  result: DrawingTrialResult,
  dateStamp: string,
): string {
  const shortId = result.trial.id.slice(0, 8)
  return `artiscan-trial-${result.task.id}-${shortId}-${dateStamp}.json`
}
