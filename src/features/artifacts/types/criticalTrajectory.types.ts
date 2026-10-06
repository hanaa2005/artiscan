/**
 * The critical trajectory artifact.
 *
 * WHAT IT IS, STATED IN THE TYPE ITSELF
 *
 * A LOSSY, DERIVED summary of a canonical DrawingSession: the points that carry
 * the shape and the timing, and nothing else. `lossy: true` is a required
 * literal rather than a boolean, so a file that omits it cannot typecheck and
 * cannot be produced by accident.
 *
 * WHAT IT IS NOT
 *
 * Not a session, not a replacement for one, and not importable as one. It has
 * its own `artifactSchemaVersion`, deliberately independent of
 * DrawingSession.schemaVersion: the two change for entirely different reasons,
 * and a shared number would make every recording look outdated whenever the
 * analysis format moved.
 *
 * TRACEABILITY IS THE POINT
 *
 * Every node names the raw point it came from - `sourcePointSequence` and
 * `sourcePointIndex` - so any claim the graph makes can be checked against the
 * canonical session. No node is ever synthesised: the coordinates, the
 * timestamp and the pressure of a node are copied from a real sample, never
 * interpolated. That is what keeps this a summary of evidence rather than a
 * model of it.
 *
 * NO INTERPRETATION
 *
 * Every reason below is a geometric or temporal measurement with a stated
 * threshold. "Direction changed by 103 degrees" is in scope. What that might
 * mean about the person is not, and nothing in this file may drift towards it.
 */

import type { DrawingTool } from '../../drawing/types/drawing.types'
import type { StrokeStatus } from '../../drawing/utils/strokeVisibility'

/** Bumped when the MEANING of this artifact changes. Independent of the session schema. */
export const CRITICAL_TRAJECTORY_SCHEMA_VERSION = 2 as const

/**
 * The first published artifact version. Still readable, never written again.
 *
 * Version 2 exists because the artifact's MEANING changed in two ways that a
 * reader must not get wrong:
 *
 * 1. It now declares a `mode`. A v1 file described the whole recorded history
 *    with no way to say so, and reading it as if it were a final-visible graph
 *    would silently present cleared and undone strokes as the finished drawing.
 * 2. `pause_boundary` was renamed `temporal_gap_boundary`. The threshold behind
 *    it is 120 ms - an order of magnitude below the project's actual pause
 *    policy of 500 ms - so the old name claimed a finding the data never
 *    supported.
 *
 * `DrawingSession.schemaVersion` is untouched: nothing about how strokes are
 * recorded changed.
 */
export const LEGACY_CRITICAL_TRAJECTORY_SCHEMA_VERSION = 1 as const

/**
 * Which slice of the recording an artifact describes.
 *
 * These are two different questions and a file has to say which one it answers:
 *
 * `full_process`  every stroke in the append-only history, whatever became of
 *                 it - what the participant actually did.
 * `final_visible` only the strokes still painted after the whole timeline is
 *                 replayed - what the drawing ended up as.
 *
 * A drawing that was cleared halfway through produces two very different
 * pictures, and neither is a defect.
 */
export type GraphMode = 'full_process' | 'final_visible'

/** Bumped when the selection algorithm changes, so old files stay interpretable. */
export const CRITICAL_TRAJECTORY_ALGORITHM_VERSION = '1.0.0'

export const CRITICAL_TRAJECTORY_ALGORITHM_NAME = 'mandatory-points-plus-rdp'

/**
 * Why a point was kept.
 *
 * ONLY REASONS THAT ARE ACTUALLY IMPLEMENTED AND TESTED APPEAR HERE.
 *
 * Speed and acceleration extrema, stroke intersections and region revisits were
 * considered and are deliberately ABSENT: they need a motion engine that does
 * not exist yet, and reserving their names now would let a later reader assume
 * a file was checked for something it never was. They will be added when they
 * are implemented, and the algorithm version will move when they are.
 */
