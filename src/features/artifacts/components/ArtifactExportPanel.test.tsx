/**
 * WEEK 1C - the export panel.
 *
 * The assertions that matter most are about HONESTY rather than mechanics:
 * the lossy warning is present, the lossless group says it is lossless, and no
 * control is rendered that cannot do what it says.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactExportPanel } from './ArtifactExportPanel'
import * as gzipCodec from '../services/gzipCodec'
import { makePoint, makeSession, makeStroke } from '../../drawing/testing/sessionFixture'
import type { DrawingSession } from '../../drawing/types/drawing.types'

const CANVAS = { width: 800, height: 400, devicePixelRatio: 1 }

function sampleSession(): DrawingSession {
  const points = Array.from({ length: 24 }, (_, i) =>
    makePoint({
      sequence: i + 1,
      timeMs: (i + 1) * 10,
      x: 50 + i * 10,
      y: 200 + Math.sin(i / 3) * 40,
      normalizedX: (50 + i * 10) / 800,
      normalizedY: (200 + Math.sin(i / 3) * 40) / 400,
    }),
  )
  return makeSession({
    canvas: CANVAS,
    strokes: [makeStroke({ id: 'a', order: 0, startedAtMs: 10, endedAtMs: 240, points })],
    actions: [],
  })
}

/** Captures downloads without touching the real filesystem. */
let downloads: string[] = []
let clickSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  downloads = []
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock')
  globalThis.URL.revokeObjectURL = vi.fn()
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
})

afterEach(() => {
  clickSpy.mockRestore()
  vi.restoreAllMocks()
})

describe('honest labelling', () => {
  it('warns that the derived files do not replace the raw data', () => {
    render(<ArtifactExportPanel session={sampleSession()} />)

    expect(
      screen.getByText(/جایگزین داده خام آزمون نمی‌شود/),
    ).toBeDefined()
  })

  it('states that the compressed export loses nothing', () => {
    render(<ArtifactExportPanel session={sampleSession()} />)

    expect(screen.getByText(/هیچ نقطه‌ای از آن حذف نشده است/)).toBeDefined()
  })

  it('separates the lossless group from the lossy group', () => {
    render(<ArtifactExportPanel session={sampleSession()} />)

    expect(screen.getByText('داده کامل (بدون کاستی)')).toBeDefined()
    expect(screen.getByText('خروجی‌های کاسته‌شده (Lossy)')).toBeDefined()
  })

  it('gives the panel an accessible Persian heading', () => {
    render(<ArtifactExportPanel session={sampleSession()} />)

    expect(screen.getByRole('heading', { name: 'خروجی‌های تحلیلی' })).toBeDefined()
  })
})

describe('every rendered control works', () => {
  it('renders the gzip button when compression is supported', () => {
    render(<ArtifactExportPanel session={sampleSession()} />)
    expect(screen.getByRole('button', { name: 'خروجی فشرده JSON.GZ' })).toBeDefined()
  })

  it('replaces the gzip button with an explanation when unsupported', () => {
    // No dead control: the capability is absent, so the button is absent too.
    vi.spyOn(gzipCodec, 'isCompressionSupported').mockReturnValue(false)
    render(<ArtifactExportPanel session={sampleSession()} />)

    expect(screen.queryByRole('button', { name: 'خروجی فشرده JSON.GZ' })).toBeNull()
    expect(screen.getByText(/از فشرده‌سازی پشتیبانی نمی‌کند/)).toBeDefined()
  })

  it('downloads a gzip file with the right name', async () => {
    const session = sampleSession()
    render(<ArtifactExportPanel session={session} />)

    await act(async () => {
      screen.getByRole('button', { name: 'خروجی فشرده JSON.GZ' }).click()
    })

    await waitFor(() => {
      expect(downloads).toHaveLength(1)
    })
    expect(downloads[0]).toMatch(/^artiscan-raw-session-.*\.json\.gz$/)
  })

  it('downloads the critical trajectory JSON and reports the point counts', async () => {
    render(<ArtifactExportPanel session={sampleSession()} />)

    await act(async () => {
      screen.getByRole('button', { name: 'خروجی گراف JSON' }).click()
    })

    await waitFor(() => {
      expect(downloads).toHaveLength(1)
    })
    // UPDATED: filenames now carry the graph mode.
    expect(downloads[0]).toMatch(/^artiscan-full-process-graph-.*\.json$/)
    expect(screen.getByRole('status').textContent).toMatch(/نقطه/)
  })

  it('offers both graph modes, defaulting to the whole process', () => {
    render(<ArtifactExportPanel session={sampleSession()} />)
    const select = screen.getByLabelText('محدوده خروجی') as HTMLSelectElement

    expect([...select.options].map((option) => option.value)).toEqual([
      'full_process',
      'final_visible',
    ])
    // The wider answer is the safe default: it can never present erased work
    // as the finished drawing.
    expect(select.value).toBe('full_process')
  })

  it('puts the chosen mode into the exported filename', async () => {
    render(<ArtifactExportPanel session={sampleSession()} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('محدوده خروجی'), {
        target: { value: 'final_visible' },
      })
    })
    await act(async () => {
      screen.getByRole('button', { name: 'خروجی گراف JSON' }).click()
    })

    await waitFor(() => {
      expect(downloads).toHaveLength(1)
    })
    expect(downloads[0]).toMatch(/^artiscan-final-visible-graph-.*\.json$/)
  })

  it('offers all three quality profiles', () => {
    render(<ArtifactExportPanel session={sampleSession()} />)
    const select = screen.getByLabelText('سطح کیفیت') as HTMLSelectElement

    expect([...select.options].map((option) => option.value)).toEqual([
      'high',
      'balanced',
      'compact',
    ])
    // High is the default, per the week-1C contract.
    expect(select.value).toBe('high')
  })
})

describe('failure is reported, never silent', () => {
  it('shows a Persian error when an export throws', async () => {
    /*
      The PNG path genuinely fails in jsdom, which has no 2D canvas context.
      That makes this a real end-to-end check of the error path rather than a
      simulated one.
    */
    render(<ArtifactExportPanel session={sampleSession()} />)

    await act(async () => {
      screen.getByRole('button', { name: 'ماسک بازسازی PNG' }).click()
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })
    expect(screen.getByRole('alert').textContent).toMatch(/ساخت خروجی ناموفق بود/)
    // And nothing was downloaded.
    expect(downloads).toHaveLength(0)
  })
})

describe('double-click protection', () => {
  it('does not start a second export while one is running', async () => {
    render(<ArtifactExportPanel session={sampleSession()} />)
    const button = screen.getByRole('button', { name: 'خروجی فشرده JSON.GZ' })

    await act(async () => {
      // Two clicks in the same tick, as an impatient double-click produces.
      button.click()
      button.click()
    })

    await waitFor(() => {
      expect(downloads.length).toBeGreaterThan(0)
    })
    // One intent, one file.
    expect(downloads).toHaveLength(1)
  })
})

describe('the panel never modifies the session', () => {
  it('leaves the session untouched across every export', async () => {
    const session = sampleSession()
    const before = JSON.parse(JSON.stringify(session)) as DrawingSession

    render(<ArtifactExportPanel session={session} />)

    for (const name of ['خروجی فشرده JSON.GZ', 'خروجی گراف JSON']) {
      await act(async () => {
        screen.getByRole('button', { name }).click()
      })
      await waitFor(() => {
        expect(screen.queryByText('در حال آماده‌سازی...')).toBeNull()
      })
    }

    expect(session).toEqual(before)
  })
})
