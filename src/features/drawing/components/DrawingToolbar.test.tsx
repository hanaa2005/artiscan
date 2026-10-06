/**
 * The toolbar's capability contract.
 *
 * A control appears only when it has a real handler. The alternative - always
 * rendering everything and passing `() => undefined` for what does not apply -
 * produced buttons that looked live and silently did nothing when pressed.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DrawingToolbar } from './DrawingToolbar'

/** The props every caller must supply. */
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

const SESSION_CONTROLS = ['جلسه جدید', 'خروجی JSON', 'ورود JSON', 'خروجی PNG']

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DrawingToolbar - optional session controls', () => {
  it('renders the drawing controls with no session handlers at all', () => {
    render(<DrawingToolbar {...coreProps()} />)

    for (const label of ['قلم', 'پاک‌کن', 'واگرد', 'ازنو', 'پاک کردن همه']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
    expect(screen.getByLabelText('رنگ')).toBeTruthy()
  })

  it('renders NONE of the session controls when their handlers are omitted', () => {
    render(<DrawingToolbar {...coreProps()} />)

    for (const label of SESSION_CONTROLS) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
    // The whole group disappears rather than sitting there empty.
    expect(screen.queryByRole('group', { name: 'جلسه و خروجی' })).toBeNull()
  })

  it('renders each session control independently of the others', () => {
    render(<DrawingToolbar {...coreProps()} onExportPng={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'خروجی PNG' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'خروجی JSON' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'ورود JSON' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'جلسه جدید' })).toBeNull()
  })

  it('renders the full week-1 toolbar when every handler is supplied', () => {
    render(
      <DrawingToolbar
        {...coreProps()}
        onNewSession={vi.fn()}
        onExportJson={vi.fn()}
        onImportJson={vi.fn()}
        onExportPng={vi.fn()}
      />,
    )

    for (const label of SESSION_CONTROLS) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('every visible enabled button actually calls its handler', () => {
    const props = coreProps()
    const onNewSession = vi.fn()
    const onExportJson = vi.fn()
    const onExportPng = vi.fn()
    render(
      <DrawingToolbar
        {...props}
        onNewSession={onNewSession}
        onExportJson={onExportJson}
        onExportPng={onExportPng}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'واگرد' }))
    fireEvent.click(screen.getByRole('button', { name: 'ازنو' }))
    fireEvent.click(screen.getByRole('button', { name: 'پاک کردن همه' }))
    fireEvent.click(screen.getByRole('button', { name: 'جلسه جدید' }))
    fireEvent.click(screen.getByRole('button', { name: 'خروجی JSON' }))
    fireEvent.click(screen.getByRole('button', { name: 'خروجی PNG' }))

    expect(props.onUndo).toHaveBeenCalledOnce()
    expect(props.onRedo).toHaveBeenCalledOnce()
    expect(props.onClear).toHaveBeenCalledOnce()
    expect(onNewSession).toHaveBeenCalledOnce()
    expect(onExportJson).toHaveBeenCalledOnce()
    expect(onExportPng).toHaveBeenCalledOnce()
  })
})

describe('DrawingToolbar - colour interaction wiring', () => {
  it('previews rather than committing while the picker is being used', () => {
    const props = coreProps()
    const onColorPreview = vi.fn()
    const onColorInteractionCommit = vi.fn()
    render(
      <DrawingToolbar
        {...props}
        onColorInteractionBegin={vi.fn()}
        onColorPreview={onColorPreview}
        onColorInteractionCommit={onColorInteractionCommit}
      />,
    )

    const input = screen.getByLabelText('رنگ')
    fireEvent.change(input, { target: { value: '#111111' } })
    fireEvent.change(input, { target: { value: '#222222' } })

    expect(onColorPreview).toHaveBeenCalledTimes(2)
    expect(onColorInteractionCommit).not.toHaveBeenCalled()
    // The atomic path must NOT also fire, or every preview would be an action.
    expect(props.onColorChange).not.toHaveBeenCalled()
  })

  it('commits when the interaction ends', () => {
    const onColorInteractionCommit = vi.fn()
    render(
      <DrawingToolbar
        {...coreProps()}
        onColorInteractionBegin={vi.fn()}
        onColorPreview={vi.fn()}
        onColorInteractionCommit={onColorInteractionCommit}
      />,
    )

    const input = screen.getByLabelText('رنگ')
    fireEvent.change(input, { target: { value: '#111111' } })
    fireEvent.blur(input)

    expect(onColorInteractionCommit).toHaveBeenCalled()
  })

  it('falls back to atomic changes when no interaction handlers are given', () => {
    const props = coreProps()
    render(<DrawingToolbar {...props} />)

    fireEvent.change(screen.getByLabelText('رنگ'), { target: { value: '#111111' } })

    expect(props.onColorChange).toHaveBeenCalledWith('#111111')
  })
})
