/**
 * SECTION 15 - an INVESTIGATION of local storage, not a change to it.
 *
 * The milestone asks what the current storage actually does before anyone
 * proposes a different representation for it. Nothing in this file changes a
 * format, and nothing here is a proposal; every claim below is either asserted
 * against the real repository code or printed as a measurement.
 *
 * THE FOUR QUESTIONS, AND WHERE EACH IS ANSWERED
 *
 * 1. In what form is a raw session stored?            -> 'the stored form'
 * 2. Structured clone or a JSON string?               -> 'structured clone, not JSON text'
 * 3. How large does a stored trial result get?        -> 'measured sizes'
 * 4. How does the store grow, and how does a failed
 *    write reach the user?                            -> 'growth' / 'a failed write is loud'
 *
 * TWO HONESTY CONSTRAINTS THAT SHAPE THIS FILE
 *
 * The environment is Node + jsdom + fake-indexeddb. Byte sizes computed from
 * the serialized record are exact and environment-independent, so they are
 * reported as measurements. Timings and anything about real browser quota are
 * NOT: fake-indexeddb keeps everything in memory, has no quota at all, and
 * cannot be made to produce a genuine QuotaExceededError. So this file measures
 * the ERROR PATH (does a failed write reach the caller?) and leaves the
 * question of when Chrome actually refuses a write to the manual checklist.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSessions,
  getLatestSession,
  getSession,
  saveSession,
} from './drawingSessionRepository'
import { resetDatabaseConnectionForTests, withStore } from './indexedDb'
import { serializeSession } from './drawingSerializer'
import {
  clearTrialResults,
  getTrialResult,
  listTrialResults,
  saveTrialResult,
} from '../../trial/services/trialResultRepository'
import { buildTrialResult } from '../../trial/services/trialResultSerializer'
import { serializeTrialResult } from '../../trial/services/trialResultSerializer'
import { makePoint, makeSession, makeStroke } from '../testing/sessionFixture'
import type { DrawingSession } from '../types/drawing.types'
import type { DrawingTask, DrawingTrial } from '../../trial/types/trial.types'

const CANVAS = { width: 800, height: 600, devicePixelRatio: 1 }

const TASK: DrawingTask = {
  id: 'house',
  labelFa: 'خانه',
  labelEn: 'House',
  quickDrawCategory: 'house',
  instructionFa: 'یک خانه بکشید.',
  timeLimitSeconds: 60,
  enabled: true,
}

/** A completed trial, which is the only kind the repository accepts. */
function trialOf(id: string): DrawingTrial {
  return {
    id,
    status: 'completed',
    timeLimitSeconds: 60,
    timing: {
      startedAt: '2026-09-01T10:00:00.000Z',
      completedAt: '2026-09-01T10:00:30.000Z',
      durationMs: 30_000,
      countdownSeconds: 3,
    },
  }
}

/**
 * A valid UUID derived from a label, so each size case gets its own trial id
 * without the test having to track an index.
 */
function trialIdFor(label: string): string {
  const suffix = String(
    [...label].reduce((total, character) => total + character.charCodeAt(0), 0),
  ).padStart(12, '0')
  return `33333333-3333-4333-8333-${suffix.slice(-12)}`
}

/** A session of `pointCount` points spread over `strokeCount` strokes. */
function sessionOf(pointCount: number, strokeCount: number, id = 'probe'): DrawingSession {
  const perStroke = Math.max(1, Math.floor(pointCount / strokeCount))
  let sequence = 0
  const strokes = Array.from({ length: strokeCount }, (_, index) => {
    const points = Array.from({ length: perStroke }, (_, i) => {
      sequence += 1
      const x = 20 + ((index * 37 + i * 3) % (CANVAS.width - 40))
      const y = 20 + ((index * 53 + i * 7) % (CANVAS.height - 40))
      return makePoint({
        sequence,
        timeMs: sequence * 10,
        x,
        y,
        normalizedX: x / CANVAS.width,
        normalizedY: y / CANVAS.height,
        pressure: 0.5,
      })
    })
    return makeStroke({
      id: `s${String(index)}`,
      order: index,
      startedAtMs: points[0]!.timeMs,
      endedAtMs: points[points.length - 1]!.timeMs,
      points,
    })
  })
  return makeSession({ id, canvas: CANVAS, strokes, actions: [] })
}

