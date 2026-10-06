/**
 * ArtiScan week 2 - Drawing Trial and derived features.
 *
 * THE LAYERING RULE THAT SHAPES THIS WHOLE FEATURE
 *
 * A DrawingSession is the raw recording and stays exactly as week 1 froze it.
 * Nothing here adds a field to it, and nothing here mutates one. Trial context
 * ("which task, when did it start, how long did it take") and derived numbers
 * ("how far did the pen travel") are DIFFERENT KINDS of data with different
 * trust levels, so they live in a wrapper around the session rather than inside
 * it:
 *
 *     DrawingTrialResult
 *       ├── resultSchemaVersion   version of THIS wrapper
 *       ├── trial                 when and how the trial ran
 *       ├── task                  what the participant was asked to draw
 *       ├── session               canonical DrawingSession v2, untouched
 *       ├── features              derived, always recomputable from `session`
 *       └── timePolicy            derived, from `trial` + `task`
 *
 * Keeping them apart means the raw data can never be corrupted by an analysis
 * bug, and a change to how a feature is computed never forces a migration of
 * recorded sessions.
 */

import type { DrawingSession } from '../../drawing/types/drawing.types'

/**
 * Version of the RESULT WRAPPER, deliberately independent of
 * DrawingSession.schemaVersion.
 *
 * The two describe different things and change for different reasons: adding a
 * feature to the analysis has nothing to do with how strokes are recorded. A
 * shared number would force every stored session to look "outdated" whenever
 * the wrapper evolved, and would make the compatibility policy impossible to
 * reason about.
 */
export const CURRENT_RESULT_SCHEMA_VERSION = 2 as const

/**
 * The first published wrapper version. Still readable, never written again.
 *
 * Version 2 exists because the DrawingFeatures CONTRACT changed: raw versus
 * in-canvas geometry was split apart and the advisory-time block was added. The
 * embedded DrawingSession did NOT change and stays at schemaVersion 2 - bumping
 * it would falsely imply that recordings themselves need migrating.
 *
 * A v1 file is imported by validating its embedded session, discarding its
 * stored v1 features and recomputing the current ones. See
 * services/trialResultValidator.ts.
 */
export const LEGACY_RESULT_SCHEMA_VERSION = 1 as const

/** Phases a trial moves through. See the transition table in docs/trial-schema.md. */
export type TrialStatus =
  /** Nothing selected yet. */
  | 'idle'
  /** A task is chosen; the participant is reading what to draw. */
  | 'instructions'
  /** Counting down to the start of drawing. */
  | 'countdown'
  /** Actively drawing; the session is recording. */
  | 'drawing'
  /** Finished normally. The session is frozen and a result can be built. */
  | 'completed'
  /** Abandoned. No result can be built. */
  | 'cancelled'

/** One thing a participant can be asked to draw. */
export interface DrawingTask {
  /** Stable identifier. Never reuse or renumber - results reference it. */
  id: string
  /** Persian label shown in the UI. */
  labelFa: string
  /** English label, for exports and future analysis. */
  labelEn: string
  /**
   * The matching Google QuickDraw category name.
   *
   * Stored now so a later version can line these recordings up with that
   * dataset. Week 2 neither downloads nor bundles any of it.
   */
  quickDrawCategory: string
  /** Persian instruction text shown before the countdown. */
  instructionFa: string
  /**
   * ADVISORY time in seconds. Null means no recommendation.
   *
   * The name is legacy: nothing enforces it. The trial is never auto-completed
   * when it elapses, because cutting a recording off at a deadline would destroy
   * raw data - the one thing this system exists to preserve. It is displayed as
   * «زمان پیشنهادی», recorded, and compared against the actual duration in
   * TrialTimePolicy. The field name is kept so existing files stay readable.
   */
  timeLimitSeconds: number | null
  /** Disabled tasks stay in the catalog for reference but are not offered. */
  enabled: boolean
}

/**
 * Trial timing.
 *
 * Two clocks on purpose, following the week-1 rule:
 * - `durationMs` is MEASURED, so it comes from performance.now();
 * - the ISO strings are calendar LABELS, so they come from Date.now().
 *
 * They are never mixed: subtracting the ISO strings would reintroduce exactly
 * the wall-clock jumps performance.now() exists to avoid.
 */
