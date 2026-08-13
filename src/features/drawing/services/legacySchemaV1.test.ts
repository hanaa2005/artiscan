/**
 * Legacy schema-1 import.
 *
 * The contract under test: a v1 file is READ, never rejected for being old; its
 * surviving data is preserved byte for byte; and the strokes its destructive
 * Clear deleted are reported as missing rather than invented.
 */

import { describe, expect, it } from 'vitest'
import { validateSession } from './drawingValidator'
import { serializeSession, deserializeSession } from './drawingSerializer'
import { makeStrokeSeries } from '../testing/sessionFixture'
import { computeVisibleStrokes } from '../utils/strokeVisibility'
import type { DrawingStroke } from '../types/drawing.types'

/** A schema-1 stroke: same shape, but the pressure flag has the old name. */
function legacyStroke(stroke: DrawingStroke): Record<string, unknown> {
  const { hasPressureSamples, ...rest } = stroke
  return { ...rest, hasRealPressure: hasPressureSamples }
}

/** Builds a raw schema-1 file. */
function legacyV1File(
  strokes: readonly DrawingStroke[],
  actions: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'legacy-session-1',
    createdAt: '2026-08-01T09:00:00.000Z',
    startedAt: '2026-08-01T09:00:00.000Z',
    canvas: { width: 800, height: 400, devicePixelRatio: 1 },
    strokes: strokes.map(legacyStroke),
    actions: [...actions],
  }
}

describe('legacy v1 import - acceptance', () => {
  it('accepts a schema-1 file and upgrades it to schema 2', () => {
    const result = validateSession(legacyV1File(makeStrokeSeries(2, ['a', 'b'])))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.schemaVersion).toBe(2)
  })

  it('preserves every surviving stroke with its points, timing and tool', () => {
    const strokes = makeStrokeSeries(3, ['a', 'b', 'c'])
    const result = validateSession(legacyV1File(strokes))

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.strokes).toHaveLength(3)
    expect(result.value.strokes.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(result.value.strokes[0]?.points).toHaveLength(3)
    expect(result.value.strokes[0]?.startedAtMs).toBe(strokes[0]?.startedAtMs)
  })

  it('migrates hasRealPressure onto the renamed hasPressureSamples field', () => {
    const [stroke] = makeStrokeSeries(1, ['a'])
    const raw = legacyV1File([{ ...(stroke as DrawingStroke), hasPressureSamples: true }])
    const result = validateSession(raw)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.strokes[0]?.hasPressureSamples).toBe(true)
  })
})

