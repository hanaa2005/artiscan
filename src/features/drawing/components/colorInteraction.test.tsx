/**
 * WEEK 1A - colour interaction REGRESSION cover.
 *
 * The colour architecture was already correct: a real exported session shows
 * three picker interactions producing exactly three `color_change` actions. It
 * is deliberately NOT rewritten here.
 *
 * What this file adds is the safety net the width work needed. Colour and width
 * now share the same begin/preview/commit shape, the same `persistPreferences`
 * helper and the same "commit before a stroke starts" hook, so a mistake in the
 * width path could silently damage colour. These tests drive the real toolbar
 * against the real recorder so that damage cannot pass unnoticed.
 */

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { DrawingToolbar } from './DrawingToolbar'
import { useDrawingSession, type RawPointerSample } from '../hooks/useDrawingSession'

const CANVAS = { width: 800, height: 400 }
const DEFAULT_COLOR = '#1f2933'

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

function colorInput(): HTMLInputElement {
  return screen.getByLabelText('رنگ') as HTMLInputElement
}

function widthSlider(): HTMLInputElement {
  return screen.getByLabelText(/ضخامت/) as HTMLInputElement
}

describe('colour picker end to end', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function renderWiredToolbar() {
    const hook = renderHook(() => useDrawingSession())

    function Wired(): React.JSX.Element {
      const session = hook.result.current
      return (
        <DrawingToolbar
          tool={session.tool}
          color={session.color}
          width={session.width}
          canUndo={session.canUndo}
          canRedo={session.canRedo}
          onToolChange={session.setTool}
          onColorChange={session.setColor}
          onColorInteractionBegin={session.beginColorInteraction}
          onColorPreview={session.previewColor}
          onColorInteractionCommit={session.commitColorInteraction}
          onWidthChange={session.setWidth}
          onWidthInteractionBegin={session.beginWidthInteraction}
          onWidthPreview={session.previewWidth}
          onWidthInteractionCommit={session.commitWidthInteraction}
          onUndo={session.undo}
          onRedo={session.redo}
          onClear={session.clear}
        />
      )
    }

    const view = render(<Wired />)
    return {
      hook,
      rerenderToolbar: () => {
        view.rerender(<Wired />)
      },
    }
  }

  function colorActions(hook: { result: { current: ReturnType<typeof useDrawingSession> } }) {
    return hook.result.current.actions.filter((action) => action.type === 'color_change')
  }

  /** Drags through several colours inside one picker interaction. */
  function dragThroughColors(
    rerenderToolbar: () => void,
    colors: readonly string[],
  ): void {
    const input = colorInput()
    fireEvent.pointerDown(input)
    for (const color of colors) {
      fireEvent.change(input, { target: { value: color } })
      rerenderToolbar()
    }
  }

  it('records one action for many previews inside one interaction', () => {
    const { hook, rerenderToolbar } = renderWiredToolbar()

    dragThroughColors(rerenderToolbar, ['#111111', '#333333', '#ff0000'])
    fireEvent.pointerUp(colorInput())

    const actions = colorActions(hook)
    expect(actions).toHaveLength(1)
    expect(actions[0]?.payload).toEqual({ from: DEFAULT_COLOR, to: '#ff0000' })
  })

  it('stays at one action when pointerup and blur both fire', () => {
    const { hook, rerenderToolbar } = renderWiredToolbar()

    dragThroughColors(rerenderToolbar, ['#00ff00'])
    fireEvent.pointerUp(colorInput())
    fireEvent.blur(colorInput())

    expect(colorActions(hook)).toHaveLength(1)
  })

  it('records nothing when the interaction returns to the starting colour', () => {
    const { hook, rerenderToolbar } = renderWiredToolbar()

    dragThroughColors(rerenderToolbar, ['#abcdef', '#123456', DEFAULT_COLOR])
    fireEvent.pointerUp(colorInput())
    fireEvent.blur(colorInput())

    expect(colorActions(hook)).toHaveLength(0)
  })

  it('records three actions for three separate interactions', () => {
    // The shape observed in the real exported session.
    const { hook, rerenderToolbar } = renderWiredToolbar()

    for (const color of ['#ff0000', '#00ff00', '#0000ff']) {
      dragThroughColors(rerenderToolbar, [color])
      fireEvent.pointerUp(colorInput())
      fireEvent.blur(colorInput())
      rerenderToolbar()
    }

    const actions = colorActions(hook)
    expect(actions).toHaveLength(3)
    expect(actions.map((action) => action.payload)).toEqual([
      { from: DEFAULT_COLOR, to: '#ff0000' },
      { from: '#ff0000', to: '#00ff00' },
      { from: '#00ff00', to: '#0000ff' },
    ])
  })

  it('commits an open picker when a stroke starts, before the first point', () => {
    const { hook, rerenderToolbar } = renderWiredToolbar()

    // The picker is never blurred: the user goes straight to the canvas.
    dragThroughColors(rerenderToolbar, ['#ff0000'])

    act(() => {
      hook.result.current.beginStroke(sample(10, 10))
      hook.result.current.endStroke()
    })

    const actions = colorActions(hook)
    expect(actions).toHaveLength(1)

    const stroke = hook.result.current.strokes[0]
    // The ink and the log agree, and the log explains the ink first.
    expect(stroke?.color).toBe('#ff0000')
    expect(actions[0]?.sequence).toBeLessThan(stroke?.points[0]?.sequence ?? 0)
  })

  it('handles a direct set immediately after a committed interaction', () => {
    const { hook, rerenderToolbar } = renderWiredToolbar()

    dragThroughColors(rerenderToolbar, ['#ff0000'])
    fireEvent.pointerUp(colorInput())
    rerenderToolbar()

    act(() => {
      hook.result.current.setColor('#0000ff')
    })

    const actions = colorActions(hook)
    expect(actions).toHaveLength(2)
    expect(actions[1]?.payload).toEqual({ from: '#ff0000', to: '#0000ff' })
  })

  it('persists only the committed colour', () => {
    const { rerenderToolbar } = renderWiredToolbar()

    dragThroughColors(rerenderToolbar, ['#aaaaaa', '#bbbbbb'])
    expect(localStorage.getItem('artiscan:preferences')).toBeNull()

    fireEvent.pointerUp(colorInput())
    const stored = JSON.parse(
      localStorage.getItem('artiscan:preferences') ?? '{}',
    ) as { color?: string }
    expect(stored.color).toBe('#bbbbbb')
  })

  /**
   * The specific regression the width work could have introduced: both
   * interactions open at once, each committing its own single action, and
   * neither preference overwriting the other.
   */
  it('keeps colour and width interactions completely independent', () => {
    const { hook, rerenderToolbar } = renderWiredToolbar()

    const input = colorInput()
    fireEvent.pointerDown(input)
    fireEvent.change(input, { target: { value: '#ff0000' } })
    rerenderToolbar()

    const slider = widthSlider()
    fireEvent.pointerDown(slider)
    fireEvent.change(slider, { target: { value: '18' } })
    rerenderToolbar()
    fireEvent.pointerUp(slider)
    rerenderToolbar()

    fireEvent.pointerUp(input)
    rerenderToolbar()

    expect(colorActions(hook)).toHaveLength(1)
    expect(
      hook.result.current.actions.filter((action) => action.type === 'width_change'),
    ).toHaveLength(1)
    expect(hook.result.current.color).toBe('#ff0000')
    expect(hook.result.current.width).toBe(18)

    // Neither preference write clobbered the other.
    const stored = JSON.parse(
      localStorage.getItem('artiscan:preferences') ?? '{}',
    ) as { color?: string; width?: number }
    expect(stored).toMatchObject({ color: '#ff0000', width: 18 })
  })
})
