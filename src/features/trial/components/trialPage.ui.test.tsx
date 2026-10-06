/**
 * The trial page as the participant actually meets it.
 *
 * WHY THE CANVAS IS MOCKED
 *
 * Konva needs a real 2D context, and jsdom has none. Week 1 already decided not
 * to test canvas RENDERING here; these tests are about orchestration - which
 * controls exist, which of them do something, and what happens when a file is
 * opened. Mocking the canvas keeps that focus and adds no dependency. Real
 * rendering is verified in Chrome, per the manual checklist.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../drawing/components/DrawingCanvas', () => ({
  DrawingCanvas: (): React.JSX.Element => <div data-testid="canvas-stub" />,
}))

import { TrialPage } from './TrialPage'
import { buildTrialResult, serializeTrialResult } from '../services/trialResultSerializer'
import { CURRENT_RESULT_SCHEMA_VERSION, type DrawingTrial } from '../types/trial.types'
import { findTaskById } from '../utils/taskSelection'
import { makeSession, makeStrokeSeries } from '../../drawing/testing/sessionFixture'

const COMPLETED_TRIAL: DrawingTrial = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  status: 'completed',
  timeLimitSeconds: 60,
  timing: {
    startedAt: '2026-08-13T10:00:00.000Z',
    completedAt: '2026-08-13T10:01:48.000Z',
    durationMs: 108_000,
    countdownSeconds: 3,
  },
}

/** A serialized, importable result for the 'house' task. */
function validResultJson(): string {
  const task = findTaskById('house')
  if (task === null) throw new Error('house task must exist')
  const session = makeSession({ strokes: makeStrokeSeries(2, ['a', 'b']), actions: [] })
  return serializeTrialResult(buildTrialResult(COMPLETED_TRIAL, task, session))
}

function jsonFile(text: string): File {
  return new File([text], 'result.json', { type: 'application/json' })
}

/** Selects a task and runs the countdown out, landing in the drawing phase. */
async function reachDrawingPhase(): Promise<void> {
  fireEvent.click(screen.getAllByRole('button', { name: /خانه/ })[0] as HTMLElement)
  fireEvent.click(screen.getByRole('button', { name: 'آماده‌ام، شروع کن' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000)
  })
}

describe('TrialPage - no visible control is a no-op', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('offers only the drawing controls during the drawing phase', async () => {
    render(<TrialPage />)
    await reachDrawingPhase()

    for (const label of ['قلم', 'پاک‌کن', 'واگرد', 'ازنو', 'پاک کردن همه']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
    expect(screen.getByLabelText('رنگ')).toBeTruthy()
  })

  it('does not render the raw session import, export, PNG or new-session controls', async () => {
    // These used to be rendered with inert handlers: visible, enabled, and
    // silently doing nothing when pressed.
    render(<TrialPage />)
    await reachDrawingPhase()

    expect(screen.queryByRole('button', { name: 'ورود JSON' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'خروجی JSON' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'خروجی PNG' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'جلسه جدید' })).toBeNull()
  })

  it('offers no result export before the trial is completed', async () => {
    render(<TrialPage />)
    await reachDrawingPhase()

    expect(screen.queryByRole('button', { name: 'خروجی JSON نتیجه آزمون' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'خروجی PNG نقاشی' })).toBeNull()
  })

  it('always offers the result import, which is a real and separate action', () => {
    render(<TrialPage />)
    expect(screen.getByRole('button', { name: 'ورود فایل نتیجه آزمون' })).toBeTruthy()
  })
})

describe('TrialPage - the empty-trial rule in the UI', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('refuses completion with a Persian message and stays in the drawing phase', async () => {
    render(<TrialPage />)
    await reachDrawingPhase()

    fireEvent.click(screen.getByRole('button', { name: 'پایان و ثبت نتیجه' }))

    expect(
      screen.getByText('برای ثبت نتیجه، ابتدا حداقل یک خط روی بوم رسم کنید.', {
        selector: '[role=alert]',
      }),
    ).toBeTruthy()
    // Still drawing: the finish button is still on screen, and no result is.
    expect(screen.getByRole('button', { name: 'پایان و ثبت نتیجه' })).toBeTruthy()
    expect(screen.queryByText('آزمون تکمیل شد.', { exact: false })).toBeNull()
    expect(screen.queryByRole('button', { name: 'خروجی JSON نتیجه آزمون' })).toBeNull()
  })

  it('never asks the user to confirm an empty trial - the old escape hatch is gone', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<TrialPage />)
    await reachDrawingPhase()

    fireEvent.click(screen.getByRole('button', { name: 'پایان و ثبت نتیجه' }))

    expect(confirmSpy).not.toHaveBeenCalled()
  })
})

