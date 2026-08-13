/**
 * Collapsible panel showing the live state of the recording.
 *
 * This is the main week-1 verification tool: it makes the invisible event log
 * visible while drawing, so it is obvious at a glance whether points are being
 * captured, which device type was detected, and how the session is growing.
 */

import { memo } from 'react'
import type { DrawingSession, DrawingTool, PointerInputType } from '../types/drawing.types'
import type { Size } from '../utils/coordinates'
import { computeStats } from '../utils/drawingStats'
import { formatDurationFa } from '../utils/timing'
import styles from './DrawingDebugPanel.module.css'

interface DrawingDebugPanelProps {
  session: DrawingSession
  /** How many strokes are currently painted, after replaying undo/redo/clear. */
  visibleStrokeCount: number
  tool: DrawingTool
  lastPointerType: PointerInputType | null
  canvasSize: Size
  isOpen: boolean
  onToggle: () => void
  autoSaveStatus: string
}

const POINTER_TYPE_LABELS: Record<PointerInputType, string> = {
  mouse: 'موس',
  pen: 'قلم',
  touch: 'لمس',
  unknown: 'نامشخص',
}

const TOOL_LABELS: Record<DrawingTool, string> = {
  pen: 'قلم',
  eraser: 'پاک‌کن',
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  )
}

function DrawingDebugPanelComponent({
  session,
  visibleStrokeCount,
  tool,
  lastPointerType,
  canvasSize,
  isOpen,
  onToggle,
  autoSaveStatus,
}: DrawingDebugPanelProps): React.JSX.Element {
  const stats = computeStats(session)

  return (
    <section className={styles.panel}>
      <button
        type="button"
        className={styles.header}
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <span>پنل اطلاعات جلسه</span>
        <span aria-hidden="true">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen ? (
        <div className={styles.body}>
          <Row label="شناسه جلسه" value={session.id} />
          {/*
            Two different numbers on purpose: the first is the research data
            (append-only), the second is what is painted right now. After a
            Clear they differ - and that difference is the point.
          */}
          <Row label="خطوط ثبت‌شده (کل)" value={String(stats.strokeCount)} />
          <Row label="خطوط قابل مشاهده" value={String(visibleStrokeCount)} />
          <Row label="تعداد کل نقاط" value={String(stats.pointCount)} />
          <Row label="مدت جلسه" value={formatDurationFa(stats.durationMs)} />
          <Row label="ابزار فعال" value={TOOL_LABELS[tool]} />
          <Row
            label="نوع آخرین ورودی"
            value={
              lastPointerType === null ? 'هنوز رسمی انجام نشده' : POINTER_TYPE_LABELS[lastPointerType]
            }
          />
          <Row
            label="اندازه بوم"
            value={`${canvasSize.width} × ${canvasSize.height} پیکسل`}
          />
          <Row label="تعداد واگرد" value={String(stats.undoCount)} />
          <Row label="تعداد ازنو" value={String(stats.redoCount)} />
          <Row label="خطوط قلم / پاک‌کن" value={`${stats.penStrokeCount} / ${stats.eraserStrokeCount}`} />
          <Row
            label="نمونه فشار قلم"
            value={stats.hasPressureSamples ? 'ثبت شده' : 'ثبت نشده'}
          />
          <Row label="تعداد رویدادها" value={String(session.actions.length)} />
          <Row label="نسخه Schema" value={String(session.schemaVersion)} />
          <Row label="ذخیره خودکار" value={autoSaveStatus} />

          {session.provenance !== undefined ? (
            <p
              className={
                session.provenance.historyComplete ? styles.provenance : styles.provenanceWarning
              }
            >
              {session.provenance.note}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

export const DrawingDebugPanel = memo(DrawingDebugPanelComponent)
