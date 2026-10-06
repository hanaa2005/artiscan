/**
 * The replay surface. READ-ONLY by construction.
 *
 * There is no pointer handling here at all - no overlay, no listeners, no
 * pointer capture. Replay cannot modify the recording it is showing, because
 * there is no path from this component back into the recorder.
 *
 * Strokes are painted with the SAME component the live canvas uses, from the
 * same normalized coordinates, so the final replay frame and the exported
 * picture are the same picture.
 */

import { memo } from 'react'
import { Layer, Stage } from 'react-konva'
import { StrokeLine } from '../../drawing/components/strokeRendering'
import type { CanvasDescriptor } from '../../drawing/types/drawing.types'
import type { Size } from '../../drawing/utils/coordinates'
import type { ReplayState } from '../services/replayEngine'
import { computeVisualCanvas } from '../utils/replayGeometry'
import styles from './ReplayPanel.module.css'

interface ReplayCanvasProps {
  state: ReplayState
  /** The session's fixed logical canvas. Decides the shape, never the size. */
  logicalCanvas: CanvasDescriptor
  /** How much room the panel has, in display pixels. */
  available: Size
}

function ReplayCanvasComponent({
  state,
  logicalCanvas,
  available,
}: ReplayCanvasProps): React.JSX.Element {
  const visual = computeVisualCanvas(logicalCanvas, available)

  if (visual.size.width <= 0 || visual.size.height <= 0) {
    // Before the first layout there is nothing meaningful to draw; rendering a
    // zero-sized Stage is preferable to guessing a size.
    return <div className={styles.canvasFrame} />
  }

  return (
    <div
      className={styles.canvasFrame}
      style={{ width: visual.size.width, height: visual.size.height }}
    >
      <Stage width={visual.size.width} height={visual.size.height}>
        {/*
          One layer, because the eraser composites with destination-out and can
          only erase ink that shares its layer. `listening={false}` keeps the
          replay inert to the pointer.
        */}
        <Layer listening={false}>
          {state.strokes.map((stroke) => (
            <StrokeLine
              key={stroke.id}
              points={stroke.points}
              tool={stroke.tool}
              color={stroke.color}
              width={stroke.width}
              size={visual.size}
              // Widths are recorded in logical pixels; scale them so the brush
              // keeps its proportion to the drawing at any panel size.
              widthScale={visual.scale}
            />
          ))}
        </Layer>
      </Stage>
    </div>
  )
}

export const ReplayCanvas = memo(ReplayCanvasComponent)
