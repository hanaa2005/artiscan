import { describe, expect, it } from 'vitest'
import {
  buildSessionFileName,
  deserializeSession,
  serializeSession,
} from './drawingSerializer'
import { makeSession, makeStrokeSeries } from '../testing/sessionFixture'
import type { DrawingStroke } from '../types/drawing.types'

describe('serializeSession', () => {
  it('produces pretty-printed, human-readable JSON', () => {
    const text = serializeSession(makeSession())
    expect(text).toContain('\n')
    expect(text).toContain('  "schemaVersion": 2')
  })
})

describe('round-trip', () => {
  it('reproduces the session exactly after export and import', () => {
    // This is the acceptance criterion for the whole import/export feature:
    // whatever was recorded must come back byte-for-byte identical.
    const original = makeSession()
    const result = deserializeSession(serializeSession(original))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual(original)
    }
  })

  it('preserves timing, ordering and normalized coordinates of every point', () => {
    const original = makeSession()
    const result = deserializeSession(serializeSession(original))

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const originalPoints = original.strokes[0]?.points ?? []
    const restoredPoints = result.value.strokes[0]?.points ?? []
    expect(restoredPoints).toHaveLength(originalPoints.length)

    for (let i = 0; i < originalPoints.length; i += 1) {
      expect(restoredPoints[i]?.sequence).toBe(originalPoints[i]?.sequence)
      expect(restoredPoints[i]?.timeMs).toBe(originalPoints[i]?.timeMs)
      expect(restoredPoints[i]?.normalizedX).toBe(originalPoints[i]?.normalizedX)
      expect(restoredPoints[i]?.normalizedY).toBe(originalPoints[i]?.normalizedY)
    }
  })

  it('survives a session containing both pen and eraser strokes', () => {
    const [penStroke, eraserStroke] = makeStrokeSeries(2, ['pen-1', 'eraser-1'])
    const original = makeSession({
      strokes: [
        { ...(penStroke as DrawingStroke), tool: 'pen' },
        { ...(eraserStroke as DrawingStroke), tool: 'eraser' },
      ],
    })
    const result = deserializeSession(serializeSession(original))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.strokes.map((stroke) => stroke.tool)).toEqual(['pen', 'eraser'])
    }
  })
})

describe('deserializeSession - invalid input', () => {
  it('reports malformed JSON instead of throwing', () => {
    const result = deserializeSession('{ this is not json')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('JSON')
    }
  })

  it('reports an empty file instead of throwing', () => {
    expect(deserializeSession('').ok).toBe(false)
  })

  it('rejects valid JSON that is not an ArtiScan session', () => {
    const result = deserializeSession('{"hello":"world"}')
    expect(result.ok).toBe(false)
  })

  it('rejects a JSON array', () => {
    expect(deserializeSession('[1,2,3]').ok).toBe(false)
  })
})

describe('buildSessionFileName', () => {
  it('includes a short session id and the date', () => {
    const session = makeSession({ id: 'abcdef12-3456-4789-8abc-def012345678' })
    expect(buildSessionFileName(session, '2026-08-09')).toBe(
      'artiscan-session-abcdef12-2026-08-09.json',
    )
  })
})
