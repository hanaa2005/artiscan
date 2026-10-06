/**
 * The lossless round-trip.
 *
 * THE CLAIM UNDER TEST
 *
 * A session written as JSON.GZ and read back is the SAME session - deeply
 * equal, field for field, point for point, with no value rounded, reordered,
 * renamed or dropped. Gzip is a transport encoding and nothing else.
 *
 * Deep equality is the assertion throughout, deliberately. A test that compared
 * stroke counts would pass on a file that had silently lost every pressure
 * reading, and losing pressure is exactly the kind of quiet damage a compression
 * path can do.
 *
 * The timings recorded at the end were measured in NODE, not in a browser. They
 * are reported as such: Node's CompressionStream is not Chrome's, and quoting
 * one as the other would be inventing a browser measurement.
 */

import { describe, expect, it } from 'vitest'
import { readSessionFile } from './sessionFileReader'
import { deserializeSession, serializeSession } from './drawingSerializer'
import { gzipText } from '../../artifacts/services/gzipCodec'
import {
  makeAction,
  makeClearAction,
  makePoint,
  makeRedoAction,
  makeSession,
  makeStroke,
  makeUndoAction,
  timeForSequence,
} from '../testing/sessionFixture'
import { CURRENT_SCHEMA_VERSION, type DrawingSession } from '../types/drawing.types'

const CANVAS = { width: 800, height: 400, devicePixelRatio: 2 }

/** Wraps bytes in a File, the way the browser hands one to the import control. */
function fileOf(bytes: Uint8Array | string, name: string): File {
  return new File([bytes as BlobPart], name)
}

/** Compresses a session the way the export button does. */
async function gzipSession(session: DrawingSession): Promise<Uint8Array<ArrayBuffer>> {
  return gzipText(serializeSession(session))
}

/**
 * The full assertion: export, compress, read, parse, compare.
 *
 * Returns the recovered session so a caller can make extra claims about it.
 */
async function roundTrip(session: DrawingSession): Promise<DrawingSession> {
  const read = await readSessionFile(fileOf(await gzipSession(session), 'session.json.gz'))
  expect(read.ok).toBe(true)
  if (!read.ok) throw new Error(read.error)
  expect(read.value.encoding).toBe('gzip')

  const parsed = deserializeSession(read.value.text)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error(parsed.error)

  expect(parsed.value).toEqual(session)
  return parsed.value
}

// ---------------------------------------------------------------------------
// Round-trip fidelity
// ---------------------------------------------------------------------------

