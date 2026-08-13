/**
 * Schema validation for imported session files.
 *
 * An imported file is UNTRUSTED input: the user may pick any .json on their
 * disk, hand-edit an export, or open a file written by an older version of
 * ArtiScan. Nothing here may throw and nothing may crash the app - every
 * failure returns a readable Persian message instead.
 *
 * Validation runs in three layers, and the order matters:
 *
 *   1. SHAPE      - is each field the right type and in the right range?
 *   2. STRUCTURE  - are ids unique, sequences strictly increasing, timestamps
 *                   non-decreasing, `order` a clean 0..n-1 permutation?
 *   3. REFERENCE  - do undo/redo/clear actually point at strokes that exist?
 *
 * Layers 1 and 2 apply to every version. Layer 3 applies to schema 2 only:
 * a v1 file legitimately contains undo and clear events whose strokes were
 * deleted by the old destructive model, so demanding referential integrity
 * there would reject files that are perfectly valid for what they are. Legacy
 * handling lives in its own module - see legacySchemaV1.ts.
 *
 * Note the complete absence of `any`: input is typed `unknown` and narrowed
 * step by step, so TypeScript itself proves we never read an unchecked field.
 */

import {
  CURRENT_SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION,
  type DrawingAction,
  type DrawingActionType,
  type DrawingSession,
  type DrawingStroke,
  type DrawingTool,
  type ParseResult,
  type PointSample,
  type PointerInputType,
  type SessionProvenance,
} from '../types/drawing.types'
import { upgradeLegacyV1Session } from './legacySchemaV1'

const VALID_TOOLS: readonly string[] = ['pen', 'eraser']
const VALID_POINTER_TYPES: readonly string[] = ['mouse', 'pen', 'touch', 'unknown']
const VALID_ACTION_TYPES: readonly string[] = [
  'undo',
  'redo',
  'clear',
  'tool_change',
  'color_change',
  'width_change',
]

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

/** A sequence number must be a non-negative whole number - it is a counter. */
function isValidSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

// ---------------------------------------------------------------------------
// Layer 1: shape
// ---------------------------------------------------------------------------

function validatePoint(
  raw: unknown,
  strokeIndex: number,
  pointIndex: number,
): ParseResult<PointSample> {
  const where = `خط ${strokeIndex + 1}، نقطه ${pointIndex + 1}`

  if (!isRecord(raw)) {
    return fail(`ساختار نقطه نامعتبر است (${where}).`)
  }
  if (!isValidSequence(raw['sequence'])) {
    return fail(`شماره ترتیب نقطه باید عددی صحیح و نامنفی باشد (${where}).`)
  }
  if (!isFiniteNumber(raw['timeMs'])) {
    return fail(`زمان نقطه نامعتبر است (${where}).`)
  }
  if (raw['timeMs'] < 0) {
    return fail(`زمان نقطه نمی‌تواند منفی باشد (${where}).`)
  }
  if (!isFiniteNumber(raw['x']) || !isFiniteNumber(raw['y'])) {
    return fail(`مختصات نقطه نامعتبر است (${where}).`)
  }

  const normalizedX = raw['normalizedX']
  const normalizedY = raw['normalizedY']
  if (!isFiniteNumber(normalizedX) || !isFiniteNumber(normalizedY)) {
    return fail(`مختصات نرمال‌شده نقطه نامعتبر است (${where}).`)
  }
  if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
    return fail(`مختصات نرمال‌شده باید بین ۰ و ۱ باشد (${where}).`)
  }

  if (!isNullableFiniteNumber(raw['pressure'])) {
    return fail(`مقدار فشار قلم نامعتبر است (${where}).`)
  }
  if (!isNullableFiniteNumber(raw['tiltX']) || !isNullableFiniteNumber(raw['tiltY'])) {
    return fail(`زاویه قلم نامعتبر است (${where}).`)
  }

  const pointerType = raw['pointerType']
  if (typeof pointerType !== 'string' || !VALID_POINTER_TYPES.includes(pointerType)) {
    return fail(`نوع ورودی نقطه نامعتبر است (${where}).`)
  }

  return {
    ok: true,
    value: {
      sequence: raw['sequence'],
      timeMs: raw['timeMs'],
      x: raw['x'],
      y: raw['y'],
      normalizedX,
      normalizedY,
      pressure: raw['pressure'],
      tiltX: raw['tiltX'],
      tiltY: raw['tiltY'],
      pointerType: pointerType as PointerInputType,
    },
  }
}