export interface TrialTiming {
  /** ISO 8601 wall-clock label for when drawing began. */
  startedAt: string
  /** ISO 8601 wall-clock label for when the trial completed. Null until then. */
  completedAt: string | null
  /** Measured drawing duration in milliseconds. Null until completion. */
  durationMs: number | null
  /** Countdown length actually used, in seconds. */
  countdownSeconds: number
}

/** One run of one task. */
export interface DrawingTrial {
  /** crypto.randomUUID() */
  id: string
  status: TrialStatus
  timing: TrialTiming
  /**
   * The task's ADVISORY time, copied at start so a catalog edit cannot rewrite
   * history. Advisory only - see DrawingTask.timeLimitSeconds.
   */
  timeLimitSeconds: number | null
}

/**
 * How the actual duration compared with the recommendation.
 *
 * Entirely DERIVED from `trial.timing.durationMs` and `trial.timeLimitSeconds`,
 * and recomputed on import exactly like the features. The measured duration is
 * always authoritative: this block reports the comparison, it never adjusts,
 * truncates or flags the recording.
 */
export interface TrialTimePolicy {
  /** The advisory duration in seconds, or null when the task has none. */
  recommendedSeconds: number | null
  /** The measured drawing duration in milliseconds. Authoritative. */
  actualDurationMs: number
  /** False whenever there is no recommendation to exceed. */
  exceededRecommendedTime: boolean
  /** max(0, actualDurationMs - recommendedSeconds * 1000). Zero without a recommendation. */
  overtimeMs: number
}

/** An axis-aligned rectangle covering every recorded point. */
export interface BoundingBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

/**
 * Deterministic, objective measurements derived from a DrawingSession.
 *
 * NOT interpretations. The approved roadmap is explicit that this version
 * extracts objective features and performs no psychological interpretation
 * whatsoever, and nothing in this type may drift from that.
 *
 * Every field is finite. Fields that genuinely have no value when the input
 * lacks the necessary samples are typed `| null` rather than defaulted to zero,
 * because "no pressure was measured" and "the pressure was zero" are different
 * claims and only one of them is true.
 *
 * RAW versus IN-CANVAS (result schema 2)
 *
 * Pointer capture keeps recording after the pointer leaves the surface, so the
 * captured path and the visible path are two different things. Every geometric
 * measurement therefore exists twice, under an explicit name:
 *
 *   raw*        the complete captured pointer path, outside movement included
 *   inCanvas*   only the portion inside the canvas rectangle, segment-clipped
 *
 * The older un-prefixed names are kept as documented ALIASES so existing
 * readers keep working - see docs/feature-extraction.md for the exact table of
 * which alias tracks which explicit field, and which of them changed meaning
 * between result schema 1 and 2.
 */
export interface DrawingFeatures {
  // --- counts -------------------------------------------------------------
  /** Strokes in the canonical append-only history, including hidden ones. */
  totalStrokeCount: number
  /** Strokes still painted after replaying undo / redo / clear. */
  visibleStrokeCount: number
  penStrokeCount: number
  eraserStrokeCount: number
  totalPointCount: number

  // --- inside / outside the canvas ----------------------------------------
  /** Points whose raw pixel coordinates lie within the canvas rectangle. */
  insideCanvasPointCount: number
  /** Points recorded outside it. Kept in the raw data, never deleted. */
  outsideCanvasPointCount: number
  /** outsideCanvasPointCount / totalPointCount. Zero when there are no points. */
  outsideCanvasPointRatio: number
  /** Strokes containing at least one outside point. */
  strokeWithOutsidePointsCount: number

  // --- time ---------------------------------------------------------------
  /** Largest recorded timestamp in the session, in milliseconds. */
  durationMs: number

  // --- geometry: raw ------------------------------------------------------
  /** Total captured travel in canvas pixels, outside movement included. */
  rawPathLengthPx: number
  /**
   * The same travel divided by the canvas size. NOT clamped: a point 200px to
   * the left of a 400px canvas contributes a negative coordinate, because that
   * is where the hand actually was.
   */
  rawPathLengthNormalized: number
  /** Pixel bounding box of every recorded point. Null when there are no points. */
  rawBoundingBox: BoundingBox | null

