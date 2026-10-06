/**
 * The stable-graph contract.
 *
 * These tests defend the properties that make the graph readable as evidence
 * rather than as decoration: that S02 names the same stroke in every file and
 * every mode, that a stroke's start and end are its own, that direction follows
 * the recorded point order, that no line is ever drawn between two strokes, and
 * that the two modes answer their two different questions honestly.
 *
 * They run against the artifact - the JSON the PNG is rendered from - because
 * that is where the claims are made. The pixels are checked by eye in Chrome;
 * jsdom has no 2D context and a passing test here is not a passing image.
 */

import { describe, expect, it } from 'vitest'
import {
  buildCriticalTrajectory,
  buildCriticalTrajectoryFileName,
  buildStrokeLabel,
} from './criticalTrajectory'
import {
  FIXTURE_CANVAS,
  fixtureClearSession,
  fixtureNormalSession,
  fixtureStroke,
  fixtureUndoRedoSession,
} from '../testing/graphFixtures'
import {
  makeClearAction,
  makeSession,
  makeUndoAction,
  makeRedoAction,
  timeForSequence,
} from '../../drawing/testing/sessionFixture'
import type { DrawingAction, DrawingSession } from '../../drawing/types/drawing.types'
import type {
  CriticalStrokeSummary,
  CriticalTrajectoryArtifactV2,
  GraphMode,
} from '../types/criticalTrajectory.types'

/** A fixed clock, so two builds of one session are byte-comparable. */
const NOW = () => '2026-01-01T00:00:00.000Z'

function build(session: DrawingSession, mode: GraphMode = 'full_process') {
  return buildCriticalTrajectory(session, { mode, now: NOW })
}

/** The summaries an artifact carries, keyed by stroke id. */
function summaryOf(
  artifact: CriticalTrajectoryArtifactV2,
  strokeId: string,
): CriticalStrokeSummary | undefined {
  return artifact.strokes.find((stroke) => stroke.strokeId === strokeId)
}

/** Nodes belonging to one stroke, in the order the artifact lists them. */
function nodesOf(artifact: CriticalTrajectoryArtifactV2, strokeId: string) {
  return artifact.nodes.filter((node) => node.strokeId === strokeId)
}

function sessionOf(strokes: ReturnType<typeof fixtureStroke>[], actions: DrawingAction[] = []) {
  return makeSession({ canvas: { ...FIXTURE_CANVAS }, strokes, actions })
}

// ---------------------------------------------------------------------------
// Stroke coverage and shape
// ---------------------------------------------------------------------------

describe('graph - stroke coverage', () => {
  it('describes a single stroke with one summary and a start and an end', () => {
    const artifact = build(
      sessionOf([
        fixtureStroke('only', 0, 1, [
          [20, 20],
          [120, 20],
          [220, 90],
        ]),
      ]),
    )

    expect(artifact.strokes).toHaveLength(1)
    const summary = artifact.strokes[0]
    expect(summary?.label).toBe('S01')
    expect(summary?.startNodeId).not.toBeNull()
    expect(summary?.endNodeId).not.toBeNull()
    expect(summary?.startNodeId).not.toBe(summary?.endNodeId)
  })

  it('keeps a single-point stroke as a stroke rather than dropping it', () => {
    const artifact = build(sessionOf([fixtureStroke('dot', 0, 1, [[100, 100]])]))

    expect(artifact.strokes).toHaveLength(1)
    const nodes = nodesOf(artifact, 'dot')
    expect(nodes).toHaveLength(1)
    // A tap has one place, so its start and its end are the same node. Saying
    // so explicitly is more honest than inventing a second point.
    const summary = summaryOf(artifact, 'dot')
    expect(summary?.startNodeId).toBe(summary?.endNodeId)
    expect(nodes[0]?.reasons).toContain('single_point_stroke')
  })

  it('keeps both ends of a very short two-point path', () => {
    const artifact = build(
      sessionOf([
        fixtureStroke('tick', 0, 1, [
          [100, 100],
          [102, 101],
        ]),
      ]),
    )

    // Simplification may never remove a stroke's own endpoints: they are where
    // the pen landed and where it left.
    expect(nodesOf(artifact, 'tick')).toHaveLength(2)
  })

  it('lists multiple strokes in canonical order', () => {
    const artifact = build(fixtureNormalSession())

    expect(artifact.strokes.map((stroke) => stroke.strokeId)).toEqual(['n-1', 'n-2', 'n-3'])
    expect(artifact.strokes.map((stroke) => stroke.order)).toEqual([0, 1, 2])
    expect(artifact.strokes.map((stroke) => stroke.label)).toEqual(['S01', 'S02', 'S03'])
  })
})

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

