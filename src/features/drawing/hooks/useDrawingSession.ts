/**
 * The event recorder: the single source of truth for one drawing session.
 *
 * PERFORMANCE RULE that shapes this whole file:
 * a pointer can fire 120+ move events per second, and with getCoalescedEvents()
 * each of those can carry several samples. Calling setState on every sample
 * would re-render React hundreds of times a second and drop frames.
 *
 * So the stroke being drawn RIGHT NOW lives in a ref (`currentStrokeRef`) and
 * causes zero re-renders. Only when the pointer is released does one setState
 * commit the finished stroke. The canvas draws the in-progress line
 * imperatively - see DrawingCanvas.tsx.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  computeVisibleStrokes,
  replayHistory,
  type ClearActionPayload,
} from '../utils/strokeVisibility'
import {
  CURRENT_SCHEMA_VERSION,
  type DrawingAction,
  type DrawingActionType,
  type DrawingSession,
  type DrawingStroke,
  type DrawingTool,
  type PointSample,
  type PointerInputType,
  type SessionProvenance,
} from '../types/drawing.types'
import type { Size } from '../utils/coordinates'
import { roundNormalized, roundPixel } from '../utils/coordinates'
import { createSessionClock, nowIsoTimestamp, type SessionClock } from '../utils/timing'
import { loadPreferences, savePreferences } from '../services/preferencesStorage'

/**
 * One raw sample handed over by the canvas.
 * The canvas owns DOM geometry (it knows the bounding rect); this hook owns the
 * event log. Splitting it this way keeps both sides testable.
 */
export interface RawPointerSample {
  x: number
  y: number
  normalizedX: number
  normalizedY: number
  pressure: number | null
  tiltX: number | null
  tiltY: number | null
  pointerType: PointerInputType
}

/** The stroke currently under the pointer, before it is committed to state. */
interface InProgressStroke {
  id: string
  tool: DrawingTool
  color: string
  width: number
  startedAtMs: number
  hasPressureSamples: boolean
  points: PointSample[]
}

export interface SessionMeta {
  id: string
  createdAt: string
  startedAt: string
  /**
   * Set only when this session came from an older schema. It travels with the
   * session through every re-export, because "this history is incomplete" is a
   * permanent property of the data, not a one-off import warning.
   */
  provenance?: SessionProvenance
}

export interface UseDrawingSessionResult {
  /**
   * CANONICAL, append-only research data: every stroke ever completed in this
   * session, in creation order. Undo and clear never remove anything from here.
   */
  strokes: readonly DrawingStroke[]
  /**
   * The subset the canvas should paint, derived by replaying the action log.
   * Use this for rendering; use `strokes` for export and analysis.
   */
  visibleStrokes: readonly DrawingStroke[]
  /** The action log (undo / redo / clear / tool, color, width changes). */
  actions: readonly DrawingAction[]
  meta: SessionMeta
  tool: DrawingTool
  color: string
  width: number
  canUndo: boolean
  canRedo: boolean
  lastPointerType: PointerInputType | null

  beginStroke: (sample: RawPointerSample) => void
  /** Appends samples to the live stroke. Does NOT re-render. */
  extendStroke: (samples: readonly RawPointerSample[]) => void
  /** Commits the live stroke. Returns true when a stroke was actually added. */
  endStroke: () => boolean
  /** Drops the live stroke without recording it (pointercancel). */
  abortStroke: () => void
  /** Reads the live stroke for imperative drawing. */
  getLiveStroke: () => InProgressStroke | null

  setTool: (tool: DrawingTool) => void
  setColor: (color: string) => void
  setWidth: (width: number) => void

  undo: () => void
  redo: () => void
  clear: () => void
  startNewSession: () => void
  loadSession: (session: DrawingSession) => void

  /** Builds the exportable snapshot for the given canvas size. */
  buildSession: (canvasSize: Size) => DrawingSession
}

function createSessionId(): string {
  return crypto.randomUUID()
}

function createMeta(): SessionMeta {
  const timestamp = nowIsoTimestamp()
  return { id: createSessionId(), createdAt: timestamp, startedAt: timestamp }
}

