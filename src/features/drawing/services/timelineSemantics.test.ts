/**
 * Timeline semantics: is this file a session that could actually have happened?
 *
 * The referential pass asks "does this stroke id appear anywhere in the file?"
 * - a question about the file as a whole, with no notion of time. It therefore
 * accepts an undo of a stroke that had not been drawn yet, or a redo with no
 * undo before it. Such a file describes a session that could never have been
 * recorded: replaying it produces a canvas the user never saw, and its timings
 * and stroke counts are fiction.
 *
 * These tests hold every action to the state as it existed at that exact moment.
 */

import { describe, expect, it } from 'vitest'
import { validateSession, validateTimelineSemantics } from './drawingValidator'
import {
  makeClearAction,
  makePoint,
  makeRedoAction,
  makeSession,
  makeStroke,
  makeStrokeSeries,
  makeUndoAction,
  timeForSequence,
} from '../testing/sessionFixture'
import type { DrawingAction, DrawingStroke } from '../types/drawing.types'

/** Asserts a rejection and returns the message. */
function expectRejected(raw: unknown): string {
  const result = validateSession(raw)
  expect(result.ok).toBe(false)
  return result.ok ? '' : result.error
}

/**
 * Three strokes at sequences 1-3, 5-7 and 9-11, leaving 4, 8 and 12+ free for
 * actions to be interleaved at precise moments.
 */
function threeStrokes(): DrawingStroke[] {
  return makeStrokeSeries(3, ['a', 'b', 'c'])
}

describe('temporal integrity - an action may not reference the future', () => {
  it('rejects an undo of a stroke drawn AFTER the action', () => {
    // Stroke c starts at sequence 9; this undo claims to have happened at 4.
    const error = expectRejected(
      makeSession({ strokes: threeStrokes(), actions: [makeUndoAction('c', 4)] }),
    )
    expect(error).toContain('هنوز کشیده نشده بود')
  })

  it('rejects a redo of a stroke drawn AFTER the action', () => {
    const error = expectRejected(
      makeSession({ strokes: threeStrokes(), actions: [makeRedoAction('c', 4)] }),
    )
    expect(error).toContain('هنوز کشیده نشده بود')
  })

  it('rejects a clear naming a stroke that did not exist yet', () => {
    const error = expectRejected(
      makeSession({ strokes: threeStrokes(), actions: [makeClearAction(['a', 'c'], 4)] }),
    )
    expect(error).toContain('هنوز کشیده نشده بود')
  })

  it('accepts an undo placed after the stroke it removes', () => {
    const session = makeSession({
      strokes: threeStrokes(),
      actions: [makeUndoAction('c', 50)],
    })
    expect(validateSession(session).ok).toBe(true)
  })

  it('accepts an action interleaved between two strokes', () => {
    // Undo of stroke a at sequence 4 - after a (1-3), before b (5-7).
    const session = makeSession({
      strokes: threeStrokes(),
      actions: [makeUndoAction('a', 4)],
    })
    expect(validateSession(session).ok).toBe(true)
  })
})

describe('undo must target a visible stroke', () => {
  it('rejects undoing the same stroke twice', () => {
    const error = expectRejected(
      makeSession({
        strokes: threeStrokes(),
        actions: [makeUndoAction('c', 50), makeUndoAction('c', 51)],
      }),
    )
    expect(error).toContain('روی بوم نبود')
  })

  it('rejects undoing a stroke that a clear already hid', () => {
    const error = expectRejected(
      makeSession({
        strokes: threeStrokes(),
        actions: [makeClearAction(['a', 'b', 'c'], 50), makeUndoAction('b', 51)],
      }),
    )
    expect(error).toContain('روی بوم نبود')
  })

  it('accepts undoing a stroke that was undone and then redone', () => {
    const session = makeSession({
      strokes: threeStrokes(),
      actions: [makeUndoAction('c', 50), makeRedoAction('c', 51), makeUndoAction('c', 52)],
    })
    expect(validateSession(session).ok).toBe(true)
  })
})

