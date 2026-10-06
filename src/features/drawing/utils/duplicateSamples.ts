/**
 * Duplicate protection for raw pointer samples.
 *
 * THE OBSERVATION
 *
 * Exported sessions contain adjacent point pairs that are identical in every
 * recorded field except `sequence`:
 *
 *     sequence 101 / 102, timeMs 1505.7, x 248.8, y 220.6,
 *     pressure null, tiltX null, tiltY null, pointerType mouse
 *
 * THE RULE THAT SHAPES THIS FILE
 *
 * Two points that LOOK identical are not proof of a duplicate. PointSample
 * values are rounded on the way in - x/y to 0.01 px, timeMs to 0.1 ms - so two
 * genuinely distinct samples from a fast digitizer can round onto each other.
 * Deleting one of those would destroy real evidence of how the hand moved.
 *
 * So the check runs BEFORE any rounding, before a PointSample is built and
 * before a `sequence` is assigned, against the UNROUNDED native event fields.
 * Two categories are treated completely differently:
 *
 *   DEFINITE   the identical raw sample was delivered twice - same pointerId,
 *              same event timeStamp, same unrounded coordinates, same pressure
 *              and tilt, adjacent within one capture. This is the browser
 *              handing back a sample we already have (the native pointermove
 *              overlapping the tail of its own getCoalescedEvents() list), not
 *              the hand producing two measurements. Dropped, and counted.
 *
 *   SUSPECTED  the position repeats but the raw timeStamp advanced. That is a
 *              stationary pointer - a pause, a hesitation, a press-and-hold -
 *              which is exactly the kind of temporal evidence this project
 *              exists to record. KEPT in the raw data, counted only so the
 *              volume is visible during debugging.
 *
 * Because the drop happens before `sequence` is assigned, removing a definite
 * duplicate leaves NO gap in the sequence numbering.
 *
 * Nothing here is written into the session schema: the counters are a
 * diagnostic surface for the debug panel and tests, never exported data.
 */

/**
 * The identity of one raw sample, read straight from the native event.
 *
 * Every field is the browser's own unrounded value. `timeStamp` is included
 * deliberately: it is what separates "the same sample twice" from "the pointer
 * did not move".
 */
export interface RawPointerIdentity {
  pointerId: number
  pointerType: string
  timeStamp: number
  clientX: number
  clientY: number
  pressure: number
  tiltX: number
  tiltY: number
}

/** Reads the identity of a native pointer event. */
export function readPointerIdentity(event: PointerEvent): RawPointerIdentity {
  return {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    timeStamp: event.timeStamp,
    clientX: event.clientX,
    clientY: event.clientY,
    pressure: event.pressure,
    // Not every environment populates tilt; a missing value is normalised to 0
    // so two equally tilt-less samples compare equal instead of NaN-equal.
    tiltX: typeof event.tiltX === 'number' ? event.tiltX : 0,
    tiltY: typeof event.tiltY === 'number' ? event.tiltY : 0,
  }
}

/** True when the pointer occupied the same place with the same sensor readings. */
function isSamePosition(a: RawPointerIdentity, b: RawPointerIdentity): boolean {
  return (
    a.pointerId === b.pointerId &&
    a.pointerType === b.pointerType &&
    a.clientX === b.clientX &&
    a.clientY === b.clientY &&
    Object.is(a.pressure, b.pressure) &&
    Object.is(a.tiltX, b.tiltX) &&
    Object.is(a.tiltY, b.tiltY)
  )
}

/**
 * True when `b` is provably a re-delivery of `a`: same place, same instant.
 *
 * This is the only condition under which a sample is discarded.
 */
export function isDefiniteDuplicate(a: RawPointerIdentity, b: RawPointerIdentity): boolean {
  return isSamePosition(a, b) && a.timeStamp === b.timeStamp
}

/**
 * True when the position repeats but time advanced - a stationary pointer.
 * Never a reason to discard anything.
 */
export function isSuspectedDuplicate(a: RawPointerIdentity, b: RawPointerIdentity): boolean {
  return isSamePosition(a, b) && a.timeStamp !== b.timeStamp
}

/** Diagnostic counters. Debug-only; never part of the exported session. */
export interface CaptureDiagnostics {
  /** Raw samples the browser delivered, before filtering. */
  receivedSampleCount: number
  /** Provable re-deliveries that were dropped. */
  droppedDuplicateCount: number
  /** Stationary-pointer repeats that were KEPT. */
  suspectedDuplicateCount: number
}

export const EMPTY_CAPTURE_DIAGNOSTICS: CaptureDiagnostics = {
  receivedSampleCount: 0,
  droppedDuplicateCount: 0,
  suspectedDuplicateCount: 0,
}

export interface CaptureSampleFilter {
  /**
   * Returns the subset of `events` that is genuinely new, in order.
   *
   * Comparison is against the last ACCEPTED sample only. A duplicate is by
   * definition an immediate re-delivery; comparing against the whole history
   * would delete a legitimate return to an earlier position.
   */
  accept: (events: readonly PointerEvent[]) => PointerEvent[]
  /** Forgets the last sample. Called when a stroke ends, so strokes never interact. */
  reset: () => void
  /** Cumulative counters since the last clearDiagnostics(). */
  getDiagnostics: () => CaptureDiagnostics
  clearDiagnostics: () => void
}

/**
 * Creates a stateful filter for one capture surface.
 *
 * Stateful by necessity: whether a sample is a duplicate is a question about
 * the sample before it, and that sample arrived in a previous event.
 */
export function createCaptureSampleFilter(): CaptureSampleFilter {
  let last: RawPointerIdentity | null = null
  let received = 0
  let dropped = 0
  let suspected = 0

  return {
    accept(events) {
      const kept: PointerEvent[] = []
      for (const event of events) {
        received += 1
        const identity = readPointerIdentity(event)

        if (last !== null) {
          if (isDefiniteDuplicate(last, identity)) {
            dropped += 1
            // `last` deliberately not updated: it already IS this sample.
            continue
          }
          if (isSuspectedDuplicate(last, identity)) {
            suspected += 1
            // Falls through and is kept. A stationary pointer is data.
          }
        }

        last = identity
        kept.push(event)
      }
      return kept
    },
    reset() {
      last = null
    },
    getDiagnostics() {
      return {
        receivedSampleCount: received,
        droppedDuplicateCount: dropped,
        suspectedDuplicateCount: suspected,
      }
    },
    clearDiagnostics() {
      received = 0
      dropped = 0
      suspected = 0
    },
  }
}
