/**
 * WEEK 1A - the width slider, from DOM event to recorded action.
 *
 * The hook-level contract is covered in
 * hooks/useDrawingSession.width.test.ts. What is tested HERE is the wiring: a
 * real `<input type="range">` fires `change` on every step it crosses, and the
 * question is how many actions reach the log when a human drags it.
 *
 * The second suite drives the REAL toolbar against the REAL recorder, so a
 * regression in either one - or in the props between them - fails the test.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DrawingToolbar } from './DrawingToolbar'
import { useDrawingSession } from '../hooks/useDrawingSession'

function coreProps() {
  return {
    tool: 'pen' as const,
    color: '#000000',
    width: 4,
    canUndo: true,
    canRedo: true,
    onToolChange: vi.fn(),
    onColorChange: vi.fn(),
    onWidthChange: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onClear: vi.fn(),
  }
}

function widthSlider(): HTMLInputElement {
  return screen.getByLabelText(/ضخامت/) as HTMLInputElement
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DrawingToolbar - width interaction wiring', () => {
  it('previews rather than committing while the slider is being dragged', () => {
    const props = coreProps()
    const onWidthPreview = vi.fn()
    const onWidthInteractionBegin = vi.fn()
    const onWidthInteractionCommit = vi.fn()

    render(
      <DrawingToolbar
        {...props}
        onWidthInteractionBegin={onWidthInteractionBegin}
        onWidthPreview={onWidthPreview}
        onWidthInteractionCommit={onWidthInteractionCommit}
      />,
    )

    const slider = widthSlider()
    fireEvent.pointerDown(slider)
    for (const value of [14, 13, 12, 11, 10, 9]) {
      fireEvent.change(slider, { target: { value: String(value) } })
    }

    // Every step is a preview; nothing is committed yet, and the atomic
    // handler - the one that would log an action - is never called.
    expect(onWidthPreview).toHaveBeenCalledTimes(6)
    expect(onWidthInteractionCommit).not.toHaveBeenCalled()
    expect(props.onWidthChange).not.toHaveBeenCalled()
    expect(onWidthInteractionBegin).toHaveBeenCalled()
  })

  it('commits on pointerup and on blur, leaving commit to be idempotent', () => {
    const onWidthInteractionCommit = vi.fn()

    render(
      <DrawingToolbar
        {...coreProps()}
        onWidthInteractionBegin={vi.fn()}
        onWidthPreview={vi.fn()}
        onWidthInteractionCommit={onWidthInteractionCommit}
      />,
    )

    const slider = widthSlider()
    fireEvent.pointerDown(slider)
    fireEvent.change(slider, { target: { value: '8' } })
    fireEvent.pointerUp(slider)
    fireEvent.blur(slider)

    // Both fire; the recorder is what makes the pair produce one action.
    expect(onWidthInteractionCommit).toHaveBeenCalledTimes(2)
  })

  it('opens an interaction on focus, so keyboard use is covered too', () => {
    const onWidthInteractionBegin = vi.fn()
    const onWidthPreview = vi.fn()

    render(
      <DrawingToolbar
        {...coreProps()}
        onWidthInteractionBegin={onWidthInteractionBegin}
        onWidthPreview={onWidthPreview}
        onWidthInteractionCommit={vi.fn()}
      />,
    )

    const slider = widthSlider()
    fireEvent.focus(slider)
    fireEvent.change(slider, { target: { value: '5' } })

    expect(onWidthInteractionBegin).toHaveBeenCalled()
    expect(onWidthPreview).toHaveBeenCalledWith(5)
  })

  it('falls back to atomic changes when no interaction handlers are given', () => {
    // A scripted or minimal caller must keep working exactly as before.
    const props = coreProps()
    render(<DrawingToolbar {...props} />)

    fireEvent.change(widthSlider(), { target: { value: '9' } })

    expect(props.onWidthChange).toHaveBeenCalledExactlyOnceWith(9)
  })
})

/**
 * The real toolbar against the real recorder.
 *
 * This is the test that would have caught the reported bug: it reproduces the
 * exact drag from the exported session and counts what lands in the log.
 */
describe('width slider end to end', () => {
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

  it('records ONE action for the exact drag from the reported session', () => {
    const { hook, rerenderToolbar } = renderWiredToolbar()

    act(() => {
      hook.result.current.setWidth(29)
    })
    rerenderToolbar()

    const slider = widthSlider()
    fireEvent.pointerDown(slider)
    // The fourteen intermediate values recorded in the real file.
    for (const value of [14, 13, 12, 11, 10, 9, 12, 9, 11, 8, 10, 7, 9, 8]) {
      fireEvent.change(slider, { target: { value: String(value) } })
      rerenderToolbar()
    }
    fireEvent.pointerUp(slider)
    fireEvent.blur(slider)

    const widthChanges = hook.result.current.actions.filter(
      (action) => action.type === 'width_change',
    )

    // Before the fix this drag produced fifteen actions in total.
    expect(widthChanges).toHaveLength(2)
    expect(widthChanges[0]?.payload).toEqual({ from: 4, to: 29 })
    expect(widthChanges[1]?.payload).toEqual({ from: 29, to: 8 })
    expect(hook.result.current.width).toBe(8)
  })

  it('records nothing for a drag that returns to where it started', () => {
    const { hook, rerenderToolbar } = renderWiredToolbar()

    const slider = widthSlider()
    fireEvent.pointerDown(slider)
    for (const value of [9, 15, 4]) {
      fireEvent.change(slider, { target: { value: String(value) } })
      rerenderToolbar()
    }
    fireEvent.pointerUp(slider)

    expect(
      hook.result.current.actions.filter((action) => action.type === 'width_change'),
    ).toHaveLength(0)
  })

  it('records one action per successive keyboard adjustment session', () => {
    const { hook, rerenderToolbar } = renderWiredToolbar()

    const slider = widthSlider()
    // Focus, three arrow presses, blur - one deliberate adjustment.
    fireEvent.focus(slider)
    for (const value of [5, 6, 7]) {
      fireEvent.change(slider, { target: { value: String(value) } })
      rerenderToolbar()
    }
    fireEvent.blur(slider)

    const widthChanges = hook.result.current.actions.filter(
      (action) => action.type === 'width_change',
    )
    expect(widthChanges).toHaveLength(1)
    expect(widthChanges[0]?.payload).toEqual({ from: 4, to: 7 })
  })
})
