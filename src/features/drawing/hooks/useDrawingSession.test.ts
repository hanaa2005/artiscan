/**
 * Behavioural tests for the recorder itself.
 *
 * These drive the real hook rather than a pure helper, so they cover the actual
 * site of the Clear regression: what the hook writes into the session when the
 * user presses the button.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDrawingSession, type RawPointerSample } from './useDrawingSession'
import { computeVisibleStrokes } from '../utils/strokeVisibility'
import { validateSession } from '../services/drawingValidator'
import type { DrawingSession } from '../types/drawing.types'

const CANVAS = { width: 800, height: 400 }

function sample(x: number, y: number): RawPointerSample {
  return {
    x,
    y,
    normalizedX: x / CANVAS.width,
    normalizedY: y / CANVAS.height,
    pressure: null,
    tiltX: null,
    tiltY: null,
    pointerType: 'mouse',
  }
}

/** Simulates a complete press-move-release gesture. */
function drawStroke(
  result: { current: ReturnType<typeof useDrawingSession> },
  offset: number,
): void {
  act(() => {
    result.current.beginStroke(sample(offset, offset))
    result.current.extendStroke([sample(offset + 10, offset + 10)])
    result.current.extendStroke([sample(offset + 20, offset + 25)])
    result.current.endStroke()
  })
}

function visibleIds(session: DrawingSession): string[] {
  return computeVisibleStrokes(session.strokes, session.actions).map((s) => s.id)
}

describe('useDrawingSession - recording', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('commits one stroke per gesture, with its points', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)

    expect(result.current.strokes).toHaveLength(1)
    expect(result.current.strokes[0]?.points).toHaveLength(3)
  })

  it('does not re-render while the stroke is still in progress', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginStroke(sample(10, 10))
      result.current.extendStroke([sample(20, 20)])
    })
    // The stroke exists in the live ref but has not reached state yet.
    expect(result.current.strokes).toHaveLength(0)
    expect(result.current.getLiveStroke()?.points).toHaveLength(2)
  })
})

/**
 * The flag is named `hasPressureSamples`, and these tests hold it to exactly
 * that claim: samples are present. It must not be set for a device that only
 * reports the spec-mandated constant, and it must not pretend to say anything
 * about whether the pressure varied.
 */
describe('useDrawingSession - pressure flag means what it says', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function penSample(pressure: number | null): RawPointerSample {
    return { ...sample(20, 20), pointerType: 'pen', pressure }
  }

  it('is false for a mouse stroke, which reports no real pressure', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    expect(result.current.strokes[0]?.hasPressureSamples).toBe(false)
  })

  it('is true as soon as one sample carries pressure', () => {
    const { result } = renderHook(() => useDrawingSession())
    act(() => {
      result.current.beginStroke(penSample(0.4))
      result.current.endStroke()
    })
    expect(result.current.strokes[0]?.hasPressureSamples).toBe(true)
  })

  it('is true for constant pressure - it claims presence, not variation', () => {
    // A stylus that reports the same force throughout still produced pressure
    // samples. Whether they varied is a question for feature extraction, and
    // the raw values are all preserved for it to answer.
    const { result } = renderHook(() => useDrawingSession())
    act(() => {
      result.current.beginStroke(penSample(0.5))
      result.current.extendStroke([penSample(0.5), penSample(0.5)])
      result.current.endStroke()
    })

    const stroke = result.current.strokes[0]
    expect(stroke?.hasPressureSamples).toBe(true)
    expect(stroke?.points.map((p) => p.pressure)).toEqual([0.5, 0.5, 0.5])
  })

  it('turns true when pressure appears part-way through a stroke', () => {
    const { result } = renderHook(() => useDrawingSession())
    act(() => {
      result.current.beginStroke(penSample(null))
      result.current.extendStroke([penSample(0.7)])
      result.current.endStroke()
    })
    expect(result.current.strokes[0]?.hasPressureSamples).toBe(true)
  })
})

