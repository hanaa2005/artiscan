/**
 * Validation for the critical trajectory artifact.
 *
 * SEPARATE FROM THE SESSION VALIDATOR ON PURPOSE
 *
 * These are different kinds of file with different guarantees, and the single
 * most important property of this module is NEGATIVE: a critical trajectory
 * must never be accepted anywhere a canonical session is expected, and a
 * session must never be accepted here. The two validators reject each other's
 * files by construction, because each demands a discriminator the other cannot
 * produce - `artifactType` here, `schemaVersion` there.
 *
 * Everything is checked against the data rather than trusted: a duplicate node
 * id makes every edge ambiguous, and an edge pointing at a node that is not in
 * the file describes a relationship between something and nothing.
 */

import type { ParseResult } from '../../drawing/types/drawing.types'
import { fail, isRecord } from '../../drawing/services/drawingValidator'
import { buildStrokeLabel } from './criticalTrajectory'
import {
  CRITICAL_TRAJECTORY_SCHEMA_VERSION,
  LEGACY_CRITICAL_TRAJECTORY_SCHEMA_VERSION,
  type CriticalActionNode,
  type CriticalEdge,
  type CriticalNode,
  type CriticalStrokeSummary,
  type CriticalTrajectoryArtifactV2,
} from '../types/criticalTrajectory.types'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

/** A source reference must be a non-negative whole number - it is a counter. */
function isValidSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function validateNode(raw: unknown, index: number): ParseResult<CriticalNode> {
  if (!isRecord(raw)) return fail(`گره ${index + 1} یک شیء معتبر نیست.`)

  if (typeof raw['id'] !== 'string' || raw['id'].length === 0) {
    return fail(`گره ${index + 1} شناسه معتبر ندارد.`)
  }
  if (typeof raw['strokeId'] !== 'string' || raw['strokeId'].length === 0) {
    return fail(`گره ${index + 1} به هیچ خطی ارجاع نمی‌دهد.`)
  }
  // The traceability link. Without it the node claims evidence it cannot show.
  if (!isValidSequence(raw['sourcePointSequence'])) {
    return fail(`گره ${index + 1} ارجاع معتبری به شماره ترتیب نقطه خام ندارد.`)
  }
  if (!isValidSequence(raw['sourcePointIndex'])) {
    return fail(`گره ${index + 1} ارجاع معتبری به جایگاه نقطه خام ندارد.`)
  }

  for (const field of ['x', 'y', 'normalizedX', 'normalizedY', 'timeMs']) {
    if (!isFiniteNumber(raw[field])) {
      return fail(`گره ${index + 1} مقدار «${field}» معتبری ندارد.`)
    }
  }
  if ((raw['timeMs'] as number) < 0) {
    return fail(`گره ${index + 1} زمان منفی دارد.`)
  }

  const reasons = raw['reasons']
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return fail(`گره ${index + 1} هیچ دلیلی برای انتخاب‌شدن ندارد.`)
  }
  if (!reasons.every((reason) => typeof reason === 'string')) {
    return fail(`گره ${index + 1} دلیل نامعتبر دارد.`)
  }

  return { ok: true, value: raw as unknown as CriticalNode }
}

function validateActionNode(raw: unknown, index: number): ParseResult<CriticalActionNode> {
  if (!isRecord(raw)) return fail(`گره رویداد ${index + 1} یک شیء معتبر نیست.`)

  if (typeof raw['id'] !== 'string' || raw['id'].length === 0) {
    return fail(`گره رویداد ${index + 1} شناسه معتبر ندارد.`)
  }
  if (!isValidSequence(raw['sourceActionSequence'])) {
    return fail(`گره رویداد ${index + 1} ارجاع معتبری به شماره ترتیب رویداد خام ندارد.`)
  }
  if (typeof raw['actionType'] !== 'string' || raw['actionType'].length === 0) {
    return fail(`گره رویداد ${index + 1} نوع معتبری ندارد.`)
  }
  if (!isFiniteNumber(raw['timeMs']) || raw['timeMs'] < 0) {
    return fail(`گره رویداد ${index + 1} زمان معتبری ندارد.`)
  }

  return { ok: true, value: raw as unknown as CriticalActionNode }
}

