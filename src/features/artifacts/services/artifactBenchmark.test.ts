/**
 * WEEK 1C - storage and accuracy benchmark.
 *
 * HOW TO READ THESE NUMBERS
 *
 * Every timing here is an INDICATIVE TEST-ENVIRONMENT MEASUREMENT taken in
 * Node/jsdom on one machine. It is not a browser benchmark and must never be
 * quoted as one: there is no rendering, no user, and no device variability in
 * this process. The SIZES and the ACCURACY figures, by contrast, are exact -
 * they are byte counts and deterministic geometry, and they will be identical
 * on any machine.
 *
 * The suite asserts only properties that must hold (round-trips are exact,
 * quality profiles are met, nothing is NaN). The measured values are printed
 * rather than asserted, because pinning a timing to a threshold would make the
 * suite fail on a slow CI box for no good reason.
 */

import { describe, expect, it } from 'vitest'
import { buildCriticalTrajectory, QUALITY_PROFILES } from './criticalTrajectory'
import { serializeCriticalTrajectory } from './criticalTrajectoryValidator'
import { gunzipToText, gzipText } from './gzipCodec'
import { rasterizeStrokes, countCovered } from '../utils/rasterMask'
import { serializeSession, deserializeSession } from '../../drawing/services/drawingSerializer'
import { makeClearAction, makePoint, makeSession, makeStroke, makeUndoAction } from '../../drawing/testing/sessionFixture'
import type { DrawingSession, DrawingStroke, PointSample } from '../../drawing/types/drawing.types'
import type { QualityProfileName } from '../types/criticalTrajectory.types'

const CANVAS = { width: 800, height: 600, devicePixelRatio: 1 }

/**
 * Builds a session of roughly `pointCount` samples spread over several strokes.
 *
 * The shape is deliberately drawing-like rather than random noise: smooth arcs
 * with corners and varying curvature. Random points would be incompressible and
 * unsimplifiable, and would make every number here pessimistic in a way no real
 * recording ever is.
 */
function syntheticSession(
  pointCount: number,
  options: { strokeCount?: number; withActions?: boolean; withOutside?: boolean } = {},
): DrawingSession {
  const strokeCount = options.strokeCount ?? Math.max(1, Math.round(pointCount / 250))
  const perStroke = Math.max(2, Math.floor(pointCount / strokeCount))

  let sequence = 0
  const strokes: DrawingStroke[] = []

  for (let s = 0; s < strokeCount; s += 1) {
    const points: PointSample[] = []
    for (let i = 0; i < perStroke; i += 1) {
      sequence += 1
      const t = i / perStroke
      // An arc with a superimposed wobble, plus a corner halfway through.
      const angle = t * Math.PI * 1.5 + s
      let x = 400 + Math.cos(angle) * (150 + s * 20) + Math.sin(i / 7) * 6
      let y = 300 + Math.sin(angle) * (110 + s * 15) + Math.cos(i / 5) * 5

      if (options.withOutside === true && i > perStroke * 0.6 && i < perStroke * 0.7) {
        // A genuine pointer-capture excursion beyond the right edge.
        x = 820 + (i % 10) * 4
        y = 300 + (i % 7) * 3
      }

      points.push(
        makePoint({
          sequence,
          timeMs: sequence * 8,
          x,
          y,
          normalizedX: Math.min(1, Math.max(0, x / CANVAS.width)),
          normalizedY: Math.min(1, Math.max(0, y / CANVAS.height)),
        }),
      )
    }

    const first = points[0]
    const last = points[points.length - 1]
    strokes.push(
      makeStroke({
        id: `stroke-${String(s)}`,
        order: s,
        width: 4,
        startedAtMs: first?.timeMs ?? 0,
        endedAtMs: last?.timeMs ?? 0,
        points,
      }),
    )
    // Leave a sequence gap between strokes for actions and pen-up time.
    sequence += 20
  }

  const actions =
    options.withActions === true && strokes.length >= 2
      ? [
          makeUndoAction(strokes[strokes.length - 1]!.id, sequence + 1),
          makeClearAction([strokes[0]!.id], sequence + 2),
        ]
      : []

  return makeSession({ canvas: CANVAS, strokes, actions })
}

