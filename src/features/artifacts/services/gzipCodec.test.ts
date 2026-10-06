/**
 * The lossless guarantee, tested as a guarantee rather than as a happy path.
 *
 * Every assertion here is about EXACTNESS: the same string back, the same
 * session back, the same order, the same floats. A compression step that is
 * "almost" lossless is not lossless, and the artifact policy rests on this file.
 */

import { describe, expect, it } from 'vitest'
import {
  buildGzipFileName,
  gunzipToText,
  gzipText,
  isCompressionSupported,
  looksLikeGzip,
} from './gzipCodec'
import { serializeSession, deserializeSession } from '../../drawing/services/drawingSerializer'
import {
  makeClearAction,
  makeRedoAction,
  makeSession,
  makeStrokeSeries,
  makeUndoAction,
} from '../../drawing/testing/sessionFixture'
import type { DrawingSession } from '../../drawing/types/drawing.types'

describe('capability detection', () => {
  it('reports support in this runtime', () => {
    expect(isCompressionSupported()).toBe(true)
  })
})

describe('round trip', () => {
  it('returns the exact same text', async () => {
    const text = '{"hello":"world","n":1.5}'
    const round = await gunzipToText(await gzipText(text))

    expect(round.ok).toBe(true)
    if (round.ok) expect(round.value).toBe(text)
  })

  it('preserves Persian and other non-ASCII text exactly', async () => {
    const text = JSON.stringify({
      note: 'این جلسه از نسخه قدیمی وارد شده و تاریخچه کامل ندارد.',
      label: 'دایره',
      mixed: 'a—ب—٣ 😀',
    })

    const round = await gunzipToText(await gzipText(text))
    expect(round.ok).toBe(true)
    if (round.ok) expect(round.value).toBe(text)
  })

  it('preserves a full session byte for byte', async () => {
    const session = makeSession({
      strokes: makeStrokeSeries(4, ['A', 'B', 'C', 'D']),
      actions: [makeUndoAction('D', 16), makeRedoAction('D', 17), makeClearAction(['A'], 18)],
    })
    const original = serializeSession(session)

    const round = await gunzipToText(await gzipText(original))
    expect(round.ok).toBe(true)
    if (!round.ok) return

    // The exact string, not merely an equivalent object.
    expect(round.value).toBe(original)

    // And it still parses and validates as the same session.
    const parsed = deserializeSession(round.value)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual(session)
  })

  it('preserves float precision without rounding', async () => {
    const session = makeSession({ strokes: makeStrokeSeries(1, ['A']) })
    const first = session.strokes[0]
    if (first === undefined) throw new Error('fixture')
    const point = first.points[0]
    if (point === undefined) throw new Error('fixture')

    // Values that a careless re-serialization would round.
    first.points[0] = { ...point, x: 248.83999999999997, y: 220.60000000000002, timeMs: 1505.7 }

    const text = serializeSession(session)
    const round = await gunzipToText(await gzipText(text))
    expect(round.ok).toBe(true)
    if (!round.ok) return

    const parsed = JSON.parse(round.value) as DrawingSession
    expect(parsed.strokes[0]?.points[0]?.x).toBe(248.83999999999997)
    expect(parsed.strokes[0]?.points[0]?.y).toBe(220.60000000000002)
    expect(parsed.strokes[0]?.points[0]?.timeMs).toBe(1505.7)
  })

  it('preserves point and action order', async () => {
    const session = makeSession({
      strokes: makeStrokeSeries(3, ['A', 'B', 'C']),
      actions: [makeUndoAction('C', 12), makeRedoAction('C', 13), makeClearAction(['A', 'B'], 14)],
    })

    const round = await gunzipToText(await gzipText(serializeSession(session)))
    expect(round.ok).toBe(true)
    if (!round.ok) return

    const parsed = JSON.parse(round.value) as DrawingSession
    expect(parsed.strokes.map((s) => s.id)).toEqual(['A', 'B', 'C'])
    expect(parsed.actions.map((a) => a.sequence)).toEqual([12, 13, 14])
    expect(parsed.strokes[0]?.points.map((p) => p.sequence)).toEqual(
      session.strokes[0]?.points.map((p) => p.sequence),
    )
  })

  it('preserves provenance on an upgraded legacy session', async () => {
    const session = makeSession({ strokes: makeStrokeSeries(1, ['A']) })
    session.provenance = {
      importedFromSchemaVersion: 1,
      historyComplete: false,
      note: 'این فایل از نسخه ۱ وارد شده و تاریخچه کامل ندارد.',
    }

    const round = await gunzipToText(await gzipText(serializeSession(session)))
    expect(round.ok).toBe(true)
    if (!round.ok) return

    const parsed = JSON.parse(round.value) as DrawingSession
    expect(parsed.provenance).toEqual(session.provenance)
  })

  it('round-trips a large session', async () => {
    // 40 strokes x 3 points is small; build something with real bulk instead.
    const strokes = makeStrokeSeries(200)
    const session = makeSession({ strokes })
    const text = serializeSession(session)

    const compressed = await gzipText(text)
    const round = await gunzipToText(compressed)

    expect(round.ok).toBe(true)
    if (round.ok) expect(round.value).toBe(text)
    // Repetitive JSON compresses well; this asserts the codec is really working.
    expect(compressed.length).toBeLessThan(text.length)
  })

  it('actually reduces size on realistic session text', async () => {
    const session = makeSession({ strokes: makeStrokeSeries(100) })
    const text = serializeSession(session)
    const compressed = await gzipText(text)

    expect(compressed.length).toBeLessThan(new TextEncoder().encode(text).length)
  })
})