/** Row count in a store, without assuming anything about its contents. */
function countRows(storeName: string): Promise<number> {
  return withStore(storeName, 'readonly', async (store) => {
    return new Promise<number>((resolve, reject) => {
      const request = store.count()
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('count failed'))
      }
    })
  })
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

interface SizeRow {
  label: string
  points: number
  sessionBytes: number
  resultBytes: number
  overheadBytes: number
  bytesPerPoint: number
}

const sizeRows: SizeRow[] = []

beforeEach(async () => {
  resetDatabaseConnectionForTests()
  await clearSessions()
  await clearTrialResults()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the stored form', () => {
  it('stores one whole session per row, keyed by its own id', async () => {
    await saveSession(sessionOf(60, 3, 'alpha'))
    await saveSession(sessionOf(60, 3, 'beta'))

    // The key path is the session id, so a save REPLACES that session rather
    // than appending a second copy of it. This is what makes autosave safe to
    // fire repeatedly, and it is also why the stale-write guard exists.
    expect(await countRows('drawingSessions')).toBe(2)
    await saveSession(sessionOf(90, 3, 'alpha'))
    expect(await countRows('drawingSessions')).toBe(2)
  })

  it('stores the session as a live object graph, not as a string', async () => {
    await saveSession(sessionOf(40, 2, 'shape'))

    const raw = await withStore('drawingSessions', 'readonly', async (store) => {
      return new Promise<unknown>((resolve, reject) => {
        const request = store.get('shape')
        request.onsuccess = () => {
          resolve(request.result)
        }
        request.onerror = () => {
          reject(request.error ?? new Error('get failed'))
        }
      })
    })

    // This is the answer to "how is it stored": an object whose arrays are real
    // arrays. No JSON.stringify happens on the write path, so no parse happens
    // on the read path either.
    expect(typeof raw).toBe('object')
    expect(typeof raw).not.toBe('string')
    const record = raw as DrawingSession
    expect(Array.isArray(record.strokes)).toBe(true)
    expect(Array.isArray(record.strokes[0]?.points)).toBe(true)
  })

  it('returns a detached copy, so a reader cannot corrupt the stored row', async () => {
    await saveSession(sessionOf(40, 2, 'detach'))

    const first = await getSession('detach')
    expect(first).not.toBeNull()
    // Mutating what a read returned must not travel back into the store. A
    // shared reference here would mean any accidental edit in the UI silently
    // rewrote the recording.
    ;(first as DrawingSession).strokes[0]!.points.length = 0

    const second = await getSession('detach')
    expect(second!.strokes[0]!.points.length).toBeGreaterThan(0)
  })

  it('finds the newest session through the createdAt index, not by scanning', async () => {
    await saveSession(makeSession({ id: 'older', createdAt: '2026-01-01T00:00:00.000Z' }))
    await saveSession(makeSession({ id: 'newest', createdAt: '2026-09-01T00:00:00.000Z' }))

    expect((await getLatestSession())?.id).toBe('newest')
  })
})