/** Milliseconds for one call, measured with performance.now(). */
async function timeIt(work: () => unknown | Promise<unknown>): Promise<number> {
  const start = performance.now()
  await work()
  return performance.now() - start
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

interface AuditRow {
  label: string
  strokes: number
  points: number
  actions: number
  rawBytes: number
  bytesPerPoint: number
  stringifyMs: number
  parseMs: number
  gzipBytes: number
  gzipRatio: number
  gzipMs: number
  gunzipMs: number
}

const auditRows: AuditRow[] = []
const profileRows: string[][] = []

describe('storage audit (section 1)', () => {
  const cases: Array<[string, DrawingSession]> = [
    ['100 points', syntheticSession(100, { strokeCount: 1 })],
    ['1,000 points', syntheticSession(1000, { strokeCount: 4 })],
    ['3,000 points', syntheticSession(3000, { strokeCount: 10 })],
    ['10,000 points', syntheticSession(10_000, { strokeCount: 30 })],
    ['multi-stroke (12)', syntheticSession(1200, { strokeCount: 12 })],
    ['with undo/clear', syntheticSession(1200, { strokeCount: 4, withActions: true })],
    ['with outside-canvas points', syntheticSession(1200, { strokeCount: 4, withOutside: true })],
  ]

  it.each(cases)('measures %s', async (label, session) => {
    const text = serializeSession(session)
    const rawBytes = bytesOf(text)
    const points = session.strokes.reduce((total, s) => total + s.points.length, 0)

    const stringifyMs = await timeIt(() => serializeSession(session))
    const parseMs = await timeIt(() => deserializeSession(text))

    const compressed = await gzipText(text)
    const gzipMs = await timeIt(() => gzipText(text))
    const gunzipMs = await timeIt(() => gunzipToText(compressed))

    // The lossless guarantee, re-checked at every size.
    const round1 = await gunzipToText(compressed)
    expect(round1.ok).toBe(true)
    if (round1.ok) expect(round1.value).toBe(text)

    auditRows.push({
      label,
      strokes: session.strokes.length,
      points,
      actions: session.actions.length,
      rawBytes,
      bytesPerPoint: round(rawBytes / Math.max(1, points), 1),
      stringifyMs: round(stringifyMs),
      parseMs: round(parseMs),
      gzipBytes: compressed.length,
      gzipRatio: round(compressed.length / rawBytes, 4),
      gzipMs: round(gzipMs),
      gunzipMs: round(gunzipMs),
    })

    expect(compressed.length).toBeLessThan(rawBytes)
  })

  it('prints the storage audit table', () => {
    const lines = [
      '',
      '=== SECTION 1: STORAGE AUDIT ===',
      'Sizes are exact. Timings are INDICATIVE TEST-ENVIRONMENT MEASUREMENTS (Node/jsdom), not browser benchmarks.',
      '',
      '| Session | Strokes | Points | Actions | Raw JSON B | B/point | stringify ms | parse ms | Gzip B | Ratio | gzip ms | gunzip ms |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
      ...auditRows.map(
        (r) =>
          `| ${r.label} | ${String(r.strokes)} | ${String(r.points)} | ${String(r.actions)} | ${String(r.rawBytes)} | ${String(r.bytesPerPoint)} | ${String(r.stringifyMs)} | ${String(r.parseMs)} | ${String(r.gzipBytes)} | ${String(r.gzipRatio)} | ${String(r.gzipMs)} | ${String(r.gunzipMs)} |`,
      ),
      '',
    ]
    console.log(lines.join('\n'))
    expect(auditRows.length).toBeGreaterThan(0)
  })
})

describe('representation comparison (section 14)', () => {
  const session = syntheticSession(3000, { strokeCount: 10 })
  const rawText = serializeSession(session)
  const rawBytes = bytesOf(rawText)
  const rawPoints = session.strokes.reduce((total, s) => total + s.points.length, 0)

  it.each(['high', 'balanced', 'compact'] as QualityProfileName[])(
    'measures the %s profile',
    async (profile) => {
      const encodeMs = await timeIt(() => buildCriticalTrajectory(session, { profile }))
      const artifact = buildCriticalTrajectory(session, { profile })
      const text = serializeCriticalTrajectory(artifact)
      const bytes = bytesOf(text)

      const renderMs = await timeIt(() =>
        rasterizeStrokes(
          session.strokes.map((s) => ({
            points: s.points.map((p) => ({ x: p.x, y: p.y })),
            width: s.width,
          })),
          CANVAS,
        ),
      )

      const thresholds = QUALITY_PROFILES[profile]
      // The profile must actually be met - this is the assertion, not the print.
      expect(artifact.quality.meetsProfile).toBe(true)
      expect(artifact.quality.maskIoU!).toBeGreaterThanOrEqual(thresholds.minimumMaskIoU)

      profileRows.push([
        `Critical ${profile}`,
        String(bytes),
        `${String(round((1 - bytes / rawBytes) * 100, 1))}%`,
        String(round(encodeMs)),
        '—',
        String(artifact.quality.criticalPointCount),
        'Lossy',
        String(round((artifact.quality.retentionRatio ?? 0) * 100, 1)) + '%',
        String(round(artifact.quality.maskIoU ?? 0, 4)),
        String(round(artifact.quality.maxGeometricDeviationPx ?? 0, 3)),
        String(round(artifact.quality.pathLengthErrorRatio ?? 0, 5)),
        String(round(artifact.quality.boundingBoxErrorRatio ?? 0, 5)),
        String(round(artifact.algorithm.tolerancePx, 3)),
        String(round(renderMs)),
      ])
    },
  )

  it('prints the representation comparison table', async () => {
    const compressed = await gzipText(rawText)
    const gzipMs = await timeIt(() => gzipText(rawText))
    const gunzipMs = await timeIt(() => gunzipToText(compressed))

    const mask = rasterizeStrokes(
      session.strokes.map((s) => ({
        points: s.points.map((p) => ({ x: p.x, y: p.y })),
        width: s.width,
      })),
      CANVAS,
    )

    const lines = [
      '',
      '=== SECTION 14: REPRESENTATION COMPARISON (3,000-point session, 10 strokes) ===',
      `Raw JSON = ${String(rawBytes)} B, ${String(rawPoints)} points.`,
      'Sizes/accuracy exact. Timings INDICATIVE TEST-ENVIRONMENT MEASUREMENTS (Node/jsdom).',
      '',
      '| Representation | Size B | Reduction | Encode ms | Decode ms | Points | Lossless/Lossy |',
      '|---|---:|---:|---:|---:|---:|---|',
      `| Raw JSON | ${String(rawBytes)} | 0% | ${String(round(await timeIt(() => serializeSession(session))))} | ${String(round(await timeIt(() => deserializeSession(rawText))))} | ${String(rawPoints)} | Lossless |`,
      `| Raw JSON Gzip | ${String(compressed.length)} | ${String(round((1 - compressed.length / rawBytes) * 100, 1))}% | ${String(round(gzipMs))} | ${String(round(gunzipMs))} | ${String(rawPoints)} | Lossless |`,
      ...profileRows.map(
        (r) => `| ${r[0]!} | ${r[1]!} | ${r[2]!} | ${r[3]!} | ${r[4]!} | ${r[5]!} | ${r[6]!} |`,
      ),
      `| Reconstruction Mask (raster) | ${String(countCovered(mask))} px covered | — | — | — | — | Lossy |`,
      '',
      '--- Per-profile accuracy ---',
      '',
      '| Profile | Retention | Mask IoU | Max deviation px | Path-length err | BBox err | Tolerance px |',
      '|---|---:|---:|---:|---:|---:|---:|',
      ...profileRows.map(
        (r) => `| ${r[0]!} | ${r[7]!} | ${r[8]!} | ${r[9]!} | ${r[10]!} | ${r[11]!} | ${r[12]!} |`,
      ),
      '',
    ]
    console.log(lines.join('\n'))
    expect(profileRows).toHaveLength(3)
  })
})

describe('scaling behaviour of the derivation', () => {
  it.each([100, 1000, 3000])('derives a %s-point session without producing NaN', (count) => {
    const artifact = buildCriticalTrajectory(syntheticSession(count))

    for (const [key, value] of Object.entries(artifact.quality)) {
      if (typeof value === 'number') {
        expect(Number.isFinite(value), `${key} must be finite`).toBe(true)
      }
    }
    expect(artifact.quality.meetsProfile).toBe(true)
  })
})