/**
 * Validates one stroke.
 *
 * `pressureFieldName` differs between versions: schema 1 wrote
 * `hasRealPressure`, schema 2 writes `hasPressureSamples`. Passing the name in
 * keeps a single implementation honest about both without guessing.
 */
function validateStroke(
  raw: unknown,
  index: number,
  pressureFieldName: 'hasPressureSamples' | 'hasRealPressure',
): ParseResult<DrawingStroke> {
  const where = `خط ${index + 1}`

  if (!isRecord(raw)) {
    return fail(`ساختار خطوط نامعتبر است (${where}).`)
  }
  if (typeof raw['id'] !== 'string' || raw['id'].length === 0) {
    return fail(`شناسه خط وجود ندارد یا نامعتبر است (${where}).`)
  }
  if (!isValidSequence(raw['order'])) {
    return fail(`ترتیب خط باید عددی صحیح و نامنفی باشد (${where}).`)
  }

  const tool = raw['tool']
  if (typeof tool !== 'string' || !VALID_TOOLS.includes(tool)) {
    return fail(`ابزار خط نامعتبر است؛ فقط pen یا eraser مجاز است (${where}).`)
  }
  if (typeof raw['color'] !== 'string') {
    return fail(`رنگ خط نامعتبر است (${where}).`)
  }
  if (!isFiniteNumber(raw['width']) || raw['width'] <= 0) {
    return fail(`ضخامت خط باید عددی مثبت باشد (${where}).`)
  }

  const startedAtMs = raw['startedAtMs']
  const endedAtMs = raw['endedAtMs']
  if (!isFiniteNumber(startedAtMs) || !isFiniteNumber(endedAtMs)) {
    return fail(`زمان شروع یا پایان خط نامعتبر است (${where}).`)
  }
  if (startedAtMs < 0 || endedAtMs < 0) {
    return fail(`زمان خط نمی‌تواند منفی باشد (${where}).`)
  }
  if (startedAtMs > endedAtMs) {
    return fail(`زمان شروع خط بزرگ‌تر از زمان پایان آن است (${where}).`)
  }

  if (!Array.isArray(raw['points'])) {
    return fail(`فهرست نقاط خط نامعتبر است (${where}).`)
  }

  const points: PointSample[] = []
  for (let i = 0; i < raw['points'].length; i += 1) {
    const result = validatePoint(raw['points'][i], index, i)
    if (!result.ok) return result
    points.push(result.value)
  }

  // Within a stroke the samples are a single monotonic recording.
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1]
    const current = points[i]
    if (previous === undefined || current === undefined) continue
    if (current.sequence <= previous.sequence) {
      return fail(`شماره ترتیب نقاط باید صعودی باشد (${where}، نقطه ${i + 1}).`)
    }
    if (current.timeMs < previous.timeMs) {
      return fail(`زمان نقاط نمی‌تواند کاهش یابد (${where}، نقطه ${i + 1}).`)
    }
  }

  return {
    ok: true,
    value: {
      id: raw['id'],
      order: raw['order'],
      tool: tool as DrawingTool,
      color: raw['color'],
      width: raw['width'],
      startedAtMs,
      endedAtMs,
      hasPressureSamples: raw[pressureFieldName] === true,
      points,
    },
  }
}

