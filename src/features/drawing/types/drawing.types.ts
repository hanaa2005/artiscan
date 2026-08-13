/**
 * ArtiScan - Core data model.
 *
 * ARCHITECTURAL RULE (from the approved project roadmap):
 * The event log IS the primary data of this system. The rendered picture,
 * any extracted feature and any future report are DERIVED from this data.
 * Therefore this model must be complete enough to rebuild the drawing
 * exactly, and it must never be mutated for display reasons.
 */

/** The tools available in week 1. */
export type DrawingTool = 'pen' | 'eraser'

/** How the user physically produced the input. */
export type PointerInputType = 'mouse' | 'pen' | 'touch' | 'unknown'

/**
 * A single sampled point of a stroke.
 *
 * Both raw pixel coordinates and normalized (0..1) coordinates are stored:
 * - raw pixels answer "what did it look like on THAT screen"
 * - normalized answers "where on the canvas", independent of screen size,
 *   which is what makes resize-safe reconstruction possible.
 */
export interface PointSample {
  /**
   * Position of this sample in the session timeline.
   *
   * TIMELINE CONTRACT (see docs/event-schema.md):
   * `sequence` is a non-negative integer drawn from ONE counter shared by every
   * point and every action, and it strictly increases across the whole session.
   * It is the authoritative ordering key - when two events carry the same
   * `timeMs`, `sequence` decides which came first.
   */
  sequence: number
  /**
   * Milliseconds since session start, measured with performance.now().
   *
   * Guaranteed monotonic NON-DECREASING across the session: two events may
   * share a timestamp (the clock is rounded to 0.1 ms), but a later event can
   * never carry a smaller value than an earlier one.
   */
  timeMs: number
  /** Raw canvas pixel coordinate at capture time. */
  x: number
  y: number
  /** Canvas-relative coordinate in the 0..1 range. */
  normalizedX: number
  normalizedY: number
  /**
   * Real pen pressure in the 0..1 range, or null.
   *
   * IMPORTANT: a mouse reports a constant 0.5 through the Pointer Events API.
   * That is not real pressure data, so we deliberately store null for it
   * rather than polluting the dataset with a fake constant.
   */
  pressure: number | null
  /** Pen tilt in degrees, or null when the device does not report it. */
  tiltX: number | null
  tiltY: number | null
  /** Which kind of device produced this sample. */
  pointerType: PointerInputType
}

/** One continuous press-move-release gesture. */
export interface DrawingStroke {
  /** crypto.randomUUID(). Unique within the session. */
  id: string
  /**
   * Position of this stroke in the canonical creation order, starting at 0.
   * Within a session these values are exactly 0..strokes.length-1, each used
   * once - they index the append-only history, not the visible drawing.
   */
  order: number
  tool: DrawingTool
  /** CSS color. For an eraser stroke this is kept but not used for painting. */
  color: string
  /** Line width in canvas pixels. */
  width: number
  /** Milliseconds since session start. Always <= endedAtMs. */
  startedAtMs: number
  endedAtMs: number
  /**
   * True when at least one point of this stroke carries a non-null `pressure`.
   *
   * NAMING IS DELIBERATE. This flag claims exactly one thing: pressure samples
   * are PRESENT. It does NOT claim the pressure varied, and it does not grade
   * the quality of the signal. An earlier version called this `hasRealPressure`
   * while documenting it as "genuine, varying pressure" - a promise the code
   * never checked. In research data a field that overstates what was measured
   * is worse than no field at all, so the name was narrowed to match the test
   * the code actually performs.
   *
   * Whether the pressure varied is a question for feature extraction, which can
   * answer it from `points[].pressure` whenever it is needed.
   */
  hasPressureSamples: boolean
  points: PointSample[]
}

/** Everything the user did that is not itself a stroke. */
export type DrawingActionType =
  | 'undo'
  | 'redo'
  | 'clear'
  | 'tool_change'
  | 'color_change'
  | 'width_change'

export interface DrawingAction {
  /** Shares one counter with PointSample.sequence. See the contract there. */
  sequence: number
  /** Milliseconds since session start. Monotonic non-decreasing. */
  timeMs: number
  type: DrawingActionType
  /**
   * Extra context. The shape depends on `type`:
   * - undo / redo   -> { strokeId: string }
   * - clear         -> { affectedStrokeIds: string[] }  (required in schema 2)
   * - tool_change   -> { from: DrawingTool, to: DrawingTool }
   * - color_change  -> { from: string, to: string }
   * - width_change  -> { from: number, to: number }
   */
  payload?: Record<string, unknown>
}

/** Physical description of the drawing surface when the session was recorded. */
export interface CanvasDescriptor {
  width: number
  height: number
  devicePixelRatio: number
}

/**
 * Where a session's data came from, and how much of its history survived.
 *
 * Absent on a natively recorded session: no provenance note means the record is
 * complete and was produced by this schema version.
 */
export interface SessionProvenance {
  /** The schema version of the file this session was upgraded from. */
  importedFromSchemaVersion: 1
  /**
   * False when the source format was incapable of preserving the full history.
   *
   * Schema 1 implemented Clear destructively: it deleted strokes from the file.
   * A v1 export taken after a Clear therefore has no record of what was erased,
   * and that data cannot be recovered - only reported as missing. Strokes are
   * NEVER fabricated to fill the gap.
   */
  historyComplete: boolean
  /** Human-readable Persian explanation, shown in the UI. */
  note: string
}

/** The complete recording of one drawing session. */
export interface DrawingSession {
  /**
   * Bumped whenever the MEANING of this file changes in a breaking way.
   *
   * 1 - destructive history. Undo and Clear removed strokes from `strokes`.
   *     A `clear` action carried only `{ removedStrokeCount }`, so the erased
   *     strokes were unrecoverable.
   * 2 - append-only history. `strokes` holds every completed stroke forever;
   *     undo / redo / clear only change VISIBILITY, and `clear` names the exact
   *     stroke ids it hid. `hasRealPressure` was renamed `hasPressureSamples`.
   *
   * The two versions describe the same fields with different guarantees, which
   * is precisely why they must not share a version number: reading a v1 file as
   * if it were v2 would silently claim a complete history that does not exist.
   */
  schemaVersion: 2
  /** crypto.randomUUID() */
  id: string
  /** ISO 8601 wall-clock timestamp - a calendar label only, never used for timing. */
  createdAt: string
  startedAt: string
  canvas: CanvasDescriptor
  /** Append-only. Every completed stroke, in canonical creation order. */
  strokes: DrawingStroke[]
  actions: DrawingAction[]
  /** Present only on sessions upgraded from an older schema. */
  provenance?: SessionProvenance
}

/** The schema version this build writes. */
export const CURRENT_SCHEMA_VERSION = 2 as const

/** The older, destructive-history schema this build can still import. */
export const LEGACY_SCHEMA_VERSION = 1 as const

/** Result type used by the validator and serializer. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }
