/**
 * SECTION 18 - the three reference fixtures, each taken through all seven
 * outputs of this milestone.
 *
 * The other test files each defend one artifact. This one defends the
 * RELATIONSHIPS BETWEEN them, which is where a milestone like this actually
 * breaks: the graph says S03 was cleared while the mask still paints it, or the
 * final-visible mask contains ink the final-visible graph has no stroke for.
 * Those disagreements are invisible when each file is checked alone.
 *
 * THE SEVEN OUTPUTS
 *
 *   1. raw-session.json.gz        lossless, the record itself
 *   2. full-process-graph.json
 *   3. final-visible-graph.json
 *   4. full-process-graph.png
 *   5. final-visible-graph.png
 *   6. full-process-mask.png
 *   7. final-visible-mask.png
 *
 * Outputs 4-7 are PNG files, and jsdom has no 2D context, so what is checked
 * here is everything up to the encoder: the artifact each image is rendered
 * from, the exact bytes handed to putImageData for the masks, and the file
 * names. The IMAGES themselves are looked at by eye in Chrome - see
 * docs/graph-mask-manual-test-checklist.md. A green run of this file is not a
 * statement about pixels.
 */

import { describe, expect, it } from 'vitest'
import { buildCriticalTrajectory, buildCriticalTrajectoryFileName } from './criticalTrajectory'
import { buildCriticalPngFileName } from './artifactPngRenderer'
import {
  MASK_BACKGROUND_VALUE,
  MASK_FOREGROUND_VALUE,
  buildBinaryMask,
  buildBinaryMaskFileName,
  maskToRgbaBytes,
  selectStrokesForMode,
} from './binaryMaskPng'
import { serializeCriticalTrajectory, validateCriticalTrajectory } from './criticalTrajectoryValidator'
import { buildGzipFileName, gunzipToText, gzipText } from './gzipCodec'
import { serializeSession, deserializeSession } from '../../drawing/services/drawingSerializer'
import { computeStrokeStatuses } from '../../drawing/utils/strokeVisibility'
import {
  fixtureClearSession,
  fixtureNormalSession,
  fixtureUndoRedoSession,
} from '../testing/graphFixtures'
import type { DrawingSession } from '../../drawing/types/drawing.types'
import type { BinaryMask } from '../utils/rasterMask'

/** A fixed clock and stamp, so a rebuild is comparable byte for byte. */
const NOW = () => '2026-01-01T00:00:00.000Z'
const STAMP = '2026-01-01'

interface Fixture {
  name: string
  session: DrawingSession
  /** The statuses this fixture exists to exercise. */
  expectedStatuses: Record<string, 'visible' | 'cleared' | 'undone'>
}

const FIXTURES: Fixture[] = [
  {
    name: 'A - normal',
    session: fixtureNormalSession(),
    expectedStatuses: { 'n-1': 'visible', 'n-2': 'visible', 'n-3': 'visible' },
  },
  {
    name: 'B - undo/redo',
    session: fixtureUndoRedoSession(),
    // u-2 stays undone; u-3 was undone and redone, so it is visible again.
    expectedStatuses: { 'u-1': 'visible', 'u-2': 'undone', 'u-3': 'visible', 'u-4': 'visible' },
  },
  {
    name: 'C - clear',
    session: fixtureClearSession(),
    expectedStatuses: { 'c-1': 'cleared', 'c-2': 'cleared', 'c-3': 'visible', 'c-4': 'visible' },
  },
]

/** Everything this milestone produces from one session. */
interface SevenOutputs {
  // Narrowed exactly as gzipCodec narrows it: a SharedArrayBuffer-backed view
  // cannot be handed to a stream writer.
  gzBytes: Uint8Array<ArrayBuffer>
  gzFileName: string
  fullGraphJson: string
  visibleGraphJson: string
  fullGraphFileName: string
  visibleGraphFileName: string
  fullPngFileName: string
  visiblePngFileName: string
  fullMask: BinaryMask
  visibleMask: BinaryMask
  fullMaskFileName: string
  visibleMaskFileName: string
}