function validateAction(raw: unknown, index: number): ParseResult<DrawingAction> {
  const where = `رویداد ${index + 1}`

  if (!isRecord(raw)) {
    return fail(`ساختار رویدادها نامعتبر است (${where}).`)
  }
  if (!isValidSequence(raw['sequence'])) {
    return fail(`شماره ترتیب رویداد باید عددی صحیح و نامنفی باشد (${where}).`)
  }
  if (!isFiniteNumber(raw['timeMs'])) {
    return fail(`زمان رویداد نامعتبر است (${where}).`)
  }
  if (raw['timeMs'] < 0) {
    return fail(`زمان رویداد نمی‌تواند منفی باشد (${where}).`)
  }

  const type = raw['type']
  if (typeof type !== 'string' || !VALID_ACTION_TYPES.includes(type)) {
    return fail(`نوع رویداد نامعتبر است (${where}).`)
  }

  const payload = raw['payload']
  if (payload !== undefined && !isRecord(payload)) {
    return fail(`محتوای رویداد نامعتبر است (${where}).`)
  }

  // A clear event drives the visibility replay, so its id list is validated
  // rather than trusted: a malformed one would silently paint the wrong canvas.
  if (type === 'clear' && payload !== undefined) {
    const affected = payload['affectedStrokeIds']
    if (affected !== undefined) {
      if (!Array.isArray(affected) || !affected.every((id) => typeof id === 'string')) {
        return fail(
          `فهرست خطوط پاک‌شده در رویداد clear باید آرایه‌ای از شناسه‌ها باشد (${where}).`,
        )
      }
    }
  }

  if ((type === 'undo' || type === 'redo') && payload !== undefined) {
    const strokeId = payload['strokeId']
    if (strokeId !== undefined && typeof strokeId !== 'string') {
      return fail(`شناسه خط در رویداد ${type} نامعتبر است (${where}).`)
    }
  }

  const action: DrawingAction = {
    sequence: raw['sequence'],
    timeMs: raw['timeMs'],
    type: type as DrawingActionType,
  }
  // Assigned conditionally because exactOptionalPropertyTypes forbids
  // explicitly writing `undefined` into an optional property.
  if (payload !== undefined) {
    action.payload = payload
  }
  return { ok: true, value: action }
}

/**
 * Reads the provenance note off a v2 file.
 *
 * This must survive a round trip. Re-exporting an imported legacy session would
 * otherwise launder an incomplete history into a clean-looking v2 file - the
 * "four strokes are missing" warning would silently disappear the first time
 * the user pressed Export, which is the opposite of what the field is for.
 *
 * A malformed note is dropped rather than rejected: the strokes are the data
 * that matters, and a corrupt annotation is not worth refusing the file over.
 */
function readProvenance(raw: unknown): SessionProvenance | null {
  if (!isRecord(raw)) return null
  if (raw['importedFromSchemaVersion'] !== LEGACY_SCHEMA_VERSION) return null
  if (typeof raw['historyComplete'] !== 'boolean') return null
  if (typeof raw['note'] !== 'string') return null

  return {
    importedFromSchemaVersion: LEGACY_SCHEMA_VERSION,
    historyComplete: raw['historyComplete'],
    note: raw['note'],
  }
}

function validateCanvas(raw: unknown): ParseResult<DrawingSession['canvas']> {
  if (!isRecord(raw)) {
    return fail('اطلاعات ابعاد بوم در فایل وجود ندارد.')
  }
  if (!isFiniteNumber(raw['width']) || !isFiniteNumber(raw['height'])) {
    return fail('ابعاد بوم در فایل نامعتبر است.')
  }
  if (raw['width'] <= 0 || raw['height'] <= 0) {
    return fail('ابعاد بوم باید عددی مثبت باشد.')
  }
  const ratio = raw['devicePixelRatio']
  return {
    ok: true,
    value: {
      width: raw['width'],
      height: raw['height'],
      devicePixelRatio: isFiniteNumber(ratio) && ratio > 0 ? ratio : 1,
    },
  }
}