function validateEdge(raw: unknown, index: number, knownIds: Set<string>): ParseResult<CriticalEdge> {
  if (!isRecord(raw)) return fail(`یال ${index + 1} یک شیء معتبر نیست.`)

  if (typeof raw['id'] !== 'string' || raw['id'].length === 0) {
    return fail(`یال ${index + 1} شناسه معتبر ندارد.`)
  }

  const from = raw['from']
  const to = raw['to']
  if (typeof from !== 'string' || typeof to !== 'string') {
    return fail(`یال ${index + 1} مبدأ یا مقصد معتبری ندارد.`)
  }
  // A broken edge describes a relationship between something and nothing.
  if (!knownIds.has(from)) {
    return fail(`یال ${index + 1} به گره ناموجود «${from}» ارجاع می‌دهد.`)
  }
  if (!knownIds.has(to)) {
    return fail(`یال ${index + 1} به گره ناموجود «${to}» ارجاع می‌دهد.`)
  }

  if (typeof raw['relationType'] !== 'string' || raw['relationType'].length === 0) {
    return fail(`یال ${index + 1} نوع رابطه معتبری ندارد.`)
  }

  for (const field of [
    'durationMs',
    'directDistancePx',
    'sourcePathLengthPx',
    'simplifiedPathLengthPx',
  ]) {
    if (!isNullableFiniteNumber(raw[field])) {
      return fail(`یال ${index + 1} مقدار «${field}» معتبری ندارد.`)
    }
  }

  return { ok: true, value: raw as unknown as CriticalEdge }
}

/**
 * Validates a parsed critical trajectory artifact.
 *
 * Rejects a canonical session outright: a session has no `artifactType`, so it
 * fails at the discriminator rather than being partially interpreted.
 */