async function produceAll(session: DrawingSession): Promise<SevenOutputs> {
  const fullArtifact = buildCriticalTrajectory(session, { mode: 'full_process', now: NOW })
  const visibleArtifact = buildCriticalTrajectory(session, { mode: 'final_visible', now: NOW })

  return {
    gzBytes: await gzipText(serializeSession(session)),
    gzFileName: buildGzipFileName(session.id, STAMP),
    fullGraphJson: serializeCriticalTrajectory(fullArtifact),
    visibleGraphJson: serializeCriticalTrajectory(visibleArtifact),
    fullGraphFileName: buildCriticalTrajectoryFileName(session.id, STAMP, 'full_process'),
    visibleGraphFileName: buildCriticalTrajectoryFileName(session.id, STAMP, 'final_visible'),
    fullPngFileName: buildCriticalPngFileName(session.id, STAMP, 'full_process'),
    visiblePngFileName: buildCriticalPngFileName(session.id, STAMP, 'final_visible'),
    fullMask: buildBinaryMask(session, 'full_process'),
    visibleMask: buildBinaryMask(session, 'final_visible'),
    fullMaskFileName: buildBinaryMaskFileName(session.id, STAMP, 'full_process'),
    visibleMaskFileName: buildBinaryMaskFileName(session.id, STAMP, 'final_visible'),
  }
}

/** Indices of the foreground pixels in a mask. */
function foregroundIndices(mask: BinaryMask): Set<number> {
  const found = new Set<number>()
  for (let index = 0; index < mask.data.length; index += 1) {
    if (mask.data[index] !== 0) found.add(index)
  }
  return found
}

describe.each(FIXTURES)('$name - all seven outputs', (fixture) => {
  it('produces seven files with seven distinct names', async () => {
    const out = await produceAll(fixture.session)

    const names = [
      out.gzFileName,
      out.fullGraphFileName,
      out.visibleGraphFileName,
      out.fullPngFileName,
      out.visiblePngFileName,
      out.fullMaskFileName,
      out.visibleMaskFileName,
    ]

    expect(names).toHaveLength(7)
    // Seven distinct names, because two artifacts that answer different
    // questions must not be able to overwrite each other in a download folder.
    expect(new Set(names).size).toBe(7)
    for (const name of names) {
      expect(name).toContain(fixture.session.id.slice(0, 8))
      expect(name).toContain(STAMP)
    }
    expect(out.gzFileName.endsWith('.json.gz')).toBe(true)
    expect(out.fullGraphFileName.endsWith('.json')).toBe(true)
    expect(out.fullPngFileName.endsWith('.png')).toBe(true)
    expect(out.fullMaskFileName.endsWith('.png')).toBe(true)
  })

  it('output 1 recovers the session exactly', async () => {
    const out = await produceAll(fixture.session)
    const text = serializeSession(fixture.session)

    const unzipped = await gunzipToText(out.gzBytes)
    expect(unzipped.ok).toBe(true)
    if (!unzipped.ok) return

    // Character for character, then value for value after a parse. Gzip is a
    // transport encoding here and nothing else.
    expect(unzipped.value).toBe(text)
    const parsed = deserializeSession(unzipped.value)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual(fixture.session)
  })

  it('outputs 2 and 3 declare their own mode and validate', async () => {
    const out = await produceAll(fixture.session)

    const full = validateCriticalTrajectory(JSON.parse(out.fullGraphJson))
    const visible = validateCriticalTrajectory(JSON.parse(out.visibleGraphJson))
    expect(full.ok).toBe(true)
    expect(visible.ok).toBe(true)
    if (!full.ok || !visible.ok) return

    expect(full.value.mode).toBe('full_process')
    expect(visible.value.mode).toBe('final_visible')
  })

  it('the graph statuses match the shared derivation, not a second opinion', async () => {
    const out = await produceAll(fixture.session)
    const full = validateCriticalTrajectory(JSON.parse(out.fullGraphJson))
    expect(full.ok).toBe(true)
    if (!full.ok) return

    const statuses = computeStrokeStatuses(fixture.session.strokes, fixture.session.actions)

    for (const [strokeId, expected] of Object.entries(fixture.expectedStatuses)) {
      // Two independent checks on purpose: the fixture's documented intent, and
      // the derivation the canvas itself uses. If the graph ever disagrees with
      // the canvas, one of these fails.
      expect(statuses.get(strokeId)).toBe(expected)
      expect(full.value.strokes.find((s) => s.strokeId === strokeId)?.status).toBe(expected)
    }
  })

  it('keeps every stroke on the same label in both graphs', async () => {
    const out = await produceAll(fixture.session)
    const full = validateCriticalTrajectory(JSON.parse(out.fullGraphJson))
    const visible = validateCriticalTrajectory(JSON.parse(out.visibleGraphJson))
    if (!full.ok || !visible.ok) throw new Error('fixture artifacts must validate')

    for (const summary of visible.value.strokes) {
      const inFull = full.value.strokes.find((s) => s.strokeId === summary.strokeId)
      // S03 names the same stroke in both files. Renumbering the visible graph
      // to 1..n would make the two files impossible to read side by side.
      expect(inFull?.label).toBe(summary.label)
      expect(inFull?.order).toBe(summary.order)
    }
  })

  it('output 3 contains only strokes that are still on the canvas', async () => {
    const out = await produceAll(fixture.session)
    const visible = validateCriticalTrajectory(JSON.parse(out.visibleGraphJson))
    if (!visible.ok) throw new Error('fixture artifact must validate')

    const expectedVisible = Object.entries(fixture.expectedStatuses)
      .filter(([, status]) => status === 'visible')
      .map(([id]) => id)

    expect(visible.value.strokes.map((s) => s.strokeId).sort()).toEqual([...expectedVisible].sort())
    for (const summary of visible.value.strokes) {
      expect(summary.status).toBe('visible')
    }
  })

  it('outputs 6 and 7 contain nothing but 0 and 255', async () => {
    const out = await produceAll(fixture.session)

    for (const mask of [out.fullMask, out.visibleMask]) {
      const bytes = maskToRgbaBytes(mask)
      expect(bytes.length).toBe(mask.width * mask.height * 4)

      const seen = new Set<number>()
      for (let index = 0; index < bytes.length; index += 1) {
        seen.add(bytes[index]!)
      }
      // The whole binary claim, on real fixture geometry rather than a
      // hand-placed test shape.
      for (const value of seen) {
        expect([MASK_BACKGROUND_VALUE, MASK_FOREGROUND_VALUE]).toContain(value)
      }
    }
  })

  it('the masks agree with the graphs about what is still on the canvas', async () => {
    const out = await produceAll(fixture.session)

    const visibleStrokes = selectStrokesForMode(fixture.session, 'final_visible')
    const expectedVisible = Object.entries(fixture.expectedStatuses).filter(
      ([, status]) => status === 'visible',
    )

    // Same population as the final-visible graph, counted independently.
    expect(visibleStrokes).toHaveLength(expectedVisible.length)

    const full = foregroundIndices(out.fullMask)
    const partial = foregroundIndices(out.visibleMask)
    // Hiding a stroke can only remove ink, never add it. A pixel in the
    // final-visible mask that the full-process mask does not have would mean
    // one of the two rasterizations used different geometry.
    for (const index of partial) {
      expect(full.has(index)).toBe(true)
    }
  })

  it('both masks are exactly the canvas size, whatever was hidden', async () => {
    const out = await produceAll(fixture.session)

    for (const mask of [out.fullMask, out.visibleMask]) {
      expect(mask.width).toBe(fixture.session.canvas.width)
      expect(mask.height).toBe(fixture.session.canvas.height)
    }
  })

  it('produces all seven outputs without touching the session', async () => {
    const session = fixture.session
    const before = JSON.parse(JSON.stringify(session)) as DrawingSession

    await produceAll(session)

    // The canonical record is read-only to every derivation in this milestone.
    expect(session).toEqual(before)
  })

  it('produces identical outputs when run twice', async () => {
    const first = await produceAll(fixture.session)
    const second = await produceAll(fixture.session)

    expect(second.fullGraphJson).toBe(first.fullGraphJson)
    expect(second.visibleGraphJson).toBe(first.visibleGraphJson)
    expect([...second.fullMask.data]).toEqual([...first.fullMask.data])
    expect([...second.visibleMask.data]).toEqual([...first.visibleMask.data])
  })
})