describe('json.gz round trip is lossless', () => {
  it('recovers a plain session exactly', async () => {
    await roundTrip(makeSession({ canvas: CANVAS }))
  })

  it('recovers a session with undo, redo and clear exactly', async () => {
    const session = makeSession({
      canvas: CANVAS,
      strokes: [
        makeStroke({ id: 'a', order: 0 }),
        makeStroke({
          id: 'b',
          order: 1,
          startedAtMs: timeForSequence(6),
          endedAtMs: timeForSequence(8),
          points: [6, 7, 8].map((s) =>
            makePoint({ sequence: s, timeMs: timeForSequence(s), x: s * 10, y: 40 }),
          ),
        }),
      ],
      actions: [makeUndoAction('b', 20), makeRedoAction('b', 21), makeClearAction(['a', 'b'], 22)],
    })

    const recovered = await roundTrip(session)
    // The action log is the part a naive "save what's on screen" export loses.
    expect(recovered.actions.map((action) => action.type)).toEqual(['undo', 'redo', 'clear'])
  })

  it('recovers colour and width actions with their payloads intact', async () => {
    const session = makeSession({
      canvas: CANVAS,
      actions: [
        makeAction({
          sequence: 5,
          type: 'color_change',
          payload: { from: '#1f2933', to: '#e03131' },
        }),
        makeAction({ sequence: 6, type: 'width_change', payload: { from: 4, to: 11.5 } }),
        makeAction({ sequence: 7, type: 'tool_change', payload: { from: 'pen', to: 'eraser' } }),
      ],
    })

    const recovered = await roundTrip(session)
    expect(recovered.actions[1]?.payload).toEqual({ from: 4, to: 11.5 })
  })

  it('recovers coordinates recorded outside the canvas, sign and all', async () => {
    /*
      The real capture contract, which this fixture now matches: raw `x`/`y`
      keep the excursion exactly as it happened, while `normalizedX/Y` are
      clamped to 0..1 at capture time (see utils/coordinates). The pixels are
      the evidence; the normalized pair is a resize-independent VIEW of a point
      on the canvas, and the validator enforces its range.
    */
    const session = makeSession({
      canvas: CANVAS,
      strokes: [
        makeStroke({
          points: [
            makePoint({ sequence: 1, x: -137.25, y: -8, normalizedX: 0, normalizedY: 0 }),
            makePoint({ sequence: 2, x: 400, y: 200, normalizedX: 0.5, normalizedY: 0.5 }),
            makePoint({ sequence: 3, x: 943.5, y: 512.75, normalizedX: 1, normalizedY: 1 }),
          ],
        }),
      ],
      actions: [],
    })

    const recovered = await roundTrip(session)
    // Out-of-canvas pixels are evidence. Rounding or clamping THEM would be
    // data loss that no later stage could detect.
    expect(recovered.strokes[0]?.points[0]?.x).toBe(-137.25)
    expect(recovered.strokes[0]?.points[2]?.x).toBe(943.5)
    expect(recovered.strokes[0]?.points[2]?.y).toBe(512.75)
  })

  it('keeps pressure null rather than turning it into zero', async () => {
    const session = makeSession({
      canvas: CANVAS,
      strokes: [
        makeStroke({
          points: [1, 2, 3].map((s) => makePoint({ sequence: s, pressure: null })),
        }),
      ],
      actions: [],
    })

    const recovered = await roundTrip(session)
    // null means "this device reported no pressure". 0 means "the pen touched
    // with no force". Collapsing the two would fabricate a measurement.
    for (const point of recovered.strokes[0]?.points ?? []) {
      expect(point.pressure).toBeNull()
      expect(point.pressure).not.toBe(0)
    }
  })

  it('recovers real pressure and tilt values at full precision', async () => {
    const session = makeSession({
      canvas: CANVAS,
      strokes: [
        makeStroke({
          hasPressureSamples: true,
          points: [
            makePoint({ sequence: 1, pressure: 0.06666666666666667, tiltX: -37, tiltY: 12, pointerType: 'pen' }),
            makePoint({ sequence: 2, pressure: 0.4823529411764706, tiltX: 0, tiltY: -3, pointerType: 'pen' }),
            makePoint({ sequence: 3, pressure: 1, tiltX: 59, tiltY: 0, pointerType: 'pen' }),
          ],
        }),
      ],
      actions: [],
    })

    const recovered = await roundTrip(session)
    expect(recovered.strokes[0]?.points[0]?.pressure).toBe(0.06666666666666667)
    expect(recovered.strokes[0]?.points[1]?.tiltY).toBe(-3)
    expect(recovered.strokes[0]?.hasPressureSamples).toBe(true)
  })

  it('carries Persian and other Unicode text through compression unchanged', async () => {
    /*
      A DrawingSession has no free-text field, so this is asserted against the
      codec directly rather than by inventing one on the session. It still
      matters: the trial result and the provenance note are Persian, and a
      compression path that mangled UTF-8 would corrupt both.
    */
    const text = JSON.stringify({
      note: 'آزمون ترسیم — شرکت‌کننده ۱۲ (نیم‌فاصله و «گیومه»)',
      emoji: '🖊️✅',
      mixed: 'RTL داخل LTR ۱۲۳',
    })
    const read = await readSessionFile(fileOf(await gzipText(text), 'meta.json.gz'))

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.text).toBe(text)
  })

  it('recovers a migrated session together with its Persian provenance note', async () => {
    const session = makeSession({
      canvas: CANVAS,
      strokes: [makeStroke({ color: '#00ff88' })],
      actions: [],
      provenance: {
        importedFromSchemaVersion: 1,
        historyComplete: false,
        note: 'این فایل از نسخه ۱ ارتقا یافته و تاریخچه کامل ندارد.',
      },
    })

    const recovered = await roundTrip(session)
    expect(recovered.provenance?.note).toBe(session.provenance?.note)
  })

  it('recovers a large session with many points', async () => {
    const points = Array.from({ length: 3000 }, (_, i) =>
      makePoint({
        sequence: i + 1,
        timeMs: timeForSequence(i + 1),
        x: (i % 800) + 0.125,
        y: Math.sin(i / 40) * 180 + 200,
        normalizedX: ((i % 800) + 0.125) / 800,
        normalizedY: (Math.sin(i / 40) * 180 + 200) / 400,
      }),
    )
    const session = makeSession({
      canvas: CANVAS,
      strokes: [
        makeStroke({
          points,
          startedAtMs: timeForSequence(1),
          endedAtMs: timeForSequence(3000),
        }),
      ],
      actions: [],
    })

    const recovered = await roundTrip(session)
    expect(recovered.strokes[0]?.points).toHaveLength(3000)
  })

  it('produces the same text as the uncompressed export, character for character', async () => {
    const session = makeSession({ canvas: CANVAS })
    const read = await readSessionFile(fileOf(await gzipSession(session), 'a.json.gz'))

    expect(read.ok).toBe(true)
    if (!read.ok) return
    // Not merely "parses to the same object" - the STRING is identical, which
    // is the strongest form of the claim.
    expect(read.value.text).toBe(serializeSession(session))
  })

  it('survives a second round trip without drifting', async () => {
    const session = makeSession({ canvas: CANVAS })

    expect(await roundTrip(await roundTrip(session))).toEqual(session)
  })
})