describe('TrialPage - importing a saved result', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Picks a file through the real import control. */
  function importFile(file: File): void {
    const input = screen.getByLabelText('انتخاب فایل نتیجه آزمون')
    fireEvent.change(input, { target: { files: [file] } })
  }

  it('displays a valid result, with its task and trial metadata', async () => {
    render(<TrialPage />)
    importFile(jsonFile(validResultJson()))

    await waitFor(() => {
      expect(screen.getByText('۳. نتیجه واردشده از فایل')).toBeTruthy()
    })
    expect(screen.getByText(COMPLETED_TRIAL.id)).toBeTruthy()
    expect(screen.getByText('خانه (House)')).toBeTruthy()
  })

  it('preserves the session id and the result schema version on screen', async () => {
    const session = makeSession({ strokes: makeStrokeSeries(2, ['a', 'b']), actions: [] })
    render(<TrialPage />)
    importFile(jsonFile(validResultJson()))

    await waitFor(() => {
      expect(screen.getByText(session.id)).toBeTruthy()
    })
    // Both version rows now read "2" - the session schema and the result
    // schema - so the assertion is on the labelled row, not the bare value.
    const versionRow = screen.getByText('نسخه Schema نتیجه').parentElement
    expect(versionRow?.textContent).toContain(String(CURRENT_RESULT_SCHEMA_VERSION))
  })

  it('shows a Persian error for malformed JSON instead of crashing', async () => {
    render(<TrialPage />)
    importFile(jsonFile('{ this is not json'))

    await waitFor(() => {
      expect(
        screen.getByText('فایل انتخاب‌شده یک JSON معتبر نیست و قابل خواندن نبود.'),
      ).toBeTruthy()
    })
    expect(screen.queryByText('۳. نتیجه واردشده از فایل')).toBeNull()
  })

  it('shows a Persian error for an unsupported result version', async () => {
    const parsed: Record<string, unknown> = JSON.parse(validResultJson())
    parsed['resultSchemaVersion'] = 99
    render(<TrialPage />)
    importFile(jsonFile(JSON.stringify(parsed)))

    await waitFor(() => {
      expect(screen.getByText(/نسخه Schema نتیجه \(99\) پشتیبانی نمی‌شود/)).toBeTruthy()
    })
  })

  it('shows a Persian error when the embedded session is invalid', async () => {
    const parsed: Record<string, unknown> = JSON.parse(validResultJson())
    const session = parsed['session'] as Record<string, unknown>
    session['strokes'] = 'not an array'
    render(<TrialPage />)
    importFile(jsonFile(JSON.stringify(parsed)))

    await waitFor(() => {
      expect(screen.getByText(/جلسه نقاشی داخل فایل معتبر نیست/)).toBeTruthy()
    })
  })

  it('does not load the imported drawing into the live recorder', async () => {
    render(<TrialPage />)
    importFile(jsonFile(validResultJson()))

    await waitFor(() => {
      expect(screen.getByText('۳. نتیجه واردشده از فایل')).toBeTruthy()
    })
    // The live counters still describe an empty recorder: an imported result is
    // a record of a finished trial, not a drawing to continue.
    expect(screen.getByText(/خطوط ثبت‌شده: 0/)).toBeTruthy()
  })

  it('offers no PNG export for an imported result - the canvas holds no pixels for it', async () => {
    render(<TrialPage />)
    importFile(jsonFile(validResultJson()))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'خروجی JSON نتیجه آزمون' })).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: 'خروجی PNG نقاشی' })).toBeNull()
  })
})

describe('TrialPage - importing while a trial is running', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function importFile(file: File): void {
    const input = screen.getByLabelText('انتخاب فایل نتیجه آزمون')
    fireEvent.change(input, { target: { files: [file] } })
  }

  it('asks for confirmation, and declining preserves the active trial exactly', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<TrialPage />)
    await reachDrawingPhase()

    importFile(jsonFile(validResultJson()))

    expect(confirmSpy).toHaveBeenCalledOnce()
    // Untouched: same phase, same task, same controls.
    expect(screen.getByRole('button', { name: 'پایان و ثبت نتیجه' })).toBeTruthy()
    expect(screen.getByText('خانه (House)')).toBeTruthy()
    expect(screen.queryByText('۳. نتیجه واردشده از فایل')).toBeNull()
  })

  it('accepting cancels the active trial and then shows the imported result', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<TrialPage />)
    await reachDrawingPhase()

    // FileReader schedules its callback on the real task queue, so the fake
    // clock is dropped BEFORE the read starts - dropping it afterwards would
    // discard the already-scheduled callback with it.
    vi.useRealTimers()
    importFile(jsonFile(validResultJson()))

    expect(screen.getByText(/آزمون لغو شد/)).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText('۳. نتیجه واردشده از فایل')).toBeTruthy()
    })
  })

  it('asks nothing when no trial is running', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<TrialPage />)

    importFile(jsonFile(validResultJson()))

    expect(confirmSpy).not.toHaveBeenCalled()
  })
})
