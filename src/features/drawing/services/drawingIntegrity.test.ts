/**
 * Integrity rules for imported sessions.
 *
 * These are the defects that would NOT crash the app - they would quietly
 * produce a wrong analysis. A duplicate stroke id makes every id lookup
 * ambiguous, a repeated sequence number destroys the merged timeline, and a
 * clear pointing at a stroke that does not exist means the file no longer
 * describes a drawing that ever happened.
 *
 * Catching them at import is the only cheap moment: afterwards the bad data is
 * indistinguishable from good data.
 */

import { describe, expect, it } from 'vitest'
import { validateSession } from './drawingValidator'
import {
  makeClearAction,
  makePoint,
  makeRedoAction,
  makeSession,
  makeStroke,
  makeStrokeSeries,
  makeUndoAction,
} from '../testing/sessionFixture'
import type { DrawingStroke } from '../types/drawing.types'

/** Asserts a rejection and returns the message for further checks. */
function expectRejected(raw: unknown): string {
  const result = validateSession(raw)
  expect(result.ok).toBe(false)
  return result.ok ? '' : result.error
}

describe('stroke identity', () => {
  it('rejects duplicate stroke ids', () => {
    const strokes = makeStrokeSeries(2, ['same', 'same'])
    const error = expectRejected(makeSession({ strokes, actions: [] }))
    expect(error).toContain('تکراری')
  })

  it('accepts distinct ids', () => {
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    expect(validateSession(makeSession({ strokes, actions: [] })).ok).toBe(true)
  })
})

describe('canonical order values', () => {
  it('rejects duplicate order values', () => {
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const broken = strokes.map((stroke) => ({ ...stroke, order: 0 }))
    const error = expectRejected(makeSession({ strokes: broken, actions: [] }))
    expect(error).toContain('order')
  })

  it('rejects an order value beyond the end of the history', () => {
    // `order` indexes the append-only history, so 7 in a two-stroke session
    // means a stroke went missing.
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const broken = [strokes[0] as DrawingStroke, { ...(strokes[1] as DrawingStroke), order: 7 }]
    expect(expectRejected(makeSession({ strokes: broken, actions: [] }))).toContain('order')
  })

  it('rejects a negative order value', () => {
    const [stroke] = makeStrokeSeries(1, ['a'])
    const broken = [{ ...(stroke as DrawingStroke), order: -1 }]
    expect(expectRejected(makeSession({ strokes: broken, actions: [] }))).toContain('ترتیب')
  })

  it('rejects a fractional order value', () => {
    const [stroke] = makeStrokeSeries(1, ['a'])
    const broken = [{ ...(stroke as DrawingStroke), order: 0.5 }]
    expect(expectRejected(makeSession({ strokes: broken, actions: [] }))).not.toBe('')
  })
})

describe('sequence numbers', () => {
  it('rejects a sequence repeated between two strokes', () => {
    const strokes = [makeStroke({ id: 'a', order: 0 }), makeStroke({ id: 'b', order: 1 })]
    // Both fixtures use sequences 1-3, so the counter collides.
    expect(expectRejected(makeSession({ strokes, actions: [] }))).toContain('یکتا')
  })

  it('rejects a sequence shared between a point and an action', () => {
    // One counter feeds both arrays, so a cross-array collision is just as
    // corrupting as a collision inside one of them.
    const strokes = makeStrokeSeries(1, ['a'])
    const actions = [makeUndoAction('a', 2)]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('یکتا')
  })

  it('rejects a negative sequence', () => {
    const strokes = [makeStroke({ points: [makePoint({ sequence: -1 })] })]
    expect(expectRejected(makeSession({ strokes, actions: [] }))).toContain('نامنفی')
  })

  it('rejects a fractional sequence', () => {
    const strokes = [makeStroke({ points: [makePoint({ sequence: 1.5 })] })]
    expect(expectRejected(makeSession({ strokes, actions: [] }))).toContain('صحیح')
  })

  it('rejects decreasing sequence numbers inside one stroke', () => {
    const strokes = [
      makeStroke({
        points: [
          makePoint({ sequence: 5, timeMs: 100 }),
          makePoint({ sequence: 2, timeMs: 200 }),
        ],
      }),
    ]
    expect(expectRejected(makeSession({ strokes, actions: [] }))).toContain('صعودی')
  })

  it('rejects decreasing sequence numbers across actions', () => {
    const strokes = makeStrokeSeries(1, ['a'])
    const actions = [makeUndoAction('a', 60), makeRedoAction('a', 50)]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('صعودی')
  })

  it('rejects a negative action sequence', () => {
    const strokes = makeStrokeSeries(1, ['a'])
    expect(expectRejected(makeSession({ strokes, actions: [makeUndoAction('a', -3)] }))).toContain(
      'نامنفی',
    )
  })
})

