/**
 * WEEK 1B - the deterministic replay engine.
 *
 * The contract under test: for any session and any time, exactly one canvas
 * state, reachable by seeking directly rather than only by playing there.
 *
 * The fixture timeline is regular and worth keeping in mind - stroke `i` has
 * three points at sequences 4i+1..4i+3, i.e. times 40i+10, 40i+20, 40i+30, with
 * sequence 4i+4 (time 40i+40) left free for an action:
 *
 *   stroke 0  points at t = 10, 20, 30      action slot t = 40
 *   stroke 1  points at t = 50, 60, 70      action slot t = 80
 *   stroke 2  points at t = 90, 100, 110    action slot t = 120
 */

import { describe, expect, it } from 'vitest'
import {
  getReplayDurationMs,
  getReplayStateAt,
  validateReplaySession,
  type ReplayState,
} from './replayEngine'
import { computeVisibleStrokes } from '../../drawing/utils/strokeVisibility'
import {
  makeClearAction,
  makePoint,
  makeRedoAction,
  makeSession,
  makeStroke,
  makeStrokeSeries,
  makeUndoAction,
} from '../../drawing/testing/sessionFixture'
import type { DrawingSession } from '../../drawing/types/drawing.types'

/** Ids of the strokes painted at `t`, in paint order. */
function visibleIdsAt(session: DrawingSession, t: number): string[] {
  return getReplayStateAt(session, t).strokes.map((stroke) => stroke.id)
}

/** Point counts of the strokes painted at `t`. */
function pointCountsAt(session: DrawingSession, t: number): number[] {
  return getReplayStateAt(session, t).strokes.map((stroke) => stroke.points.length)
}

/** A session of `count` strokes and no actions. */
function plainSession(count: number, ids?: readonly string[]): DrawingSession {
  return makeSession({ strokes: makeStrokeSeries(count, ids), actions: [] })
}

describe('getReplayDurationMs', () => {
  it('is zero for an empty session', () => {
    expect(getReplayDurationMs(makeSession({ strokes: [], actions: [] }))).toBe(0)
  })

  it('is the last point time of the last stroke', () => {
    expect(getReplayDurationMs(plainSession(3))).toBe(110)
  })

  it('extends to a trailing action that happened after the last stroke', () => {
    // A session ending in a clear lasts until the clear, not until the ink.
    const session = makeSession({
      strokes: makeStrokeSeries(2, ['a', 'b']),
      actions: [makeClearAction(['a', 'b'], 8)],
    })
    expect(getReplayDurationMs(session)).toBe(80)
  })

  it('respects a pointer released after the final sample', () => {
    const stroke = makeStroke({
      id: 'a',
      order: 0,
      startedAtMs: 10,
      endedAtMs: 500,
      points: [makePoint({ sequence: 1, timeMs: 10 })],
    })
    expect(getReplayDurationMs(makeSession({ strokes: [stroke], actions: [] }))).toBe(500)
  })
})

describe('boundaries of the timeline', () => {
  it('an empty session has an empty state at every time', () => {
    const session = makeSession({ strokes: [], actions: [] })

    for (const t of [-100, 0, 50, 10_000]) {
      const state = getReplayStateAt(session, t)
      expect(state.strokes).toEqual([])
      expect(state.durationMs).toBe(0)
      expect(state.activeStrokeId).toBeNull()
    }
  })

  it('shows nothing before the first point', () => {
    const session = plainSession(2)
    // The first point lands at t = 10.
    expect(visibleIdsAt(session, 0)).toEqual([])
    expect(visibleIdsAt(session, 9.9)).toEqual([])
    expect(visibleIdsAt(session, 10)).toEqual(['stroke-0'])
  })

  it('clamps a negative time to the opening state', () => {
    const session = plainSession(2)
    const state = getReplayStateAt(session, -5000)

    expect(state.timeMs).toBe(0)
    expect(state.strokes).toEqual([])
    expect(state.isAtEnd).toBe(false)
  })

  it('clamps a time past the end to the final state', () => {
    const session = plainSession(3)
    const state = getReplayStateAt(session, 999_999)

    expect(state.timeMs).toBe(110)
    expect(state.isAtEnd).toBe(true)
    expect(state.strokes).toHaveLength(3)
  })

  it('treats a non-finite time as the start rather than throwing', () => {
    const session = plainSession(2)
    expect(getReplayStateAt(session, Number.NaN).timeMs).toBe(0)
  })
})

