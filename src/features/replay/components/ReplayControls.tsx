/**
 * Replay transport controls.
 *
 * Presentational only - every action is a callback. Following the toolbar's
 * rule, no control is rendered inert: the whole panel is only mounted when
 * there is a valid session to replay, so every button here always does what it
 * says.
 */

import { memo } from 'react'
import { PLAYBACK_RATES, type PlaybackRate } from '../hooks/useReplayClock'
import { formatReplayTime } from '../utils/replayGeometry'
import styles from './ReplayPanel.module.css'

interface ReplayControlsProps {
  timeMs: number
  durationMs: number
  isPlaying: boolean
  isAtEnd: boolean
  rate: PlaybackRate
  onPlay: () => void
  onPause: () => void
  onRestart: () => void
  onSeek: (timeMs: number) => void
  onRateChange: (rate: PlaybackRate) => void
}

/**
 * Slider resolution.
 *
 * The slider works in milliseconds rather than in a 0..100 percentage, so
 * seeking is exact and does not lose precision on a long recording.
 */
const SEEK_STEP_MS = 1

function ReplayControlsComponent({
  timeMs,
  durationMs,
  isPlaying,
  isAtEnd,
  rate,
  onPlay,
  onPause,
  onRestart,
  onSeek,
  onRateChange,
}: ReplayControlsProps): React.JSX.Element {
  return (
    <div className={styles.controls} role="group" aria-label="کنترل بازپخش">
      <div className={styles.transport}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={isPlaying ? onPause : onPlay}
        >
          {isPlaying ? 'توقف' : isAtEnd ? 'پخش دوباره' : 'پخش'}
        </button>
        <button type="button" className={styles.button} onClick={onRestart}>
          از ابتدا
        </button>
      </div>

      <label className={styles.seekField} htmlFor="artiscan-replay-seek">
        <span className={styles.srOnly}>موقعیت بازپخش</span>
        <input
          id="artiscan-replay-seek"
          type="range"
          className={styles.seekSlider}
          min={0}
          max={durationMs}
          step={SEEK_STEP_MS}
          value={timeMs}
          // Seeking during playback is explicitly supported: the clock
          // re-anchors rather than fighting the drag.
          onChange={(event) => {
            onSeek(Number(event.target.value))
          }}
          aria-valuetext={`${formatReplayTime(timeMs)} از ${formatReplayTime(durationMs)}`}
        />
      </label>

      <p className={styles.timeReadout} aria-live="off">
        <span>{formatReplayTime(timeMs)}</span>
        <span aria-hidden="true"> / </span>
        <span>{formatReplayTime(durationMs)}</span>
      </p>

      <div className={styles.rates} role="group" aria-label="سرعت بازپخش">
        {PLAYBACK_RATES.map((option) => (
          <button
            key={option}
            type="button"
            className={option === rate ? styles.rateButtonActive : styles.rateButton}
            aria-pressed={option === rate}
            onClick={() => {
              onRateChange(option)
            }}
          >
            {`${String(option)}x`}
          </button>
        ))}
      </div>
    </div>
  )
}

export const ReplayControls = memo(ReplayControlsComponent)