describe('graph - stroke numbering', () => {
  it('numbers from one with a leading zero, and widens past ninety-nine', () => {
    expect(buildStrokeLabel(0)).toBe('S01')
    expect(buildStrokeLabel(8)).toBe('S09')
    expect(buildStrokeLabel(9)).toBe('S10')
    expect(buildStrokeLabel(99)).toBe('S100')
  })

  it('gives every stroke a distinct label', () => {
    const artifact = build(fixtureUndoRedoSession())
    const labels = artifact.strokes.map((stroke) => stroke.label)

    expect(new Set(labels).size).toBe(labels.length)
  })

  it('keeps a stroke on the same label in both modes', () => {
    const session = fixtureClearSession()
    const full = build(session, 'full_process')
    const final = build(session, 'final_visible')

    // c-3 survived the clear. If final-visible renumbered from its own first
    // stroke, this would be S01 there and S03 here - and two graphs of one
    // session would disagree about which stroke is which.
    expect(summaryOf(full, 'c-3')?.label).toBe('S03')
    expect(summaryOf(final, 'c-3')?.label).toBe('S03')
    expect(summaryOf(final, 'c-4')?.label).toBe('S04')
  })

  it('does not renumber after an undo', () => {
    const session = fixtureUndoRedoSession()
    const final = build(session, 'final_visible')

    // u-2 is gone, but u-4 keeps the number it was drawn with.
    expect(summaryOf(final, 'u-2')).toBeUndefined()
    expect(summaryOf(final, 'u-4')?.label).toBe('S04')
  })

  it('gives the same labels every time the same session is built', () => {
    const session = fixtureNormalSession()

    expect(build(session).strokes.map((s) => s.label)).toEqual(
      build(session).strokes.map((s) => s.label),
    )
  })
})

// ---------------------------------------------------------------------------
// Start, end and direction
// ---------------------------------------------------------------------------

describe('graph - start, end and direction', () => {
  it('matches each start and end to the stroke it belongs to', () => {
    const artifact = build(fixtureNormalSession())

    for (const summary of artifact.strokes) {
      const nodes = nodesOf(artifact, summary.strokeId)
      expect(summary.startNodeId).toBe(nodes[0]?.id)
      expect(summary.endNodeId).toBe(nodes[nodes.length - 1]?.id)
    }
  })

  it('never pairs one stroke start with another stroke end', () => {
    const artifact = build(fixtureNormalSession())
    const nodeStroke = new Map(artifact.nodes.map((node) => [node.id, node.strokeId]))

    for (const summary of artifact.strokes) {
      expect(nodeStroke.get(summary.startNodeId ?? '')).toBe(summary.strokeId)
      expect(nodeStroke.get(summary.endNodeId ?? '')).toBe(summary.strokeId)
    }
  })

  it('takes the start from the first recorded sample, not the leftmost one', () => {
    // Drawn right to left: a renderer that sorted by x would put the start at
    // the wrong end and reverse every arrow.
    const artifact = build(
      sessionOf([
        fixtureStroke('rtl', 0, 1, [
          [300, 50],
          [200, 50],
          [60, 50],
        ]),
      ]),
    )
    const nodes = nodesOf(artifact, 'rtl')

    expect(nodes[0]?.x).toBe(300)
    expect(nodes[nodes.length - 1]?.x).toBe(60)
  })

  it('orders nodes by the recorded sequence, so direction follows the pen', () => {
    const artifact = build(fixtureNormalSession())

    for (const summary of artifact.strokes) {
      const nodes = nodesOf(artifact, summary.strokeId)
      for (let i = 1; i < nodes.length; i += 1) {
        const previous = nodes[i - 1]
        const current = nodes[i]
        expect(current?.sourcePointSequence).toBeGreaterThan(previous?.sourcePointSequence ?? 0)
        expect(current?.timeMs).toBeGreaterThanOrEqual(previous?.timeMs ?? 0)
      }
    }
  })

  it('reports the stroke end time from the stroke, not from the last kept node', () => {
    const session = fixtureNormalSession()
    const artifact = build(session)

    for (const stroke of session.strokes) {
      expect(summaryOf(artifact, stroke.id)?.endedAtMs).toBe(stroke.endedAtMs)
    }
  })
})

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

