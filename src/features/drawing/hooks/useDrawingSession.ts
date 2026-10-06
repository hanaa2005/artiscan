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
  type CanvasDescriptor,
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
  /**
   * Changes the colour and records it as one action. For direct, atomic
   * selection; a picker the user drags through should use the three calls below.
   */
  setColor: (color: string) => void
  setWidth: (width: number) => void

  /**
   * COLOUR INTERACTION: preview is not an action.
   *
   * A native `<input type="color">` fires `change` continuously while the user
   * drags around inside the picker, so one deliberate colour choice used to
   * append dozens of `color_change` events - burying the single decision the
   * participant actually made under the noise of them looking for it.
   *
   * The fix separates the two things that were conflated:
   *
   *   previewColor()            paints with the colour, records nothing
   *   commitColorInteraction()  records ONE action, from the colour at the
   *                             start of the interaction to the final one
   *
   * Commit is idempotent, so `change` + `pointerup` + `blur` for a single
   * interaction still yields exactly one action, and an interaction that ends
   * on the colour it started with yields none.
   */
  beginColorInteraction: () => void
  previewColor: (color: string) => void
  commitColorInteraction: () => void

  /**
   * WIDTH INTERACTION: identical contract to colour, for the same reason.
   *
   * A `<input type="range">` fires `change` on every step the thumb crosses, so
   * one deliberate drag from 29 down to 8 appended a `width_change` for each
   * intermediate value - a real recording contained
   * `29 -> 14 -> 13 -> 12 -> 11 -> 10 -> 9 -> 12 -> 9 -> 11 -> 8 -> 10 -> 7 -> 9 -> 8`,
   * fifteen actions describing one decision. The overshoot back and forth is
   * the participant's hand on a slider, not fifteen choices about line width.
   *
   *   previewWidth()            paints with the width, records nothing
   *   commitWidthInteraction()  records ONE action, from the width at the start
   *                             of the interaction to the final one
   *
   * Commit is idempotent, so `change` + `pointerup` + `blur` for a single drag
   * still yields exactly one action, and a drag that ends on the width it
   * started with yields none.
   */
  beginWidthInteraction: () => void
  previewWidth: (width: number) => void
  commitWidthInteraction: () => void

  undo: () => void
  redo: () => void
  clear: () => void
  startNewSession: () => void
  loadSession: (session: DrawingSession) => void

  /**
   * Fixes the LOGICAL CANVAS for this session, once.
   *
   * THE PROBLEM THIS SOLVES (confirmed in week 1A)
   *
   * buildSession() used to stamp whatever size the canvas happened to be at
   * EXPORT time. Raw points, however, were captured against the size the canvas
   * had at CAPTURE time. Resize the window between the two and the file pairs
   * one with the other: a point recorded well inside a 900 px canvas is filed
   * against a 718 px descriptor and reads as "outside the canvas" although the
   * pointer never left the surface.
   *
   * So the descriptor is latched the first time a real layout size is known and
   * then never moves for the lifetime of the session. A later resize changes
   * only what is displayed. Calling this repeatedly is safe - every call after
   * the first is ignored.
   *
   * A 1x1 size is the pre-layout placeholder from useCanvasSize and is never
   * latched; latching it would freeze the session at a meaningless size.
   */
  latchLogicalCanvas: (size: Size) => void
  /** The fixed logical canvas, or null before the first real layout. */
  getLogicalCanvas: () => CanvasDescriptor | null

  /**
   * Builds the exportable snapshot.
   *
   * `fallbackSize` is used ONLY when no logical canvas has been latched yet -
   * an export taken before the first layout. Once latched, the logical canvas
   * wins and this argument is ignored, which is what makes the descriptor
   * stable across a resize.
   */
  buildSession: (fallbackSize: Size) => DrawingSession
}

function createSessionId(): string {
  return crypto.randomUUID()
}

/**
 * The size below which a measurement is treated as "layout has not happened
 * yet" rather than as a real canvas. useCanvasSize reports 1x1 until its
 * ResizeObserver first fires.
 */
const MIN_LOGICAL_CANVAS_PX = 2

