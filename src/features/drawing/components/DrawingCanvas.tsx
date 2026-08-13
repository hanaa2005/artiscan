/**
 * The drawing surface.
 *
 * Responsibilities are deliberately narrow: DOM geometry, pointer plumbing and
 * painting. It records nothing itself - every sample is handed to
 * useDrawingSession, which owns the event log.
 *
 * Two rendering paths coexist here on purpose:
 * 1. committed strokes are rendered by React from state (declarative, simple);
 * 2. the stroke under the pointer is drawn IMPERATIVELY on a single Konva Line
 *    through a ref, so that moving the pointer never triggers a React render.
 */

import { memo, useCallback, useEffect, useRef } from 'react'
import { Layer, Line, Stage } from 'react-konva'
import type Konva from 'konva'
import type { DrawingStroke } from '../types/drawing.types'
import type { RawPointerSample, UseDrawingSessionResult } from '../hooks/useDrawingSession'
import { toKonvaPoints, type Size } from '../utils/coordinates'
import { getPointerSamples, toRawSample } from '../utils/pointerInput'
import styles from './DrawingCanvas.module.css'

interface DrawingCanvasProps {
  size: Size
  strokes: readonly DrawingStroke[]
  session: UseDrawingSessionResult
  stageRef: React.RefObject<Konva.Stage | null>
}

/** Shared Konva line settings that make strokes look like ink rather than wire. */
const LINE_STYLE = {
  lineCap: 'round',
  lineJoin: 'round',
  // Konva's own smoothing; purely visual and never written back to the data.
  tension: 0,
  perfectDrawEnabled: false,
} as const

/**
 * One committed stroke.
 *
 * The eraser is drawn with the `destination-out` composite operation: instead
 * of painting a colour it removes whatever is already on the layer. That is why
 * the eraser must live in the SAME layer as the ink - a separate layer would
 * only erase its own (empty) canvas.
 */
const StrokeLine = memo(function StrokeLine({
  stroke,
  size,
}: {
  stroke: DrawingStroke
  size: Size
}) {
  const isEraser = stroke.tool === 'eraser'
  return (
    <Line
      points={toKonvaPoints(stroke.points, size)}
      stroke={isEraser ? '#000000' : stroke.color}
      strokeWidth={stroke.width}
      globalCompositeOperation={isEraser ? 'destination-out' : 'source-over'}
      {...LINE_STYLE}
    />
  )
})

