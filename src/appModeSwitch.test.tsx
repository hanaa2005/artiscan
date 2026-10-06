/**
 * Protecting an in-flight trial from a workspace switch.
 *
 * `beforeunload` covers a reload or a closed tab. It does NOT cover a React
 * mode change: the browser never hears about that, so switching to the free
 * drawing lab mid-trial used to unmount the page and take the drawing, the
 * timing and the trial id with it, silently.
 *
 * The canvas is mocked for the same reason as in trialPage.ui.test.tsx: Konva
 * needs a real 2D context and these tests are about orchestration.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./features/drawing/components/DrawingCanvas', () => ({
  DrawingCanvas: (): React.JSX.Element => <div data-testid="canvas-stub" />,
}))

import App from './App'

const LAB_TAB = 'رسم آزاد'
const TRIAL_TAB = 'اجرای آزمون'

function clickTab(name: string): void {
  fireEvent.click(screen.getByRole('tab', { name }))
}

/** Selects the house task; leaves the trial on the instructions screen. */
function selectHouse(): void {
  fireEvent.click(screen.getAllByRole('button', { name: /خانه/ })[0] as HTMLElement)
}

async function runCountdownOut(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000)
  })
}

describe('App - switching workspace during a trial', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts on the trial workspace', () => {
    render(<App />)
    expect(screen.getByRole('tab', { name: TRIAL_TAB }).getAttribute('aria-selected')).toBe(
      'true',
    )
  })

  it('switches freely from the instructions screen - nothing is recorded yet', () => {
    // The documented policy: no countdown has run, so there is nothing to lose
    // and a confirmation would only be noise.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    selectHouse()

    clickTab(LAB_TAB)

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: LAB_TAB }).getAttribute('aria-selected')).toBe('true')
  })

  it('asks for confirmation when leaving during the countdown', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<App />)
    selectHouse()
    fireEvent.click(screen.getByRole('button', { name: 'آماده‌ام، شروع کن' }))

    clickTab(LAB_TAB)

    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('آزمون در حال اجراست')
  })

  it('asks for confirmation when leaving during drawing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<App />)
    selectHouse()
    fireEvent.click(screen.getByRole('button', { name: 'آماده‌ام، شروع کن' }))
    await runCountdownOut()

    clickTab(LAB_TAB)

    expect(confirmSpy).toHaveBeenCalledOnce()
  })

  it('declining preserves the trial exactly - same task, same phase, same strokes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<App />)
    selectHouse()
    fireEvent.click(screen.getByRole('button', { name: 'آماده‌ام، شروع کن' }))
    await runCountdownOut()

    const trialIdBefore = screen.getByText(/خطوط ثبت‌شده:/).textContent
    clickTab(LAB_TAB)

    expect(screen.getByRole('tab', { name: TRIAL_TAB }).getAttribute('aria-selected')).toBe(
      'true',
    )
    // Still drawing the same task, with the recorder untouched.
    expect(screen.getByRole('button', { name: 'پایان و ثبت نتیجه' })).toBeTruthy()
    expect(screen.getByText('خانه (House)')).toBeTruthy()
    expect(screen.getByText(/خطوط ثبت‌شده:/).textContent).toBe(trialIdBefore)
  })

  it('asks only once per click, even in StrictMode-style double invocation', async () => {
    // The confirmation is a side effect and must never live inside a state
    // updater, or one click would show the user two dialogs.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<App />)
    selectHouse()
    fireEvent.click(screen.getByRole('button', { name: 'آماده‌ام، شروع کن' }))
    await runCountdownOut()

    clickTab(LAB_TAB)
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    clickTab(LAB_TAB)
    expect(confirmSpy).toHaveBeenCalledTimes(2)
  })

  it('accepting switches to the lab', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    selectHouse()
    fireEvent.click(screen.getByRole('button', { name: 'آماده‌ام، شروع کن' }))
    await runCountdownOut()

    clickTab(LAB_TAB)

    expect(screen.getByRole('tab', { name: LAB_TAB }).getAttribute('aria-selected')).toBe('true')
    // The week-1 workspace, with its own full toolbar.
    expect(screen.getByRole('button', { name: 'ورود JSON' })).toBeTruthy()
  })

  it('leaves no timer running after an accepted abandonment', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    selectHouse()
    fireEvent.click(screen.getByRole('button', { name: 'آماده‌ام، شروع کن' }))
    await runCountdownOut()

    clickTab(LAB_TAB)

    // The countdown and elapsed intervals were cleared by the explicit cancel,
    // not merely orphaned by an unmount. Nothing may fire afterwards.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('comes back to a fresh trial, never a half-abandoned one', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    selectHouse()
    fireEvent.click(screen.getByRole('button', { name: 'آماده‌ام، شروع کن' }))
    await runCountdownOut()

    clickTab(LAB_TAB)
    clickTab(TRIAL_TAB)

    /*
      Leaving unmounts the page, so returning starts over at task selection.
      That is the honest outcome: the abandoned recording is gone - which is
      exactly what the confirmation warned about - and nothing pretends
      otherwise by resuming a trial whose clock stopped while it was away.
    */
    expect(screen.getByText('ابتدا یک تکلیف انتخاب کنید.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'پایان و ثبت نتیجه' })).toBeNull()
    expect(screen.getByRole('group', { name: 'فهرست تکالیف' })).toBeTruthy()
  })

  it('switches away from a completed or cancelled trial without asking', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    selectHouse()
    fireEvent.click(screen.getByRole('button', { name: 'آماده‌ام، شروع کن' }))
    await runCountdownOut()

    // Cancel through the trial's own control (one confirmation of its own).
    fireEvent.click(screen.getByRole('button', { name: 'لغو آزمون' }))
    confirmSpy.mockClear()

    clickTab(LAB_TAB)

    expect(confirmSpy).not.toHaveBeenCalled()
  })
})