describe('structured clone, not JSON text', () => {
  it('round-trips every value class a recording contains, exactly', async () => {
    const session = makeSession({
      id: 'fidelity',
      canvas: CANVAS,
      strokes: [
        makeStroke({
          id: 'only',
          order: 0,
          startedAtMs: 10,
          endedAtMs: 40,
          points: [
            // A pen that reports no pressure. null must stay null: zero would
            // read as "touched the surface with no force", which is a different
            // observation.
            makePoint({ sequence: 1, timeMs: 10, pressure: null }),
            // Full float precision, not a rounded decimal string.
            makePoint({
              sequence: 2,
              timeMs: 20,
              x: 123.456_789_012_345_67,
              y: 98.765_432_109_876_54,
              normalizedX: 123.456_789_012_345_67 / CANVAS.width,
              normalizedY: 98.765_432_109_876_54 / CANVAS.height,
              pressure: 0.333_333_333_333_333_3,
            }),
            // Recorded outside the canvas. The sign is part of the observation.
            makePoint({
              sequence: 3,
              timeMs: 30,
              x: -42.5,
              y: -7.25,
              normalizedX: -42.5 / CANVAS.width,
              normalizedY: -7.25 / CANVAS.height,
            }),
            makePoint({ sequence: 4, timeMs: 40 }),
          ],
        }),
      ],
      actions: [],
    })

    await saveSession(session)
    const restored = await getSession('fidelity')

    // Deep equality across the whole graph: this is the lossless claim for the
    // storage layer, matching the one the json.gz export makes for files.
    expect(restored).toEqual(session)
    const points = restored!.strokes[0]!.points
    expect(points[0]!.pressure).toBeNull()
    expect(points[1]!.x).toBe(123.456_789_012_345_67)
    expect(points[2]!.x).toBeLessThan(0)
  })

  it('carries Persian provenance text through unchanged', async () => {
    const session = makeSession({
      id: 'unicode',
      canvas: CANVAS,
      provenance: {
        importedFromSchemaVersion: 1,
        historyComplete: false,
        // Zero-width non-joiner, Persian quotation marks and Persian digits -
        // the three things a careless encoding step mangles first.
        note: 'این نشست از نسخه‌ی ۱ ارتقا یافته و «تاریخچه» آن کامل نیست.',
      },
    })

    await saveSession(session)

    const restored = await getSession('unicode')
    expect(restored).toEqual(session)
    expect(restored!.provenance!.note).toContain('«تاریخچه»')
  })

  it('refuses a value it cannot clone instead of writing a damaged row', async () => {
    const session = sessionOf(20, 1, 'notclonable') as unknown as Record<string, unknown>
    // A function is the practical example. The point is the CONTRAST with a
    // JSON write path: JSON.stringify would drop this key silently and store a
    // row that looks fine, whereas structuredClone throws and the caller is
    // told. Loud is the behaviour we want from a recording tool.
    session['callback'] = () => undefined

    await expect(saveSession(session as unknown as DrawingSession)).rejects.toBeInstanceOf(Error)
    expect(await getSession('notclonable')).toBeNull()
  })
})

describe('measured sizes', () => {
  const cases: Array<[string, number, number]> = [
    ['short sketch', 120, 2],
    ['typical trial', 900, 6],
    ['long trial', 3000, 12],
  ]

  it.each(cases)('measures %s', async (label, pointCount, strokeCount) => {
    const session = sessionOf(pointCount, strokeCount, `size-${label}`)
    const points = session.strokes.reduce((total, s) => total + s.points.length, 0)

    const sessionBytes = bytesOf(serializeSession(session))
    const result = buildTrialResult(trialOf(trialIdFor(label)), TASK, session)
    const resultBytes = bytesOf(serializeTrialResult(result))

    sizeRows.push({
      label,
      points,
      sessionBytes,
      resultBytes,
      overheadBytes: resultBytes - sessionBytes,
      bytesPerPoint: round(sessionBytes / Math.max(1, points)),
    })

    // The wrapper adds task, trial and derived features around the SAME
    // session; it never shrinks it, because the session is embedded verbatim.
    expect(resultBytes).toBeGreaterThan(sessionBytes)
  })

  it('prints the storage size table', () => {
    const lines = [
      '',
      '=== SECTION 15: LOCAL STORAGE SIZES ===',
      'Byte sizes are EXACT (computed from the serialized record, environment-independent).',
      'No timing is reported here: fake-indexeddb is an in-memory store and its',
      'write latency says nothing about Chrome.',
      '',
      '| Session | Points | Session B | Trial result B | Wrapper overhead B | B/point |',
      '|---|---:|---:|---:|---:|---:|',
      ...sizeRows.map(
        (r) =>
          `| ${r.label} | ${String(r.points)} | ${String(r.sessionBytes)} | ${String(r.resultBytes)} | ${String(r.overheadBytes)} | ${String(r.bytesPerPoint)} |`,
      ),
      '',
      'Stored rows are structured clones, so the real footprint is of the same',
      'order as these numbers but is not byte-identical to them: IndexedDB stores',
      'the object graph, not this text.',
      '',
    ]
    console.log(lines.join('\n'))
    expect(sizeRows).toHaveLength(cases.length)
  })
})