export function validateCriticalTrajectory(
  raw: unknown,
): ParseResult<CriticalTrajectoryArtifactV2> {
  if (!isRecord(raw)) return fail('محتوای فایل یک شیء معتبر نیست.')

  // --- discriminator, checked first ---------------------------------------
  if (raw['artifactType'] !== 'critical_trajectory') {
    return fail(
      'این فایل یک فایل «مسیر نقاط ضروری» نیست. اگر فایل جلسه خام است، آن را از بخش ورود جلسه باز کنید.',
    )
  }
  const version = raw['artifactSchemaVersion']
  if (
    version !== CRITICAL_TRAJECTORY_SCHEMA_VERSION &&
    version !== LEGACY_CRITICAL_TRAJECTORY_SCHEMA_VERSION
  ) {
    return fail(
      `نسخه این فایل (${String(version)}) پشتیبانی نمی‌شود؛ نسخه‌های پشتیبانی‌شده ${String(LEGACY_CRITICAL_TRAJECTORY_SCHEMA_VERSION)} و ${String(CRITICAL_TRAJECTORY_SCHEMA_VERSION)} هستند.`,
    )
  }
  const isLegacy = version === LEGACY_CRITICAL_TRAJECTORY_SCHEMA_VERSION

  /*
    `mode` is required from v2 onwards and absent from every v1 file.

    A v1 artifact always described the whole recorded history, so it is read as
    `full_process`. Guessing the other way round would be the dangerous error:
    it would present cleared and undone strokes as the finished drawing.
  */
  if (!isLegacy && raw['mode'] !== 'full_process' && raw['mode'] !== 'final_visible') {
    return fail(
      `نوع گراف در این فایل («${String(raw['mode'])}») معتبر نیست؛ باید full_process یا final_visible باشد.`,
    )
  }
  // The honesty flag. A file that omits it is not a file this app produced.
  if (raw['lossy'] !== true) {
    return fail('این فایل نشانه «داده کاسته‌شده» ندارد و معتبر نیست.')
  }
  if (typeof raw['sourceSessionId'] !== 'string' || raw['sourceSessionId'].length === 0) {
    return fail('این فایل به هیچ جلسه‌ای ارجاع نمی‌دهد.')
  }
  if (!isFiniteNumber(raw['sourceSchemaVersion'])) {
    return fail('نسخه schema جلسه مبدأ در این فایل معتبر نیست.')
  }

  // --- algorithm block -----------------------------------------------------
  const algorithm = raw['algorithm']
  if (!isRecord(algorithm)) return fail('اطلاعات الگوریتم در این فایل موجود نیست.')
  if (typeof algorithm['name'] !== 'string' || algorithm['name'].length === 0) {
    return fail('نام الگوریتم در این فایل معتبر نیست.')
  }
  if (typeof algorithm['version'] !== 'string' || algorithm['version'].length === 0) {
    return fail('نسخه الگوریتم در این فایل معتبر نیست.')
  }
  if (!isFiniteNumber(algorithm['tolerancePx']) || (algorithm['tolerancePx'] as number) < 0) {
    return fail('مقدار tolerance الگوریتم معتبر نیست.')
  }

  // --- canvas --------------------------------------------------------------
  const canvas = raw['canvas']
  if (!isRecord(canvas)) return fail('اطلاعات بوم در این فایل موجود نیست.')
  if (
    !isFiniteNumber(canvas['width']) ||
    !isFiniteNumber(canvas['height']) ||
    canvas['width'] <= 0 ||
    canvas['height'] <= 0
  ) {
    return fail('ابعاد بوم در این فایل معتبر نیست.')
  }

  // --- quality -------------------------------------------------------------
  const quality = raw['quality']
  if (!isRecord(quality)) return fail('اطلاعات کیفیت در این فایل موجود نیست.')
  for (const field of ['rawStrokeCount', 'rawPointCount', 'criticalPointCount']) {
    if (!isValidSequence(quality[field])) {
      return fail(`مقدار «${field}» در بخش کیفیت معتبر نیست.`)
    }
  }
  for (const field of [
    'maskIoU',
    'maxGeometricDeviationPx',
    'pathLengthErrorRatio',
    'boundingBoxErrorRatio',
  ]) {
    if (!isNullableFiniteNumber(quality[field])) {
      return fail(`مقدار «${field}» در بخش کیفیت معتبر نیست.`)
    }
  }

  // --- nodes ---------------------------------------------------------------
  const rawNodes = raw['nodes']
  if (!Array.isArray(rawNodes)) return fail('فهرست گره‌ها در این فایل معتبر نیست.')
  const rawActionNodes = raw['actionNodes'] ?? []
  if (!Array.isArray(rawActionNodes)) return fail('فهرست گره‌های رویداد معتبر نیست.')

  const ids = new Set<string>()
  const nodes: CriticalNode[] = []
  for (const [index, entry] of rawNodes.entries()) {
    const parsed = validateNode(entry, index)
    if (!parsed.ok) return parsed
    // A duplicate id makes every edge that references it ambiguous.
    if (ids.has(parsed.value.id)) {
      return fail(`شناسه گره «${parsed.value.id}» بیش از یک بار استفاده شده است.`)
    }
    ids.add(parsed.value.id)
    nodes.push(parsed.value)
  }

  const actionNodes: CriticalActionNode[] = []
  for (const [index, entry] of rawActionNodes.entries()) {
    const parsed = validateActionNode(entry, index)
    if (!parsed.ok) return parsed
    if (ids.has(parsed.value.id)) {
      return fail(`شناسه گره رویداد «${parsed.value.id}» بیش از یک بار استفاده شده است.`)
    }
    ids.add(parsed.value.id)
    actionNodes.push(parsed.value)
  }

  /*
    --- stroke summaries -----------------------------------------------------

    Required from v2. They carry the label, the canonical order and the final
    status, and every one of them must name a stroke the nodes actually belong
    to - a summary for a stroke with no nodes would put a label on the image
    with nothing under it.
  */
  const strokes: CriticalStrokeSummary[] = []
  if (!isLegacy) {
    const rawStrokes = raw['strokes']
    if (!Array.isArray(rawStrokes)) {
      return fail('فهرست خطوط در این فایل معتبر نیست.')
    }
    const strokeIds = new Set<string>()
    const labels = new Set<string>()
    const orders = new Set<number>()
    for (const [index, entry] of rawStrokes.entries()) {
      const parsed = validateStrokeSummary(entry, index)
      if (!parsed.ok) return parsed
      const summary = parsed.value
      if (strokeIds.has(summary.strokeId)) {
        return fail(`خط «${summary.strokeId}» بیش از یک بار در فهرست آمده است.`)
      }
      // Labels and orders are the identity the whole image rests on; a repeat
      // would make two different strokes indistinguishable.
      if (labels.has(summary.label)) {
        return fail(`برچسب «${summary.label}» برای بیش از یک خط استفاده شده است.`)
      }
      if (orders.has(summary.order)) {
        return fail(`ترتیب «${String(summary.order)}» برای بیش از یک خط استفاده شده است.`)
      }
      strokeIds.add(summary.strokeId)
      labels.add(summary.label)
      orders.add(summary.order)
      strokes.push(summary)
    }

    // Every node must belong to a declared stroke, or the graph would draw a
    // path the summary list cannot explain.
    for (const node of nodes) {
      if (!strokeIds.has(node.strokeId)) {
        return fail(`گره «${node.id}» به خطی اشاره می‌کند که در فهرست خطوط نیست.`)
      }
    }
  }

  // --- edges ---------------------------------------------------------------
  const rawEdges = raw['edges']
  if (!Array.isArray(rawEdges)) return fail('فهرست یال‌ها در این فایل معتبر نیست.')

  const edgeIds = new Set<string>()
  const edges: CriticalEdge[] = []
  for (const [index, entry] of rawEdges.entries()) {
    const parsed = validateEdge(entry, index, ids)
    if (!parsed.ok) return parsed
    if (edgeIds.has(parsed.value.id)) {
      return fail(`شناسه یال «${parsed.value.id}» بیش از یک بار استفاده شده است.`)
    }
    edgeIds.add(parsed.value.id)
    edges.push(parsed.value)
  }

  if (!isLegacy) {
    return { ok: true, value: raw as unknown as CriticalTrajectoryArtifactV2 }
  }

  /*
    A v1 file is READ, never rewritten in place.

    It is returned in the v2 shape with the two things v1 could not say filled
    in honestly: the mode it always meant, and stroke summaries rebuilt from the
    nodes it does contain. The statuses are reported as `visible` because a v1
    artifact carries no history to derive anything else from - and inventing
    `cleared` or `undone` would be a claim the file does not support.
  */
  const rebuilt = rebuildLegacyStrokeSummaries(nodes)
  return {
    ok: true,
    value: {
      ...(raw as unknown as CriticalTrajectoryArtifactV2),
      artifactSchemaVersion: CRITICAL_TRAJECTORY_SCHEMA_VERSION,
      mode: 'full_process',
      strokes: rebuilt,
    },
  }
}

