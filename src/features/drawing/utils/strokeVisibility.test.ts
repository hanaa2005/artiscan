import { describe, expect, it } from 'vitest'
import {
  computeRedoStack,
  computeVisibleStrokeIds,
  computeVisibleStrokes,
  replayHistory,
} from './strokeVisibility'
import {
  makeAction,
  makeClearAction,
  makeRedoAction,
  makeSession,
  makeStroke,
  makeStrokeSeries,
  makeUndoAction,
  timeForSequence,
} from '../testing/sessionFixture'
import { serializeSession, deserializeSession } from '../services/drawingSerializer'

/**
 * Four strokes named a, b, c, d - the scenario from the original bug report.
 * makeStrokeSeries gives them non-overlapping ascending sequence blocks
 * (a: 1-3, b: 5-7, c: 9-11, d: 13-15), so actions numbered from 50 upwards are
 * unambiguously later than every stroke.
 */
function fourStrokes() {
  return makeStrokeSeries(4, ['a', 'b', 'c', 'd'])
}

describe('computeVisibleStrokes - baseline', () => {
  it('shows every stroke when nothing has been undone or cleared', () => {
    expect(computeVisibleStrokes(fourStrokes(), []).map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })

  it('ignores actions that do not affect visibility', () => {
    const actions = [
      makeAction({ sequence: 50, type: 'tool_change' }),
      makeAction({ sequence: 51, type: 'color_change' }),
      makeAction({ sequence: 52, type: 'width_change' }),
    ]
    expect(computeVisibleStrokes(fourStrokes(), actions)).toHaveLength(4)
  })
})

describe('computeVisibleStrokes - clear', () => {
  it('hides exactly the strokes named in the clear event', () => {
    const actions = [makeClearAction(['a', 'b', 'c', 'd'], 50)]
    expect(computeVisibleStrokes(fourStrokes(), actions)).toEqual([])
  })

  it('leaves a stroke drawn AFTER the clear visible', () => {
    // The clear can only name ids that existed when it happened, so a later
    // stroke is provably untouched by it - no timeline arithmetic needed.
    const strokes = makeStrokeSeries(5, ['a', 'b', 'c', 'd', 'e'])
    const actions = [makeClearAction(['a', 'b', 'c', 'd'], 50)]
    expect(computeVisibleStrokes(strokes, actions).map((s) => s.id)).toEqual(['e'])
  })

  it('survives two clears with drawing in between', () => {
    const strokes = makeStrokeSeries(3, ['a', 'b', 'c'])
    const actions = [makeClearAction(['a'], 50), makeClearAction(['b'], 60)]
    expect(computeVisibleStrokes(strokes, actions).map((s) => s.id)).toEqual(['c'])
  })

  it('treats a clear with no id list as affecting nothing', () => {
    // Defensive: a hand-edited or upgraded legacy file must not blank the canvas.
    const actions = [
      makeAction({ sequence: 50, type: 'clear', payload: { removedStrokeCount: 4 } }),
    ]
    expect(computeVisibleStrokes(fourStrokes(), actions)).toHaveLength(4)
  })
})

describe('computeVisibleStrokes - undo and redo', () => {
  it('hides an undone stroke', () => {
    const actions = [makeUndoAction('d', 50)]
    expect(computeVisibleStrokes(fourStrokes(), actions).map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('restores a redone stroke to its ORIGINAL position, not the end', () => {
    // Painting order matters for the eraser: a redone stroke must go back where
    // it was drawn, not on top of everything drawn since.
    const actions = [makeUndoAction('b', 50), makeRedoAction('b', 51)]
    expect(computeVisibleStrokes(fourStrokes(), actions).map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })

  it('keeps a stroke hidden when it was undone and never redone', () => {
    const actions = [
      makeUndoAction('d', 50),
      makeUndoAction('c', 51),
      makeRedoAction('c', 52),
    ]
    expect(computeVisibleStrokes(fourStrokes(), actions).map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('ignores an undo naming a stroke that does not exist', () => {
    expect(computeVisibleStrokes(fourStrokes(), [makeUndoAction('ghost', 50)])).toHaveLength(4)
  })
})

describe('computeVisibleStrokeIds', () => {
  it('returns the ids rather than the stroke objects', () => {
    const ids = computeVisibleStrokeIds(fourStrokes(), [makeUndoAction('a', 50)])
    expect([...ids].sort()).toEqual(['b', 'c', 'd'])
  })
})

/**
 * The redo stack is UI state that the recorded history already determines.
 * Rebuilding it from the log is what lets a restored session continue exactly
 * where the user left off, instead of losing a stroke that was one click away
 * from returning.
 */
describe('computeRedoStack', () => {
  it('is empty when nothing has been undone', () => {
    expect(computeRedoStack(fourStrokes(), [])).toEqual([])
  })

  it('holds a stroke that was undone and not redone', () => {
    expect(computeRedoStack(fourStrokes(), [makeUndoAction('d', 50)])).toEqual(['d'])
  })

  it('orders entries so the LAST one is redone first', () => {
    const actions = [makeUndoAction('d', 50), makeUndoAction('c', 51)]
    // Undoing d then c means a redo must bring back c first.
    expect(computeRedoStack(fourStrokes(), actions)).toEqual(['d', 'c'])
  })

  it('pops the entry again once it is redone', () => {
    const actions = [makeUndoAction('d', 50), makeRedoAction('d', 51)]
    expect(computeRedoStack(fourStrokes(), actions)).toEqual([])
  })

  it('is invalidated by a clear', () => {
    const actions = [makeUndoAction('d', 50), makeClearAction(['a', 'b', 'c'], 51)]
    expect(computeRedoStack(fourStrokes(), actions)).toEqual([])
  })

  it('is invalidated by drawing a new stroke afterwards', () => {
    // Stroke e is drawn at sequence 17, i.e. AFTER the undo at 10.
    const strokes = makeStrokeSeries(5, ['a', 'b', 'c', 'd', 'e'])
    const actions = [makeUndoAction('d', 16)]
    expect(computeRedoStack(strokes, actions)).toEqual([])
  })

  it('ignores a redo naming a stroke that is not in the file', () => {
    const actions = [makeUndoAction('d', 50), makeRedoAction('ghost', 51)]
    expect(computeRedoStack(fourStrokes(), actions)).toEqual(['d'])
  })
})

describe('replayHistory - merged timeline', () => {
  it('returns visibility and redo state from a single pass', () => {
    const result = replayHistory(fourStrokes(), [makeUndoAction('c', 50)])
    expect([...result.visibleIds].sort()).toEqual(['a', 'b', 'd'])
    expect(result.redoStack).toEqual(['c'])
  })

  it('orders a stroke against an action using sequence, not array position', () => {
    // The undo at sequence 6 lands between stroke b (5-7) and stroke c (9-11),
    // so stroke c is drawn afterwards and clears the redo stack.
    const strokes = makeStrokeSeries(3, ['a', 'b', 'c'])
    const result = replayHistory(strokes, [makeUndoAction('a', 6)])
    expect(result.redoStack).toEqual([])
    expect([...result.visibleIds].sort()).toEqual(['b', 'c'])
  })
})

/**
 * The regression this whole model exists for: Clear used to delete the strokes
 * from the session, so the exported JSON lost their ids, points, timing and
 * tools forever.
 */
describe('regression - Clear must not destroy research data', () => {
  it('keeps all four strokes in the exported session after a clear', () => {
    const session = makeSession({
      strokes: fourStrokes(),
      actions: [makeClearAction(['a', 'b', 'c', 'd'], 50)],
    })

    const result = deserializeSession(serializeSession(session))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.strokes).toHaveLength(4)
    expect(result.value.strokes.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('preserves the points, timing and tool of every cleared stroke', () => {
    const session = makeSession({
      strokes: [makeStroke({ id: 'a', tool: 'eraser', startedAtMs: 5, endedAtMs: 300 })],
      actions: [makeClearAction(['a'], 50)],
    })

    const result = deserializeSession(serializeSession(session))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const restored = result.value.strokes[0]
    expect(restored?.tool).toBe('eraser')
    expect(restored?.startedAtMs).toBe(5)
    expect(restored?.endedAtMs).toBe(300)
    expect(restored?.points).toHaveLength(3)
    expect(restored?.points[0]?.timeMs).toBe(timeForSequence(1))
  })

  it('records which stroke ids the clear affected', () => {
    const session = makeSession({
      strokes: fourStrokes(),
      actions: [makeClearAction(['a', 'b', 'c', 'd'], 50)],
    })

    const clear = session.actions.find((action) => action.type === 'clear')
    expect(clear?.payload?.['affectedStrokeIds']).toEqual(['a', 'b', 'c', 'd'])
  })

  it('replays a cleared session to an empty visible canvas', () => {
    const session = makeSession({
      strokes: fourStrokes(),
      actions: [makeClearAction(['a', 'b', 'c', 'd'], 50)],
    })
    expect(computeVisibleStrokes(session.strokes, session.actions)).toEqual([])
  })

  it('shows only the new stroke when drawing continues after a clear', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(5, ['a', 'b', 'c', 'd', 'e']),
      actions: [makeClearAction(['a', 'b', 'c', 'd'], 16)],
    })

    const visible = computeVisibleStrokes(session.strokes, session.actions)
    expect(visible.map((s) => s.id)).toEqual(['e'])
    // ...while the research data still holds all five.
    expect(session.strokes).toHaveLength(5)
  })

  it('reconstructs the identical visible result after export and import', () => {
    const original = makeSession({
      strokes: makeStrokeSeries(5, ['a', 'b', 'c', 'd', 'e']),
      actions: [makeClearAction(['a', 'b', 'c', 'd'], 50), makeUndoAction('e', 60)],
    })

    const result = deserializeSession(serializeSession(original))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const before = computeVisibleStrokes(original.strokes, original.actions)
    const after = computeVisibleStrokes(result.value.strokes, result.value.actions)
    expect(after).toEqual(before)
    expect(after).toEqual([])
    // Nothing was lost on the way through the file.
    expect(result.value.strokes).toHaveLength(5)
  })
})