function DrawingCanvasComponent({
  size,
  strokes,
  session,
  stageRef,
}: DrawingCanvasProps): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const liveLineRef = useRef<Konva.Line | null>(null)
  const layerRef = useRef<Konva.Layer | null>(null)
  const activePointerIdRef = useRef<number | null>(null)

  /** Latest size, readable from the native listeners without re-subscribing. */
  const sizeRef = useRef<Size>(size)
  sizeRef.current = size

  const sessionRef = useRef<UseDrawingSessionResult>(session)
  sessionRef.current = session

  /** Repaints the in-progress line from the live stroke held in the recorder. */
  const redrawLiveStroke = useCallback((): void => {
    const line = liveLineRef.current
    if (line === null) return

    const stroke = sessionRef.current.getLiveStroke()
    if (stroke === null) {
      line.points([])
    } else {
      const isEraser = stroke.tool === 'eraser'
      line.points(toKonvaPoints(stroke.points, sizeRef.current))
      line.stroke(isEraser ? '#000000' : stroke.color)
      line.strokeWidth(stroke.width)
      line.globalCompositeOperation(isEraser ? 'destination-out' : 'source-over')
    }
    // batchDraw coalesces repaints into the next animation frame instead of
    // redrawing synchronously on every single sample.
    layerRef.current?.batchDraw()
  }, [])

  useEffect(() => {
    const element = overlayRef.current
    if (element === null) return

    const readRect = (): DOMRect => element.getBoundingClientRect()

    const handlePointerDown = (event: PointerEvent): void => {
      // Ignore secondary mouse buttons so a right-click never starts a stroke.
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if (activePointerIdRef.current !== null) return

      event.preventDefault()
      activePointerIdRef.current = event.pointerId

      // Pointer capture routes all further events for this pointer to this
      // element even when it leaves the canvas. Without it, dragging outside
      // the canvas silently truncates the stroke.
      try {
        element.setPointerCapture(event.pointerId)
      } catch {
        // Some browsers refuse capture for synthetic pointers; drawing still works.
      }

      const sample: RawPointerSample = toRawSample(event, readRect(), sizeRef.current)
      sessionRef.current.beginStroke(sample)
      redrawLiveStroke()
    }

    const handlePointerMove = (event: PointerEvent): void => {
      if (activePointerIdRef.current !== event.pointerId) return
      event.preventDefault()

      const rect = readRect()
      const currentSize = sizeRef.current
      // One pointermove can carry several real samples on a high-frequency
      // digitizer; getPointerSamples() unpacks them.
      const samples = getPointerSamples(event).map((raw) =>
        toRawSample(raw, rect, currentSize),
      )
      sessionRef.current.extendStroke(samples)
      redrawLiveStroke()
    }

    const finishStroke = (event: PointerEvent, cancelled: boolean): void => {
      if (activePointerIdRef.current !== event.pointerId) return
      activePointerIdRef.current = null

      try {
        if (element.hasPointerCapture(event.pointerId)) {
          element.releasePointerCapture(event.pointerId)
        }
      } catch {
        // Capture may already have been lost; nothing to release.
      }

      if (cancelled) {
        sessionRef.current.abortStroke()
      } else {
        sessionRef.current.endStroke()
      }
      // Clear the live line: the committed stroke is now rendered by React.
      redrawLiveStroke()
    }

    const handlePointerUp = (event: PointerEvent): void => {
      finishStroke(event, false)
    }
    const handlePointerCancel = (event: PointerEvent): void => {
      finishStroke(event, true)
    }

    // passive: false is required because these handlers call preventDefault()
    // to stop touch scrolling and mouse text-selection while drawing.
    const options: AddEventListenerOptions = { passive: false }
    element.addEventListener('pointerdown', handlePointerDown, options)
    element.addEventListener('pointermove', handlePointerMove, options)
    element.addEventListener('pointerup', handlePointerUp, options)
    element.addEventListener('pointercancel', handlePointerCancel, options)

    // Every listener is removed on unmount - none may outlive the component.
    return () => {
      element.removeEventListener('pointerdown', handlePointerDown, options)
      element.removeEventListener('pointermove', handlePointerMove, options)
      element.removeEventListener('pointerup', handlePointerUp, options)
      element.removeEventListener('pointercancel', handlePointerCancel, options)
      activePointerIdRef.current = null
    }
  }, [redrawLiveStroke])

  // A resize changes the pixel size of every stroke, including the live one.
  useEffect(() => {
    redrawLiveStroke()
  }, [redrawLiveStroke, size])

  return (
    <div className={styles.canvasFrame}>
      <Stage ref={stageRef} width={size.width} height={size.height}>
        <Layer ref={layerRef} listening={false}>
          {strokes.map((stroke) => (
            <StrokeLine key={stroke.id} stroke={stroke} size={size} />
          ))}
          {/* The live stroke. Always last so it paints above committed ink. */}
          <Line ref={liveLineRef} points={[]} {...LINE_STYLE} />
        </Layer>
      </Stage>
      {/*
        A transparent overlay owns all pointer handling. Listening here rather
        than on the Konva canvas keeps the input layer independent of Konva's
        own event system and gives us native PointerEvents, which is what
        getCoalescedEvents() and pointer capture need.
      */}
      <div ref={overlayRef} className={styles.pointerOverlay} />
    </div>
  )
}

export const DrawingCanvas = memo(DrawingCanvasComponent)
