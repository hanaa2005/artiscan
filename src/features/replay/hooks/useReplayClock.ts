/**
 * The replay clock.
 *
 * ELAPSED TIME, NOT FRAMES
 *
 * Replay time advances by measured wall-clock elapsed time multiplied by the
 * playback rate - never by counting frames. Counting frames would make the
 * replay run slower on a loaded machine and at a different speed on a 120 Hz
 * display than on a 60 Hz one, so the same session would take a different
 * amount of time to replay depending on the hardware. Elapsed time makes 2x
 * mean twice as fast everywhere.
 *
 * THE ANCHOR
 *
 * The loop never accumulates `+= delta`, because repeated addition drifts and
 * makes the current time depend on how many frames happened to fire. Instead
 * two values are anchored - the wall clock and the replay time at the moment
 * playback last started - and the current time is computed from them:
 *
 *     timeMs = anchorReplayMs + (now - anchorWallMs) * rate
 *
 * Pausing, seeking and changing the rate all RE-ANCHOR. That is what lets the
 * rate change mid-playback without a jump: the time already elapsed keeps the
 * speed it was played at, and only what follows uses the new rate.
 *
 * EXACTLY ONE LOOP
 *
 * A second requestAnimationFrame loop would advance the clock twice per frame.
 * The handle is held in a ref and a new loop is only ever scheduled when there
 * is none, so a double play() - or a StrictMode double effect - cannot start one.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** The offered playback speeds. */
export type PlaybackRate = 1 | 2 | 4

export const PLAYBACK_RATES: readonly PlaybackRate[] = [1, 2, 4]

export interface ReplayClock {
  /** Current replay position, always within 0..durationMs. */
  timeMs: number
  isPlaying: boolean
  rate: PlaybackRate
  durationMs: number
  /** True once the clock has reached the end of the timeline. */
  isAtEnd: boolean

  /** Starts or resumes. At the end of the timeline it replays from the start. */
  play: () => void
  pause: () => void
  /** Jumps to zero and plays. */
  restart: () => void
  /** Jumps to a time, clamped, without disturbing play/pause state. */
  seek: (timeMs: number) => void
  setRate: (rate: PlaybackRate) => void
}

function clampTime(timeMs: number, durationMs: number): number {
  if (!Number.isFinite(timeMs)) return 0
  if (timeMs < 0) return 0
  if (timeMs > durationMs) return durationMs
  return timeMs
}

export function useReplayClock(durationMs: number): ReplayClock {
  const [timeMs, setTimeMsState] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [rate, setRateState] = useState<PlaybackRate>(1)

  /**
   * The authoritative current time.
   *
   * State is for rendering and is a render behind inside a batch; the loop and
   * every control read and write this instead, so a seek immediately followed
   * by a rate change cannot anchor to a stale value.
   */
  const timeRef = useRef(0)
  const rateRef = useRef<PlaybackRate>(1)
  const durationRef = useRef(durationMs)
  durationRef.current = durationMs

  /** The single animation-frame handle. Non-null exactly while a loop is live. */
  const frameRef = useRef<number | null>(null)
  /** Wall clock and replay time at the last (re-)anchor. */
  const anchorWallRef = useRef(0)
  const anchorReplayRef = useRef(0)

  const writeTime = useCallback((next: number): void => {
    timeRef.current = next
    setTimeMsState(next)
  }, [])

  const stopLoop = useCallback((): void => {
    if (frameRef.current === null) return
    cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }, [])

  /** Re-bases the anchor on the current time. Safe to call while stopped. */
  const anchor = useCallback((): void => {
    anchorWallRef.current = performance.now()
    anchorReplayRef.current = timeRef.current
  }, [])

  /**
   * One frame: recompute the time from the anchor, stop at the end.
   *
   * Declared through a ref so the loop body can be replaced without cancelling
   * and restarting the loop, and so it never closes over a stale rate.
   */
  const tickRef = useRef<() => void>(() => undefined)
  tickRef.current = () => {
    const duration = durationRef.current
    const elapsed = performance.now() - anchorWallRef.current
    const next = anchorReplayRef.current + elapsed * rateRef.current

    if (next >= duration) {
      // Land exactly on the end rather than a frame past it, and stop: replay
      // must not loop on its own.
      writeTime(duration)
      stopLoop()
      setIsPlaying(false)
      return
    }

    writeTime(next)
    frameRef.current = requestAnimationFrame(() => {
      tickRef.current()
    })
  }

  const startLoop = useCallback((): void => {
    // Exactly one loop, ever.
    if (frameRef.current !== null) return
    anchor()
    frameRef.current = requestAnimationFrame(() => {
      tickRef.current()
    })
  }, [anchor])

  const play = useCallback((): void => {
    const duration = durationRef.current
    if (duration <= 0) return

    // Pressing play at the end starts over, rather than doing nothing.
    if (timeRef.current >= duration) {
      writeTime(0)
    }
    setIsPlaying(true)
    startLoop()
  }, [startLoop, writeTime])

  const pause = useCallback((): void => {
    stopLoop()
    setIsPlaying(false)
    // Keep the anchor honest so a later resume continues from here rather than
    // from where playback originally began.
    anchor()
  }, [anchor, stopLoop])

  const seek = useCallback(
    (next: number): void => {
      writeTime(clampTime(next, durationRef.current))
      // Re-anchor whether or not the clock is running: a seek during playback
      // must continue from the new position, not carry the old elapsed time.
      anchor()
    },
    [anchor, writeTime],
  )

  const setRate = useCallback(
    (next: PlaybackRate): void => {
      // Anchor FIRST, so everything played so far keeps the speed it was played
      // at and only the remainder uses the new rate. Without this the whole
      // elapsed span would be recomputed at the new rate and the time would jump.
      anchor()
      rateRef.current = next
      setRateState(next)
    },
    [anchor],
  )

  const restart = useCallback((): void => {
    writeTime(0)
    setIsPlaying(true)
    anchor()
    startLoop()
  }, [anchor, startLoop, writeTime])

  /**
   * A different recording is a different timeline.
   *
   * Rewinding avoids showing a position that does not exist in the new session,
   * and stopping avoids a loop that outlives what it was playing.
   */
  useEffect(() => {
    stopLoop()
    setIsPlaying(false)
    timeRef.current = 0
    setTimeMsState(0)
  }, [durationMs, stopLoop])

  /**
   * No animation frame may outlive the component.
   *
   * This is the cleanup StrictMode exercises twice in development, and the one
   * that matters when the user leaves the page mid-playback.
   */
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  return {
    timeMs,
    isPlaying,
    rate,
    durationMs,
    isAtEnd: durationMs > 0 && timeMs >= durationMs,
    play,
    pause,
    restart,
    seek,
    setRate,
  }
}