describe('legacy v1 import - history completeness', () => {
  it('marks a clean v1 file as a complete history', () => {
    const result = validateSession(legacyV1File(makeStrokeSeries(2, ['a', 'b'])))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.provenance?.importedFromSchemaVersion).toBe(1)
    expect(result.value.provenance?.historyComplete).toBe(true)
  })

  it('marks a v1 file containing a destructive clear as INCOMPLETE', () => {
    // This is the whole point of the version bump: a v1 clear deleted strokes,
    // so this file cannot be treated as a full recording.
    const raw = legacyV1File(makeStrokeSeries(1, ['survivor']), [
      { sequence: 90, timeMs: 900, type: 'clear', payload: { removedStrokeCount: 4 } },
    ])
    const result = validateSession(raw)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.provenance?.historyComplete).toBe(false)
    expect(result.value.provenance?.note).toContain('ناقص')
  })

  it('never fabricates the strokes a destructive clear removed', () => {
    // The file says four strokes were removed. The upgrade must NOT invent them.
    const raw = legacyV1File(makeStrokeSeries(1, ['survivor']), [
      { sequence: 90, timeMs: 900, type: 'clear', payload: { removedStrokeCount: 4 } },
    ])
    const result = validateSession(raw)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.strokes).toHaveLength(1)
    expect(result.value.strokes[0]?.id).toBe('survivor')
  })

  it('keeps removedStrokeCount as the only surviving trace of the lost strokes', () => {
    const raw = legacyV1File(makeStrokeSeries(1, ['survivor']), [
      { sequence: 90, timeMs: 900, type: 'clear', payload: { removedStrokeCount: 4 } },
    ])
    const result = validateSession(raw)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const clear = result.value.actions.find((action) => action.type === 'clear')
    expect(clear?.payload?.['removedStrokeCount']).toBe(4)
    expect(clear?.payload?.['legacyDestructiveClear']).toBe(true)
  })

  it('gives the upgraded clear an empty id list so it hides nothing that survived', () => {
    const strokes = makeStrokeSeries(2, ['a', 'b'])
    const raw = legacyV1File(strokes, [
      { sequence: 90, timeMs: 900, type: 'clear', payload: { removedStrokeCount: 3 } },
    ])
    const result = validateSession(raw)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const clear = result.value.actions.find((action) => action.type === 'clear')
    expect(clear?.payload?.['affectedStrokeIds']).toEqual([])
    // The strokes that are still in the file were never part of that clear,
    // so blanking the canvas would be wrong.
    expect(computeVisibleStrokes(result.value.strokes, result.value.actions)).toHaveLength(2)
  })

  it('marks the history incomplete when an undo points at a missing stroke', () => {
    // The other symptom of the destructive model: the stroke was dropped on
    // export, leaving a dangling undo behind.
    const raw = legacyV1File(makeStrokeSeries(1, ['a']), [
      { sequence: 90, timeMs: 900, type: 'undo', payload: { strokeId: 'deleted-one' } },
    ])
    const result = validateSession(raw)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.provenance?.historyComplete).toBe(false)
  })
})

describe('legacy v1 import - separation from the v2 rules', () => {
  it('does NOT apply v2 referential integrity to a v1 file', () => {
    // A dangling undo is a defect in a v2 file and normal in a v1 one. Applying
    // the strict rule here would reject a perfectly faithful legacy export.
    const raw = legacyV1File(makeStrokeSeries(1, ['a']), [
      { sequence: 90, timeMs: 900, type: 'undo', payload: { strokeId: 'gone' } },
    ])
    expect(validateSession(raw).ok).toBe(true)
  })

  it('does NOT require affectedStrokeIds on a v1 clear', () => {
    const raw = legacyV1File(makeStrokeSeries(1, ['a']), [
      { sequence: 90, timeMs: 900, type: 'clear', payload: { removedStrokeCount: 2 } },
    ])
    expect(validateSession(raw).ok).toBe(true)
  })

  it('still applies the structural rules to a v1 file', () => {
    // Version tolerance is not a licence for incoherent data: duplicate stroke
    // ids make every id-based lookup ambiguous in any schema version.
    const [stroke] = makeStrokeSeries(1, ['duplicate'])
    const raw = legacyV1File([stroke as DrawingStroke, stroke as DrawingStroke])

    const result = validateSession(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('تکراری')
    }
  })
})

describe('legacy v1 import - provenance travels with the data', () => {
  it('survives a re-export as schema 2', () => {
    // Re-exporting must not launder an incomplete history into a clean-looking
    // v2 file - "this recording has a hole in it" is permanent.
    const raw = legacyV1File(makeStrokeSeries(1, ['a']), [
      { sequence: 90, timeMs: 900, type: 'clear', payload: { removedStrokeCount: 4 } },
    ])
    const imported = validateSession(raw)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return

    const reimported = deserializeSession(serializeSession(imported.value))
    expect(reimported.ok).toBe(true)
    if (!reimported.ok) return

    expect(reimported.value.provenance?.historyComplete).toBe(false)
    expect(reimported.value.provenance?.importedFromSchemaVersion).toBe(1)
  })

  it('leaves a natively recorded session with no provenance note at all', () => {
    const native = validateSession(legacyV1File(makeStrokeSeries(1, ['a'])))
    expect(native.ok).toBe(true)
    if (!native.ok) return
    // A v1 import always carries a note; a v2-native session must not.
    expect(native.value.provenance).toBeDefined()
  })
})
