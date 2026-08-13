import { describe, expect, it } from 'vitest'
import { computeDurationMs, computeStats, countPoints } from './drawingStats'
import { makeAction, makeSession, makeStroke } from '../testing/sessionFixture'

describe('countPoints', () => {
  it('sums the points of every stroke', () => {
    const strokes = [
      makeStroke({ id: 'a' }),
      makeStroke({ id: 'b', points: [] }),
      makeStroke({ id: 'c' }),
    ]
    // 3 + 0 + 3
    expect(countPoints(strokes)).toBe(6)
  })

  it('returns zero for an empty drawing', () => {
    expect(countPoints([])).toBe(0)
  })
})

describe('computeDurationMs', () => {
  it('uses the largest recorded timestamp across strokes and actions', () => {
    const session = makeSession({
      strokes: [makeStroke({ endedAtMs: 1200 })],
      actions: [makeAction({ timeMs: 3400 })],
    })
    expect(computeDurationMs(session)).toBe(3400)
  })

  it('derives the duration from the data, not from wall-clock time', () => {
    // An imported session must report the duration it HAD when it was recorded,
    // regardless of how long ago the app was opened.
    const session = makeSession({
      strokes: [makeStroke({ startedAtMs: 5000, endedAtMs: 9000 })],
      actions: [],
    })
    expect(computeDurationMs(session)).toBe(9000)
  })

  it('returns zero for an empty session', () => {
    expect(computeDurationMs(makeSession({ strokes: [], actions: [] }))).toBe(0)
  })
})

describe('computeStats', () => {
  it('counts strokes, points and tools separately', () => {
    const session = makeSession({
      strokes: [
        makeStroke({ id: 'a', tool: 'pen' }),
        makeStroke({ id: 'b', tool: 'eraser' }),
        makeStroke({ id: 'c', tool: 'pen' }),
      ],
      actions: [],
    })
    const stats = computeStats(session)

    expect(stats.strokeCount).toBe(3)
    expect(stats.pointCount).toBe(9)
    expect(stats.penStrokeCount).toBe(2)
    expect(stats.eraserStrokeCount).toBe(1)
  })

  it('counts undo, redo and clear events from the action log', () => {
    const session = makeSession({
      actions: [
        makeAction({ sequence: 1, type: 'undo' }),
        makeAction({ sequence: 2, type: 'undo' }),
        makeAction({ sequence: 3, type: 'redo' }),
        makeAction({ sequence: 4, type: 'clear' }),
        makeAction({ sequence: 5, type: 'color_change' }),
      ],
    })
    const stats = computeStats(session)

    expect(stats.undoCount).toBe(2)
    expect(stats.redoCount).toBe(1)
    expect(stats.clearCount).toBe(1)
  })

  it('reports whether any stroke carried pressure samples', () => {
    const withoutPressure = computeStats(makeSession())
    expect(withoutPressure.hasPressureSamples).toBe(false)

    const withPressure = computeStats(
      makeSession({ strokes: [makeStroke({ hasPressureSamples: true })] }),
    )
    expect(withPressure.hasPressureSamples).toBe(true)
  })
})
