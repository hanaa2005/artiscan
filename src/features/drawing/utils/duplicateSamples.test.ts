/**
 * Week 1A regression tests for duplicate sample protection.
 *
 * The governing rule under test is asymmetric on purpose: a sample is dropped
 * ONLY when it is provably the same raw sample delivered twice. Everything that
 * merely looks similar is kept, because a stationary pointer is evidence about
 * how the drawing was made.
 */

import { describe, expect, it } from 'vitest'
import {
  createCaptureSampleFilter,
  isDefiniteDuplicate,
  isSuspectedDuplicate,
  readPointerIdentity,
  type RawPointerIdentity,
} from './duplicateSamples'

interface FakeEventOptions {
  pointerId?: number
  pointerType?: string
  timeStamp?: number
  clientX?: number
  clientY?: number
  pressure?: number
  tiltX?: number
  tiltY?: number
}

/**
 * A minimal stand-in for a native PointerEvent.
 *
 * jsdom's PointerEvent does not let `timeStamp` be set, and timeStamp is the
 * field the whole policy turns on, so the filter is driven with plain objects
 * carrying exactly the fields it reads.
 */
function fakeEvent(options: FakeEventOptions = {}): PointerEvent {
  return {
    pointerId: options.pointerId ?? 1,
    pointerType: options.pointerType ?? 'mouse',
    timeStamp: options.timeStamp ?? 1000,
    clientX: options.clientX ?? 100,
    clientY: options.clientY ?? 200,
    pressure: options.pressure ?? 0.5,
    tiltX: options.tiltX ?? 0,
    tiltY: options.tiltY ?? 0,
  } as PointerEvent
}

function identity(options: FakeEventOptions = {}): RawPointerIdentity {
  return readPointerIdentity(fakeEvent(options))
}

describe('duplicate classification', () => {
  it('treats an identical raw sample at the identical instant as a definite duplicate', () => {
    const a = identity()
    const b = identity()
    expect(isDefiniteDuplicate(a, b)).toBe(true)
    expect(isSuspectedDuplicate(a, b)).toBe(false)
  })

  it('treats the same position at a later instant as suspected, never definite', () => {
    const a = identity({ timeStamp: 1000 })
    const b = identity({ timeStamp: 1008 })
    expect(isDefiniteDuplicate(a, b)).toBe(false)
    expect(isSuspectedDuplicate(a, b)).toBe(true)
  })

  it('does not call a moved pointer a duplicate of any kind', () => {
    const a = identity({ clientX: 100 })
    const b = identity({ clientX: 100.5 })
    expect(isDefiniteDuplicate(a, b)).toBe(false)
    expect(isSuspectedDuplicate(a, b)).toBe(false)
  })

  it('separates samples from different pointers even when everything else matches', () => {
    const a = identity({ pointerId: 1 })
    const b = identity({ pointerId: 2 })
    expect(isDefiniteDuplicate(a, b)).toBe(false)
    expect(isSuspectedDuplicate(a, b)).toBe(false)
  })

  it('separates samples whose pressure differs', () => {
    const a = identity({ pointerType: 'pen', pressure: 0.4 })
    const b = identity({ pointerType: 'pen', pressure: 0.41 })
    expect(isDefiniteDuplicate(a, b)).toBe(false)
  })

  it('separates samples whose tilt differs', () => {
    const a = identity({ pointerType: 'pen', tiltX: 10 })
    const b = identity({ pointerType: 'pen', tiltX: 11 })
    expect(isDefiniteDuplicate(a, b)).toBe(false)
  })
})

