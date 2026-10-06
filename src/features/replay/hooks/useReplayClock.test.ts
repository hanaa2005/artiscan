/**
 * WEEK 1B - the replay clock.
 *
 * Time is faked here, including requestAnimationFrame and performance.now(), so
 * "advance 500 ms" means exactly that and the assertions are about elapsed time
 * rather than about how many frames happened to fire. That is also what the
 * clock itself is built on, so the test and the implementation agree about what
 * is being measured.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReplayClock, type PlaybackRate } from './useReplayClock'

const DURATION = 1000

/** Lets `ms` of wall-clock time pass, running animation frames as it goes. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
      'setTimeout',
      'clearTimeout',
    ],
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('play, pause and resume', () => {
  it('starts at zero and paused', () => {
    const { result } = renderHook(() => useReplayClock(DURATION))

    expect(result.current.timeMs).toBe(0)
    expect(result.current.isPlaying).toBe(false)
    expect(result.current.isAtEnd).toBe(false)
  })

  it('advances by elapsed real time at 1x', () => {
    const { result } = renderHook(() => useReplayClock(DURATION))

    act(() => {
      result.current.play()
    })
    advance(500)

    expect(result.current.isPlaying).toBe(true)
    // Frame granularity means the last frame may land a little before 500.
    expect(result.current.timeMs).toBeGreaterThan(450)
    expect(result.current.timeMs).toBeLessThanOrEqual(500)
  })

  it('stops advancing while paused', () => {
    const { result } = renderHook(() => useReplayClock(DURATION))

    act(() => {
      result.current.play()
    })
    advance(300)
    act(() => {
      result.current.pause()
    })
    const atPause = result.current.timeMs

    advance(1000)

    expect(result.current.isPlaying).toBe(false)
    expect(result.current.timeMs).toBe(atPause)
  })

  it('resumes from where it paused, with no time jump', () => {
    const { result } = renderHook(() => useReplayClock(DURATION))

    act(() => {
      result.current.play()
    })
    advance(300)
    act(() => {
      result.current.pause()
    })
    const atPause = result.current.timeMs

    // A long wait while paused must not be credited to the replay.
    advance(5000)
    act(() => {
      result.current.play()
    })
    advance(200)

    expect(result.current.timeMs).toBeGreaterThanOrEqual(atPause + 150)
    expect(result.current.timeMs).toBeLessThanOrEqual(atPause + 200)
  })

  it('does nothing on play when there is no timeline', () => {
    const { result } = renderHook(() => useReplayClock(0))

    act(() => {
      result.current.play()
    })
    advance(500)

    expect(result.current.isPlaying).toBe(false)
    expect(result.current.timeMs).toBe(0)
  })
})

describe('the end of the timeline', () => {
  it('stops exactly at the duration and does not overshoot', () => {
    const { result } = renderHook(() => useReplayClock(DURATION))

    act(() => {
      result.current.play()
    })
    advance(DURATION + 500)

    expect(result.current.timeMs).toBe(DURATION)
    expect(result.current.isPlaying).toBe(false)
    expect(result.current.isAtEnd).toBe(true)
  })

  it('does not loop by itself once it has finished', () => {
    const { result } = renderHook(() => useReplayClock(DURATION))

    act(() => {
      result.current.play()
    })
    advance(DURATION + 100)
    advance(5000)

    // Still parked at the end rather than having wrapped around.
    expect(result.current.timeMs).toBe(DURATION)
    expect(result.current.isPlaying).toBe(false)
  })

  it('plays again from the start when play is pressed at the end', () => {
    const { result } = renderHook(() => useReplayClock(DURATION))

    act(() => {
      result.current.play()
    })
    advance(DURATION + 100)
    expect(result.current.isAtEnd).toBe(true)

    act(() => {
      result.current.play()
    })
    advance(100)

    expect(result.current.isPlaying).toBe(true)
    expect(result.current.timeMs).toBeLessThan(200)
    expect(result.current.timeMs).toBeGreaterThan(0)
  })

  it('restart rewinds to zero and plays', () => {
    const { result } = renderHook(() => useReplayClock(DURATION))

    act(() => {
      result.current.play()
    })
    advance(700)
    act(() => {
      result.current.restart()
    })

    expect(result.current.timeMs).toBe(0)
    expect(result.current.isPlaying).toBe(true)

    advance(100)
    expect(result.current.timeMs).toBeGreaterThan(0)
    expect(result.current.timeMs).toBeLessThanOrEqual(100)
  })
})

describe('playback rate', () => {
  it.each([1, 2, 4] as PlaybackRate[])('advances at %sx', (rate) => {
    const { result } = renderHook(() => useReplayClock(10_000))

    act(() => {
      result.current.setRate(rate)
      result.current.play()
    })
    advance(400)

    expect(result.current.rate).toBe(rate)
    // 400 ms of wall clock is 400 * rate of replay time, within one frame.
    expect(result.current.timeMs).toBeGreaterThan(400 * rate - 20 * rate)
    expect(result.current.timeMs).toBeLessThanOrEqual(400 * rate)
  })

  it('changes rate mid-playback without jumping the clock', () => {
    const { result } = renderHook(() => useReplayClock(10_000))

    act(() => {
      result.current.play()
    })
    advance(500)
    const beforeChange = result.current.timeMs

    act(() => {
      result.current.setRate(4)
    })
    // The change itself must move nothing.
    expect(result.current.timeMs).toBe(beforeChange)

    advance(100)
    // Only what follows runs at the new rate: about 400 ms more, not 2000.
    const gained = result.current.timeMs - beforeChange
    expect(gained).toBeGreaterThan(300)
    expect(gained).toBeLessThanOrEqual(400)
  })

  it('reaches the same end state at every rate', () => {
    for (const rate of [1, 2, 4] as PlaybackRate[]) {
      const { result, unmount } = renderHook(() => useReplayClock(DURATION))

      act(() => {
        result.current.setRate(rate)
        result.current.play()
      })
      advance(DURATION + 100)

      expect(result.current.timeMs).toBe(DURATION)
      expect(result.current.isAtEnd).toBe(true)
      unmount()
    }
  })

  it('keeps the rate across a pause and resume', () => {
    const { result } = renderHook(() => useReplayClock(10_000))

    act(() => {
      result.current.setRate(2)
      result.current.play()
    })
    advance(200)
    act(() => {
      result.current.pause()
    })
    act(() => {
      result.current.play()
    })
    advance(200)

    expect(result.current.rate).toBe(2)
    // Two 200 ms spans at 2x is about 800 ms of replay time.
    expect(result.current.timeMs).toBeGreaterThan(700)
    expect(result.current.timeMs).toBeLessThanOrEqual(800)
  })
})

describe('seeking', () => {
  it('seeks while paused without starting playback', () => {
    const { result } = renderHook(() => useReplayClock(DURATION))

    act(() => {
      result.current.seek(620)
    })

    expect(result.current.timeMs).toBe(620)
    expect(result.current.isPlaying).toBe(false)

    advance(500)
    expect(result.current.timeMs).toBe(620)
  })

  it('seeks while playing and continues from the new position', () => {
    const { result } = renderHook(() => useReplayClock(10_000))

    act(() => {
      result.current.play()
    })
    advance(300)
    act(() => {
      result.current.seek(5000)
    })

    expect(result.current.timeMs).toBe(5000)
    expect(result.current.isPlaying).toBe(true)

    advance(200)
    // Continues forward from 5000 - the pre-seek elapsed time is not re-added.
    expect(result.current.timeMs).toBeGreaterThan(5000)
    expect(result.current.timeMs).toBeLessThanOrEqual(5200)
  })

  it('clamps a seek past either end', () => {
    const { result } = renderHook(() => useReplayClock(DURATION))

    act(() => {
      result.current.seek(-500)
    })
    expect(result.current.timeMs).toBe(0)

    act(() => {
      result.current.seek(999_999)
    })
    expect(result.current.timeMs).toBe(DURATION)
    expect(result.current.isAtEnd).toBe(true)
  })

  it('ignores a non-finite seek instead of poisoning the clock', () => {
    const { result } = renderHook(() => useReplayClock(DURATION))

    act(() => {
      result.current.seek(Number.NaN)
    })
    expect(result.current.timeMs).toBe(0)
  })

  it('can be seeked backwards repeatedly while playing', () => {
    const { result } = renderHook(() => useReplayClock(10_000))

    act(() => {
      result.current.play()
    })
    for (const target of [4000, 1000, 7000, 200]) {
      act(() => {
        result.current.seek(target)
      })
      expect(result.current.timeMs).toBe(target)
      advance(50)
      expect(result.current.timeMs).toBeGreaterThanOrEqual(target)
      expect(result.current.timeMs).toBeLessThanOrEqual(target + 50)
    }
  })
})

describe('loop hygiene', () => {
  it('runs exactly one animation loop even after repeated play calls', () => {
    const requestSpy = vi.spyOn(globalThis, 'requestAnimationFrame')
    const { result } = renderHook(() => useReplayClock(10_000))

    act(() => {
      result.current.play()
      result.current.play()
      result.current.play()
    })
    requestSpy.mockClear()

    // One frame elapsed should schedule exactly one successor, not three.
    advance(16)
    expect(requestSpy).toHaveBeenCalledTimes(1)

    requestSpy.mockRestore()
  })

  it('advances at the same speed whether play was called once or many times', () => {
    const single = renderHook(() => useReplayClock(10_000))
    act(() => {
      single.result.current.play()
    })
    advance(300)
    const singleTime = single.result.current.timeMs
    single.unmount()

    const repeated = renderHook(() => useReplayClock(10_000))
    act(() => {
      repeated.result.current.play()
      repeated.result.current.play()
      repeated.result.current.play()
    })
    advance(300)

    /*
      A second loop would advance the clock twice per frame, so the tell-tale is
      roughly double, not a few milliseconds. The tolerance is one frame,
      because the two mounts start at different phases of the faked clock -
      asserting exact equality would be testing frame alignment, not loop count.
    */
    expect(Math.abs(repeated.result.current.timeMs - singleTime)).toBeLessThanOrEqual(20)
    repeated.unmount()
  })

  it('cancels its animation frame on unmount', () => {
    const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame')
    const { result, unmount } = renderHook(() => useReplayClock(10_000))

    act(() => {
      result.current.play()
    })
    unmount()

    expect(cancelSpy).toHaveBeenCalled()
    cancelSpy.mockRestore()
  })

  it('leaves no frame running after unmount', () => {
    const { result, unmount } = renderHook(() => useReplayClock(10_000))
    act(() => {
      result.current.play()
    })
    unmount()

    const requestSpy = vi.spyOn(globalThis, 'requestAnimationFrame')
    // Nothing may reschedule itself once the component is gone.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(requestSpy).not.toHaveBeenCalled()
    requestSpy.mockRestore()
  })

  it('survives a StrictMode double mount without doubling the clock', async () => {
    const { StrictMode, createElement } = await import('react')
    const single = renderHook(() => useReplayClock(10_000))
    act(() => {
      single.result.current.play()
    })
    advance(300)
    const singleTime = single.result.current.timeMs
    single.unmount()

    const strict = renderHook(() => useReplayClock(10_000), {
      wrapper: ({ children }) => createElement(StrictMode, null, children),
    })
    act(() => {
      strict.result.current.play()
    })
    advance(300)

    // StrictMode mounts, unmounts and remounts. If that left the first mount's
    // loop alive the clock would run at double speed; one frame of tolerance
    // covers only the phase difference between the two mounts.
    expect(Math.abs(strict.result.current.timeMs - singleTime)).toBeLessThanOrEqual(20)
    strict.unmount()
  })

  it('rewinds and stops when the timeline is replaced', () => {
    const { result, rerender } = renderHook(({ duration }) => useReplayClock(duration), {
      initialProps: { duration: 10_000 },
    })

    act(() => {
      result.current.play()
    })
    advance(500)
    expect(result.current.timeMs).toBeGreaterThan(0)

    // A different recording: showing a position from the previous one would be
    // meaningless, and a loop outliving it would be a leak.
    rerender({ duration: 2000 })

    expect(result.current.timeMs).toBe(0)
    expect(result.current.isPlaying).toBe(false)
    expect(result.current.durationMs).toBe(2000)
  })
})
