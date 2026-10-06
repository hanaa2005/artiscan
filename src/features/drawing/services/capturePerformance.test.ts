/**
 * WEEK 1A - measurements of the capture and persistence path.
 *
 * HONESTY NOTE, WHICH MATTERS MORE THAN THE NUMBERS
 *
 * These run in jsdom against fake-indexeddb, NOT in Chrome. So:
 *
 *   - the React commit counts ARE meaningful. They are a property of the hook's
 *     design, not of the browser, and they are the number the capture-loop rule
 *     actually turns on.
 *   - point and stroke counts and JSON byte sizes ARE meaningful. They are pure
 *     data properties.
 *   - the TIMINGS are indicative only. jsdom is not Chrome and fake-indexeddb
 *     is an in-memory shim, so a duration measured here must never be quoted as
 *     a real IndexedDB write time.
 *
 * Assertions are therefore placed only on the things that are genuinely
 * determined here; the timings are recorded and printed, not asserted.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDrawingSession, type RawPointerSample } from '../hooks/useDrawingSession'
import { clearSessions, flushPendingWrites, saveSession } from './drawingSessionRepository'
import { resetDatabaseConnectionForTests } from './indexedDb'

const CANVAS = { width: 800, height: 600 }

/** A realistic session shape: a detailed drawing, not a toy. */
const STROKE_COUNT = 20
const POINTS_PER_STROKE = 150

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

/** Printed as one block so the numbers are readable in the test output. */
function report(label: string, values: Record<string, string | number>): void {
  const body = Object.entries(values)
    .map(([key, value]) => `    ${key}: ${String(value)}`)
    .join('\n')
  console.info(`\n  [measured] ${label}\n${body}\n`)
}

describe('capture loop - React commits per stroke', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('MEASURED: pointer movement causes ZERO React commits', () => {
    let renderCount = 0
    const { result } = renderHook(() => {
      renderCount += 1
      return useDrawingSession()
    })

    const afterMount = renderCount

    act(() => {
      result.current.beginStroke(sample(10, 10))
    })
    const afterBegin = renderCount

    // 150 samples, delivered the way a coalesced pointermove delivers them.
    act(() => {
      for (let i = 0; i < POINTS_PER_STROKE; i += 1) {
        result.current.extendStroke([sample(10 + i, 10 + i)])
      }
    })
    const afterMoves = renderCount

    act(() => {
      result.current.endStroke()
    })
    const afterEnd = renderCount

    report('React commits for one 150-point stroke', {
      'commits at mount': afterMount,
      'commits added by beginStroke': afterBegin - afterMount,
      'commits added by 150 extendStroke calls': afterMoves - afterBegin,
      'commits added by endStroke': afterEnd - afterMoves,
      'total commits for the stroke': afterEnd - afterMount,
    })

    // THE RULE: moving the pointer must never re-render React. This is the
    // assertion that keeps the capture loop light.
    expect(afterMoves - afterBegin).toBe(0)
    // Every point still arrived.
    expect(result.current.strokes[0]?.points).toHaveLength(POINTS_PER_STROKE + 1)
  })

  it('MEASURED: commits stay flat as the point count grows tenfold', () => {
    const counts: Record<string, number> = {}

    for (const pointCount of [50, 500, 5000]) {
      let renderCount = 0
      const { result } = renderHook(() => {
        renderCount += 1
        return useDrawingSession()
      })
      const before = renderCount

      act(() => {
        result.current.beginStroke(sample(1, 1))
        for (let i = 0; i < pointCount; i += 1) {
          result.current.extendStroke([sample(i % CANVAS.width, i % CANVAS.height)])
        }
        result.current.endStroke()
      })

      counts[`${pointCount} points`] = renderCount - before
    }

    report('React commits versus point count', counts)

    // Identical regardless of how many points were captured: the cost of a
    // stroke is O(1) in renders.
    expect(new Set(Object.values(counts)).size).toBe(1)
  })
})

describe('session size and serialization', () => {
  beforeEach(async () => {
    localStorage.clear()
    resetDatabaseConnectionForTests()
    await clearSessions()
  })

  it('MEASURED: size and write cost of a 3000-point session', async () => {
    const { result } = renderHook(() => useDrawingSession())

    act(() => {
      for (let stroke = 0; stroke < STROKE_COUNT; stroke += 1) {
        result.current.beginStroke(sample(stroke * 5, 10))
        const points: RawPointerSample[] = []
        for (let i = 1; i < POINTS_PER_STROKE; i += 1) {
          points.push(sample((stroke * 5 + i) % CANVAS.width, (10 + i) % CANVAS.height))
        }
        result.current.extendStroke(points)
        result.current.endStroke()
      }
    })

    const session = result.current.buildSession(CANVAS)
    const pointCount = session.strokes.reduce((sum, s) => sum + s.points.length, 0)

    const serializeStart = performance.now()
    const json = JSON.stringify(session)
    const serializeMs = performance.now() - serializeStart

    const writeStart = performance.now()
    await saveSession(session)
    await flushPendingWrites(session.id)
    const writeMs = performance.now() - writeStart

    report('3000-point session (jsdom / fake-indexeddb - timings indicative only)', {
      'stroke count': session.strokes.length,
      'point count': pointCount,
      'JSON size (bytes)': json.length,
      'JSON size (KB)': (json.length / 1024).toFixed(1),
      'bytes per point': Math.round(json.length / pointCount),
      'serialization (ms, jsdom)': serializeMs.toFixed(2),
      'IndexedDB write (ms, fake-indexeddb - NOT a browser measurement)':
        writeMs.toFixed(2),
    })

    // Data-shape assertions only. No timing is asserted, because no timing
    // measured here is a property of the real runtime.
    expect(session.strokes).toHaveLength(STROKE_COUNT)
    expect(pointCount).toBe(STROKE_COUNT * POINTS_PER_STROKE)
    expect(json.length).toBeGreaterThan(0)
  })
})