describe('createCaptureSampleFilter', () => {
  it('drops the coalesced sample that repeats the native event exactly', () => {
    /*
      The observed Chrome shape: the native pointermove is delivered, and the
      tail of its own getCoalescedEvents() list is the very same sample. Both
      reach the recorder in one tick, which is why the exported pair shared a
      timeMs of 1505.7 as well as x 248.8 / y 220.6.
    */
    const filter = createCaptureSampleFilter()
    const duplicated = { timeStamp: 1505.7, clientX: 248.8, clientY: 220.6 }

    expect(filter.accept([fakeEvent(duplicated)])).toHaveLength(1)
    expect(filter.accept([fakeEvent(duplicated)])).toHaveLength(0)

    const diagnostics = filter.getDiagnostics()
    expect(diagnostics.receivedSampleCount).toBe(2)
    expect(diagnostics.droppedDuplicateCount).toBe(1)
    expect(diagnostics.suspectedDuplicateCount).toBe(0)
  })

  it('drops a duplicate that arrives inside one coalesced batch', () => {
    const filter = createCaptureSampleFilter()
    const kept = filter.accept([
      fakeEvent({ timeStamp: 1000, clientX: 10 }),
      fakeEvent({ timeStamp: 1000, clientX: 10 }),
      fakeEvent({ timeStamp: 1004, clientX: 12 }),
    ])

    expect(kept).toHaveLength(2)
    expect(kept.map((event) => event.clientX)).toEqual([10, 12])
    expect(filter.getDiagnostics().droppedDuplicateCount).toBe(1)
  })

  it('KEEPS a stationary pointer: same x/y, different timestamp', () => {
    const filter = createCaptureSampleFilter()
    const kept = filter.accept([
      fakeEvent({ timeStamp: 1000, clientX: 50, clientY: 50 }),
      fakeEvent({ timeStamp: 1016, clientX: 50, clientY: 50 }),
      fakeEvent({ timeStamp: 1032, clientX: 50, clientY: 50 }),
    ])

    // A pointer held still is exactly the kind of temporal evidence this
    // project records. Nothing may be removed.
    expect(kept).toHaveLength(3)
    const diagnostics = filter.getDiagnostics()
    expect(diagnostics.droppedDuplicateCount).toBe(0)
    expect(diagnostics.suspectedDuplicateCount).toBe(2)
  })

  it('keeps a genuine return to an earlier position', () => {
    // Compared against the previous sample only. A path that comes back to
    // where it was is real movement, not a re-delivery.
    const filter = createCaptureSampleFilter()
    const kept = filter.accept([
      fakeEvent({ timeStamp: 1000, clientX: 10 }),
      fakeEvent({ timeStamp: 1010, clientX: 20 }),
      fakeEvent({ timeStamp: 1020, clientX: 10 }),
    ])
    expect(kept).toHaveLength(3)
  })

  it('never compares across strokes: a new press at the same spot is recorded', () => {
    const filter = createCaptureSampleFilter()
    const spot = { timeStamp: 1000, clientX: 30, clientY: 30 }

    expect(filter.accept([fakeEvent(spot)])).toHaveLength(1)
    filter.reset()
    // Same coordinates, same timestamp - but a different stroke entirely.
    expect(filter.accept([fakeEvent(spot)])).toHaveLength(1)
    expect(filter.getDiagnostics().droppedDuplicateCount).toBe(0)
  })

  it.each(['mouse', 'touch', 'pen'])('applies the same policy to %s input', (pointerType) => {
    const filter = createCaptureSampleFilter()
    const base = { pointerType, timeStamp: 500, clientX: 5, clientY: 5, pressure: 0.7 }

    expect(filter.accept([fakeEvent(base)])).toHaveLength(1)
    // Exact re-delivery: dropped.
    expect(filter.accept([fakeEvent(base)])).toHaveLength(0)
    // Stationary: kept.
    expect(filter.accept([fakeEvent({ ...base, timeStamp: 516 })])).toHaveLength(1)
  })

  it('reports diagnostics that can be cleared without affecting filtering', () => {
    const filter = createCaptureSampleFilter()
    filter.accept([fakeEvent(), fakeEvent()])
    expect(filter.getDiagnostics().droppedDuplicateCount).toBe(1)

    filter.clearDiagnostics()
    expect(filter.getDiagnostics()).toEqual({
      receivedSampleCount: 0,
      droppedDuplicateCount: 0,
      suspectedDuplicateCount: 0,
    })
  })
})