describe('timestamps', () => {
  it('rejects a negative action time', () => {
    const strokes = makeStrokeSeries(1, ['a'])
    const actions = [{ sequence: 50, timeMs: -1, type: 'undo' as const, payload: { strokeId: 'a' } }]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('منفی')
  })

  it('rejects a stroke that ends before it starts', () => {
    const [stroke] = makeStrokeSeries(1, ['a'])
    const broken = [{ ...(stroke as DrawingStroke), startedAtMs: 500, endedAtMs: 100 }]
    expect(expectRejected(makeSession({ strokes: broken, actions: [] }))).toContain(
      'بزرگ‌تر از زمان پایان',
    )
  })

  it('accepts a stroke whose start equals its end', () => {
    // A single-sample tap is a real gesture, not a defect.
    const [stroke] = makeStrokeSeries(1, ['a'])
    const instant = [
      { ...(stroke as DrawingStroke), startedAtMs: 100, endedAtMs: 100, points: [makePoint()] },
    ]
    expect(validateSession(makeSession({ strokes: instant, actions: [] })).ok).toBe(true)
  })

  it('rejects decreasing timestamps inside one stroke', () => {
    const strokes = [
      makeStroke({
        points: [
          makePoint({ sequence: 1, timeMs: 500 }),
          makePoint({ sequence: 2, timeMs: 100 }),
        ],
      }),
    ]
    expect(expectRejected(makeSession({ strokes, actions: [] }))).toContain('کاهش')
  })

  it('rejects decreasing timestamps across actions', () => {
    const strokes = makeStrokeSeries(1, ['a'])
    const actions = [
      { sequence: 50, timeMs: 900, type: 'undo' as const, payload: { strokeId: 'a' } },
      { sequence: 51, timeMs: 100, type: 'redo' as const, payload: { strokeId: 'a' } },
    ]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('نزولی')
  })

  it('accepts two events sharing a timestamp', () => {
    // The clock is rounded to 0.1 ms, so ties are routine on a fast digitizer.
    // sequence is what breaks them - see compareTimeline.
    const strokes = [
      makeStroke({
        points: [
          makePoint({ sequence: 1, timeMs: 100 }),
          makePoint({ sequence: 2, timeMs: 100 }),
        ],
      }),
    ]
    expect(validateSession(makeSession({ strokes, actions: [] })).ok).toBe(true)
  })
})

describe('referential integrity (schema 2)', () => {
  it('rejects an undo with no strokeId at all', () => {
    const strokes = makeStrokeSeries(1, ['a'])
    const actions = [{ sequence: 50, timeMs: 500, type: 'undo' as const }]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('بدون شناسه خط')
  })

  it('rejects an undo naming a stroke that is not in the file', () => {
    const strokes = makeStrokeSeries(1, ['a'])
    const actions = [makeUndoAction('ghost', 50)]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('وجود ندارد')
  })

  it('rejects a redo naming a stroke that is not in the file', () => {
    const strokes = makeStrokeSeries(1, ['a'])
    const actions = [makeRedoAction('ghost', 50)]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('وجود ندارد')
  })

  it('rejects a clear with no affectedStrokeIds', () => {
    // Required in schema 2: without it the clear cannot be replayed, and its
    // absence is exactly the schema-1 defect this version exists to fix.
    const strokes = makeStrokeSeries(1, ['a'])
    const actions = [
      { sequence: 50, timeMs: 500, type: 'clear' as const, payload: { removedStrokeCount: 1 } },
    ]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('affectedStrokeIds')
  })

  it('rejects a clear naming a stroke that is not in the file', () => {
    const strokes = makeStrokeSeries(1, ['a'])
    const actions = [makeClearAction(['a', 'ghost'], 50)]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('وجود ندارد')
  })

  it('accepts a clear with an empty id list', () => {
    // Nothing was visible when the clear happened - a real, harmless case.
    const strokes = makeStrokeSeries(1, ['a'])
    expect(validateSession(makeSession({ strokes, actions: [makeClearAction([], 50)] })).ok).toBe(
      true,
    )
  })

  it('accepts a fully consistent session', () => {
    const strokes = makeStrokeSeries(3, ['a', 'b', 'c'])
    const actions = [
      makeUndoAction('c', 50),
      makeRedoAction('c', 51),
      makeClearAction(['a', 'b', 'c'], 52),
    ]
    expect(validateSession(makeSession({ strokes, actions })).ok).toBe(true)
  })
})
