/**
 * The replay panel: engine + clock + surface + transport.
 *
 * WHAT THIS COMPONENT IS CAREFUL ABOUT
 *
 * 1. It never mutates the session. The session arrives as a prop, is validated
 *    once, and is only ever read.
 * 2. It refuses to replay an invalid session. Rendering "something" for a file
 *    whose timeline contradicts itself would present a guess as a
 *    reconstruction, so the panel explains the problem instead.
 * 3. It derives the frame from the clock, not the other way round. The clock
 *    owns time; getReplayStateAt owns what that time looks like. Neither knows
 *    about the other.
 * 4. No animation frame outlives it - see useReplayClock's cleanup.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { DrawingSession } from '../../drawing/types/drawing.types'
import type { Size } from '../../drawing/utils/coordinates'
import { useReplayClock } from '../hooks/useReplayClock'
import { getReplayStateAt, validateReplaySession } from '../services/replayEngine'
import { ReplayCanvas } from './ReplayCanvas'
import { ReplayControls } from './ReplayControls'
import styles from './ReplayPanel.module.css'

interface ReplayPanelProps {
  /**
   * The recording to replay. Treated as immutable: the panel holds no copy and
   * writes nothing back.
   */
  session: DrawingSession
}

/**
 * Measures the panel so the replay can be letterboxed into it.
 *
 * Its own observer rather than useCanvasSize, because that hook starts at 1x1
 * and is written for the capture container; here a zero size simply means
 * "not laid out yet" and the canvas renders nothing.
 */
function useAvailableSize(): {
  containerRef: React.RefObject<HTMLDivElement | null>
  available: Size
} {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [available, setAvailable] = useState<Size>({ width: 0, height: 0 })

  useEffect(() => {
    const element = containerRef.current
    if (element === null) return

    const apply = (width: number, height: number): void => {
      setAvailable((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      )
    }

    apply(element.clientWidth, element.clientHeight)

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      apply(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(element)

    return () => {
      observer.disconnect()
    }
  }, [])

  return { containerRef, available }
}

export function ReplayPanel({ session }: ReplayPanelProps): React.JSX.Element {
  const { containerRef, available } = useAvailableSize()

  /**
   * Validated once per session, not per frame.
   *
   * Replay must not silently render an invalid recording, but re-validating
   * sixty times a second would be pure waste - the session cannot change while
   * it is being replayed.
   */
  const validated = useMemo(() => validateReplaySession(session), [session])
  const replaySession = validated.ok ? validated.value : null

  const durationMs = useMemo(() => {
    if (replaySession === null) return 0
    return getReplayStateAt(replaySession, Number.POSITIVE_INFINITY).durationMs
  }, [replaySession])

  const clock = useReplayClock(durationMs)

  /**
   * The frame.
   *
   * Recomputed only when the time or the session changes - no deep clone, no
   * serialization, nothing per-frame beyond this one derivation.
   */
  const state = useMemo(() => {
    if (replaySession === null) return null
    return getReplayStateAt(replaySession, clock.timeMs)
  }, [clock.timeMs, replaySession])

  if (replaySession === null || state === null) {
    return (
      <section className={styles.panel} aria-labelledby="replay-heading">
        <h3 id="replay-heading" className={styles.heading}>
          بازپخش فرایند رسم
        </h3>
        <p className={styles.errorNotice} role="alert">
          این جلسه قابل بازپخش نیست، چون داده آن معتبر نیست:{' '}
          {validated.ok ? 'خطای ناشناخته' : validated.error}
        </p>
      </section>
    )
  }

  const hasTimeline = durationMs > 0

  return (
    <section className={styles.panel} aria-labelledby="replay-heading">
      <h3 id="replay-heading" className={styles.heading}>
        بازپخش فرایند رسم
      </h3>
      <p className={styles.note}>
        این بازپخش فقط از روی داده خام همین جلسه ساخته می‌شود و هیچ تغییری در آن ایجاد
        نمی‌کند.
      </p>

      <div className={styles.stageArea} ref={containerRef}>
        <ReplayCanvas
          state={state}
          logicalCanvas={replaySession.canvas}
          available={available}
        />
      </div>

      {hasTimeline ? (
        <ReplayControls
          timeMs={clock.timeMs}
          durationMs={clock.durationMs}
          isPlaying={clock.isPlaying}
          isAtEnd={clock.isAtEnd}
          rate={clock.rate}
          onPlay={clock.play}
          onPause={clock.pause}
          onRestart={clock.restart}
          onSeek={clock.seek}
          onRateChange={clock.setRate}
        />
      ) : (
        // No timeline means nothing to transport through. Rendering a dead
        // slider and a play button that cannot play would be a lie.
        <p className={styles.note}>این جلسه هیچ نقطه‌ای برای بازپخش ندارد.</p>
      )}

      <p className={styles.statusLine}>
        <span>{`خطوط نمایش‌داده‌شده: ${String(state.strokes.length)}`}</span>
        {state.activeStrokeId === null ? null : (
          <span className={styles.activeBadge}>در حال رسم</span>
        )}
      </p>
    </section>
  )
}