describe('useDrawingSession - Clear is non-destructive', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps all four strokes in the session after a clear', () => {
    const { result } = renderHook(() => useDrawingSession())
    for (let i = 0; i < 4; i += 1) drawStroke(result, 10 + i * 30)
    expect(result.current.strokes).toHaveLength(4)

    act(() => {
      result.current.clear()
    })

    // The canonical record is untouched...
    expect(result.current.strokes).toHaveLength(4)
    // ...while the canvas is empty.
    expect(result.current.visibleStrokes).toHaveLength(0)
  })

  it('records the ids of the strokes the clear affected', () => {
    const { result } = renderHook(() => useDrawingSession())
    for (let i = 0; i < 4; i += 1) drawStroke(result, 10 + i * 30)
    const drawnIds = result.current.strokes.map((s) => s.id)

    act(() => {
      result.current.clear()
    })

    const clear = result.current.actions.find((action) => action.type === 'clear')
    expect(clear).toBeDefined()
    expect(clear?.payload?.['affectedStrokeIds']).toEqual(drawnIds)
  })

  it('exports every pre-clear stroke, with points and timing intact', () => {
    const { result } = renderHook(() => useDrawingSession())
    for (let i = 0; i < 4; i += 1) drawStroke(result, 10 + i * 30)

    act(() => {
      result.current.clear()
    })

    const session = result.current.buildSession(CANVAS)
    expect(session.strokes).toHaveLength(4)
    for (const stroke of session.strokes) {
      expect(stroke.points).toHaveLength(3)
      expect(stroke.endedAtMs).toBeGreaterThanOrEqual(stroke.startedAtMs)
      expect(stroke.tool).toBe('pen')
    }
    expect(visibleIds(session)).toEqual([])
  })

  it('shows only the new stroke when drawing continues after a clear', () => {
    const { result } = renderHook(() => useDrawingSession())
    for (let i = 0; i < 4; i += 1) drawStroke(result, 10 + i * 30)

    act(() => {
      result.current.clear()
    })
    drawStroke(result, 200)

    const session = result.current.buildSession(CANVAS)
    expect(session.strokes).toHaveLength(5)
    expect(result.current.visibleStrokes).toHaveLength(1)
    expect(visibleIds(session)).toEqual([session.strokes[4]?.id])
  })

  it('assigns canonical order across cleared and new strokes', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    act(() => {
      result.current.clear()
    })
    drawStroke(result, 100)

    const session = result.current.buildSession(CANVAS)
    expect(session.strokes.map((s) => s.order)).toEqual([0, 1])
  })

  it('does nothing when the canvas is already empty', () => {
    const { result } = renderHook(() => useDrawingSession())
    act(() => {
      result.current.clear()
    })
    expect(result.current.actions).toHaveLength(0)
  })

  it('disables undo after a clear but allows it again once drawing resumes', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    act(() => {
      result.current.clear()
    })
    expect(result.current.canUndo).toBe(false)

    drawStroke(result, 100)
    expect(result.current.canUndo).toBe(true)
  })
})

describe('useDrawingSession - undo and redo are non-destructive too', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps an undone stroke in the exported session', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    drawStroke(result, 60)

    act(() => {
      result.current.undo()
    })

    const session = result.current.buildSession(CANVAS)
    expect(session.strokes).toHaveLength(2)
    expect(result.current.visibleStrokes).toHaveLength(1)
    expect(session.actions.some((a) => a.type === 'undo')).toBe(true)
  })

  it('brings the stroke back on redo', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    drawStroke(result, 60)

    act(() => {
      result.current.undo()
    })
    act(() => {
      result.current.redo()
    })

    expect(result.current.visibleStrokes).toHaveLength(2)
    expect(result.current.canRedo).toBe(false)
  })

  it('invalidates the redo history once a new stroke is drawn', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    act(() => {
      result.current.undo()
    })
    expect(result.current.canRedo).toBe(true)

    drawStroke(result, 100)
    expect(result.current.canRedo).toBe(false)
  })

  it('logs each undo exactly once', () => {
    // Guards against side effects inside a state updater, which React
    // StrictMode would run twice and double-record.
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    act(() => {
      result.current.undo()
    })

    const undos = result.current.actions.filter((a) => a.type === 'undo')
    expect(undos).toHaveLength(1)
  })
})

