/**
 * WEEK 1A - Width drag integrity.
 *
 * A real recording contained fifteen `width_change` actions for one slider
 * drag: 29 -> 14 -> 13 -> 12 -> 11 -> 10 -> 9 -> 12 -> 9 -> 11 -> 8 -> 10 ->
 * 7 -> 9 -> 8. That is ONE decision (29 -> 8) buried under fourteen records of
 * a hand moving on a slider, and it makes the action log useless for telling
 * what the participant chose from how they reached for it.
 *
 * These tests pin the corrected contract: preview paints, commit records, and
 * one interaction produces at most one action.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDrawingSession, type RawPointerSample } from './useDrawingSession'
import { validateSession } from '../services/drawingValidator'

const CANVAS = { width: 800, height: 400 }

/** The width the recorder starts from with no stored preferences. */
const DEFAULT_WIDTH = 4

type Recorder = { current: ReturnType<typeof useDrawingSession> }

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
function drawStroke(result: Recorder, offset: number): void {
  act(() => {
    result.current.beginStroke(sample(offset, offset))
    result.current.extendStroke([sample(offset + 10, offset + 10)])
    result.current.endStroke()
  })
}

/** The width actions recorded so far, in order. */
function widthActions(result: Recorder) {
  return result.current.actions.filter((action) => action.type === 'width_change')
}

function storedWidth(): number | undefined {
  const raw = localStorage.getItem('artiscan:preferences')
  if (raw === null) return undefined
  return (JSON.parse(raw) as { width?: number }).width
}