describe('redo must match a real undo', () => {
  it('rejects a redo with no undo before it', () => {
    const error = expectRejected(
      makeSession({ strokes: threeStrokes(), actions: [makeRedoAction('c', 50)] }),
    )
    expect(error).toContain('بدون یک undo متناظر')
  })

  it('rejects a second redo when only one undo happened', () => {
    const error = expectRejected(
      makeSession({
        strokes: threeStrokes(),
        actions: [makeUndoAction('c', 50), makeRedoAction('c', 51), makeRedoAction('c', 52)],
      }),
    )
    expect(error).toContain('بدون یک undo متناظر')
  })

  it('rejects a redo of an id that is not on top of the stack', () => {
    // Undone in the order c, b - so the stack is [c, b] and b must return first.
    const error = expectRejected(
      makeSession({
        strokes: threeStrokes(),
        actions: [makeUndoAction('c', 50), makeUndoAction('b', 51), makeRedoAction('c', 52)],
      }),
    )
    expect(error).toContain('بالای پشته')
  })

  it('rejects a redo after a clear wiped the stack', () => {
    const error = expectRejected(
      makeSession({
        strokes: threeStrokes(),
        actions: [
          makeUndoAction('c', 50),
          makeClearAction(['a', 'b'], 51),
          makeRedoAction('c', 52),
        ],
      }),
    )
    expect(error).toContain('بدون یک undo متناظر')
  })

  it('rejects a redo after a new stroke invalidated the stack', () => {
    // Undo of stroke b at sequence 8, then stroke c is drawn at 9-11, which
    // clears the redo history. The redo at 50 no longer has anything to restore.
    const error = expectRejected(
      makeSession({
        strokes: threeStrokes(),
        actions: [makeUndoAction('b', 8), makeRedoAction('b', 50)],
      }),
    )
    expect(error).toContain('بدون یک undo متناظر')
  })

  it('accepts a redo that pops the correct top of the stack', () => {
    const session = makeSession({
      strokes: threeStrokes(),
      actions: [makeUndoAction('c', 50), makeUndoAction('b', 51), makeRedoAction('b', 52)],
    })
    expect(validateSession(session).ok).toBe(true)
  })
})

describe('clear semantics', () => {
  it('rejects duplicate ids inside one clear', () => {
    const error = expectRejected(
      makeSession({
        strokes: threeStrokes(),
        actions: [makeClearAction(['a', 'b', 'a'], 50)],
      }),
    )
    expect(error).toContain('شناسه تکراری')
  })

  it('rejects a clear naming a stroke that was already undone', () => {
    const error = expectRejected(
      makeSession({
        strokes: threeStrokes(),
        actions: [makeUndoAction('c', 50), makeClearAction(['a', 'b', 'c'], 51)],
      }),
    )
    expect(error).toContain('روی بوم نبود')
  })

  it('rejects a clear naming a stroke a previous clear already hid', () => {
    const error = expectRejected(
      makeSession({
        strokes: threeStrokes(),
        actions: [makeClearAction(['a'], 50), makeClearAction(['a', 'b'], 51)],
      }),
    )
    expect(error).toContain('روی بوم نبود')
  })

  it('accepts a clear naming exactly the visible strokes', () => {
    const session = makeSession({
      strokes: threeStrokes(),
      actions: [makeUndoAction('c', 50), makeClearAction(['a', 'b'], 51)],
    })
    expect(validateSession(session).ok).toBe(true)
  })

  it('accepts a stroke drawn after a clear, then cleared again', () => {
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const session = makeSession({
      strokes,
      // Clear a at sequence 4 (before b exists), then clear b at 50.
      actions: [makeClearAction(['a'], 4), makeClearAction(['b'], 50)],
    })
    expect(validateSession(session).ok).toBe(true)
  })
})

/**
 * The scenario named in the hardening request. It exercises a two-level redo
 * stack surviving an export/import round trip - the exact history that the old
 * `setRedoStack([])` used to throw away.
 */