describe('stroke reveal and partial strokes', () => {
  it('reveals only the points recorded so far', () => {
    const session = plainSession(1)

    // Points at 10, 20, 30. Between the second and third only two are drawn.
    expect(pointCountsAt(session, 10)).toEqual([1])
    expect(pointCountsAt(session, 15)).toEqual([1])
    expect(pointCountsAt(session, 20)).toEqual([2])
    expect(pointCountsAt(session, 25)).toEqual([2])
    expect(pointCountsAt(session, 30)).toEqual([3])
  })

  it('never reveals a point from the future', () => {
    const session = plainSession(1)
    const state = getReplayStateAt(session, 25)

    for (const point of state.strokes[0]?.points ?? []) {
      expect(point.timeMs).toBeLessThanOrEqual(25)
    }
  })

  it('marks a half-drawn stroke as active and incomplete', () => {
    const session = plainSession(1)
    const midway = getReplayStateAt(session, 20)

    expect(midway.activeStrokeId).toBe('stroke-0')
    expect(midway.strokes[0]?.isComplete).toBe(false)

    const finished = getReplayStateAt(session, 30)
    expect(finished.activeStrokeId).toBeNull()
    expect(finished.strokes[0]?.isComplete).toBe(true)
  })

  it('keeps a single-point stroke rather than discarding it', () => {
    // A tap is a real observation: the participant touched the surface.
    const stroke = makeStroke({
      id: 'tap',
      order: 0,
      startedAtMs: 10,
      endedAtMs: 10,
      points: [makePoint({ sequence: 1, timeMs: 10 })],
    })
    const session = makeSession({ strokes: [stroke], actions: [] })

    const state = getReplayStateAt(session, 10)
    expect(state.strokes).toHaveLength(1)
    expect(state.strokes[0]?.points).toHaveLength(1)
    expect(state.strokes[0]?.isComplete).toBe(true)
  })

  it('holds the canvas still through a pause between strokes', () => {
    const session = plainSession(2)

    // Stroke 0 ends at 30, stroke 1 starts at 50. Nothing changes between.
    for (const t of [30, 35, 40, 45, 49.9]) {
      expect(visibleIdsAt(session, t)).toEqual(['stroke-0'])
      expect(pointCountsAt(session, t)).toEqual([3])
    }
    expect(visibleIdsAt(session, 50)).toEqual(['stroke-0', 'stroke-1'])
  })

  it('accumulates several strokes in canonical order', () => {
    const session = plainSession(3)

    expect(visibleIdsAt(session, 30)).toEqual(['stroke-0'])
    expect(visibleIdsAt(session, 70)).toEqual(['stroke-0', 'stroke-1'])
    expect(visibleIdsAt(session, 110)).toEqual(['stroke-0', 'stroke-1', 'stroke-2'])
  })

  it('carries each stroke its own tool, colour and width', () => {
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const first = strokes[0]
    const second = strokes[1]
    if (first === undefined || second === undefined) throw new Error('fixture')
    strokes[0] = { ...first, tool: 'pen', color: '#ff0000', width: 3 }
    strokes[1] = { ...second, tool: 'eraser', color: '#00ff00', width: 20 }

    const state = getReplayStateAt(makeSession({ strokes, actions: [] }), 999)

    expect(state.strokes[0]).toMatchObject({ tool: 'pen', color: '#ff0000', width: 3 })
    expect(state.strokes[1]).toMatchObject({ tool: 'eraser', color: '#00ff00', width: 20 })
  })
})