// ---------------------------------------------------------------------------
// Layer 2: structure (applies to every schema version)
// ---------------------------------------------------------------------------

/**
 * Checks the invariants that make a session a coherent recording rather than a
 * bag of plausible-looking objects.
 *
 * Each of these would corrupt an analysis rather than crash the app, which is
 * exactly why they are worth rejecting at the door: a duplicate stroke id makes
 * every id-based lookup ambiguous, a repeated sequence number destroys the
 * merged timeline, and a duplicated `order` value makes "the third stroke drawn"
 * meaningless.
 */
export function validateStructuralIntegrity(
  strokes: readonly DrawingStroke[],
  actions: readonly DrawingAction[],
): ParseResult<true> {
  const strokeIds = new Set<string>()
  for (const stroke of strokes) {
    if (strokeIds.has(stroke.id)) {
      return fail(`شناسه خط تکراری است: ${stroke.id}. هر خط باید شناسه یکتا داشته باشد.`)
    }
    strokeIds.add(stroke.id)
  }

  // `order` must be a clean permutation of 0..n-1: it identifies a position in
  // the append-only history, so a gap or a repeat means the file lost a stroke
  // or duplicated one.
  const orders = new Set<number>()
  for (const stroke of strokes) {
    if (orders.has(stroke.order)) {
      return fail(`مقدار order تکراری است: ${stroke.order}. ترتیب خطوط باید یکتا باشد.`)
    }
    if (stroke.order >= strokes.length) {
      return fail(
        `مقدار order خارج از محدوده است: ${stroke.order}. باید بین ۰ و ${strokes.length - 1} باشد.`,
      )
    }
    orders.add(stroke.order)
  }

  // One counter feeds both points and actions, so a collision between the two
  // arrays is just as corrupting as a collision inside one of them.
  const sequences = new Set<number>()
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      if (sequences.has(point.sequence)) {
        return fail(
          `شماره ترتیب ${point.sequence} بیش از یک بار استفاده شده است؛ شماره‌ها باید در کل جلسه یکتا باشند.`,
        )
      }
      sequences.add(point.sequence)
    }
  }
  for (const action of actions) {
    if (sequences.has(action.sequence)) {
      return fail(
        `شماره ترتیب ${action.sequence} هم در نقاط و هم در رویدادها استفاده شده است؛ شماره‌ها باید یکتا باشند.`,
      )
    }
    sequences.add(action.sequence)
  }

  // Both arrays are stored in recording order, so both must be ascending.
  for (let i = 1; i < strokes.length; i += 1) {
    const previous = strokes[i - 1]
    const current = strokes[i]
    if (previous === undefined || current === undefined) continue
    if (current.startedAtMs < previous.startedAtMs) {
      return fail(`زمان شروع خط ${i + 1} کمتر از خط قبلی است؛ ترتیب زمانی خطوط به‌هم ریخته است.`)
    }
  }

  for (let i = 1; i < actions.length; i += 1) {
    const previous = actions[i - 1]
    const current = actions[i]
    if (previous === undefined || current === undefined) continue
    if (current.sequence <= previous.sequence) {
      return fail(`شماره ترتیب رویداد ${i + 1} صعودی نیست؛ ترتیب رویدادها معتبر نیست.`)
    }
    if (current.timeMs < previous.timeMs) {
      return fail(`زمان رویداد ${i + 1} کمتر از رویداد قبلی است؛ زمان باید نزولی نشود.`)
    }
  }

  return { ok: true, value: true }
}

// ---------------------------------------------------------------------------
// Layer 2b: the merged timeline (applies to every schema version)
// ---------------------------------------------------------------------------

/** One entry on the single timeline that points and actions share. */
interface TimelineEntry {
  sequence: number
  timeMs: number
  label: string
}

/**
 * Builds the complete merged timeline: every point and every action, in
 * `sequence` order.
 *
 * Points and actions live in two arrays but happened in ONE interleaved order.
 * Checking each array on its own therefore proves very little: both can be
 * perfectly ascending while an action still claims to have happened before a
 * point that precedes it in sequence.
 */