describe('graph - edges never join two strokes', () => {
  it('draws no path edge between the end of one stroke and the start of the next', () => {
    const artifact = build(fixtureNormalSession())
    const nodeStroke = new Map(artifact.nodes.map((node) => [node.id, node.strokeId]))

    for (const edge of artifact.edges) {
      if (edge.relationType !== 'temporal_path') continue
      const from = nodeStroke.get(edge.from)
      const to = nodeStroke.get(edge.to)
      // The pen was lifted between strokes. A line there would be a distance
      // the hand never travelled on the surface.
      expect(from).toBe(to)
      expect(edge.strokeId).toBe(from)
    }
  })

  it('holds even when strokes are adjacent in time with an action between them', () => {
    const session = sessionOf(
      [
        fixtureStroke('a', 0, 1, [
          [20, 20],
          [80, 20],
        ]),
        fixtureStroke('b', 1, 4, [
          [200, 20],
          [260, 20],
        ]),
      ],
      [
        {
          sequence: 3,
          timeMs: timeForSequence(3),
          type: 'color_change',
          payload: { from: '#000000', to: '#ff0000' },
        },
      ],
    )
    const artifact = build(session)
    const nodeStroke = new Map(artifact.nodes.map((node) => [node.id, node.strokeId]))

    const crossing = artifact.edges.filter(
      (edge) =>
        edge.relationType === 'temporal_path' &&
        nodeStroke.get(edge.from) !== nodeStroke.get(edge.to),
    )
    expect(crossing).toHaveLength(0)
  })

  it('gives every edge two endpoints that exist', () => {
    const artifact = build(fixtureClearSession())
    const ids = new Set([
      ...artifact.nodes.map((node) => node.id),
      ...artifact.actionNodes.map((node) => node.id),
    ])

    for (const edge of artifact.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

describe('graph - stroke status', () => {
  it('marks an undone stroke undone and a redone stroke visible', () => {
    const artifact = build(fixtureUndoRedoSession())

    expect(summaryOf(artifact, 'u-1')?.status).toBe('visible')
    expect(summaryOf(artifact, 'u-2')?.status).toBe('undone')
    // Undone and then redone: the undo was taken back, so nothing about this
    // stroke should still be marked as removed.
    expect(summaryOf(artifact, 'u-3')?.status).toBe('visible')
    expect(summaryOf(artifact, 'u-4')?.status).toBe('visible')
  })

  it('marks cleared strokes cleared and keeps later strokes visible', () => {
    const artifact = build(fixtureClearSession())

    expect(summaryOf(artifact, 'c-1')?.status).toBe('cleared')
    expect(summaryOf(artifact, 'c-2')?.status).toBe('cleared')
    expect(summaryOf(artifact, 'c-3')?.status).toBe('visible')
    expect(summaryOf(artifact, 'c-4')?.status).toBe('visible')
  })

  it('survives repeated undo and redo of the same stroke', () => {
    const session = sessionOf(
      [
        fixtureStroke('a', 0, 1, [
          [20, 20],
          [80, 20],
        ]),
      ],
      [
        makeUndoAction('a', 10),
        makeRedoAction('a', 11),
        makeUndoAction('a', 12),
        makeRedoAction('a', 13),
      ],
    )

    expect(summaryOf(build(session), 'a')?.status).toBe('visible')
  })

  it('reports a stroke undone after a clear as undone, not cleared', () => {
    const session = sessionOf(
      [
        fixtureStroke('a', 0, 1, [
          [20, 20],
          [80, 20],
        ]),
        fixtureStroke('b', 1, 4, [
          [20, 60],
          [80, 60],
        ]),
      ],
      [makeClearAction(['a', 'b'], 10), makeUndoAction('a', 11)],
    )
    const artifact = build(session)

    // `a` left the canvas because of the clear; the later undo of an already
    // hidden stroke must not rewrite why it went.
    expect(summaryOf(artifact, 'a')?.status).toBe('cleared')
  })

  it('marks every stroke visible when nothing was ever hidden', () => {
    const artifact = build(fixtureNormalSession())

    expect(artifact.strokes.every((stroke) => stroke.status === 'visible')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The two modes
// ---------------------------------------------------------------------------

describe('graph - full process versus final visible', () => {
  it('declares its mode in the artifact', () => {
    expect(build(fixtureNormalSession(), 'full_process').mode).toBe('full_process')
    expect(build(fixtureNormalSession(), 'final_visible').mode).toBe('final_visible')
  })

  it('defaults to full_process', () => {
    expect(buildCriticalTrajectory(fixtureNormalSession(), { now: NOW }).mode).toBe(
      'full_process',
    )
  })

  it('produces identical strokes and nodes in both modes when nothing was hidden', () => {
    const session = fixtureNormalSession()

    const full = build(session, 'full_process')
    const final = build(session, 'final_visible')
    expect(final.strokes).toEqual(full.strokes)
    expect(final.nodes).toEqual(full.nodes)
  })

  it('drops hidden strokes from final_visible and keeps them in full_process', () => {
    const session = fixtureClearSession()

    expect(build(session, 'full_process').strokes.map((s) => s.strokeId)).toEqual([
      'c-1',
      'c-2',
      'c-3',
      'c-4',
    ])
    expect(build(session, 'final_visible').strokes.map((s) => s.strokeId)).toEqual([
      'c-3',
      'c-4',
    ])
  })

  it('contains no cleared or undone stroke in final_visible', () => {
    for (const session of [fixtureUndoRedoSession(), fixtureClearSession()]) {
      const final = build(session, 'final_visible')
      expect(final.strokes.every((stroke) => stroke.status === 'visible')).toBe(true)
      expect(final.nodes.every((node) =>
        final.strokes.some((stroke) => stroke.strokeId === node.strokeId),
      )).toBe(true)
    }
  })

  it('still reports the FULL raw counts in final_visible, so nothing is hidden twice', () => {
    const session = fixtureClearSession()
    const final = build(session, 'final_visible')

    // The file must not pretend the session only ever had two strokes.
    expect(final.quality.rawStrokeCount).toBe(session.strokes.length)
  })

  it('names the two graph files differently', () => {
    const full = buildCriticalTrajectoryFileName('abcdef1234', '2026-01-01', 'full_process')
    const final = buildCriticalTrajectoryFileName('abcdef1234', '2026-01-01', 'final_visible')

    expect(full).toContain('full-process-graph')
    expect(final).toContain('final-visible-graph')
    expect(full).not.toBe(final)
  })
})

// ---------------------------------------------------------------------------
// Out-of-canvas geometry and actions
// ---------------------------------------------------------------------------

describe('graph - geometry and timeline events', () => {
  it('keeps points recorded outside the canvas instead of clamping them', () => {
    const artifact = build(
      sessionOf([
        fixtureStroke('out', 0, 1, [
          [-60, 40],
          [100, 40],
          [520, 40],
        ]),
      ]),
    )
    const nodes = nodesOf(artifact, 'out')

    // The excursion happened. Clamping it would move a sample the recording
    // actually contains, and the graph would misreport where the pen was.
    expect(nodes.some((node) => node.x < 0)).toBe(true)
    expect(nodes.some((node) => node.x > FIXTURE_CANVAS.width)).toBe(true)
  })

  it('records a history-changing action between two strokes as an action node', () => {
    const session = sessionOf(
      [
        fixtureStroke('a', 0, 1, [
          [20, 20],
          [80, 20],
        ]),
        fixtureStroke('b', 1, 12, [
          [20, 60],
          [80, 60],
        ]),
      ],
      [makeUndoAction('a', 8), makeRedoAction('a', 9)],
    )
    const artifact = build(session)

    expect(artifact.actionNodes.map((node) => node.actionType)).toEqual(['undo', 'redo'])
    // An action node carries a time and no coordinates: it happened in time,
    // not in a place, so it can never put a mark on the canvas.
    for (const node of artifact.actionNodes) {
      expect(Object.hasOwn(node, 'x')).toBe(false)
      expect(Object.hasOwn(node, 'y')).toBe(false)
    }
  })

  it('leaves a settings change out of the graph rather than making it clutter', () => {
    // A width change alters no stroke that was already drawn and moves nothing
    // on the canvas. It stays in the session, where it is recorded in full.
    const artifact = build(fixtureNormalSession())

    expect(artifact.actionNodes).toHaveLength(0)
  })

  it('carries the colour and width of each stroke into its summary', () => {
    const session = sessionOf([
      fixtureStroke('a', 0, 1, [[20, 20], [80, 20]], { color: '#ff0000', width: 2 }),
      fixtureStroke('b', 1, 4, [[20, 60], [80, 60]], { color: '#0000ff', width: 9 }),
    ])
    const artifact = build(session)

    expect(summaryOf(artifact, 'a')?.color).toBe('#ff0000')
    expect(summaryOf(artifact, 'a')?.width).toBe(2)
    expect(summaryOf(artifact, 'b')?.color).toBe('#0000ff')
    expect(summaryOf(artifact, 'b')?.width).toBe(9)
  })

  it('reports how many raw samples each stroke had, so the loss is visible', () => {
    const session = fixtureNormalSession()
    const artifact = build(session)

    for (const stroke of session.strokes) {
      const summary = summaryOf(artifact, stroke.id)
      expect(summary?.sourcePointCount).toBe(stroke.points.length)
      expect(summary?.nodeCount).toBeLessThanOrEqual(stroke.points.length)
    }
  })

  it('writes the thresholds it used into the file', () => {
    const artifact = build(fixtureNormalSession())

    expect(artifact.algorithm.thresholds.temporalGapBoundaryMs).toBeGreaterThan(0)
    expect(artifact.algorithm.thresholds.directionChangeDegrees).toBeGreaterThan(0)
  })

  it('never calls a temporal gap a pause', () => {
    const serialized = JSON.stringify(build(fixtureNormalSession()))

    expect(serialized).not.toContain('pause_boundary')
  })
})

// ---------------------------------------------------------------------------
// Purity and determinism
// ---------------------------------------------------------------------------

describe('graph - purity and determinism', () => {
  it('never mutates the session it was built from', () => {
    for (const session of [
      fixtureNormalSession(),
      fixtureUndoRedoSession(),
      fixtureClearSession(),
    ]) {
      const before = structuredClone(session)
      build(session, 'full_process')
      build(session, 'final_visible')
      expect(session).toEqual(before)
    }
  })

  it('produces byte-identical output from identical input', () => {
    for (const mode of ['full_process', 'final_visible'] as const) {
      const session = fixtureClearSession()
      expect(JSON.stringify(build(session, mode))).toBe(JSON.stringify(build(session, mode)))
    }
  })

  it('handles a session with no strokes at all', () => {
    const artifact = build(makeSession({ canvas: { ...FIXTURE_CANVAS }, strokes: [], actions: [] }))

    expect(artifact.strokes).toHaveLength(0)
    expect(artifact.nodes).toHaveLength(0)
    expect(artifact.edges).toHaveLength(0)
  })

  it('handles a session where everything was cleared', () => {
    const session = sessionOf(
      [
        fixtureStroke('a', 0, 1, [
          [20, 20],
          [80, 20],
        ]),
      ],
      [makeClearAction(['a'], 10)],
    )
    const final = build(session, 'final_visible')

    expect(final.strokes).toHaveLength(0)
    expect(final.nodes).toHaveLength(0)
    // The canvas is still declared, so an empty graph still renders at the
    // right size rather than collapsing to nothing.
    expect(final.canvas.width).toBe(FIXTURE_CANVAS.width)
  })
})
