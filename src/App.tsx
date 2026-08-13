/**
 * ArtiScan - application shell.
 *
 * App owns wiring only: it connects the recorder hook to the canvas, the
 * toolbar and the import/export services. All recording logic lives in
 * useDrawingSession, all file logic in services/, all geometry in utils/.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type Konva from 'konva'
import { DrawingCanvas } from './features/drawing/components/DrawingCanvas'
import { DrawingDebugPanel } from './features/drawing/components/DrawingDebugPanel'
import { DrawingToolbar } from './features/drawing/components/DrawingToolbar'
import { SessionRestorePrompt } from './features/drawing/components/SessionRestorePrompt'
import { useAutoSave, useRevision } from './features/drawing/hooks/useAutoSave'
import { useCanvasSize } from './features/drawing/hooks/useCanvasSize'
import { useDrawingSession } from './features/drawing/hooks/useDrawingSession'
import {
  downloadSessionJson,
  downloadStagePng,
} from './features/drawing/services/drawingExporter'
import { deserializeSession } from './features/drawing/services/drawingSerializer'
import { getLatestSession } from './features/drawing/services/drawingSessionRepository'
import type { DrawingSession } from './features/drawing/types/drawing.types'
import { computeVisibleStrokes } from './features/drawing/utils/strokeVisibility'
import styles from './App.module.css'

interface Notice {
  kind: 'error' | 'success'
  message: string
}

export default function App(): React.JSX.Element {
  const session = useDrawingSession()
  const { containerRef, size } = useCanvasSize()
  const stageRef = useRef<Konva.Stage | null>(null)

  const [notice, setNotice] = useState<Notice | null>(null)
  const [isDebugOpen, setIsDebugOpen] = useState(true)
  const [restorable, setRestorable] = useState<DrawingSession | null>(null)

  const { strokes, actions, buildSession, loadSession, startNewSession } = session

  /** The exportable snapshot of everything recorded so far. */
  const snapshot = useMemo(() => buildSession(size), [buildSession, size])

  // A ref keeps the autosave callback pointing at the newest snapshot without
  // making the autosave effect depend on it.
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const buildSnapshot = useCallback((): DrawingSession => snapshotRef.current, [])

  const revision = useRevision(strokes, actions)
  const autoSave = useAutoSave(buildSnapshot, revision)

  /** Looks for a previously stored session once, on startup. */
  useEffect(() => {
    let cancelled = false
    getLatestSession().then(
      (stored) => {
        if (cancelled) return
        // Only offer to restore something that actually contains a drawing.
        if (stored !== null && stored.strokes.length > 0) {
          setRestorable(stored)
        }
      },
      () => {
        // No local storage available - the app simply starts with a blank session.
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  /** Auto-hides a notice after a few seconds. */
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => {
      setNotice(null)
    }, 6000)
    return () => {
      window.clearTimeout(timer)
    }
  }, [notice])

  const handleClear = useCallback((): void => {
    const confirmed = window.confirm(
      'همه خطوط این نقاشی پاک می‌شوند و این عمل قابل بازگشت نیست. ادامه می‌دهید؟',
    )
    if (!confirmed) return
    session.clear()
  }, [session])

  const handleNewSession = useCallback((): void => {
    const confirmed = window.confirm(
      'جلسه فعلی بسته و یک جلسه جدید با شناسه تازه ساخته می‌شود. ادامه می‌دهید؟',
    )
    if (!confirmed) return
    startNewSession()
    setRestorable(null)
    setNotice({ kind: 'success', message: 'جلسه جدید آغاز شد.' })
  }, [startNewSession])

  const handleExportJson = useCallback((): void => {
    downloadSessionJson(snapshotRef.current)
    setNotice({ kind: 'success', message: 'فایل JSON جلسه دانلود شد.' })
  }, [])

  const handleExportPng = useCallback((): void => {
    const stage = stageRef.current
    if (stage === null) {
      setNotice({ kind: 'error', message: 'بوم نقاشی هنوز آماده نیست.' })
      return
    }
    try {
      downloadStagePng(stage, snapshotRef.current)
      setNotice({ kind: 'success', message: 'تصویر PNG دانلود شد.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'خطای ناشناخته'
      setNotice({ kind: 'error', message: `ساخت تصویر PNG ناموفق بود: ${message}` })
    }
  }, [])

  /**
   * Imports a session file.
   *
   * Every failure path ends in a Persian message: an unreadable file, malformed
   * JSON and a structurally invalid session must all be survivable.
   */
  const handleImportJson = useCallback(
    (file: File): void => {
      const reader = new FileReader()

      reader.onerror = () => {
        setNotice({ kind: 'error', message: 'خواندن فایل ناموفق بود.' })
      }

      reader.onload = () => {
        const text = reader.result
        if (typeof text !== 'string') {
          setNotice({ kind: 'error', message: 'محتوای فایل قابل خواندن نبود.' })
          return
        }

        const result = deserializeSession(text)
        if (!result.ok) {
          setNotice({ kind: 'error', message: result.error })
          return
        }

        loadSession(result.value)
        setRestorable(null)

        // Report both numbers when a Clear in the file makes them differ,
        // otherwise "imported 5 strokes" onto a 1-stroke canvas looks like a bug.
        const recorded = result.value.strokes.length
        const visible = computeVisibleStrokes(result.value.strokes, result.value.actions).length
        const countMessage =
          recorded === visible
            ? `جلسه با ${recorded} خط وارد و روی بوم بازسازی شد.`
            : `جلسه با ${recorded} خط ثبت‌شده وارد شد؛ ${visible} خط روی بوم دیده می‌شود (بقیه با Clear یا Undo پنهان شده‌اند).`

        // An incomplete legacy history is a data-quality warning, not a success:
        // the user must not walk away thinking the file holds a full recording.
        const provenance = result.value.provenance
        if (provenance !== undefined && !provenance.historyComplete) {
          setNotice({ kind: 'error', message: `${countMessage} ${provenance.note}` })
          return
        }

        setNotice({ kind: 'success', message: countMessage })
      }

      reader.readAsText(file)
    },
    [loadSession],
  )

  const handleRestore = useCallback((): void => {
    if (restorable === null) return
    loadSession(restorable)
    setRestorable(null)
    setNotice({ kind: 'success', message: 'جلسه ذخیره‌شده بازیابی شد.' })
  }, [loadSession, restorable])

  /**
   * Dismissing only hides the banner - the stored session is deliberately NOT
   * deleted, so a mis-click cannot destroy the user's previous work. It stops
   * reappearing on its own because the current session is saved with a newer
   * `createdAt` and becomes the one getLatestSession() returns.
   */
  const handleDismissRestore = useCallback((): void => {
    setRestorable(null)
  }, [])

  const handleToggleDebug = useCallback((): void => {
    setIsDebugOpen((previous) => !previous)
  }, [])

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>ArtiScan - آزمایشگاه ثبت فرایند نقاشی</h1>
        <p className={styles.subtitle}>
          نمونه اولیه هفته اول: ثبت رویدادمحور فرایند رسم. داده‌های این نسخه آزمایشی هستند و
          سامانه هیچ تحلیل یا کاربرد تشخیصی روان‌شناختی ندارد.
        </p>
      </header>

      {restorable !== null ? (
        <SessionRestorePrompt
          session={restorable}
          onRestore={handleRestore}
          onDismiss={handleDismissRestore}
        />
      ) : null}

      <DrawingToolbar
        tool={session.tool}
        color={session.color}
        width={session.width}
        canUndo={session.canUndo}
        canRedo={session.canRedo}
        onToolChange={session.setTool}
        onColorChange={session.setColor}
        onWidthChange={session.setWidth}
        onUndo={session.undo}
        onRedo={session.redo}
        onClear={handleClear}
        onNewSession={handleNewSession}
        onExportJson={handleExportJson}
        onImportJson={handleImportJson}
        onExportPng={handleExportPng}
      />

      {notice !== null ? (
        <p
          className={notice.kind === 'error' ? styles.errorNotice : styles.successNotice}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.message}
        </p>
      ) : null}

      <main className={styles.canvasArea} ref={containerRef}>
        {/* The canvas paints the DERIVED view; `strokes` stays the full record. */}
        <DrawingCanvas
          size={size}
          strokes={session.visibleStrokes}
          session={session}
          stageRef={stageRef}
        />
      </main>

      <DrawingDebugPanel
        session={snapshot}
        visibleStrokeCount={session.visibleStrokes.length}
        tool={session.tool}
        lastPointerType={session.lastPointerType}
        canvasSize={size}
        isOpen={isDebugOpen}
        onToggle={handleToggleDebug}
        autoSaveStatus={autoSave.statusLabel}
      />
    </div>
  )
}