describe('undo, redo and clear at the right instant', () => {
  it('draw A, draw B, undo B, redo B', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(2, ['A', 'B']),
      // Stroke B ends at 70; the free action slots are t = 80 and t = 120.
      actions: [makeUndoAction('B', 8), makeRedoAction('B', 12)],
    })

    expect(visibleIdsAt(session, 70)).toEqual(['A', 'B'])
    expect(visibleIdsAt(session, 80)).toEqual(['A'])
    expect(visibleIdsAt(session, 119)).toEqual(['A'])
    expect(visibleIdsAt(session, 120)).toEqual(['A', 'B'])
  })

  it('honours the LIFO stack: undo B, undo A, redo A, redo B', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(2, ['A', 'B']),
      actions: [
        makeUndoAction('B', 8),
        makeUndoAction('A', 12),
        makeRedoAction('A', 16),
        makeRedoAction('B', 20),
      ],
    })

    expect(visibleIdsAt(session, 70)).toEqual(['A', 'B'])
    expect(visibleIdsAt(session, 80)).toEqual(['A'])
    expect(visibleIdsAt(session, 120)).toEqual([])
    expect(visibleIdsAt(session, 160)).toEqual(['A'])
    expect(visibleIdsAt(session, 200)).toEqual(['A', 'B'])
  })

  it('clear hides exactly the strokes it names, and a later stroke is untouched', () => {
    const strokes = makeStrokeSeries(3, ['A', 'B', 'C'])
    const session = makeSession({
      strokes,
      // Clear at t = 80, after A and B but before C starts at t = 90.
      actions: [makeClearAction(['A', 'B'], 8)],
    })

    expect(visibleIdsAt(session, 70)).toEqual(['A', 'B'])
    expect(visibleIdsAt(session, 80)).toEqual([])
    // C is drawn afterwards and cannot be in the clear's id list.
    expect(visibleIdsAt(session, 90)).toEqual(['C'])
    expect(visibleIdsAt(session, 110)).toEqual(['C'])
  })

  it('a selective clear leaves the strokes it does not name', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(2, ['A', 'B']),
      actions: [makeClearAction(['A'], 8)],
    })

    expect(visibleIdsAt(session, 70)).toEqual(['A', 'B'])
    expect(visibleIdsAt(session, 80)).toEqual(['B'])
  })

  it('drawing after an undo invalidates the redo, as the capture contract says', () => {
    const strokes = makeStrokeSeries(3, ['A', 'B', 'C'])
    const session = makeSession({
      strokes,
      // undo B at t = 80, then C is drawn from t = 90, then a redo of B at 160.
      actions: [makeUndoAction('B', 8), makeRedoAction('B', 16)],
    })

    expect(visibleIdsAt(session, 80)).toEqual(['A'])
    expect(visibleIdsAt(session, 90)).toEqual(['A', 'C'])
    // C cleared the redo stack, so the later redo of B restores nothing new
    // beyond what replayHistory itself decides - and replay must agree with it.
    expect(visibleIdsAt(session, 160)).toEqual(
      computeVisibleStrokes(session.strokes, session.actions).map((s) => s.id),
    )
  })

  it('an undo referencing an unknown stroke is ignored, not fatal', () => {
    // Legacy v1 exports legitimately contain these.
    const session = makeSession({
      strokes: makeStrokeSeries(1, ['A']),
      actions: [makeUndoAction('ghost', 4)],
    })
    expect(visibleIdsAt(session, 999)).toEqual(['A'])
  })
})

describe('equal timestamps are resolved by sequence', () => {
  it('applies an undo that shares its timestamp with the point before it', () => {
    /*
      Both the last point of B and the undo of B sit at t = 70. Sequence, not
      time, decides: the point (sequence 7) happens, then the undo (sequence 8).
      Reading the two in the other order would leave B visible.
    */
    const strokes = makeStrokeSeries(2, ['A', 'B'])
    const session = makeSession({
      strokes,
      actions: [{ sequence: 8, timeMs: 70, type: 'undo', payload: { strokeId: 'B' } }],
    })

    expect(visibleIdsAt(session, 69.9)).toEqual(['A', 'B'])
    expect(visibleIdsAt(session, 70)).toEqual(['A'])
  })

  it('applies a clear that shares its timestamp with the stroke that follows', () => {
    // Clear at t = 90 and stroke C's first point at t = 90. C has the higher
    // sequence, so it is drawn AFTER the clear and stays visible.
    const strokes = makeStrokeSeries(3, ['A', 'B', 'C'])
    const session = makeSession({
      strokes,
      actions: [{ sequence: 8, timeMs: 90, type: 'clear', payload: { affectedStrokeIds: ['A', 'B'] } }],
    })

    expect(visibleIdsAt(session, 90)).toEqual(['C'])
  })
})

