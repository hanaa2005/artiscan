/**
 * WEEK 1A - a completed trial survives a reload.
 *
 * This is the Definition-of-Done item that the repository unit tests cannot
 * prove on their own: the repository being correct is no help if the page never
 * calls it, or calls it with an incomplete result, or reports "saved" before the
 * write lands. So this drives the real TrialPage, unmounts it - which is what a
 * reload does to React state - and mounts it again.
 *
 * The canvas is stubbed for the same reason as in trialPage.ui.test.tsx: Konva
 * needs a real 2D context and jsdom has none. The stub still lets the recorder
 * be driven directly, which is all that is needed to produce a stroke.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A canvas stub that draws one real stroke into the recorder on demand.
 *
 * The button is how a test "draws": it pushes a genuine begin/extend/end
 * gesture through the real useDrawingSession instance the page owns, so the
 * empty-trial rule sees a real stroke count.
 */
vi.mock('../../drawing/components/DrawingCanvas', () => ({
  DrawingCanvas: ({
    session,
  }: {
    session: {
      beginStroke: (sample: unknown) => void
      extendStroke: (samples: unknown[]) => void
      endStroke: () => boolean
    }
  }): React.JSX.Element => {
    const sample = (x: number, y: number) => ({
      x,
      y,
      normalizedX: x / 800,
      normalizedY: y / 600,
      pressure: null,
      tiltX: null,
      tiltY: null,
      pointerType: 'mouse' as const,
    })
    return (
      <button
        type="button"
        data-testid="draw-stroke"
        onClick={() => {
          session.beginStroke(sample(10, 10))
          session.extendStroke([sample(20, 20), sample(30, 32)])
          session.endStroke()
        }}
      >
        draw
      </button>
    )
  },
}))

import { TrialPage } from './TrialPage'
import {
  clearTrialResults,
  getLatestTrialResult,
  listTrialResults,
} from '../services/trialResultRepository'
import { resetDatabaseConnectionForTests } from '../../drawing/services/indexedDb'

/**
 * Lets IndexedDB work finish.
 *
 * fake-indexeddb drives its transactions on setImmediate, which is deliberately
 * NOT faked below - faking it would freeze every database call and hang the
 * test. Yielding real macrotasks is therefore how a write is awaited here.
 */
async function flushDatabase(): Promise<void> {
  // setImmediate is a Node global that the DOM lib does not declare.
  const yieldToEventLoop = (globalThis as unknown as {
    setImmediate: (callback: () => void) => void
  }).setImmediate

  await act(async () => {
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise<void>((resolve) => {
        yieldToEventLoop(() => {
          resolve()
        })
      })
    }
  })
}

/** Selects a task and runs the countdown out, landing in the drawing phase. */
async function reachDrawingPhase(): Promise<void> {
  fireEvent.click(screen.getAllByRole('button', { name: /خانه/ })[0] as HTMLElement)
  fireEvent.click(screen.getByRole('button', { name: 'آماده‌ام، شروع کن' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000)
  })
}

/** Runs a whole trial to completion, with one real stroke recorded. */
async function completeATrial(): Promise<void> {
  await reachDrawingPhase()
  fireEvent.click(screen.getByTestId('draw-stroke'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  fireEvent.click(screen.getByRole('button', { name: 'پایان و ثبت نتیجه' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  await flushDatabase()
}

/** Asserts the page reports the result as genuinely stored. */
function expectSavedNotice(): void {
  expect(screen.getByText(/در حافظه محلی مرورگر ذخیره شد/)).toBeTruthy()
}

describe('TrialPage - a completed result survives a reload', () => {
  beforeEach(async () => {
    // The database is cleared with REAL timers, before any faking, because
    // fake-indexeddb needs the event loop to run.
    resetDatabaseConnectionForTests()
    await clearTrialResults()

    localStorage.clear()
    // Only the timer families the page itself uses. setImmediate and
    // microtasks stay real so IndexedDB keeps working.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('writes the completed result to IndexedDB and says so only once stored', async () => {
    render(<TrialPage />)
    await completeATrial()

    expectSavedNotice()

    const stored = await getLatestTrialResult()
    expect(stored).not.toBeNull()
    // The canonical session travelled with it, strokes and points included.
    expect(stored?.result.session.strokes).toHaveLength(1)
    expect(stored?.result.session.strokes[0]?.points).toHaveLength(3)
    expect(stored?.result.trial.status).toBe('completed')
    expect(stored?.result.trial.timing.completedAt).not.toBeNull()
  })

  it('offers the stored result after a remount, and restores it intact', async () => {
    const first = render(<TrialPage />)
    await completeATrial()
    expectSavedNotice()
    const storedId = (await getLatestTrialResult())?.id

    // A reload: React state is gone entirely.
    first.unmount()

    render(<TrialPage />)
    await flushDatabase()

    fireEvent.click(screen.getByRole('button', { name: 'نمایش نتیجه ذخیره‌شده' }))

    // The result is back, and labelled as restored rather than freshly measured.
    expect(screen.getByText(/نتیجه بازیابی‌شده از حافظه محلی/)).toBeTruthy()
    expect(screen.getByText(storedId ?? 'missing')).toBeTruthy()
  })

  it('dismissing the banner deletes nothing', async () => {
    const first = render(<TrialPage />)
    await completeATrial()
    expectSavedNotice()
    first.unmount()

    const second = render(<TrialPage />)
    await flushDatabase()
    fireEvent.click(screen.getByRole('button', { name: 'بستن' }))

    // Banner gone, row still there - a mis-click must not destroy a recording.
    expect(screen.queryByRole('button', { name: 'نمایش نتیجه ذخیره‌شده' })).toBeNull()
    expect(await listTrialResults()).toHaveLength(1)

    // And it is offered again on the next reload.
    second.unmount()
    render(<TrialPage />)
    await flushDatabase()
    expect(screen.getByRole('button', { name: 'نمایش نتیجه ذخیره‌شده' })).toBeTruthy()
  })

  it('stores nothing for a trial that was never completed', async () => {
    render(<TrialPage />)
    await reachDrawingPhase()
    fireEvent.click(screen.getByTestId('draw-stroke'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    // Left mid-trial, exactly as an abandoned tab would be.
    expect(await listTrialResults()).toHaveLength(0)
  })

  it('stores nothing when completion is refused for having no strokes', async () => {
    render(<TrialPage />)
    await reachDrawingPhase()

    fireEvent.click(screen.getByRole('button', { name: 'پایان و ثبت نتیجه' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    await flushDatabase()

    expect(await listTrialResults()).toHaveLength(0)
  })

  it('keeps one row per trial across two consecutive trials', async () => {
    render(<TrialPage />)
    await completeATrial()
    expectSavedNotice()

    fireEvent.click(screen.getByRole('button', { name: 'آزمون جدید' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    await completeATrial()
    expectSavedNotice()

    const all = await listTrialResults()
    expect(all).toHaveLength(2)
    // Distinct trials, not one row overwritten by the other.
    expect(new Set(all.map((row) => row.id)).size).toBe(2)
  })
})
