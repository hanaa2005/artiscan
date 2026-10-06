/**
 * Final stroke status: visible / cleared / undone.
 *
 * This is the single derivation the graph, the masks and the canvas all share.
 * If it were re-implemented per consumer, a visualisation could quietly
 * disagree with the drawing it claims to describe - so the semantics are
 * pinned down here, against the project's REAL undo/redo/clear model rather
 * than an assumed one.
 */

import { describe, expect, it } from 'vitest'
import { computeStrokeStatuses, computeVisibleStrokeIds } from './strokeVisibility'
import {
  makeClearAction,
  makeRedoAction,
  makeStrokeSeries,
  makeUndoAction,
} from '../testing/sessionFixture'

describe('computeStrokeStatuses', () => {
  it('reports every stroke visible when nothing hid anything', () => {
    const strokes = makeStrokeSeries(3, ['a', 'b', 'c'])
    const statuses = computeStrokeStatuses(strokes, [])

    expect([...statuses.entries()]).toEqual([
      ['a', 'visible'],
      ['b', 'visible'],
      ['c', 'visible'],
    ])
  })

  it('returns an entry for EVERY canonical stroke, hidden ones included', () => {
    const strokes = makeStrokeSeries(3, ['a', 'b', 'c'])
    const statuses = computeStrokeStatuses(strokes, [makeUndoAction('c', 100)])

    // The append-only history is the domain; nothing is dropped from the map.
    expect(statuses.size).toBe(3)
  })

  it('marks an undone stroke as undone', () => {
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const statuses = computeStrokeStatuses(strokes, [makeUndoAction('b', 100)])

    expect(statuses.get('a')).toBe('visible')
    expect(statuses.get('b')).toBe('undone')
  })

  it('marks an undone-then-redone stroke as VISIBLE', () => {
    // The explicit rule from the brief: what matters is the final state, not
    // that an undo appears somewhere in the history.
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const statuses = computeStrokeStatuses(strokes, [
      makeUndoAction('b', 100),
      makeRedoAction('b', 200),
    ])

    expect(statuses.get('b')).toBe('visible')
  })

  it('marks a cleared stroke as cleared', () => {
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const statuses = computeStrokeStatuses(strokes, [makeClearAction(['a', 'b'], 100)])

    expect(statuses.get('a')).toBe('cleared')
    expect(statuses.get('b')).toBe('cleared')
  })

  it('leaves strokes drawn AFTER a clear visible', () => {
    const strokes = makeStrokeSeries(3, ['a', 'b', 'c'])
    // The clear names only the strokes that existed when it happened.
    const statuses = computeStrokeStatuses(strokes, [makeClearAction(['a', 'b'], 25)])

    expect(statuses.get('a')).toBe('cleared')
    expect(statuses.get('b')).toBe('cleared')
    expect(statuses.get('c')).toBe('visible')
  })

  it('keeps `undone` for a stroke that was already undone when the clear ran', () => {
    // The undo is what removed it from the canvas; the clear found it already
    // gone. Reporting `cleared` would name an event that did nothing to it.
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const statuses = computeStrokeStatuses(strokes, [
      makeUndoAction('b', 100),
      makeClearAction(['a', 'b'], 200),
    ])

    expect(statuses.get('a')).toBe('cleared')
    expect(statuses.get('b')).toBe('undone')
  })

  it('reports the LAST thing that happened after repeated undo and redo', () => {
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const statuses = computeStrokeStatuses(strokes, [
      makeUndoAction('b', 100),
      makeRedoAction('b', 200),
      makeUndoAction('b', 300),
    ])

    expect(statuses.get('b')).toBe('undone')
  })

  it('agrees with computeVisibleStrokeIds in every case', () => {
    const strokes = makeStrokeSeries(4, ['a', 'b', 'c', 'd'])
    const actions = [
      makeUndoAction('d', 100),
      makeClearAction(['a', 'b'], 200),
      makeRedoAction('d', 300),
    ]

    const statuses = computeStrokeStatuses(strokes, actions)
    const visible = computeVisibleStrokeIds(strokes, actions)

    for (const stroke of strokes) {
      expect(statuses.get(stroke.id) === 'visible').toBe(visible.has(stroke.id))
    }
  })

  it('ignores an undo naming a stroke that is not in the file', () => {
    // Legacy v1 exports legitimately contain these.
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const statuses = computeStrokeStatuses(strokes, [makeUndoAction('ghost', 100)])

    expect(statuses.get('a')).toBe('visible')
    expect(statuses.get('b')).toBe('visible')
    expect(statuses.has('ghost')).toBe(false)
  })

  it('never mutates the strokes or the actions it is given', () => {
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const actions = [makeUndoAction('b', 100)]
    const strokesBefore = structuredClone(strokes)
    const actionsBefore = structuredClone(actions)

    computeStrokeStatuses(strokes, actions)

    expect(strokes).toEqual(strokesBefore)
    expect(actions).toEqual(actionsBefore)
  })

  it('is deterministic across repeated calls', () => {
    const strokes = makeStrokeSeries(3, ['a', 'b', 'c'])
    const actions = [makeUndoAction('c', 100), makeClearAction(['a'], 200)]

    expect([...computeStrokeStatuses(strokes, actions)]).toEqual([
      ...computeStrokeStatuses(strokes, actions),
    ])
  })

  it('handles an empty session', () => {
    expect(computeStrokeStatuses([], []).size).toBe(0)
  })
})
