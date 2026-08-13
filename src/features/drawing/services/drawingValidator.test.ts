import { describe, expect, it } from 'vitest'
import { validateSession } from './drawingValidator'
import {
  makeClearAction,
  makePoint,
  makeSession,
  makeStroke,
  makeStrokeSeries,
} from '../testing/sessionFixture'

describe('validateSession - accepting valid input', () => {
  it('accepts a well-formed session', () => {
    const result = validateSession(makeSession())
    expect(result.ok).toBe(true)
  })

  it('accepts a session with no strokes and no actions', () => {
    const result = validateSession(makeSession({ strokes: [], actions: [] }))
    expect(result.ok).toBe(true)
  })

  it('accepts an eraser stroke, which is stored exactly like a pen stroke', () => {
    const result = validateSession(
      makeSession({ strokes: [makeStroke({ tool: 'eraser' })] }),
    )
    expect(result.ok).toBe(true)
  })

  it('accepts real stylus pressure and tilt values', () => {
    const result = validateSession(
      makeSession({
        strokes: [
          makeStroke({
            hasPressureSamples: true,
            points: [makePoint({ pressure: 0.62, tiltX: -14, tiltY: 3, pointerType: 'pen' })],
          }),
        ],
      }),
    )
    expect(result.ok).toBe(true)
  })

  it('defaults a missing hasPressureSamples flag to false instead of rejecting', () => {
    const stroke = makeStroke()
    const { hasPressureSamples: _ignored, ...withoutFlag } = stroke
    const result = validateSession(makeSession({ strokes: [withoutFlag as typeof stroke] }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.strokes[0]?.hasPressureSamples).toBe(false)
    }
  })
})

describe('validateSession - rejecting invalid input', () => {
  it('rejects values that are not objects', () => {
    for (const value of [null, undefined, 42, 'hello', [1, 2, 3], true]) {
      const result = validateSession(value)
      expect(result.ok).toBe(false)
    }
  })

  it('rejects a file with no schemaVersion', () => {
    const { schemaVersion: _ignored, ...withoutVersion } = makeSession()
    const result = validateSession(withoutVersion)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('schemaVersion')
    }
  })

  it('rejects a schema version from the future', () => {
    // 1 and 2 are readable; anything beyond describes guarantees this build
    // cannot reason about, so it must be refused rather than guessed at.
    const result = validateSession({ ...makeSession(), schemaVersion: 3 })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('پشتیبانی نمی‌شود')
    }
  })

  it('rejects a session whose strokes field is not an array', () => {
    const result = validateSession({ ...makeSession(), strokes: 'not-an-array' })
    expect(result.ok).toBe(false)
  })

  it('rejects a session whose actions field is not an array', () => {
    const result = validateSession({ ...makeSession(), actions: {} })
    expect(result.ok).toBe(false)
  })

  it('rejects a missing session id', () => {
    const result = validateSession({ ...makeSession(), id: '' })
    expect(result.ok).toBe(false)
  })

  it('rejects missing canvas dimensions', () => {
    const result = validateSession({ ...makeSession(), canvas: { width: 0, height: 0 } })
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown tool', () => {
    const result = validateSession(
      makeSession({ strokes: [{ ...makeStroke(), tool: 'brush' } as never] }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('pen')
    }
  })

  it('rejects normalized coordinates outside the 0..1 range', () => {
    const result = validateSession(
      makeSession({
        strokes: [makeStroke({ points: [makePoint({ normalizedX: 1.7 })] })],
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('بین ۰ و ۱')
    }
  })

  it('rejects a non-numeric timestamp', () => {
    const result = validateSession(
      makeSession({
        strokes: [makeStroke({ points: [makePoint({ timeMs: 'later' as never })] })],
      }),
    )
    expect(result.ok).toBe(false)
  })

  it('rejects a negative timestamp', () => {
    const result = validateSession(
      makeSession({
        strokes: [makeStroke({ points: [makePoint({ timeMs: -5 })] })],
      }),
    )
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown pointer type', () => {
    const result = validateSession(
      makeSession({
        strokes: [makeStroke({ points: [makePoint({ pointerType: 'brainwave' as never })] })],
      }),
    )
    expect(result.ok).toBe(false)
  })

  it('rejects a clear event whose affectedStrokeIds is not an array', () => {
    const result = validateSession(
      makeSession({
        actions: [
          { sequence: 1, timeMs: 10, type: 'clear', payload: { affectedStrokeIds: 4 } },
        ],
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('clear')
    }
  })

  it('rejects a clear event whose affectedStrokeIds holds non-strings', () => {
    const result = validateSession(
      makeSession({
        actions: [
          {
            sequence: 1,
            timeMs: 10,
            type: 'clear',
            payload: { affectedStrokeIds: ['a', 7] },
          },
        ],
      }),
    )
    expect(result.ok).toBe(false)
  })

  it('accepts a clear event naming strokes that exist', () => {
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const result = validateSession(
      makeSession({ strokes, actions: [makeClearAction(['a', 'b'], 90)] }),
    )
    expect(result.ok).toBe(true)
  })

  it('rejects an undo event whose strokeId is not a string', () => {
    const result = validateSession(
      makeSession({
        actions: [{ sequence: 1, timeMs: 10, type: 'undo', payload: { strokeId: 12 } }],
      }),
    )
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown action type', () => {
    const result = validateSession(
      makeSession({ actions: [{ sequence: 1, timeMs: 10, type: 'teleport' } as never] }),
    )
    expect(result.ok).toBe(false)
  })

  it('always reports the failure in Persian rather than throwing', () => {
    const result = validateSession({ schemaVersion: 1, id: 5 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Every message must contain Persian characters so the user can read it.
      expect(/[؀-ۿ]/.test(result.error)).toBe(true)
    }
  })
})