function buildMergedTimeline(
  strokes: readonly DrawingStroke[],
  actions: readonly DrawingAction[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = []

  strokes.forEach((stroke, strokeIndex) => {
    stroke.points.forEach((point, pointIndex) => {
      entries.push({
        sequence: point.sequence,
        timeMs: point.timeMs,
        label: `نقطه ${pointIndex + 1} از خط ${strokeIndex + 1}`,
      })
    })
  })

  actions.forEach((action, index) => {
    entries.push({
      sequence: action.sequence,
      timeMs: action.timeMs,
      label: `رویداد ${index + 1} (${action.type})`,
    })
  })

  return entries.sort((a, b) => a.sequence - b.sequence)
}

/**
 * Time may never run backwards as `sequence` runs forwards.
 *
 * Equal timestamps stay valid: the clock is rounded to 0.1 ms and a fast
 * digitizer produces ties routinely, which is exactly why `sequence` is the
 * authoritative tie-breaker. What is rejected is a LATER event carrying an
 * EARLIER timestamp, because that makes the two ordering keys contradict each
 * other - and every duration, pause and speed measurement built on this data
 * would then depend on which key the analysis happened to sort by.
 */
export function validateMergedTimeMonotonicity(
  strokes: readonly DrawingStroke[],
  actions: readonly DrawingAction[],
): ParseResult<true> {
  const timeline = buildMergedTimeline(strokes, actions)

  for (let i = 1; i < timeline.length; i += 1) {
    const previous = timeline[i - 1]
    const current = timeline[i]
    if (previous === undefined || current === undefined) continue

    if (current.timeMs < previous.timeMs) {
      return fail(
        `زمان در خط زمانی جلسه به عقب برمی‌گردد: ${current.label} با شماره ترتیب ${current.sequence} زمان ${current.timeMs} دارد، اما ${previous.label} با شماره ترتیب کوچک‌تر ${previous.sequence} زمان بزرگ‌تر ${previous.timeMs} دارد.`,
      )
    }
  }

  return { ok: true, value: true }
}

// ---------------------------------------------------------------------------
// Layer 3: referential integrity (schema 2 only)
// ---------------------------------------------------------------------------

/**
 * Checks that every action points at a stroke that exists.
 *
 * This is meaningful ONLY under schema 2, where `strokes` is append-only and a
 * referenced stroke is therefore guaranteed to still be in the file. Under
 * schema 1 a dangling reference was the normal result of an undo, not a defect.
 */
export function validateReferentialIntegrity(
  strokes: readonly DrawingStroke[],
  actions: readonly DrawingAction[],
): ParseResult<true> {
  const knownIds = new Set(strokes.map((stroke) => stroke.id))

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i]
    if (action === undefined) continue
    const where = `رویداد ${i + 1}`

    if (action.type === 'undo' || action.type === 'redo') {
      const strokeId = action.payload?.['strokeId']
      if (typeof strokeId !== 'string' || strokeId.length === 0) {
        return fail(`رویداد ${action.type} بدون شناسه خط ثبت شده است (${where}).`)
      }
      if (!knownIds.has(strokeId)) {
        return fail(
          `رویداد ${action.type} به خطی اشاره می‌کند که در فایل وجود ندارد: ${strokeId} (${where}).`,
        )
      }
    }

    if (action.type === 'clear') {
      const affected = action.payload?.['affectedStrokeIds']
      if (!Array.isArray(affected)) {
        return fail(
          `رویداد clear در نسخه ${CURRENT_SCHEMA_VERSION} باید فهرست affectedStrokeIds داشته باشد (${where}).`,
        )
      }
      for (const id of affected) {
        if (typeof id !== 'string' || !knownIds.has(id)) {
          return fail(
            `رویداد clear به خطی اشاره می‌کند که در فایل وجود ندارد: ${String(id)} (${where}).`,
          )
        }
      }
    }
  }

  return { ok: true, value: true }
}