  // --- geometry: in-canvas ------------------------------------------------
  /**
   * Travel inside the canvas, in pixels, computed by clipping every segment
   * against the canvas rectangle. A segment whose endpoints are both outside
   * still contributes the part that crosses the surface.
   */
  inCanvasPathLengthPx: number
  /** The same clipped travel divided by the canvas size. Always within 0..1 per axis. */
  inCanvasPathLengthNormalized: number
  /** Bounding box of the clipped, visible geometry. Null when nothing is visible. */
  inCanvasBoundingBox: BoundingBox | null
  /**
   * Visible bounding-box area as a fraction of the canvas (0..1).
   *
   * Derived from inCanvasBoundingBox, so movement outside the surface cannot
   * inflate it. This is BOUNDING-BOX coverage, not painted-pixel area: a single
   * diagonal line from corner to corner reports 1.0.
   */
  visibleCanvasCoverageRatio: number

  // --- documented aliases -------------------------------------------------
  /** Alias of rawPathLengthPx. Unchanged since result schema 1. */
  totalPathLengthPx: number
  /**
   * Alias of rawPathLengthNormalized.
   * CHANGED in result schema 2: version 1 summed the CLAMPED normalized values
   * recorded in the session, which understated outside movement.
   */
  totalPathLengthNormalized: number
  /** Alias of rawBoundingBox. Unchanged since result schema 1. */
  boundingBox: BoundingBox | null
  /**
   * The raw bounding box expressed in canvas fractions, unclamped.
   * CHANGED in result schema 2: version 1 used the clamped recorded values, so
   * any excursion beyond the edge collapsed onto it.
   */
  boundingBoxNormalized: BoundingBox | null
  /**
   * Alias of visibleCanvasCoverageRatio.
   * CHANGED in result schema 2: version 1 measured the CLAMPED normalized box,
   * which meant a stroke dragged past two opposite edges reported 100% coverage
   * regardless of what was actually drawn.
   */
  canvasCoverageRatio: number

  // --- action log ---------------------------------------------------------
  undoCount: number
  redoCount: number
  clearCount: number
  toolChangeCount: number
  /** COMMITTED colour changes. Live preview while a picker is open is not an action. */
  colorChangeCount: number
  widthChangeCount: number

  // --- pressure -----------------------------------------------------------
  /** How many points carry a non-null pressure reading. */
  pressureSampleCount: number
  /** Null when no pressure was recorded - never 0, which would be a measurement. */
  minPressure: number | null
  maxPressure: number | null
  meanPressure: number | null

  // --- speed --------------------------------------------------------------
  /**
   * Intervals that could actually support a rate calculation, i.e. those with
   * dt > 0. Publishing the count alongside the averages makes it visible how
   * much data those averages rest on.
   */
  validRawSpeedSampleCount: number
  meanRawSpeedNormalizedPerSecond: number
  maxRawSpeedNormalizedPerSecond: number
  /**
   * Intervals with dt > 0 AND a visible portion.
   *
   * Time is allocated proportionally: the visible part of a segment is credited
   * the same fraction of the interval that it occupies of the segment. A segment
   * that only clips a corner therefore reports the same rate as the whole
   * segment rather than an artificial spike.
   */
  validInCanvasSpeedSampleCount: number
  meanInCanvasSpeedNormalizedPerSecond: number
  maxInCanvasSpeedNormalizedPerSecond: number
  /** Alias of validRawSpeedSampleCount. */
  validSpeedSampleCount: number
  /** Alias of meanRawSpeedNormalizedPerSecond. CHANGED in schema 2 - see the alias note above. */
  meanSpeedNormalizedPerSecond: number
  /** Alias of maxRawSpeedNormalizedPerSecond. CHANGED in schema 2 - see the alias note above. */
  maxSpeedNormalizedPerSecond: number

  // --- pauses -------------------------------------------------------------
  /** Gaps between consecutive strokes longer than PAUSE_THRESHOLD_MS. */
  pauseCount: number
  totalPauseMs: number
  longestPauseMs: number
}

/**
 * A complete, exportable trial outcome.
 *
 * `session` is the source of truth; `features` is a cached derivation of it.
 * On import the features are RECOMPUTED rather than trusted - see
 * services/trialResultValidator.ts for why.
 */
export interface DrawingTrialResult {
  resultSchemaVersion: typeof CURRENT_RESULT_SCHEMA_VERSION
  trial: DrawingTrial
  task: DrawingTask
  session: DrawingSession
  features: DrawingFeatures
  /** Derived from `trial` and the task's advisory time. Recomputed on import. */
  timePolicy: TrialTimePolicy
}