describe('useDrawingSession - width preview versus committed action', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('records exactly one action for a single direct change', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.setWidth(12)
    })

    const actions = widthActions(result)
    expect(actions).toHaveLength(1)
    expect(actions[0]?.payload).toEqual({ from: DEFAULT_WIDTH, to: 12 })
    expect(result.current.width).toBe(12)
  })

  it('collapses a whole drag - overshoot included - into ONE action', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.setWidth(29)
    })
    act(() => {
      result.current.beginWidthInteraction()
      // The exact value sequence observed in the reported session.
      for (const value of [14, 13, 12, 11, 10, 9, 12, 9, 11, 8, 10, 7, 9, 8]) {
        result.current.previewWidth(value)
      }
      result.current.commitWidthInteraction()
    })

    const actions = widthActions(result)
    // One for the direct 4 -> 29, one for the entire drag.
    expect(actions).toHaveLength(2)
    expect(actions[1]?.payload).toEqual({ from: 29, to: 8 })
    expect(result.current.width).toBe(8)
  })

  it('reads `from` from the authoritative ref, not a render-behind state', () => {
    const { result } = renderHook(() => useDrawingSession())

    // Every call lands in ONE React batch, so the mirrored state never updates
    // between them. A `from` read from state would report the initial width
    // for both actions.
    act(() => {
      result.current.beginWidthInteraction()
      result.current.previewWidth(20)
      result.current.commitWidthInteraction()
      result.current.beginWidthInteraction()
      result.current.previewWidth(30)
      result.current.commitWidthInteraction()
    })

    const actions = widthActions(result)
    expect(actions).toHaveLength(2)
    expect(actions[0]?.payload).toEqual({ from: DEFAULT_WIDTH, to: 20 })
    expect(actions[1]?.payload).toEqual({ from: 20, to: 30 })
  })

  it('is idempotent: pointerup then blur for one drag records one action', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginWidthInteraction()
      result.current.previewWidth(15)
      result.current.commitWidthInteraction() // pointerup
      result.current.commitWidthInteraction() // blur
      result.current.commitWidthInteraction() // a stray late change
    })

    expect(widthActions(result)).toHaveLength(1)
  })

  it('records nothing when the drag ends on the width it started with', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginWidthInteraction()
      result.current.previewWidth(25)
      result.current.previewWidth(11)
      result.current.previewWidth(DEFAULT_WIDTH)
      result.current.commitWidthInteraction()
    })

    expect(widthActions(result)).toHaveLength(0)
    expect(result.current.width).toBe(DEFAULT_WIDTH)
  })

  it('does not move `from` when begin fires twice inside one interaction', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      // pointerdown and focus both fire begin for one interaction.
      result.current.beginWidthInteraction()
      result.current.beginWidthInteraction()
      result.current.previewWidth(9)
      result.current.beginWidthInteraction()
      result.current.previewWidth(16)
      result.current.commitWidthInteraction()
    })

    const actions = widthActions(result)
    expect(actions).toHaveLength(1)
    expect(actions[0]?.payload).toEqual({ from: DEFAULT_WIDTH, to: 16 })
  })

  it('commits an open interaction when a stroke starts, before the first point', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginWidthInteraction()
      result.current.previewWidth(18)
    })
    // No commit: the user goes straight from the slider to the canvas.
    drawStroke(result, 10)

    const actions = widthActions(result)
    expect(actions).toHaveLength(1)
    expect(actions[0]?.payload).toEqual({ from: DEFAULT_WIDTH, to: 18 })

    const stroke = result.current.strokes[0]
    // The stroke is painted at the new width, and the action explaining it sits
    // at a LOWER sequence than the stroke's first point - so the log can never
    // contradict the ink.
    expect(stroke?.width).toBe(18)
    expect(actions[0]?.sequence).toBeLessThan(stroke?.points[0]?.sequence ?? 0)
  })

  it('keeps consecutive interactions independent', () => {
    const { result } = renderHook(() => useDrawingSession())

    for (const value of [10, 22, 7]) {
      act(() => {
        result.current.beginWidthInteraction()
        result.current.previewWidth(value)
        result.current.commitWidthInteraction()
      })
      expect(result.current.width).toBe(value)
    }

    expect(widthActions(result).map((action) => action.payload)).toEqual([
      { from: DEFAULT_WIDTH, to: 10 },
      { from: 10, to: 22 },
      { from: 22, to: 7 },
    ])
  })

  it('settles an open interaction before a direct scripted change', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginWidthInteraction()
      result.current.previewWidth(13)
      // A direct call arrives while the slider interaction is still open.
      result.current.setWidth(31)
    })

    const actions = widthActions(result)
    expect(actions).toHaveLength(2)
    expect(actions[0]?.payload).toEqual({ from: DEFAULT_WIDTH, to: 13 })
    expect(actions[1]?.payload).toEqual({ from: 13, to: 31 })
  })

  it('saves only the committed width to preferences, never a previewed one', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginWidthInteraction()
      result.current.previewWidth(33)
      result.current.previewWidth(21)
    })
    // Mid-drag: nothing persisted, so a reload cannot reopen on a width the
    // pointer merely crossed.
    expect(storedWidth()).toBeUndefined()

    act(() => {
      result.current.commitWidthInteraction()
    })
    expect(storedWidth()).toBe(21)
  })

  it('restores the committed width on a fresh mount', () => {
    const first = renderHook(() => useDrawingSession())
    act(() => {
      first.result.current.beginWidthInteraction()
      first.result.current.previewWidth(17)
      first.result.current.commitWidthInteraction()
    })
    first.unmount()

    const second = renderHook(() => useDrawingSession())
    expect(second.result.current.width).toBe(17)
  })

  it('drops an interaction left open when a new session starts', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginWidthInteraction()
      result.current.previewWidth(28)
    })
    act(() => {
      result.current.startNewSession()
    })
    act(() => {
      result.current.commitWidthInteraction()
    })

    expect(widthActions(result)).toHaveLength(0)
  })

  it('does not disturb colour handling', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginColorInteraction()
      result.current.previewColor('#ff0000')
      result.current.beginWidthInteraction()
      result.current.previewWidth(19)
      result.current.commitWidthInteraction()
      result.current.commitColorInteraction()
    })

    expect(result.current.actions.filter((a) => a.type === 'color_change')).toHaveLength(1)
    expect(result.current.actions.filter((a) => a.type === 'width_change')).toHaveLength(1)
    expect(result.current.color).toBe('#ff0000')
    expect(result.current.width).toBe(19)
  })

  it('leaves the session on one strictly increasing, valid sequence', () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      result.current.beginWidthInteraction()
      result.current.previewWidth(12)
      result.current.commitWidthInteraction()
    })
    drawStroke(result, 10)
    act(() => {
      result.current.setTool('eraser')
    })
    drawStroke(result, 50)

    const session = result.current.buildSession(CANVAS)
    const sequences = [
      ...session.actions.map((action) => action.sequence),
      ...session.strokes.flatMap((stroke) => stroke.points.map((point) => point.sequence)),
    ]

    expect(new Set(sequences).size).toBe(sequences.length)
    expect(validateSession(session).ok).toBe(true)
  })
})