describe('growth', () => {
  it('adds exactly one row per completed trial and keeps every one', async () => {
    const ids = [
      '33333333-3333-4333-8333-333333333301',
      '33333333-3333-4333-8333-333333333302',
      '33333333-3333-4333-8333-333333333303',
    ]
    for (const [index, id] of ids.entries()) {
      await saveTrialResult(
        buildTrialResult(trialOf(id), TASK, sessionOf(120, 2, `growth-${String(index)}`)),
      )
    }

    expect(await countRows('trialResults')).toBe(ids.length)
    // Nothing ages out on its own. A completed trial is evidence, and evidence
    // is removed only when something explicitly asks for it.
    expect((await listTrialResults()).map((row) => row.id).sort()).toEqual([...ids].sort())
  })

  it('re-saving one trial replaces its row rather than adding another', async () => {
    const id = '33333333-3333-4333-8333-333333333310'
    const first = buildTrialResult(trialOf(id), TASK, sessionOf(120, 2, 'rev-a'))
    const second = buildTrialResult(trialOf(id), TASK, sessionOf(240, 4, 'rev-b'))

    await saveTrialResult(first)
    await saveTrialResult(second)

    expect(await countRows('trialResults')).toBe(1)
    const stored = await getTrialResult(id)
    expect(stored!.result.session.strokes).toHaveLength(4)
  })

  it('keeps the two stores independent', async () => {
    await saveSession(sessionOf(60, 2, 'lonely'))
    await saveTrialResult(
      buildTrialResult(
        trialOf('33333333-3333-4333-8333-333333333320'),
        TASK,
        sessionOf(60, 2, 'embedded'),
      ),
    )

    // A trial result embeds its own copy of the session. Clearing the session
    // store therefore cannot damage a completed result - and that redundancy is
    // deliberate, because the result is the thing being exported.
    await clearSessions()

    expect(await countRows('drawingSessions')).toBe(0)
    expect(await countRows('trialResults')).toBe(1)
    const stored = await getTrialResult('33333333-3333-4333-8333-333333333320')
    expect(stored!.result.session.strokes.length).toBeGreaterThan(0)
  })
})

describe('a failed write is loud', () => {
  it('rejects with a readable error when the store refuses the write', async () => {
    /*
      Stands in for a quota refusal. The REAL question - at what size Chrome
      starts refusing - cannot be answered here, because fake-indexeddb has no
      quota; that belongs in the manual Chrome checklist. What is tested here is
      the part that is ours: a store that refuses must produce a rejected
      promise carrying a message, never a resolved "saved".
    */
    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation((): IDBRequest<IDBValidKey> => {
        throw new DOMException('mock quota exceeded', 'QuotaExceededError')
      })

    await expect(saveSession(sessionOf(60, 2, 'refused'))).rejects.toThrow(/quota/i)

    put.mockRestore()
    // And the store really is empty: nothing half-written was left behind.
    expect(await getSession('refused')).toBeNull()
  })

  it('refuses to store an incomplete trial at all', async () => {
    const unfinished = buildTrialResult(
      {
        ...trialOf('33333333-3333-4333-8333-333333333330'),
        status: 'cancelled',
        timing: {
          startedAt: '2026-09-01T10:00:00.000Z',
          completedAt: null,
          durationMs: null,
          countdownSeconds: 3,
        },
      },
      TASK,
      sessionOf(60, 2, 'cancelled'),
    )

    // A cancelled trial is not an observation of a finished drawing, so it
    // never reaches the results store and never inflates it.
    await expect(saveTrialResult(unfinished)).rejects.toBeInstanceOf(Error)
    expect(await countRows('trialResults')).toBe(0)
  })
})
