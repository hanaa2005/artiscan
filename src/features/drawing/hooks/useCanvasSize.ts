/**
 * Tracks the pixel size of the canvas container.
 *
 * ResizeObserver is used rather than a window 'resize' listener because the
 * container can also change size without the window doing so - a sidebar
 * opening, the debug panel expanding, a phone rotating.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Size } from '../utils/coordinates'

const MIN_SIZE = 1

export function useCanvasSize(): {
  containerRef: RefObject<HTMLDivElement | null>
  size: Size
} {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<Size>({ width: MIN_SIZE, height: MIN_SIZE })

  useEffect(() => {
    const element = containerRef.current
    if (element === null) return

    const applySize = (width: number, height: number): void => {
      const nextWidth = Math.max(MIN_SIZE, Math.round(width))
      const nextHeight = Math.max(MIN_SIZE, Math.round(height))
      setSize((previous) => {
        // Skip the state update when nothing actually changed, otherwise a
        // ResizeObserver notification would trigger a needless re-render.
        if (previous.width === nextWidth && previous.height === nextHeight) {
          return previous
        }
        return { width: nextWidth, height: nextHeight }
      })
    }

    applySize(element.clientWidth, element.clientHeight)

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      applySize(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(element)

    // Cleanup on unmount: an un-disconnected observer keeps the element alive
    // and can fire callbacks against an unmounted component.
    return () => {
      observer.disconnect()
    }
  }, [])

  return { containerRef, size }
}
