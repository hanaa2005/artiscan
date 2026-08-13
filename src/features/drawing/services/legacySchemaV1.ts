/**
 * Reading schema-1 session files.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * Schema 1 and schema 2 have the same field names but different GUARANTEES,
 * and blurring the two is the one mistake that would quietly corrupt research
 * data. Under schema 1:
 *
 *   - Clear DELETED strokes from the file. The action recorded only
 *     `{ removedStrokeCount: 4 }` - four strokes existed, and nothing about
 *     them survives. Their ids, points, timing and tools are gone.
 *   - Undo likewise removed the stroke from `strokes`, leaving an undo action
 *     that references an id no longer present in the file.
 *   - The pressure flag was called `hasRealPressure`.
 *
 * Under schema 2, `strokes` is append-only and those same actions only change
 * visibility. So the identical JSON shape means two different things depending
 * on the version number, which is exactly why the version had to be bumped.
 *
 * THE ONE RULE THIS MODULE MUST NEVER BREAK
 *
 * Data destroyed by the old model is NOT recoverable, and this module will not
 * pretend otherwise. It never invents a stroke, never back-fills an id list
 * from `removedStrokeCount`, and never guesses what was erased. It upgrades the
 * container, preserves every byte that survived, and labels the result as an
 * incomplete history so that no later analysis mistakes it for a full one.
 */

import {
  CURRENT_SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION,
  type DrawingAction,
  type DrawingSession,
  type ParseResult,
  type SessionProvenance,
} from '../types/drawing.types'
import {
  fail,
  validateLegacyStrokesAndActions,
  validateSessionEnvelope,
} from './drawingValidator'

/**
 * Rewrites a v1 `clear` into the v2 shape.
 *
 * The v2 replay hides the strokes a clear names. A v1 clear can name none,
 * because the strokes it removed are not in the file at all - so the upgraded
 * action carries an EMPTY id list. That is the truthful translation: "this
 * clear hides nothing that is still here."
 *
 * `removedStrokeCount` is preserved rather than dropped. It is the only
 * surviving trace of the lost strokes, and a count of what is missing is
 * genuine evidence even when the strokes themselves are not.
 */
function upgradeClearAction(action: DrawingAction): DrawingAction {
  const removedStrokeCount = action.payload?.['removedStrokeCount']

  const payload: Record<string, unknown> = {
    affectedStrokeIds: [],
    legacyDestructiveClear: true,
  }
  if (typeof removedStrokeCount === 'number') {
    payload['removedStrokeCount'] = removedStrokeCount
  }

  return { sequence: action.sequence, timeMs: action.timeMs, type: 'clear', payload }
}

/** True when this v1 clear actually destroyed something. */
function clearDestroyedStrokes(action: DrawingAction): boolean {
  const removedStrokeCount = action.payload?.['removedStrokeCount']
  if (typeof removedStrokeCount === 'number') return removedStrokeCount > 0
  // A clear with no count at all is ambiguous; assume it removed something,
  // because over-reporting missing data is the safe direction to err in.
  return true
}

/** Builds the Persian note shown to the user for an incomplete legacy import. */
function buildProvenanceNote(historyComplete: boolean): string {
  if (historyComplete) {
    return `این جلسه از فایل نسخه ${LEGACY_SCHEMA_VERSION} خوانده و به نسخه ${CURRENT_SCHEMA_VERSION} ارتقا یافت. چون در آن هیچ عمل پاک‌کردنی ثبت نشده، تاریخچه کامل است.`
  }
  return `این جلسه از فایل نسخه ${LEGACY_SCHEMA_VERSION} خوانده شده و تاریخچه آن ناقص است: در آن نسخه، «پاک کردن همه» خطوط را واقعاً حذف می‌کرد و آن خطوط در فایل ذخیره نشده‌اند. این داده‌ها قابل بازیابی نیستند و برای تحلیل نباید کامل فرض شوند.`
}

/**
 * Upgrades a validated schema-1 payload to the current schema.
 *
 * Referential integrity is deliberately NOT enforced here. A v1 file that
 * contains an undo whose stroke was deleted is not corrupt - it is a faithful
 * export of a destructive model. Rejecting it would make the legacy path
 * useless. The v2 replay already ignores references to absent strokes.
 */
export function upgradeLegacyV1Session(
  raw: Record<string, unknown>,
): ParseResult<DrawingSession> {
  const envelope = validateSessionEnvelope(raw)
  if (!envelope.ok) return envelope

  if (!Array.isArray(raw['strokes'])) {
    return fail('فهرست خطوط در فایل وجود ندارد یا آرایه نیست.')
  }
  if (!Array.isArray(raw['actions'])) {
    return fail('فهرست رویدادها در فایل وجود ندارد یا آرایه نیست.')
  }

  const parsed = validateLegacyStrokesAndActions(raw['strokes'], raw['actions'])
  if (!parsed.ok) return parsed

  const { strokes } = parsed.value
  let historyComplete = true

  const actions: DrawingAction[] = parsed.value.actions.map((action) => {
    if (action.type !== 'clear') return action
    if (clearDestroyedStrokes(action)) {
      historyComplete = false
    }
    return upgradeClearAction(action)
  })

  // An undo pointing at a stroke that is not in the file is the other symptom
  // of the destructive model: that stroke was dropped on export.
  const knownIds = new Set(strokes.map((stroke) => stroke.id))
  for (const action of actions) {
    if (action.type !== 'undo' && action.type !== 'redo') continue
    const strokeId = action.payload?.['strokeId']
    if (typeof strokeId === 'string' && !knownIds.has(strokeId)) {
      historyComplete = false
    }
  }

  const provenance: SessionProvenance = {
    importedFromSchemaVersion: LEGACY_SCHEMA_VERSION,
    historyComplete,
    note: buildProvenanceNote(historyComplete),
  }

  return {
    ok: true,
    value: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: envelope.value.id,
      createdAt: envelope.value.createdAt,
      startedAt: envelope.value.startedAt,
      canvas: envelope.value.canvas,
      strokes,
      actions,
      provenance,
    },
  }
}