// ---------------------------------------------------------------------------
// Layer 4: timeline semantics (schema 2 only)
// ---------------------------------------------------------------------------

/** A stroke's position on the timeline: the sequence of its first sample. */
function firstSequenceOf(stroke: DrawingStroke): number {
  return stroke.points[0]?.sequence ?? 0
}

type SemanticEvent =
  | { kind: 'draw'; sequence: number; strokeId: string; index: number }
  | { kind: 'action'; sequence: number; action: DrawingAction; index: number }

/**
 * Replays the history as a STATE MACHINE and checks every action against the
 * state as it existed at that exact moment.
 *
 * WHY THE REFERENTIAL PASS IS NOT ENOUGH
 *
 * That pass asks "does this stroke id appear anywhere in the file?" - a
 * question about the file as a whole, with no notion of time. It therefore
 * accepts an undo of a stroke that had not been drawn yet, or a redo with no
 * undo before it. Such a file is internally impossible: it describes a session
 * that could never have been recorded. Replaying it produces a canvas the user
 * never saw, and the resulting timings and stroke counts are fiction.
 *
 * So this pass walks draws and actions together in `sequence` order and holds
 * each one to what was true when it happened.
 *
 * SCHEMA 2 ONLY. Under schema 1 undo and clear DELETED strokes, so a v1 file
 * legitimately contains actions referring to strokes that are no longer in it -
 * applying these rules there would reject faithful legacy exports.
 */
export function validateTimelineSemantics(
  strokes: readonly DrawingStroke[],
  actions: readonly DrawingAction[],
): ParseResult<true> {
  const events: SemanticEvent[] = []

  strokes.forEach((stroke, index) => {
    events.push({ kind: 'draw', sequence: firstSequenceOf(stroke), strokeId: stroke.id, index })
  })
  actions.forEach((action, index) => {
    events.push({ kind: 'action', sequence: action.sequence, action, index })
  })

  events.sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence
    // At an equal sequence a draw is treated as first: an action always refers
    // to strokes that already existed.
    if (a.kind !== b.kind) return a.kind === 'draw' ? -1 : 1
    return a.index - b.index
  })

  // The state as of the moment currently being validated.
  const created = new Set<string>()
  const visible = new Set<string>()
  let redoStack: string[] = []

  for (const event of events) {
    if (event.kind === 'draw') {
      created.add(event.strokeId)
      visible.add(event.strokeId)
      // Drawing invalidates the redo history, as in any editor.
      redoStack = []
      continue
    }

    const { action, index } = event
    const where = `رویداد ${index + 1}`

    switch (action.type) {
      case 'undo': {
        const strokeId = action.payload?.['strokeId']
        if (typeof strokeId !== 'string') break

        if (!created.has(strokeId)) {
          return fail(
            `رویداد undo به خطی اشاره می‌کند که هنوز کشیده نشده بود: ${strokeId} (${where}). یک عمل نمی‌تواند به آینده ارجاع دهد.`,
          )
        }
        if (!visible.has(strokeId)) {
          return fail(
            `رویداد undo خطی را برمی‌دارد که در آن لحظه روی بوم نبود: ${strokeId} (${where}).`,
          )
        }

        visible.delete(strokeId)
        redoStack.push(strokeId)
        break
      }

      case 'redo': {
        const strokeId = action.payload?.['strokeId']
        if (typeof strokeId !== 'string') break

        if (!created.has(strokeId)) {
          return fail(
            `رویداد redo به خطی اشاره می‌کند که هنوز کشیده نشده بود: ${strokeId} (${where}).`,
          )
        }
        if (redoStack.length === 0) {
          return fail(
            `رویداد redo بدون یک undo متناظر ثبت شده است: ${strokeId} (${where}). در آن لحظه چیزی برای بازگرداندن وجود نداشت.`,
          )
        }

        const top = redoStack[redoStack.length - 1]
        if (top !== strokeId) {
          // The redo stack is LIFO. Restoring anything but the top would mean
          // the recorded history could not have come from the editor.
          return fail(
            `رویداد redo خطی غیر از بالای پشته را بازمی‌گرداند: ${strokeId} در حالی که انتظار ${String(top)} بود (${where}).`,
          )
        }

        visible.add(strokeId)
        redoStack.pop()
        break
      }

      case 'clear': {
        const affected = action.payload?.['affectedStrokeIds']
        if (!Array.isArray(affected)) break

        const seen = new Set<string>()
        for (const rawId of affected) {
          if (typeof rawId !== 'string') continue

          if (seen.has(rawId)) {
            return fail(
              `فهرست خطوط پاک‌شده در رویداد clear شناسه تکراری دارد: ${rawId} (${where}).`,
            )
          }
          seen.add(rawId)

          if (!created.has(rawId)) {
            return fail(
              `رویداد clear به خطی اشاره می‌کند که هنوز کشیده نشده بود: ${rawId} (${where}).`,
            )
          }
          if (!visible.has(rawId)) {
            return fail(
              `رویداد clear خطی را پاک می‌کند که در آن لحظه روی بوم نبود: ${rawId} (${where}).`,
            )
          }

          visible.delete(rawId)
        }

        // Clear is a hard boundary: nothing hidden before it can be redone.
        redoStack = []
        break
      }

      default:
        // tool_change / color_change / width_change carry no timeline meaning.
        break
    }
  }

  return { ok: true, value: true }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Validates a session that already declares the CURRENT schema version.
 * Exported so the legacy upgrader can reuse the shape and structure layers.
 */