describe('the fixtures differ from each other in the way the milestone needs', () => {
  it('A agrees between modes, B and C do not', async () => {
    const normal = await produceAll(fixtureNormalSession())
    const undoRedo = await produceAll(fixtureUndoRedoSession())
    const cleared = await produceAll(fixtureClearSession())

    // A is the control: nothing was hidden, so the two masks must be identical
    // pixel for pixel. Any difference here is a bug in the mode selection.
    expect([...normal.visibleMask.data]).toEqual([...normal.fullMask.data])

    // B and C must diverge, otherwise the modes are not doing anything and the
    // tests above would pass vacuously.
    expect([...undoRedo.visibleMask.data]).not.toEqual([...undoRedo.fullMask.data])
    expect([...cleared.visibleMask.data]).not.toEqual([...cleared.fullMask.data])
  })

  it('C keeps the labels of the cleared strokes out of circulation', async () => {
    const out = await produceAll(fixtureClearSession())
    const visible = validateCriticalTrajectory(JSON.parse(out.visibleGraphJson))
    if (!visible.ok) throw new Error('fixture artifact must validate')

    // c-3 and c-4 are the third and fourth strokes ever drawn, so they are S03
    // and S04 even in a file where they are the only two present. Numbering
    // them S01 and S02 would claim the session began with them.
    expect(visible.value.strokes.map((s) => s.label)).toEqual(['S03', 'S04'])
  })
})