describe('scenario: draw A, draw B, undo B, undo A, restore, redo A, redo B', () => {
  const strokes = () => makeStrokeSeries(2, ['A', 'B'])

  it('accepts the full recorded history', () => {
    const session = makeSession({
      strokes: strokes(),
      actions: [
        makeUndoAction('B', 50),
        makeUndoAction('A', 51),
        // The stack is [B, A]; A is on top, so A returns first.
        makeRedoAction('A', 52),
        makeRedoAction('B', 53),
      ],
    })
    expect(validateSession(session).ok).toBe(true)
  })

  it('rejects the same scenario with the two redos swapped', () => {
    const error = expectRejected(
      makeSession({
        strokes: strokes(),
        actions: [
          makeUndoAction('B', 50),
          makeUndoAction('A', 51),
          makeRedoAction('B', 52),
          makeRedoAction('A', 53),
        ],
      }),
    )
    expect(error).toContain('بالای پشته')
  })

  it('leaves both strokes visible at the end of the valid history', () => {
    const result = validateTimelineSemantics(strokes(), [
      makeUndoAction('B', 50),
      makeUndoAction('A', 51),
      makeRedoAction('A', 52),
      makeRedoAction('B', 53),
    ])
    expect(result.ok).toBe(true)
  })
})

describe('merged timeline monotonicity', () => {
  it('rejects a point followed by an action with a lower time', () => {
    const strokes = makeStrokeSeries(1, ['a'])
    // Sequence 50 puts it last, but the timestamp is earlier than the points.
    const actions: DrawingAction[] = [
      { sequence: 50, timeMs: 1, type: 'undo', payload: { strokeId: 'a' } },
    ]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('به عقب برمی‌گردد')
  })

  it('rejects an action followed by a point with a lower time', () => {
    // The action sits at sequence 4 with a huge timestamp; stroke b's points at
    // sequences 5-7 then carry smaller ones.
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const actions: DrawingAction[] = [
      { sequence: 4, timeMs: 999_999, type: 'undo', payload: { strokeId: 'a' } },
    ]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('به عقب برمی‌گردد')
  })

  it('catches a violation that per-array checks alone would miss', () => {
    // Each array is internally ascending: the single stroke's points climb, and
    // a lone action cannot be out of order with itself. Only the MERGED view
    // reveals that the action claims to precede points that come before it.
    const strokes = [
      makeStroke({
        id: 'a',
        startedAtMs: timeForSequence(1),
        endedAtMs: timeForSequence(3),
        points: [
          makePoint({ sequence: 1, timeMs: 100 }),
          makePoint({ sequence: 2, timeMs: 200 }),
          makePoint({ sequence: 3, timeMs: 300 }),
        ],
      }),
    ]
    const actions: DrawingAction[] = [
      { sequence: 4, timeMs: 50, type: 'undo', payload: { strokeId: 'a' } },
    ]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('به عقب برمی‌گردد')
  })

  it('accepts equal timestamps with increasing unique sequences', () => {
    // The clock is rounded to 0.1 ms, so a fast digitizer ties routinely.
    // sequence is the authoritative tie-breaker, so this must stay valid.
    const strokes = [
      makeStroke({
        id: 'a',
        startedAtMs: 100,
        endedAtMs: 100,
        points: [
          makePoint({ sequence: 1, timeMs: 100 }),
          makePoint({ sequence: 2, timeMs: 100 }),
          makePoint({ sequence: 3, timeMs: 100 }),
        ],
      }),
    ]
    const actions: DrawingAction[] = [
      { sequence: 4, timeMs: 100, type: 'undo', payload: { strokeId: 'a' } },
    ]
    expect(validateSession(makeSession({ strokes, actions })).ok).toBe(true)
  })

  it('accepts a valid interleaved point/action history', () => {
    const strokes = makeStrokeSeries(3, ['a', 'b', 'c'])
    const actions = [
      // Undo of a sits at sequence 4, genuinely between stroke a (1-3) and
      // stroke b (5-7). Drawing b then invalidates the redo stack, so the
      // later clear can only name what is still visible: b and c.
      makeUndoAction('a', 4),
      makeClearAction(['b', 'c'], 50),
    ]
    expect(validateSession(makeSession({ strokes, actions })).ok).toBe(true)
  })

  it('rejects an interleaved history that ignores redo invalidation', () => {
    // Same shape, but it tries to redo `a` after stroke b was drawn - the very
    // mistake the previous test is arranged to avoid.
    const strokes = makeStrokeSeries(3, ['a', 'b', 'c'])
    const actions = [makeUndoAction('a', 4), makeRedoAction('a', 8)]
    expect(expectRejected(makeSession({ strokes, actions }))).toContain('بدون یک undo متناظر')
  })

  it('accepts a session with no actions at all', () => {
    expect(validateSession(makeSession({ strokes: threeStrokes(), actions: [] })).ok).toBe(true)
  })
})