describe('purity and determinism', () => {
  it('returns equal results for repeated identical calls', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(3, ['A', 'B', 'C']),
      actions: [makeUndoAction('B', 12)],
    })

    for (const t of [0, 25, 55, 95, 120, 5000]) {
      expect(getReplayStateAt(session, t)).toEqual(getReplayStateAt(session, t))
    }
  })

  it('reaches the same state by seeking as by stepping', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(3, ['A', 'B', 'C']),
      actions: [makeUndoAction('B', 12), makeRedoAction('B', 16)],
    })

    // Walking the whole timeline in small steps, then jumping straight to each
    // instant, must agree everywhere.
    const stepped: ReplayState[] = []
    for (let t = 0; t <= 200; t += 5) {
      stepped.push(getReplayStateAt(session, t))
    }
    stepped.forEach((state, index) => {
      expect(getReplayStateAt(session, index * 5)).toEqual(state)
    })
  })

  it('does not mutate the session, even under deep freeze', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(2, ['A', 'B']),
      actions: [makeUndoAction('B', 8)],
    })
    const before = JSON.parse(JSON.stringify(session)) as DrawingSession

    // Freezing turns any accidental write into a thrown TypeError in strict
    // mode, so this catches mutation the equality check could miss.
    const freeze = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      Object.freeze(value)
      for (const inner of Object.values(value)) freeze(inner)
    }
    freeze(session)

    for (const t of [-1, 0, 15, 55, 80, 9999]) {
      getReplayStateAt(session, t)
    }

    expect(session).toEqual(before)
  })

  it('never hands back a points array that aliases into a partial view', () => {
    const session = plainSession(1)
    const partial = getReplayStateAt(session, 20)

    // A partial view is a fresh slice, so it cannot be the session's array.
    expect(partial.strokes[0]?.points).not.toBe(session.strokes[0]?.points)
    expect(partial.strokes[0]?.points).toHaveLength(2)
    // The session itself still has all three.
    expect(session.strokes[0]?.points).toHaveLength(3)
  })
})

describe('final-state equivalence with the live editor', () => {
  const cases: Array<[string, DrawingSession]> = [
    ['plain strokes', plainSession(3)],
    [
      'with an undo',
      makeSession({
        strokes: makeStrokeSeries(3, ['A', 'B', 'C']),
        actions: [makeUndoAction('C', 12)],
      }),
    ],
    [
      'with undo then redo',
      makeSession({
        strokes: makeStrokeSeries(2, ['A', 'B']),
        actions: [makeUndoAction('B', 8), makeRedoAction('B', 12)],
      }),
    ],
    [
      'with a clear',
      makeSession({
        strokes: makeStrokeSeries(3, ['A', 'B', 'C']),
        actions: [makeClearAction(['A', 'B'], 8)],
      }),
    ],
    [
      'with a clear then more drawing',
      makeSession({
        strokes: makeStrokeSeries(3, ['A', 'B', 'C']),
        actions: [makeClearAction(['A'], 4)],
      }),
    ],
  ]

  it.each(cases)('the end of replay equals computeVisibleStrokes: %s', (_label, session) => {
    /*
      This is the anchor of the whole design. The engine hands the events that
      have happened to replayHistory(), the same function the editor uses, so at
      the end of the timeline the two cannot disagree.
    */
    const expected = computeVisibleStrokes(session.strokes, session.actions)
    const final = getReplayStateAt(session, getReplayDurationMs(session))

    expect(final.strokes.map((stroke) => stroke.id)).toEqual(
      expected.map((stroke) => stroke.id),
    )
    expect(final.strokes.every((stroke) => stroke.isComplete)).toBe(true)
    // Every point of every visible stroke is present at the end.
    expect(final.strokes.map((stroke) => stroke.points.length)).toEqual(
      expected.map((stroke) => stroke.points.length),
    )
  })

  it('seeking beyond the end gives the same state as the end', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(2, ['A', 'B']),
      actions: [makeUndoAction('B', 8)],
    })

    expect(getReplayStateAt(session, 1_000_000)).toEqual(
      getReplayStateAt(session, getReplayDurationMs(session)),
    )
  })
})