describe('gzip detection', () => {
  it('recognises its own output', async () => {
    expect(looksLikeGzip(await gzipText('{}'))).toBe(true)
  })

  it('rejects plain JSON bytes', () => {
    expect(looksLikeGzip(new TextEncoder().encode('{"a":1}'))).toBe(false)
  })

  it('rejects bytes too short to carry a header', () => {
    expect(looksLikeGzip(new Uint8Array([0x1f]))).toBe(false)
  })
})

describe('failure paths all produce a Persian message', () => {
  it('rejects an empty file', async () => {
    const result = await gunzipToText(new Uint8Array(0))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('خالی')
  })

  it('rejects a file that is not gzip at all', async () => {
    const result = await gunzipToText(new TextEncoder().encode('{"not":"gzip"}'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('gzip')
  })

  it('rejects a truncated gzip file', async () => {
    const full = await gzipText(serializeSession(makeSession({ strokes: makeStrokeSeries(20) })))
    // Keep the header so the format check passes and decoding is what fails.
    const truncated = full.slice(0, Math.floor(full.length / 2))

    const result = await gunzipToText(truncated)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('ناقص یا خراب')
  })

  it('rejects a corrupted gzip body', async () => {
    const full = await gzipText(serializeSession(makeSession({ strokes: makeStrokeSeries(20) })))
    const corrupted = Uint8Array.from(full)
    // Scramble well past the header.
    for (let i = 20; i < Math.min(corrupted.length, 80); i += 1) {
      corrupted[i] = (corrupted[i]! + 97) % 256
    }

    const result = await gunzipToText(corrupted)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })

  it('never throws, whatever the input', async () => {
    const inputs = [
      new Uint8Array(0),
      new Uint8Array([0x1f]),
      new Uint8Array([0x1f, 0x8b, 0x08]),
      new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0]),
      new TextEncoder().encode('plain text'),
    ]

    for (const input of inputs) {
      await expect(gunzipToText(input)).resolves.toHaveProperty('ok')
    }
  })
})

describe('buildGzipFileName', () => {
  it('names the file with the short session id and the .json.gz suffix', () => {
    const name = buildGzipFileName('abcdef12-3456-4789-8abc-def012345678', '1405-05-27')
    expect(name).toBe('artiscan-raw-session-abcdef12-1405-05-27.json.gz')
  })
})
