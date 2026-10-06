/**
 * The stage panel: instructions, countdown, live drawing status and the
 * finish/cancel controls.
 *
 * One component rather than four, because each phase renders a single short
 * block and splitting them would spread one small state machine across four
 * files.
 */

import { memo } from 'react'
import type { DrawingTask, TrialStatus } from '../types/trial.types'
import styles from './TrialFlow.module.css'

interface TrialStagePanelProps {
  status: TrialStatus
  task: DrawingTask | null
  countdownRemaining: number
  elapsedMs: number
  countdownSeconds: number
  /** False while the canvas is still empty - an empty trial cannot be recorded. */
  canComplete: boolean
  onBeginCountdown: () => void
  onComplete: () => void
  onCancel: () => void
  onReset: () => void
}

/** Formats elapsed milliseconds as `m:ss`. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function TrialStagePanelComponent({
  status,
  task,
  countdownRemaining,
  elapsedMs,
  countdownSeconds,
  canComplete,
  onBeginCountdown,
  onComplete,
  onCancel,
  onReset,
}: TrialStagePanelProps): React.JSX.Element {
  return (
    <section className={styles.panel} aria-labelledby="trial-stage-heading">
      <h2 id="trial-stage-heading" className={styles.heading}>
        ۲. اجرای آزمون
      </h2>

      {status === 'idle' ? (
        <p className={styles.stageText}>ابتدا یک تکلیف انتخاب کنید.</p>
      ) : null}

      {status === 'instructions' && task !== null ? (
        <div className={styles.stageBlock}>
          <p className={styles.instruction}>{task.instructionFa}</p>
          <p className={styles.stageText}>
            {task.timeLimitSeconds === null
              ? 'بدون زمان پیشنهادی.'
              : `زمان پیشنهادی: ${task.timeLimitSeconds} ثانیه (الزام‌آور نیست؛ آزمون خودکار پایان نمی‌یابد).`}{' '}
            پس از زدن دکمه، {countdownSeconds} ثانیه شمارش معکوس انجام می‌شود و سپس رسم آغاز
            می‌گردد.
          </p>
          <div className={styles.stageActions}>
            <button type="button" className={styles.primaryButton} onClick={onBeginCountdown}>
              آماده‌ام، شروع کن
            </button>
            <button type="button" className={styles.secondaryButton} onClick={onCancel}>
              انصراف
            </button>
          </div>
        </div>
      ) : null}

      {status === 'countdown' ? (
        <div className={styles.stageBlock}>
          {/* aria-live so a screen reader announces each tick. */}
          <p className={styles.countdown} role="status" aria-live="assertive">
            {countdownRemaining}
          </p>
          <p className={styles.stageText}>آماده شوید...</p>
          <button type="button" className={styles.secondaryButton} onClick={onCancel}>
            انصراف
          </button>
        </div>
      ) : null}

      {status === 'drawing' && task !== null ? (
        <div className={styles.stageBlock}>
          <p className={styles.drawingNow}>
            در حال رسم: <strong>{task.labelFa}</strong>
          </p>
          <p className={styles.stageText} role="status" aria-live="off">
            زمان سپری‌شده: <span className={styles.mono}>{formatElapsed(elapsedMs)}</span>
            {task.timeLimitSeconds === null
              ? ''
              : ` (زمان پیشنهادی: ${task.timeLimitSeconds} ثانیه)`}
          </p>
          {/*
            The button stays ENABLED on an empty canvas on purpose: a greyed-out
            control explains nothing, whereas pressing it produces the Persian
            message that says exactly what is missing.
          */}
          {canComplete ? null : (
            <p className={styles.lockNote}>
              برای ثبت نتیجه، ابتدا حداقل یک خط روی بوم رسم کنید.
            </p>
          )}
          <div className={styles.stageActions}>
            <button type="button" className={styles.primaryButton} onClick={onComplete}>
              پایان و ثبت نتیجه
            </button>
            <button type="button" className={styles.dangerButton} onClick={onCancel}>
              لغو آزمون
            </button>
          </div>
        </div>
      ) : null}

      {status === 'completed' ? (
        <div className={styles.stageBlock}>
          <p className={styles.completedNote}>
            آزمون تکمیل شد. نتیجه در بخش پایین آماده خروجی گرفتن است.
          </p>
          <button type="button" className={styles.secondaryButton} onClick={onReset}>
            آزمون جدید
          </button>
        </div>
      ) : null}

      {status === 'cancelled' ? (
        <div className={styles.stageBlock}>
          <p className={styles.cancelledNote}>
            آزمون لغو شد. نتیجه‌ای ثبت نشد و خروجی گرفتن ممکن نیست.
          </p>
          <button type="button" className={styles.secondaryButton} onClick={onReset}>
            شروع دوباره
          </button>
        </div>
      ) : null}
    </section>
  )
}

export const TrialStagePanel = memo(TrialStagePanelComponent)