export type CriticalPointReason =
  /** First sample of a stroke. Always kept. */
  | 'stroke_start'
  /** Last sample of a stroke. Always kept. */
  | 'stroke_end'
  /** The only sample of a stroke - a tap. Always kept. */
  | 'single_point_stroke'
  /**
   * Either side of a temporal gap wider than TEMPORAL_GAP_BOUNDARY_MS.
   *
   * DELIBERATELY NOT CALLED A PAUSE. Its threshold is 120 ms, chosen so the
   * simplified path keeps the recording's temporal structure; the project's
   * pause policy is PAUSE_THRESHOLD_MS = 500 and lives in feature extraction.
   * The old name `pause_boundary` (artifact v1) asserted a pause on evidence
   * four times weaker than the pause definition requires.
   */
  | 'temporal_gap_boundary'
  /** Turn sharper than the direction threshold. */
  | 'direction_change'
  /** Pen pressure moved by more than the pressure threshold. */
  | 'pressure_change'
  /** First sample inside the canvas after being outside it. */
  | 'canvas_entry'
  /** Last sample inside the canvas before leaving it. */
  | 'canvas_exit'
  /** Required by RDP to keep the reconstruction within tolerance. */
  | 'geometric_support'

/** A kept point, traceable to the exact raw sample it came from. */
export interface CriticalNode {
  id: string
  strokeId: string
  /** The `sequence` of the raw PointSample. The link back to the evidence. */
  sourcePointSequence: number
  /** Its index within that stroke's `points` array. */
  sourcePointIndex: number
  /** Copied verbatim from the raw sample - never interpolated, never rounded. */
  x: number
  y: number
  normalizedX: number
  normalizedY: number
  timeMs: number
  /** Every reason that applies, in a stable order. Never empty. */
  reasons: CriticalPointReason[]
}

/**
 * One stroke, as the graph presents it.
 *
 * WHY LABELS LIVE IN THE ARTIFACT
 *
 * `S01`, `S02`, ... have to mean the same thing in the JSON, on the PNG and in
 * any selector, across re-renders and re-exports. Deriving them at render time
 * from whatever order a map or an object happened to yield is exactly how two
 * views of one recording start disagreeing. So the label is computed once, from
 * the canonical append-only order, and written down.
 *
 * The numbering is over the FULL history in both modes: a stroke keeps the same
 * label whether or not it survived to the final drawing, so the two graphs can
 * be read side by side.
 */
export interface CriticalStrokeSummary {
  strokeId: string
  /** Index in the canonical append-only history, from 0. */
  order: number
  /** Stable display label derived from `order`: S01, S02, ... */
  label: string
  /** Final state after the whole timeline is replayed. */
  status: StrokeStatus
  /** Node ids of the first and last kept sample. Null for a stroke with no nodes. */
  startNodeId: string | null
  endNodeId: string | null
  /** Kept nodes for this stroke, in path order. */
  nodeCount: number
  /** Raw samples the stroke actually had. Lets a reader see the simplification. */
  sourcePointCount: number
  /** Copied from the stroke so a renderer needs no second lookup. */
  tool: DrawingTool
  color: string
  width: number
  startedAtMs: number
  /**
   * Copied from the stroke's own field, NOT recomputed from the last kept
   * point: simplification can drop the final sample, and rebuilding the end
   * time from what survived would quietly shorten the stroke.
   */
  endedAtMs: number
}

/**
 * A timeline event that is NOT a point.
 *
 * Undo, redo and clear are actions, not places the pen was. Turning them into
 * points would put marks on a canvas where nothing was ever drawn, so they live
 * in their own array with their own id space and their own source reference.
 */
export interface CriticalActionNode {
  id: string
  /** The `sequence` of the raw DrawingAction. */
  sourceActionSequence: number
  actionType: string
  timeMs: number
}

/**
 * Relations that are produced.
 *
 * `temporal_path` joins consecutive kept points WITHIN one stroke.
 * `action_transition` joins an action node to its timeline neighbours.
 *
 * There is deliberately NO edge between points of two different strokes. The
 * pen was lifted in between, so any line drawn there would be a distance the
 * hand never travelled on the surface; stroke ordering is carried by node
 * order and timestamps instead. `spatial_relation` is likewise absent until it
 * has a tested definition.
 */