export function useDrawingSession(): UseDrawingSessionResult {
  const initialPreferences = useMemo(() => loadPreferences(), [])

  const [strokes, setStrokes] = useState<DrawingStroke[]>([])
  const [actions, setActions] = useState<DrawingAction[]>([])
  /**
   * Ids of strokes hidden by undo and eligible for redo.
   *
   * This is UI state, not research data: the strokes themselves stay in
   * `strokes`, and the log in `actions` is what actually records the history.
   */
  const [redoStack, setRedoStack] = useState<string[]>([])
  const [meta, setMeta] = useState<SessionMeta>(createMeta)
  const [tool, setToolState] = useState<DrawingTool>(initialPreferences.tool)
  const [color, setColorState] = useState<string>(initialPreferences.color)
  const [width, setWidthState] = useState<number>(initialPreferences.width)
  const [lastPointerType, setLastPointerType] = useState<PointerInputType | null>(null)

  /** Monotonic clock for the session. Reset whenever a new session starts. */
  const clockRef = useRef<SessionClock>(null)
  if (clockRef.current === null) {
    clockRef.current = createSessionClock()
  }

  /**
   * One shared counter for points AND actions, so the two together form a
   * single ordered timeline. Reading the log sorted by `sequence` reproduces
   * exactly what happened, in order.
   */
  const sequenceRef = useRef<number>(0)
  const currentStrokeRef = useRef<InProgressStroke | null>(null)

  /**
   * Mirrors of the state, kept in sync on every render.
   * They let the callbacks below read the CURRENT value without listing it as a
   * dependency, so the callbacks stay referentially stable and the memoized
   * child components (canvas, toolbar) do not re-render on every change.
   */
  const settingsRef = useRef({ tool, color, width })
  settingsRef.current = { tool, color, width }
  const redoStackRef = useRef<string[]>(redoStack)
  redoStackRef.current = redoStack

  /**
   * What the canvas paints, replayed from the canonical strokes plus the log.
   * Recomputed only when one of those two actually changes, never during
   * pointer movement.
   */
  const visibleStrokes = useMemo(
    () => computeVisibleStrokes(strokes, actions),
    [actions, strokes],
  )
  const visibleStrokesRef = useRef<DrawingStroke[]>(visibleStrokes)
  visibleStrokesRef.current = visibleStrokes

  const nextSequence = useCallback((): number => {
    sequenceRef.current += 1
    return sequenceRef.current
  }, [])

  const elapsedMs = useCallback((): number => {
    return clockRef.current?.elapsedMs() ?? 0
  }, [])

  const logAction = useCallback(
    (type: DrawingActionType, payload?: Record<string, unknown>): void => {
      const action: DrawingAction = {
        sequence: nextSequence(),
        timeMs: elapsedMs(),
        type,
      }
      // Conditional assignment: exactOptionalPropertyTypes forbids writing
      // `undefined` into an optional property.
      if (payload !== undefined) {
        action.payload = payload
      }
      setActions((previous) => [...previous, action])
    },
    [elapsedMs, nextSequence],
  )

  const buildPoint = useCallback(
    (sample: RawPointerSample): PointSample => {
      return {
        sequence: nextSequence(),
        timeMs: elapsedMs(),
        x: roundPixel(sample.x),
        y: roundPixel(sample.y),
        normalizedX: roundNormalized(sample.normalizedX),
        normalizedY: roundNormalized(sample.normalizedY),
        pressure: sample.pressure,
        tiltX: sample.tiltX,
        tiltY: sample.tiltY,
        pointerType: sample.pointerType,
      }
    },
    [elapsedMs, nextSequence],
  )

  const beginStroke = useCallback(
    (sample: RawPointerSample): void => {
      const settings = settingsRef.current
      const point = buildPoint(sample)
      currentStrokeRef.current = {
        id: crypto.randomUUID(),
        tool: settings.tool,
        color: settings.color,
        width: settings.width,
        startedAtMs: point.timeMs,
        hasPressureSamples: point.pressure !== null,
        points: [point],
      }
      setLastPointerType(sample.pointerType)
    },
    [buildPoint],
  )

  const extendStroke = useCallback(
    (samples: readonly RawPointerSample[]): void => {
      const stroke = currentStrokeRef.current
      if (stroke === null) return
      for (const sample of samples) {
        const point = buildPoint(sample)
        stroke.points.push(point)
        if (point.pressure !== null) {
          stroke.hasPressureSamples = true
        }
      }
    },
    [buildPoint],
  )

  const endStroke = useCallback((): boolean => {
    const inProgress = currentStrokeRef.current
    currentStrokeRef.current = null
    if (inProgress === null || inProgress.points.length === 0) {
      return false
    }

    const finished: DrawingStroke = {
      id: inProgress.id,
      // Placeholder: the authoritative order is the index in the canonical
      // (append-only) stroke array, assigned in buildSession().
      order: 0,
      tool: inProgress.tool,
      color: inProgress.color,
      width: inProgress.width,
      startedAtMs: inProgress.startedAtMs,
      endedAtMs: elapsedMs(),
      hasPressureSamples: inProgress.hasPressureSamples,
      points: inProgress.points,
    }

    setStrokes((previous) => [...previous, finished])
    // Drawing something new invalidates the redo history, as in any editor.
    setRedoStack([])
    return true
  }, [elapsedMs])

  const abortStroke = useCallback((): void => {
    currentStrokeRef.current = null
  }, [])

  const getLiveStroke = useCallback((): InProgressStroke | null => {
    return currentStrokeRef.current
  }, [])

  const setTool = useCallback(
    (next: DrawingTool): void => {
      const previous = settingsRef.current.tool
      if (previous === next) return
      setToolState(next)
      savePreferences({ ...settingsRef.current, tool: next })
      logAction('tool_change', { from: previous, to: next })
    },
    [logAction],
  )

  const setColor = useCallback(
    (next: string): void => {
      const previous = settingsRef.current.color
      if (previous === next) return
      setColorState(next)
      savePreferences({ ...settingsRef.current, color: next })
      logAction('color_change', { from: previous, to: next })
    },
    [logAction],
  )

  const setWidth = useCallback(
    (next: number): void => {
      const previous = settingsRef.current.width
      if (previous === next) return
      setWidthState(next)
      savePreferences({ ...settingsRef.current, width: next })
      logAction('width_change', { from: previous, to: next })
    },
    [logAction],
  )

  /**
   * Undo / redo / clear change VISIBILITY only.
   *
   * None of them touches `strokes`: a completed stroke, with its points, timing
   * and tool, stays in the research data permanently. What each one does is
   * append an event naming the affected stroke ids; the canvas is then derived
   * by replaying that log.
   *
   * They also read from refs rather than nesting one setState updater inside
   * another, because React StrictMode invokes updaters twice in development.
   * Logging an action from inside an updater would record every undo twice -
   * corrupting the very event log this project exists to produce.
   */
  const undo = useCallback((): void => {
    const visible = visibleStrokesRef.current
    if (visible.length === 0) return
    const last = visible[visible.length - 1]
    if (last === undefined) return

    setRedoStack([...redoStackRef.current, last.id])
    logAction('undo', { strokeId: last.id })
  }, [logAction])

  const redo = useCallback((): void => {
    const stack = redoStackRef.current
    if (stack.length === 0) return
    const restoredId = stack[stack.length - 1]
    if (restoredId === undefined) return

    setRedoStack(stack.slice(0, -1))
    logAction('redo', { strokeId: restoredId })
  }, [logAction])

  /**
   * Empties the canvas without deleting anything.
   *
   * The event records exactly WHICH strokes it hid, so the drawing before the
   * clear can still be reconstructed from the exported file - and so a stroke
   * drawn afterwards is provably unaffected by it.
   */
  const clear = useCallback((): void => {
    const affectedStrokeIds = visibleStrokesRef.current.map((stroke) => stroke.id)
    if (affectedStrokeIds.length === 0) return

    logAction('clear', { affectedStrokeIds } satisfies ClearActionPayload)
    setRedoStack([])
    currentStrokeRef.current = null
  }, [logAction])

  const startNewSession = useCallback((): void => {
    currentStrokeRef.current = null
    sequenceRef.current = 0
    clockRef.current = createSessionClock()
    setStrokes([])
    setActions([])
    setRedoStack([])
    setLastPointerType(null)
    setMeta(createMeta())
  }, [])

  /**
   * Replaces the whole session with an imported or restored one.
   *
   * Three details matter for data integrity:
   *
   * 1. the clock origin is shifted so newly drawn points continue AFTER the
   *    imported timeline instead of restarting at 0;
   * 2. the sequence counter resumes past the highest sequence in the file, so
   *    new events can never collide with imported ones - this is what keeps
   *    sequence numbers unique across an import boundary;
   * 3. the redo stack is REBUILT from the history rather than emptied.
   *
   * Point 3 is easy to get wrong. Clearing the redo stack looks harmless, but
   * it silently discards state the file provably contains: if the user undid a
   * stroke and then saved, the stroke is still in `strokes` and the undo is
   * still in `actions`, so "there is something to redo" is a fact recorded in
   * the data. Dropping it makes a restored session behave differently from the
   * one the user left - the Redo button greys out and a stroke that was one
   * click away from returning becomes unreachable through the UI.
   */
  const loadSession = useCallback((session: DrawingSession): void => {
    currentStrokeRef.current = null

    let maxSequence = 0
    let maxTimeMs = 0
    for (const stroke of session.strokes) {
      if (stroke.endedAtMs > maxTimeMs) maxTimeMs = stroke.endedAtMs
      for (const point of stroke.points) {
        if (point.sequence > maxSequence) maxSequence = point.sequence
        if (point.timeMs > maxTimeMs) maxTimeMs = point.timeMs
      }
    }
    for (const action of session.actions) {
      if (action.sequence > maxSequence) maxSequence = action.sequence
      if (action.timeMs > maxTimeMs) maxTimeMs = action.timeMs
    }

    sequenceRef.current = maxSequence
    clockRef.current = createSessionClock(maxTimeMs)

    // The same replay that decides what is visible also yields what can be
    // redone, so the restored UI state cannot drift from the recorded history.
    const { redoStack: restoredRedoStack } = replayHistory(session.strokes, session.actions)

    setStrokes([...session.strokes])
    setActions([...session.actions])
    setRedoStack(restoredRedoStack)
    setLastPointerType(null)

    const nextMeta: SessionMeta = {
      id: session.id,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
    }
    // exactOptionalPropertyTypes forbids assigning `undefined` to an optional
    // property, so the field is only added when it genuinely exists.
    if (session.provenance !== undefined) {
      nextMeta.provenance = session.provenance
    }
    setMeta(nextMeta)
  }, [])

  const buildSession = useCallback(
    (canvasSize: Size): DrawingSession => {
      const session: DrawingSession = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        id: meta.id,
        createdAt: meta.createdAt,
        startedAt: meta.startedAt,
        canvas: {
          width: Math.max(1, Math.round(canvasSize.width)),
          height: Math.max(1, Math.round(canvasSize.height)),
          devicePixelRatio: window.devicePixelRatio,
        },
        // `order` is the index in the append-only history, assigned here so it
        // is always a clean 0..n-1 permutation regardless of undo and redo.
        strokes: strokes.map((stroke, index) => ({ ...stroke, order: index })),
        actions,
      }
      if (meta.provenance !== undefined) {
        session.provenance = meta.provenance
      }
      return session
    },
    [actions, meta, strokes],
  )

  return {
    strokes,
    visibleStrokes,
    actions,
    meta,
    tool,
    color,
    width,
    canUndo: visibleStrokes.length > 0,
    canRedo: redoStack.length > 0,
    lastPointerType,
    beginStroke,
    extendStroke,
    endStroke,
    abortStroke,
    getLiveStroke,
    setTool,
    setColor,
    setWidth,
    undo,
    redo,
    clear,
    startNewSession,
    loadSession,
    buildSession,
  }
}
