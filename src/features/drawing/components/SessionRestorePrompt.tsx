/**
 * Asks whether to restore the session found in local storage on startup.
 *
 * Shown as a banner rather than a modal on purpose: it must never block the
 * canvas, and dismissing it must be trivial.
 */

import { memo } from 'react'
import type { DrawingSession } from '../types/drawing.types'
import { countPoints } from '../utils/drawingStats'
import { computeVisibleStrokes } from '../utils/strokeVisibility'
import styles from './SessionRestorePrompt.module.css'

interface SessionRestorePromptProps {
  session: DrawingSession
  onRestore: () => void
  onDismiss: () => void
}

function SessionRestorePromptComponent({
  session,
  onRestore,
  onDismiss,
}: SessionRestorePromptProps): React.JSX.Element {
  const strokeCount = session.strokes.length
  const pointCount = countPoints(session.strokes)
  // After a Clear the recorded strokes outnumber the painted ones. Saying so
  // up front avoids the surprise of restoring "4 strokes" onto a blank canvas.
  const visibleCount = computeVisibleStrokes(session.strokes, session.actions).length

  return (
    <div className={styles.prompt} role="status">
      <p className={styles.text}>
        یک جلسه ذخیره‌شده پیدا شد ({strokeCount} خط ثبت‌شده و {pointCount} نقطه
        {visibleCount === strokeCount ? '' : `، ${visibleCount} خط قابل مشاهده`}). آیا
        می‌خواهید آن را بازیابی کنید؟
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={onRestore}>
          بازیابی جلسه
        </button>
        <button type="button" className={styles.secondary} onClick={onDismiss}>
          شروع جلسه جدید
        </button>
      </div>
    </div>
  )
}

export const SessionRestorePrompt = memo(SessionRestorePromptComponent)