export function validateCurrentSchemaSession(
  raw: Record<string, unknown>,
): ParseResult<DrawingSession> {
  if (typeof raw['id'] !== 'string' || raw['id'].length === 0) {
    return fail('شناسه جلسه در فایل وجود ندارد.')
  }
  if (typeof raw['createdAt'] !== 'string') {
    return fail('تاریخ ساخت جلسه در فایل وجود ندارد.')
  }
  if (typeof raw['startedAt'] !== 'string') {
    return fail('زمان شروع جلسه در فایل وجود ندارد.')
  }

  const canvasResult = validateCanvas(raw['canvas'])
  if (!canvasResult.ok) return canvasResult

  if (!Array.isArray(raw['strokes'])) {
    return fail('فهرست خطوط در فایل وجود ندارد یا آرایه نیست.')
  }
  if (!Array.isArray(raw['actions'])) {
    return fail('فهرست رویدادها در فایل وجود ندارد یا آرایه نیست.')
  }

  const strokes: DrawingStroke[] = []
  for (let i = 0; i < raw['strokes'].length; i += 1) {
    const result = validateStroke(raw['strokes'][i], i, 'hasPressureSamples')
    if (!result.ok) return result
    strokes.push(result.value)
  }

  const actions: DrawingAction[] = []
  for (let i = 0; i < raw['actions'].length; i += 1) {
    const result = validateAction(raw['actions'][i], i)
    if (!result.ok) return result
    actions.push(result.value)
  }

  const structural = validateStructuralIntegrity(strokes, actions)
  if (!structural.ok) return structural

  const merged = validateMergedTimeMonotonicity(strokes, actions)
  if (!merged.ok) return merged

  // Referential first, then semantic: the referential pass produces the clearer
  // message for a plainly missing id, so it should be the one the user sees.
  const referential = validateReferentialIntegrity(strokes, actions)
  if (!referential.ok) return referential

  const semantic = validateTimelineSemantics(strokes, actions)
  if (!semantic.ok) return semantic

  const session: DrawingSession = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: raw['id'],
    createdAt: raw['createdAt'],
    startedAt: raw['startedAt'],
    canvas: canvasResult.value,
    strokes,
    actions,
  }

  const provenance = readProvenance(raw['provenance'])
  if (provenance !== null) {
    session.provenance = provenance
  }

  return { ok: true, value: session }
}

