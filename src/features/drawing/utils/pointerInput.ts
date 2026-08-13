/**
 * Decoding raw Pointer Events into clean, honest samples.
 *
 * Everything browser-specific and every "is this value real?" judgement lives
 * here, so the recorder hook can stay a pure event log.
 */

import type { PointerInputType } from '../types/drawing.types'
import type { RawPointerSample } from '../hooks/useDrawingSession'
import { toNormalized, type Size } from './coordinates'

/** Maps the browser's pointerType string onto our closed union. */
export function readPointerType(pointerType: string): PointerInputType {
  if (pointerType === 'mouse' || pointerType === 'pen' || pointerType === 'touch') {
    return pointerType
  }
  return 'unknown'
}

/**
 * Returns genuine pen pressure, or null.
 *
 * The Pointer Events specification says a device that cannot report pressure
 * must report 0.5 while a button is held. A mouse therefore always says "0.5".
 * Recording that as pressure would quietly fill the research dataset with a
 * constant that looks like a measurement but is not one - exactly the kind of
 * artefact that invalidates a later analysis.
 *
 * So pressure is trusted only from a real stylus. Touch digitizers are excluded
 * for the same reason: most report a constant rather than true force.
 */
export function readPressure(
  pointerType: PointerInputType,
  pressure: number,
): number | null {
  if (pointerType !== 'pen') return null
  if (!Number.isFinite(pressure)) return null
  if (pressure <= 0) return null
  return Math.round(pressure * 1000) / 1000
}

/** Returns tilt in degrees, or null when the device does not report it. */
function readTilt(pointerType: PointerInputType, tilt: number | undefined): number | null {
  if (pointerType !== 'pen') return null
  if (typeof tilt !== 'number' || !Number.isFinite(tilt)) return null
  return tilt
}

/**
 * Converts a native PointerEvent into a sample in canvas coordinates.
 *
 * `rect` is the canvas bounding box in viewport coordinates; subtracting its
 * origin turns page coordinates into canvas-local ones.
 */
export function toRawSample(
  event: PointerEvent,
  rect: DOMRect,
  size: Size,
): RawPointerSample {
  const pointerType = readPointerType(event.pointerType)
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  const { normalizedX, normalizedY } = toNormalized(x, y, size)

  return {
    x,
    y,
    normalizedX,
    normalizedY,
    pressure: readPressure(pointerType, event.pressure),
    tiltX: readTilt(pointerType, event.tiltX),
    tiltY: readTilt(pointerType, event.tiltY),
    pointerType,
  }
}

/**
 * Returns every sample the browser has for this move event.
 *
 * A display refreshing at 60 Hz delivers one pointermove per frame, but a
 * 240 Hz digitizer produced several samples in that time. getCoalescedEvents()
 * hands back the ones that were merged, which is the difference between a
 * blocky polyline and an accurate trace - and for this project, between a
 * coarse and a fine recording of the drawing process.
 *
 * Not every browser implements it, hence the fallback to the event itself.
 */
export function getPointerSamples(event: PointerEvent): PointerEvent[] {
  if (typeof event.getCoalescedEvents === 'function') {
    const coalesced = event.getCoalescedEvents()
    if (coalesced.length > 0) {
      return coalesced
    }
  }
  return [event]
}