/**
 * Rebuilds stroke summaries for a v1 artifact, from its nodes alone.
 *
 * Order follows the order the strokes first appear in the node list, which for
 * a file this app produced is the canonical order. Everything that cannot be
 * known from a v1 file is left at a neutral, non-claiming value rather than
 * guessed: the colour and width are not in the artifact, and the status cannot
 * be derived without the session's action log.
 */
function rebuildLegacyStrokeSummaries(nodes: readonly CriticalNode[]): CriticalStrokeSummary[] {
  const byStroke = new Map<string, CriticalNode[]>()
  for (const node of nodes) {
    const list = byStroke.get(node.strokeId) ?? []
    list.push(node)
    byStroke.set(node.strokeId, list)
  }

  const summaries: CriticalStrokeSummary[] = []
  let order = 0
  for (const [strokeId, strokeNodes] of byStroke) {
    const first = strokeNodes[0]
    const last = strokeNodes[strokeNodes.length - 1]
    summaries.push({
      strokeId,
      order,
      label: buildStrokeLabel(order),
      status: 'visible',
      startNodeId: first?.id ?? null,
      endNodeId: last?.id ?? null,
      nodeCount: strokeNodes.length,
      // A v1 file does not record how many raw samples the stroke had; the kept
      // count is the only honest lower bound available.
      sourcePointCount: strokeNodes.length,
      tool: 'pen',
      color: '#000000',
      width: 1,
      startedAtMs: first?.timeMs ?? 0,
      endedAtMs: last?.timeMs ?? 0,
    })
    order += 1
  }
  return summaries
}

/** Validates one stroke summary. */
function validateStrokeSummary(
  raw: unknown,
  index: number,
): ParseResult<CriticalStrokeSummary> {
  const where = `خط شماره ${String(index + 1)}`
  if (!isRecord(raw)) return fail(`${where} ساختار معتبری ندارد.`)

  if (typeof raw['strokeId'] !== 'string' || raw['strokeId'].length === 0) {
    return fail(`شناسه ${where} معتبر نیست.`)
  }
  if (!isValidSequence(raw['order'])) {
    return fail(`ترتیب ${where} معتبر نیست.`)
  }
  if (typeof raw['label'] !== 'string' || raw['label'].length === 0) {
    return fail(`برچسب ${where} معتبر نیست.`)
  }
  const status = raw['status']
  if (status !== 'visible' && status !== 'cleared' && status !== 'undone') {
    return fail(`وضعیت ${where} («${String(status)}») معتبر نیست.`)
  }
  for (const field of ['startNodeId', 'endNodeId']) {
    const value = raw[field]
    if (value !== null && typeof value !== 'string') {
      return fail(`مقدار «${field}» در ${where} معتبر نیست.`)
    }
  }
  for (const field of ['nodeCount', 'sourcePointCount']) {
    if (!isValidSequence(raw[field])) {
      return fail(`مقدار «${field}» در ${where} معتبر نیست.`)
    }
  }
  if (raw['tool'] !== 'pen' && raw['tool'] !== 'eraser') {
    return fail(`ابزار ${where} معتبر نیست.`)
  }
  if (typeof raw['color'] !== 'string') return fail(`رنگ ${where} معتبر نیست.`)
  if (!isFiniteNumber(raw['width'])) return fail(`ضخامت ${where} معتبر نیست.`)
  for (const field of ['startedAtMs', 'endedAtMs']) {
    if (!isFiniteNumber(raw[field])) {
      return fail(`مقدار «${field}» در ${where} معتبر نیست.`)
    }
  }

  return { ok: true, value: raw as unknown as CriticalStrokeSummary }
}

/** Parses and validates critical trajectory JSON text. */
export function deserializeCriticalTrajectory(
  text: string,
): ParseResult<CriticalTrajectoryArtifactV2> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('محتوای فایل یک JSON معتبر نیست.')
  }
  return validateCriticalTrajectory(parsed)
}

/** Serializes the artifact for download. */
export function serializeCriticalTrajectory(
  artifact: CriticalTrajectoryArtifactV2,
): string {
  return JSON.stringify(artifact, null, 2)
}