function toCanvasDescriptor(size: Size): CanvasDescriptor {
  return {
    width: Math.max(1, Math.round(size.width)),
    height: Math.max(1, Math.round(size.height)),
    devicePixelRatio: window.devicePixelRatio,
  }
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
   * The canvas geometry this session's raw coordinates belong to.
   *
   * Latched once and then immutable for the session, so the descriptor in the
   * exported file always describes the surface the points were actually
   * captured on. See latchLogicalCanvas in the result interface.
   */
  const logicalCanvasRef = useRef<CanvasDescriptor | null>(null)

  const latchLogicalCanvas = useCallback((size: Size): void => {
    if (logicalCanvasRef.current !== null) return
    // Ignore the pre-layout placeholder: freezing the session at 1x1 would be
    // far worse than waiting one frame for a real measurement.
    if (size.width < MIN_LOGICAL_CANVAS_PX || size.height < MIN_LOGICAL_CANVAS_PX) return
    logicalCanvasRef.current = toCanvasDescriptor(size)
  }, [])

  const getLogicalCanvas = useCallback((): CanvasDescriptor | null => {
    return logicalCanvasRef.current
  }, [])

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

  /**
   * The colour the current picker interaction started from, or null when no
   * interaction is open. Its presence is what makes commit idempotent.
   */
  const colorInteractionFromRef = useRef<string | null>(null)
  /**
   * The authoritative current colour.
   *
   * `settingsRef` mirrors state and is therefore a render BEHIND whenever
   * several colour calls land in one React batch - which is exactly what a
   * picker drag produces. Every colour path writes here first and reads here
   * first, so the value can never be stale.
   */
  const currentColorRef = useRef<string>(color)
  // Safe to resync on every render: by the time a render runs, the state has
  // caught up with whatever the ref was set to during the batch.
  currentColorRef.current = color

  /** The authoritative current width, for exactly the same reason as colour. */
  const currentWidthRef = useRef<number>(width)
  currentWidthRef.current = width

  /**
   * The width the current slider interaction started from, or null when no
   * interaction is open. Its presence is what makes commit idempotent.
   */
  const widthInteractionFromRef = useRef<number | null>(null)

  /**
   * Writes the preferences that should survive a reload.
   *
   * Reads the authoritative refs rather than `settingsRef`, which mirrors state
   * and is a render behind during a batched interaction. Saving from the mirror
   * would persist whichever value the pointer happened to pass through last.
   */
  const persistPreferences = useCallback((): void => {
    savePreferences({
      tool: settingsRef.current.tool,
      color: currentColorRef.current,
      width: currentWidthRef.current,
    })
  }, [])

  const beginColorInteraction = useCallback((): void => {
    // Idempotent: a second begin inside one interaction must not move the
    // starting colour forward, or the committed `from` would be a colour the
    // user only passed through.
    if (colorInteractionFromRef.current !== null) return
    colorInteractionFromRef.current = currentColorRef.current
  }, [])

  const previewColor = useCallback((next: string): void => {
    // Preferences are deliberately NOT saved here: a colour merely passed
    // through is not the user's choice, and persisting it would make the app
    // reopen with whatever hue the pointer happened to cross last.
    currentColorRef.current = next
    setColorState(next)
  }, [])

  /** Closes an open interaction, recording at most one action. */
  const commitColorInteraction = useCallback((): void => {
    const from = colorInteractionFromRef.current
    // No open interaction: a stray blur or pointerup after an already-committed
    // change records nothing.
    if (from === null) return

    const to = currentColorRef.current
    colorInteractionFromRef.current = null

    // Ending where it began is not a change. Closing or cancelling the picker
    // therefore leaves no trace in the log.
    if (from === to) return

    persistPreferences()
    logAction('color_change', { from, to })
  }, [logAction, persistPreferences])

  const beginWidthInteraction = useCallback((): void => {
    // Idempotent: a second begin inside one drag must not move the starting
    // width forward, or the committed `from` would be an intermediate value.
    if (widthInteractionFromRef.current !== null) return
    widthInteractionFromRef.current = currentWidthRef.current
  }, [])

  const previewWidth = useCallback((next: number): void => {
    // Preferences are deliberately NOT saved here: a width merely dragged
    // through is not the user's choice, and persisting it would make the app
    // reopen with whatever value the thumb happened to cross last.
    currentWidthRef.current = next
    setWidthState(next)
  }, [])

  /** Closes an open interaction, recording at most one action. */
  const commitWidthInteraction = useCallback((): void => {
    const from = widthInteractionFromRef.current
    // No open interaction: a stray blur or pointerup after an already-committed
    // change records nothing.
    if (from === null) return

    const to = currentWidthRef.current
    widthInteractionFromRef.current = null

    // Ending where it began is not a change - a drag that wanders away and
    // comes back leaves no trace in the log.
    if (from === to) return

    persistPreferences()
    logAction('width_change', { from, to })
  }, [logAction, persistPreferences])

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
      /*
        Settle any open colour interaction BEFORE the stroke starts.

        Without this, a user who picks a colour and draws without ever blurring
        the picker would produce a stroke painted in the new colour while the
        action log still showed the old one - the log would contradict the ink.
        Committing here guarantees the color_change lands at a lower sequence
        than the stroke's first point.

        The same applies to an open slider interaction: the stroke below is
        painted with `currentWidthRef`, so the width_change must be logged
        before it or the log would contradict the ink.
      */
      commitColorInteraction()
      commitWidthInteraction()

      const settings = settingsRef.current
      const point = buildPoint(sample)
      currentStrokeRef.current = {
        id: crypto.randomUUID(),
        tool: settings.tool,
        // The ref, not the mirrored state: a colour previewed earlier in the
        // same batch is already the colour on screen.
        color: currentColorRef.current,
        // The ref for the same reason as the colour: a width previewed earlier
        // in this batch is already the width on screen.
        width: currentWidthRef.current,
        startedAtMs: point.timeMs,
        hasPressureSamples: point.pressure !== null,
        points: [point],
      }
      setLastPointerType(sample.pointerType)
    },
    [buildPoint, commitColorInteraction, commitWidthInteraction],
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
      settingsRef.current = { ...settingsRef.current, tool: next }
      setToolState(next)
      persistPreferences()
      logAction('tool_change', { from: previous, to: next })
    },
    [logAction, persistPreferences],
  )

  const setColor = useCallback(
    (next: string): void => {
      // Any half-open picker interaction is settled FIRST, so a direct
      // selection can never be swallowed into someone else's `from`/`to` pair -
      // and `previous` is read afterwards, because settling may have moved it.
      commitColorInteraction()
      const previous = currentColorRef.current
      if (previous === next) return
      currentColorRef.current = next
      setColorState(next)
      persistPreferences()
      logAction('color_change', { from: previous, to: next })
    },
    [commitColorInteraction, logAction, persistPreferences],
  )

  const setWidth = useCallback(
    (next: number): void => {
      // Any half-open slider interaction is settled FIRST, so a direct or
      // scripted change can never be swallowed into someone else's `from`/`to`
      // pair - and `previous` is read afterwards, because settling may have
      // moved it. Mirrors setColor exactly.
      commitWidthInteraction()
      const previous = currentWidthRef.current
      if (previous === next) return
      currentWidthRef.current = next
      setWidthState(next)
      persistPreferences()
      logAction('width_change', { from: previous, to: next })
    },
    [commitWidthInteraction, logAction, persistPreferences],
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
    // An interaction left open by the previous session must not commit into the
    // new log; the colour and width themselves are kept, only the pending
    // records are dropped.
    colorInteractionFromRef.current = null
    widthInteractionFromRef.current = null
    sequenceRef.current = 0
    // A new session measures its own canvas: the next real layout size latches
    // afresh, so a window resized during the previous session cannot carry a
    // stale descriptor into this one.
    logicalCanvasRef.current = null
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
    colorInteractionFromRef.current = null
    widthInteractionFromRef.current = null

    /*
      The imported file's own canvas becomes the logical canvas.

      This is what makes a round trip faithful: re-exporting an imported session
      on a differently sized screen must not restamp its points with this
      screen's geometry. The descriptor belongs to the recording, not to the
      machine that happens to be reading it.
    */
    logicalCanvasRef.current = { ...session.canvas }

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
    (fallbackSize: Size): DrawingSession => {
      const session: DrawingSession = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        id: meta.id,
        createdAt: meta.createdAt,
        startedAt: meta.startedAt,
        // The latched logical canvas, so a resize between capture and export
        // cannot re-file the raw points against a size they were never
        // recorded in. See latchLogicalCanvas.
        canvas: logicalCanvasRef.current ?? toCanvasDescriptor(fallbackSize),
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
    beginColorInteraction,
    previewColor,
    commitColorInteraction,
    beginWidthInteraction,
    previewWidth,
    commitWidthInteraction,
    undo,
    redo,
    clear,
    startNewSession,
    loadSession,
    latchLogicalCanvas,
    getLogicalCanvas,
    buildSession,
  }
}