/** Shared by the legacy upgrader: validates v1 strokes and actions. */
export function validateLegacyStrokesAndActions(
  rawStrokes: readonly unknown[],
  rawActions: readonly unknown[],
): ParseResult<{ strokes: DrawingStroke[]; actions: DrawingAction[] }> {
  const strokes: DrawingStroke[] = []
  for (let i = 0; i < rawStrokes.length; i += 1) {
    // Schema 1 spelled the pressure flag differently.
    const result = validateStroke(rawStrokes[i], i, 'hasRealPressure')
    if (!result.ok) return result
    strokes.push(result.value)
  }

  const actions: DrawingAction[] = []
  for (let i = 0; i < rawActions.length; i += 1) {
    const result = validateAction(rawActions[i], i)
    if (!result.ok) return result
    actions.push(result.value)
  }

  // Structural rules are version-independent: a v1 file with duplicate ids or
  // colliding sequence numbers is just as unusable as a v2 one. So is a file
  // whose clock runs backwards - that is a property of the recording, not of
  // the schema's undo model.
  const structural = validateStructuralIntegrity(strokes, actions)
  if (!structural.ok) return structural

  const merged = validateMergedTimeMonotonicity(strokes, actions)
  if (!merged.ok) return merged

  // Deliberately NOT run here: validateReferentialIntegrity and
  // validateTimelineSemantics. Both assume the append-only model. Under schema 1
  // an undo DELETED its stroke, so dangling references and undos of strokes that
  // are no longer visible are the normal output of that model, not corruption.
  return { ok: true, value: { strokes, actions } }
}

/** Shared by the legacy upgrader: validates the session envelope. */
export function validateSessionEnvelope(raw: Record<string, unknown>): ParseResult<{
  id: string
  createdAt: string
  startedAt: string
  canvas: DrawingSession['canvas']
}> {
  if (typeof raw['id'] !== 'string' || raw['id'].length === 0) {
    return fail('شناسه جلسه در فایل وجود ندارد.')
  }
  if (typeof raw['createdAt'] !== 'string') {
    return fail('تاریخ ساخت جلسه در فایل وجود ندارد.')
  }
  if (typeof raw['startedAt'] !== 'string') {
    return fail('زمان شروع جلسه در فایل وجود ندارد.')
  }
  const canvasResult = validateCanvas(raw['canvas'])
  if (!canvasResult.ok) return canvasResult

  return {
    ok: true,
    value: {
      id: raw['id'],
      createdAt: raw['createdAt'],
      startedAt: raw['startedAt'],
      canvas: canvasResult.value,
    },
  }
}

/**
 * Validates an arbitrary parsed JSON value and, on success, returns a fully
 * typed DrawingSession at the CURRENT schema version.
 *
 * A schema 1 file is accepted and upgraded, never rejected - but the upgrade is
 * explicit and separate, and it labels the result honestly. See legacySchemaV1.
 */
export function validateSession(raw: unknown): ParseResult<DrawingSession> {
  if (!isRecord(raw)) {
    return fail('فایل انتخاب‌شده یک جلسه نقاشی معتبر نیست.')
  }

  const schemaVersion = raw['schemaVersion']
  if (schemaVersion === undefined) {
    return fail('فیلد schemaVersion در فایل وجود ندارد؛ این فایل خروجی ArtiScan نیست.')
  }

  if (schemaVersion === CURRENT_SCHEMA_VERSION) {
    return validateCurrentSchemaSession(raw)
  }
  if (schemaVersion === LEGACY_SCHEMA_VERSION) {
    return upgradeLegacyV1Session(raw)
  }

  return fail(
    `نسخه Schema فایل (${String(schemaVersion)}) پشتیبانی نمی‌شود؛ این نسخه فقط نسخه‌های ${LEGACY_SCHEMA_VERSION} و ${CURRENT_SCHEMA_VERSION} را می‌خواند.`,
  )
}