// ---------------------------------------------------------------------------
// Plain files still work
// ---------------------------------------------------------------------------

describe('plain json still imports', () => {
  it('reads an uncompressed file and says so', async () => {
    const session = makeSession({ canvas: CANVAS })
    const read = await readSessionFile(fileOf(serializeSession(session), 'a.json'))

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.encoding).toBe('plain')
    expect(deserializeSession(read.value.text)).toEqual({ ok: true, value: session })
  })

  it('decides by content, not by filename', async () => {
    // A gzip file named .json - what a chat client or a cloud drive produces.
    const bytes = await gzipSession(makeSession({ canvas: CANVAS }))
    const read = await readSessionFile(fileOf(bytes, 'looks-plain.json'))

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.encoding).toBe('gzip')
  })

  it('strips a UTF-8 BOM that would otherwise fail JSON.parse', async () => {
    const session = makeSession({ canvas: CANVAS })
    const read = await readSessionFile(fileOf(`﻿${serializeSession(session)}`, 'bom.json'))

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(deserializeSession(read.value.text).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Failure is reported, never guessed at
// ---------------------------------------------------------------------------

describe('bad input fails with a message, not a crash', () => {
  it('rejects an empty file', async () => {
    const read = await readSessionFile(fileOf('', 'empty.json'))

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).toMatch(/خالی/)
  })

  it('rejects a truncated gzip file distinctly from a non-gzip one', async () => {
    const bytes = await gzipSession(makeSession({ canvas: CANVAS }))
    const truncated = bytes.slice(0, Math.floor(bytes.length / 2))

    const read = await readSessionFile(fileOf(truncated, 'cut.json.gz'))
    expect(read.ok).toBe(false)
    if (read.ok) return
    // The header was valid; the body was not. That is a different problem for
    // the user than picking the wrong file, so it gets a different message.
    expect(read.error).toMatch(/ناقص یا خراب/)
  })

  it('reports valid JSON that is not a session as a schema error, not a read error', async () => {
    const bytes = await gzipText(JSON.stringify({ hello: 'world' }))
    const read = await readSessionFile(fileOf(bytes, 'wrong.json.gz'))

    // Reading succeeded - the compression layer did its job.
    expect(read.ok).toBe(true)
    if (!read.ok) return
    // The failure belongs to the validator, and stays there.
    const parsed = deserializeSession(read.value.text)
    expect(parsed.ok).toBe(false)
  })

  it('reports gzip that decompresses to broken JSON as a parse error', async () => {
    const bytes = await gzipText('{ "schemaVersion": 2, ')
    const read = await readSessionFile(fileOf(bytes, 'broken.json.gz'))

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(deserializeSession(read.value.text).ok).toBe(false)
  })

  it('reads a compressed legacy v1 session through the existing migration', async () => {
    const legacy = {
      ...makeSession({ canvas: CANVAS, actions: [] }),
      schemaVersion: 1,
    }
    const bytes = await gzipText(JSON.stringify(legacy, null, 2))
    const read = await readSessionFile(fileOf(bytes, 'v1.json.gz'))

    expect(read.ok).toBe(true)
    if (!read.ok) return
    const parsed = deserializeSession(read.value.text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // Compression changed nothing about migration: a v1 file arrives migrated
    // whether it was compressed or not.
    expect(parsed.value.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('reports the compressed size, so the saving can be shown honestly', async () => {
    const session = makeSession({ canvas: CANVAS })
    const raw = new TextEncoder().encode(serializeSession(session)).length
    const read = await readSessionFile(fileOf(await gzipSession(session), 'a.json.gz'))

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.byteLength).toBeGreaterThan(0)
    expect(read.value.byteLength).toBeLessThan(raw)
  })
})