export type CriticalEdgeRelation = 'temporal_path' | 'action_transition'

export interface CriticalEdge {
  id: string
  from: string
  to: string
  relationType: CriticalEdgeRelation
  /** Null for an edge that is not inside a single stroke. */
  strokeId: string | null
  durationMs: number | null
  /** Straight-line distance between the two endpoints. */
  directDistancePx: number | null
  /** Length of the RAW path between them - what the hand actually travelled. */
  sourcePathLengthPx: number | null
  /** Length of the simplified path between them: here, the direct distance. */
  simplifiedPathLengthPx: number | null
}

/** How aggressively to simplify. `high` is the default. */
export type QualityProfileName = 'high' | 'balanced' | 'compact'

/**
 * The accuracy a profile must achieve.
 *
 * INITIAL ENGINEERING THRESHOLDS - see docs. These are a starting point chosen
 * to be conservative, NOT a scientifically validated standard, and the report
 * labels them as such. They may move once there is benchmark evidence from real
 * recordings.
 */
export interface QualityThresholds {
  minimumMaskIoU: number
  maximumGeometricDeviationPx: number
  maximumPathLengthErrorRatio: number
  maximumBoundingBoxErrorRatio: number
}

/** Measured accuracy of one simplification. Every field is finite or null. */
export interface CriticalQuality {
  rawStrokeCount: number
  rawPointCount: number
  criticalPointCount: number
  /** criticalPointCount / rawPointCount. 0 when there are no points. */
  retentionRatio: number
  rawJsonBytes: number
  criticalJsonBytes: number
  /** 1 - criticalJsonBytes / rawJsonBytes. Negative if the artifact is larger. */
  sizeReductionRatio: number
  /** Null when the two masks could not be compared. */
  maskIoU: number | null
  maxGeometricDeviationPx: number | null
  pathLengthErrorRatio: number | null
  boundingBoxErrorRatio: number | null
  /** Whether the measurements met the requested profile. */
  meetsProfile: boolean
  /**
   * Set when the profile could NOT be met even with every point kept.
   *
   * A quality failure is always reported, never hidden and never silently
   * downgraded to a weaker profile.
   */
  qualityFailureReason: string | null
}

/** Every threshold that shaped a build, written into the file it produced. */
export interface CriticalThresholdConfig {
  /**
   * Gap width that forces a kept point on both sides, in ms.
   *
   * NOT the project's pause threshold - see `temporal_gap_boundary`.
   */
  temporalGapBoundaryMs: number
  directionChangeDegrees: number
  pressureChangeDelta: number
}

export interface CriticalTrajectoryArtifactV2 {
  artifactSchemaVersion: typeof CRITICAL_TRAJECTORY_SCHEMA_VERSION
  artifactType: 'critical_trajectory'
  /** Which slice of the recording this file describes. Required. */
  mode: GraphMode
  /** The canonical session this was derived from. Required. */
  sourceSessionId: string
  sourceSchemaVersion: number
  createdAt: string
  /** Required literal. This artifact can never claim to be lossless. */
  lossy: true

  algorithm: {
    name: typeof CRITICAL_TRAJECTORY_ALGORITHM_NAME
    version: string
    /** Coordinates are in the session's fixed logical canvas pixel space. */
    coordinateSpace: 'logical_canvas_px'
    /** The tolerance actually used, after the quality search. */
    tolerancePx: number
    qualityProfile: QualityProfileName
    /** The renderer whose coverage model produced maskIoU. */
    maskRendererVersion: string
    /** The thresholds in force, so a file can be interpreted without the source. */
    thresholds: CriticalThresholdConfig
  }

  /** Every stroke this artifact covers, in canonical order. */
  strokes: CriticalStrokeSummary[]

  quality: CriticalQuality

  /** The session's logical canvas. Node coordinates belong to this space. */
  canvas: {
    width: number
    height: number
  }

  nodes: CriticalNode[]
  actionNodes: CriticalActionNode[]
  edges: CriticalEdge[]
}