describe('useDrawingSession - session lifecycle', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('startNewSession resets the record and issues a fresh id', () => {
    const { result } = renderHook(() => useDrawingSession())
    const firstId = result.current.meta.id
    drawStroke(result, 10)

    act(() => {
      result.current.startNewSession()
    })

    expect(result.current.meta.id).not.toBe(firstId)
    expect(result.current.strokes).toHaveLength(0)
    expect(result.current.actions).toHaveLength(0)
  })

  it('loadSession restores strokes and replays clear to the right canvas', () => {
    const { result } = renderHook(() => useDrawingSession())
    for (let i = 0; i < 4; i += 1) drawStroke(result, 10 + i * 30)
    act(() => {
      result.current.clear()
    })
    drawStroke(result, 200)
    const exported = result.current.buildSession(CANVAS)

    const fresh = renderHook(() => useDrawingSession())
    act(() => {
      fresh.result.current.loadSession(exported)
    })

    expect(fresh.result.current.strokes).toHaveLength(5)
    expect(fresh.result.current.visibleStrokes).toHaveLength(1)
    expect(fresh.result.current.visibleStrokes[0]?.id).toBe(exported.strokes[4]?.id)
  })

  /**
   * The redo stack is UI state the recorded history already determines. If it
   * is thrown away on restore, a stroke that was one click from returning
   * becomes unreachable - even though both the stroke and the undo that hid it
   * are sitting in the file.
   */
  it('restores the redo stack: draw A, undo A, export, restore, redo brings A back', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    const strokeId = result.current.strokes[0]?.id

    act(() => {
      result.current.undo()
    })
    expect(result.current.visibleStrokes).toHaveLength(0)

    const exported = result.current.buildSession(CANVAS)

    const fresh = renderHook(() => useDrawingSession())
    act(() => {
      fresh.result.current.loadSession(exported)
    })

    expect(fresh.result.current.canRedo).toBe(true)

    act(() => {
      fresh.result.current.redo()
    })
    expect(fresh.result.current.visibleStrokes).toHaveLength(1)
    expect(fresh.result.current.visibleStrokes[0]?.id).toBe(strokeId)
  })

  it('restores a multi-level redo stack in the right order', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    drawStroke(result, 60)
    const secondId = result.current.strokes[1]?.id

    act(() => {
      result.current.undo()
    })
    act(() => {
      result.current.undo()
    })

    const fresh = renderHook(() => useDrawingSession())
    act(() => {
      fresh.result.current.loadSession(result.current.buildSession(CANVAS))
    })

    // The stack is LIFO: the most recently undone stroke returns first.
    act(() => {
      fresh.result.current.redo()
    })
    expect(fresh.result.current.visibleStrokes).toHaveLength(1)

    act(() => {
      fresh.result.current.redo()
    })
    expect(fresh.result.current.visibleStrokes.map((s) => s.id)).toContain(secondId)
    expect(fresh.result.current.canRedo).toBe(false)
  })

  it('restores an EMPTY redo stack when a clear happened after the undo', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    drawStroke(result, 60)
    act(() => {
      result.current.undo()
    })
    act(() => {
      result.current.clear()
    })

    const fresh = renderHook(() => useDrawingSession())
    act(() => {
      fresh.result.current.loadSession(result.current.buildSession(CANVAS))
    })

    expect(fresh.result.current.canRedo).toBe(false)
    expect(fresh.result.current.visibleStrokes).toHaveLength(0)
  })

  it('restores an EMPTY redo stack when a new stroke was drawn after the undo', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    act(() => {
      result.current.undo()
    })
    drawStroke(result, 100)

    const fresh = renderHook(() => useDrawingSession())
    act(() => {
      fresh.result.current.loadSession(result.current.buildSession(CANVAS))
    })

    expect(fresh.result.current.canRedo).toBe(false)
    expect(fresh.result.current.visibleStrokes).toHaveLength(1)
  })

  it('round-trips draw A, draw B, undo B, undo A, restore, redo A, redo B', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    drawStroke(result, 60)
    const idA = result.current.strokes[0]?.id
    const idB = result.current.strokes[1]?.id

    act(() => {
      result.current.undo()
    })
    act(() => {
      result.current.undo()
    })
    expect(result.current.visibleStrokes).toHaveLength(0)

    const exported = result.current.buildSession(CANVAS)
    // The recorded history must itself be a session that could have happened.
    expect(validateSession(exported).ok).toBe(true)

    const fresh = renderHook(() => useDrawingSession())
    act(() => {
      fresh.result.current.loadSession(exported)
    })
    expect(fresh.result.current.canRedo).toBe(true)

    // The stack is [B, A], so A comes back first.
    act(() => {
      fresh.result.current.redo()
    })
    expect(fresh.result.current.visibleStrokes.map((s) => s.id)).toEqual([idA])

    act(() => {
      fresh.result.current.redo()
    })
    expect(fresh.result.current.visibleStrokes.map((s) => s.id)).toEqual([idA, idB])
    expect(fresh.result.current.canRedo).toBe(false)

    // And the re-export is still a valid history after the redos.
    expect(validateSession(fresh.result.current.buildSession(CANVAS)).ok).toBe(true)
  })

  it('produces histories that always satisfy the timeline validator', () => {
    // The app re-imports its own exports, so anything the recorder can produce
    // must pass every rule the validator enforces.
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    drawStroke(result, 60)
    act(() => {
      result.current.undo()
    })
    drawStroke(result, 110)
    act(() => {
      result.current.setTool('eraser')
    })
    drawStroke(result, 160)
    act(() => {
      result.current.clear()
    })
    drawStroke(result, 210)
    act(() => {
      result.current.undo()
    })

    const result2 = validateSession(result.current.buildSession(CANVAS))
    if (!result2.ok) {
      throw new Error(`recorder produced an invalid session: ${result2.error}`)
    }
    expect(result2.ok).toBe(true)
  })

  it('keeps sequence numbers unique across an import boundary', () => {
    // New events must never collide with imported ones, or the merged timeline
    // becomes ambiguous and the validator would reject the re-export.
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    drawStroke(result, 60)
    const exported = result.current.buildSession(CANVAS)

    const fresh = renderHook(() => useDrawingSession())
    act(() => {
      fresh.result.current.loadSession(exported)
    })
    drawStroke(fresh.result, 120)
    act(() => {
      fresh.result.current.undo()
    })

    const reexported = fresh.result.current.buildSession(CANVAS)
    const sequences: number[] = []
    for (const stroke of reexported.strokes) {
      for (const point of stroke.points) sequences.push(point.sequence)
    }
    for (const action of reexported.actions) sequences.push(action.sequence)

    expect(new Set(sequences).size).toBe(sequences.length)
  })

  it('keeps timestamps non-decreasing across an import boundary', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    const exported = result.current.buildSession(CANVAS)

    const fresh = renderHook(() => useDrawingSession())
    act(() => {
      fresh.result.current.loadSession(exported)
    })
    drawStroke(fresh.result, 100)

    const reexported = fresh.result.current.buildSession(CANVAS)
    const timeline = reexported.strokes.flatMap((stroke) => stroke.points)
    for (let i = 1; i < timeline.length; i += 1) {
      expect(timeline[i]?.timeMs).toBeGreaterThanOrEqual(timeline[i - 1]?.timeMs ?? 0)
    }
  })

  it('continues timing after an imported session instead of restarting at zero', () => {
    const { result } = renderHook(() => useDrawingSession())
    drawStroke(result, 10)
    const exported = result.current.buildSession(CANVAS)
    const lastTime = exported.strokes[0]?.endedAtMs ?? 0

    const fresh = renderHook(() => useDrawingSession())
    act(() => {
      fresh.result.current.loadSession(exported)
    })
    drawStroke(fresh.result, 100)

    const newStroke = fresh.result.current.strokes[1]
    expect(newStroke?.startedAtMs).toBeGreaterThanOrEqual(lastTime)
  })
})