describe('derived settings', () => {
  it('reports the value before the first change, then follows the log', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(1, ['A']),
      actions: [
        { sequence: 4, timeMs: 40, type: 'width_change', payload: { from: 4, to: 12 } },
        { sequence: 5, timeMs: 50, type: 'width_change', payload: { from: 12, to: 20 } },
      ],
    })

    expect(getReplayStateAt(session, 0).settings.width).toBe(4)
    expect(getReplayStateAt(session, 40).settings.width).toBe(12)
    expect(getReplayStateAt(session, 50).settings.width).toBe(20)
  })

  it('is null when the session records no change of that kind', () => {
    // Nothing to derive from, and the engine says so instead of inventing a
    // default that would look like a recorded value.
    expect(getReplayStateAt(plainSession(1), 30).settings).toEqual({
      tool: null,
      color: null,
      width: null,
    })
  })

  it('follows tool and colour changes too', () => {
    const session = makeSession({
      strokes: makeStrokeSeries(1, ['A']),
      actions: [
        { sequence: 4, timeMs: 40, type: 'tool_change', payload: { from: 'pen', to: 'eraser' } },
        {
          sequence: 5,
          timeMs: 50,
          type: 'color_change',
          payload: { from: '#000000', to: '#ff0000' },
        },
      ],
    })

    expect(getReplayStateAt(session, 0).settings.tool).toBe('pen')
    expect(getReplayStateAt(session, 45).settings).toMatchObject({
      tool: 'eraser',
      color: '#000000',
    })
    expect(getReplayStateAt(session, 50).settings).toMatchObject({
      tool: 'eraser',
      color: '#ff0000',
    })
  })
})

describe('raw data is replayed, not sanitised', () => {
  it('keeps a point recorded outside the canvas', () => {
    // Pointer capture records beyond the edge. Replay presents it; deciding
    // what to paint is the renderer's business, not the engine's.
    const stroke = makeStroke({
      id: 'out',
      order: 0,
      startedAtMs: 10,
      endedAtMs: 20,
      points: [
        makePoint({ sequence: 1, timeMs: 10, x: 400, y: 200, normalizedX: 0.5 }),
        makePoint({ sequence: 2, timeMs: 20, x: 980.4, y: -12, normalizedX: 1, normalizedY: 0 }),
      ],
    })
    const session = makeSession({ strokes: [stroke], actions: [] })

    const state = getReplayStateAt(session, 20)
    expect(state.strokes[0]?.points[1]).toMatchObject({ x: 980.4, y: -12 })
  })
})

describe('validateReplaySession', () => {
  it('accepts a valid schema-2 session', () => {
    expect(validateReplaySession(makeSession({ strokes: makeStrokeSeries(2) })).ok).toBe(true)
  })

  it('accepts a legacy v1 file and marks it, rather than replaying it silently', () => {
    const v1 = {
      schemaVersion: 1,
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z',
      canvas: { width: 800, height: 600, devicePixelRatio: 1 },
      strokes: [
        {
          id: 'legacy-a',
          order: 0,
          tool: 'pen',
          color: '#000000',
          width: 4,
          startedAtMs: 10,
          endedAtMs: 20,
          hasRealPressure: false,
          points: [
            {
              sequence: 1,
              timeMs: 10,
              x: 10,
              y: 10,
              normalizedX: 0.1,
              normalizedY: 0.1,
              pressure: null,
              tiltX: null,
              tiltY: null,
              pointerType: 'mouse',
            },
          ],
        },
      ],
      actions: [],
    }

    const parsed = validateReplaySession(v1)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    // Upgraded, marked, and replayable - with no strokes invented.
    expect(parsed.value.schemaVersion).toBe(2)
    expect(parsed.value.provenance?.importedFromSchemaVersion).toBe(1)
    expect(getReplayStateAt(parsed.value, 999).strokes.map((s) => s.id)).toEqual(['legacy-a'])
  })

  it('rejects a session whose time runs backwards against its sequence', () => {
    const session = makeSession({
      strokes: [
        makeStroke({
          id: 'bad',
          order: 0,
          startedAtMs: 10,
          endedAtMs: 20,
          points: [
            makePoint({ sequence: 1, timeMs: 50 }),
            makePoint({ sequence: 2, timeMs: 10 }),
          ],
        }),
      ],
      actions: [],
    })

    expect(validateReplaySession(session).ok).toBe(false)
  })

  it('rejects duplicate sequence numbers', () => {
    const session = makeSession({
      strokes: [
        makeStroke({
          id: 'dup',
          order: 0,
          startedAtMs: 10,
          endedAtMs: 20,
          points: [
            makePoint({ sequence: 1, timeMs: 10 }),
            makePoint({ sequence: 1, timeMs: 20 }),
          ],
        }),
      ],
      actions: [],
    })

    expect(validateReplaySession(session).ok).toBe(false)
  })
})
