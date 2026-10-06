/**
 * The trial flow, end to end.
 *
 * This component owns ORCHESTRATION only. It reuses the week-1 recorder,
 * canvas and toolbar exactly as they are - no drawing logic is reimplemented
 * here, and nothing about DrawingSession is altered.
 *
 * The canvas is mounted for the whole flow rather than only during the drawing
 * phase, because remounting it would tear down the Konva stage and the pointer
 * listeners between phases. Input is gated instead: outside the drawing phase
 * the surface is covered and marked inert.
 *
 * TWO THINGS THIS PAGE IS CAREFUL ABOUT
 *
 * 1. Every visible, enabled control does what it says. The reusable toolbar is
 *    given only the handlers that are meaningful during a trial, so the raw
 *    session import/export and "new session" buttons are not rendered at all
 *    rather than rendered inert.
 * 2. An in-flight trial lives only in memory, so both ways of losing it are
 *    guarded: `beforeunload` for a reload or a closed tab, and an exit guard
 *    published to the shell for a workspace switch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type Konva from 'konva'
import { DrawingCanvas } from '../../drawing/components/DrawingCanvas'
import { DrawingToolbar } from '../../drawing/components/DrawingToolbar'
import { useCanvasSize } from '../../drawing/hooks/useCanvasSize'
import { useDrawingSession } from '../../drawing/hooks/useDrawingSession'
import { downloadStagePng } from '../../drawing/services/drawingExporter'
import { todayFileStamp } from '../../drawing/utils/timing'
import { TASK_CATALOG } from '../data/taskCatalog'
import { useDrawingTrial, DEFAULT_COUNTDOWN_SECONDS } from '../hooks/useDrawingTrial'
import {
  buildTrialResult,
  buildTrialResultFileName,
  deserializeTrialResult,
  serializeTrialResult,
} from '../services/trialResultSerializer'
import {
  getLatestTrialResult,
  isIndexedDbSupported,
  saveTrialResult,
  type StoredTrialResult,
} from '../services/trialResultRepository'
import { validateTrialResult } from '../services/trialResultValidator'
import type { DrawingTask, DrawingTrialResult } from '../types/trial.types'
import { getEnabledTasks, selectRandomTask } from '../utils/taskSelection'
import { TaskSelector } from './TaskSelector'
import { ArtifactExportPanel } from '../../artifacts/components/ArtifactExportPanel'
import { ReplayPanel } from '../../replay/components/ReplayPanel'
import { TrialResultImport } from './TrialResultImport'
import { TrialResultSummary } from './TrialResultSummary'
import { TrialStagePanel } from './TrialStagePanel'
import styles from './TrialFlow.module.css'
import pageStyles from './TrialPage.module.css'

/**
 * How the shell asks the trial flow whether it is safe to leave.
 *
 * `beforeunload` protects a reload or a closed tab, but a React mode switch is
 * not a navigation - the browser never hears about it, so an in-flight trial
 * would simply unmount and take the drawing, the timing and the trial id with
 * it. This handle lets the shell ask first.
 */
export interface TrialExitGuard {
  /** True while abandoning would destroy an in-memory recording. */
  isActive: () => boolean
  /** Cancels the trial explicitly and clears its timers. */
  abandon: () => void
}

interface TrialPageProps {
  /** Filled in by the shell so it can guard a workspace switch. Optional. */
  exitGuardRef?: React.MutableRefObject<TrialExitGuard | null>
}

interface Notice {
  kind: 'error' | 'success'
  message: string
}

/** Where the displayed result came from. */
type ResultSource = 'live' | 'imported' | 'restored'

/**
 * Honest reporting of what is actually on disk.
 *
 * 'saved' is only ever set after the write has resolved. A result the user
 * believes is stored but is not would be worse than no indicator at all.
 */
type ResultSaveState = 'unsupported' | 'idle' | 'saving' | 'saved' | 'error'

const SAVE_STATE_LABELS: Record<ResultSaveState, string> = {
  unsupported: 'ذخیره محلی در دسترس نیست (IndexedDB غیرفعال است) - حتماً خروجی JSON بگیرید.',
  idle: 'هنوز ذخیره نشده است.',
  saving: 'در حال ذخیره نتیجه...',
  saved: 'نتیجه در حافظه محلی مرورگر ذخیره شد.',
  error: 'ذخیره نتیجه ناموفق بود. لطفاً دوباره تلاش کنید یا خروجی JSON بگیرید.',
}

/** The message shown when completion is refused for having no strokes. */
const EMPTY_TRIAL_MESSAGE = 'برای ثبت نتیجه، ابتدا حداقل یک خط روی بوم رسم کنید.'

const REPLACE_ACTIVE_TRIAL_MESSAGE =
  'آزمون در حال اجراست. با باز کردن فایل نتیجه، نقاشی فعلی ثبت نخواهد شد. ادامه می‌دهید؟'

/** Downloads a text blob. Kept local so the drawing exporter stays untouched. */
function downloadText(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function TrialPage({ exitGuardRef }: TrialPageProps = {}): React.JSX.Element {
  const session = useDrawingSession()
  const { containerRef, size } = useCanvasSize()
  const stageRef = useRef<Konva.Stage | null>(null)

  const [notice, setNotice] = useState<Notice | null>(null)
  const [result, setResult] = useState<DrawingTrialResult | null>(null)
  const [resultSource, setResultSource] = useState<ResultSource>('live')
  const [saveState, setSaveState] = useState<ResultSaveState>(() =>
    isIndexedDbSupported() ? 'idle' : 'unsupported',
  )
  /** A completed result found in local storage on startup, offered for review. */
  const [restorable, setRestorable] = useState<StoredTrialResult | null>(null)

  /**
   * Identifies this component lifetime for the repository's stale-write guard,
   * and counts save attempts within it. A retry is therefore a NEWER revision
   * than the attempt that failed, so it is never discarded as stale.
   */
  const saveEpochRef = useRef<string>(null)
  saveEpochRef.current ??= crypto.randomUUID()
  const saveRevisionRef = useRef(0)

  const { startNewSession, buildSession, strokes, latchLogicalCanvas } = session

  /**
   * Fixes the logical canvas at the first real layout.
   *
   * A trial is exactly the case the week-1A risk described: the participant
   * draws, the window is resized, the result is built. Latching here means the
   * descriptor in the result always describes the surface that was drawn on.
   */
  useEffect(() => {
    latchLogicalCanvas(size)
  }, [latchLogicalCanvas, size])

  /** Lets the state machine enforce the empty-trial rule for itself. */
  const strokesRef = useRef(strokes)
  strokesRef.current = strokes
  const getRecordedStrokeCount = useCallback((): number => strokesRef.current.length, [])

  const trial = useDrawingTrial({
    countdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
    // Wiping the recorder at the moment drawing begins - not at task selection -
    // keeps anything scribbled while reading the instructions out of the data.
    onDrawingStart: startNewSession,
    getRecordedStrokeCount,
  })

  const enabledTasks = useMemo(() => getEnabledTasks(TASK_CATALOG), [])

  /** True while losing this trial would discard a recording. */
  const isTrialActive = trial.status === 'countdown' || trial.status === 'drawing'

  const { cancel: cancelTrial } = trial

  /**
   * Publishes the exit guard to the shell.
   *
   * Rewritten on every relevant change so `isActive` never reports a stale
   * status, and cleared on unmount so the shell cannot call into a component
   * that no longer exists.
   */
  useEffect(() => {
    if (exitGuardRef === undefined) return
    exitGuardRef.current = {
      isActive: () => isTrialActive,
      abandon: () => {
        // Cancelled EXPLICITLY rather than left to unmount: cancel() clears the
        // countdown and elapsed timers and records the abandonment in the state
        // machine.
        cancelTrial()
      },
    }
    return () => {
      exitGuardRef.current = null
    }
  }, [cancelTrial, exitGuardRef, isTrialActive])

  /** Auto-hides a notice. */
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => {
      setNotice(null)
    }, 6000)
    return () => {
      window.clearTimeout(timer)
    }
  }, [notice])

  /**
   * Warns before the tab is closed mid-trial.
   *
   * A drawing in progress lives only in memory during a trial, so an accidental
   * reload would silently discard it along with the trial timing. The listener
   * is registered only while it is relevant, and removed on unmount.
   */
  useEffect(() => {
    if (!isTrialActive) return

    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      // Modern browsers show their own generic wording; assigning returnValue
      // is what actually triggers the prompt.
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [isTrialActive])

  const handleSelectTask = useCallback(
    (task: DrawingTask): void => {
      if (!trial.selectTask(task)) {
        setNotice({
          kind: 'error',
          message: 'در این مرحله امکان تغییر تکلیف وجود ندارد.',
        })
      }
    },
    [trial],
  )

  const handlePickRandom = useCallback((): void => {
    // Math.random is injected here, at the edge, so the selection utility itself
    // stays pure and testable.
    const task = selectRandomTask(Math.random, TASK_CATALOG)
    if (task === null) {
      setNotice({ kind: 'error', message: 'هیچ تکلیف فعالی در فهرست وجود ندارد.' })
      return
    }
    handleSelectTask(task)
  }, [handleSelectTask])

  const handleBeginCountdown = useCallback((): void => {
    if (!trial.beginCountdown()) {
      setNotice({ kind: 'error', message: 'برای شروع، ابتدا یک تکلیف انتخاب کنید.' })
    }
  }, [trial])

  /**
   * Finishes the trial and freezes the result.
   *
   * An empty trial is REFUSED, here and in the state machine both. A recording
   * with no strokes is not an observation of anything, and exporting one
   * produced a file that looked exactly like real data. Refusing leaves the
   * trial in the drawing phase, so the participant can simply carry on.
   */
  const handleComplete = useCallback((): void => {
    if (strokesRef.current.length === 0) {
      setNotice({ kind: 'error', message: EMPTY_TRIAL_MESSAGE })
      return
    }

    if (!trial.complete()) {
      setNotice({
        kind: 'error',
        message:
          trial.status === 'drawing'
            ? EMPTY_TRIAL_MESSAGE
            : 'این آزمون در وضعیتی نیست که بتوان آن را ثبت کرد.',
      })
      return
    }

    setNotice({ kind: 'success', message: 'آزمون ثبت شد.' })
  }, [trial])

  /**
   * Assembles the result once the trial reports completion.
   *
   * Done in an effect rather than inside handleComplete because the completed
   * trial object - with its end timestamp and measured duration - only exists
   * after that state update has been applied.
   */
  /**
   * Writes a completed result to local storage.
   *
   * Separate from the effect below so the retry button can call it again with a
   * higher revision. `setSaveState('saved')` happens only after the write has
   * actually resolved.
   */
  const persistResult = useCallback((completed: DrawingTrialResult): void => {
    if (!isIndexedDbSupported()) {
      setSaveState('unsupported')
      return
    }

    saveRevisionRef.current += 1
    const epoch = saveEpochRef.current
    const revision = saveRevisionRef.current
    setSaveState('saving')

    saveTrialResult(completed, epoch === null ? {} : { epoch, revision }).then(
      () => {
        setSaveState('saved')
      },
      (error: unknown) => {
        setSaveState('error')
        console.warn('ArtiScan: ذخیره نتیجه آزمون ناموفق بود.', error)
      },
    )
  }, [])

  useEffect(() => {
    if (trial.status !== 'completed') return
    if (trial.trial === null || trial.task === null) return
    if (result !== null) return

    const completed = buildTrialResult(trial.trial, trial.task, buildSession(size))
    setResult(completed)
    setResultSource('live')
    // Persisted the moment it exists, not when the user remembers to export:
    // a reload or a crash before that click used to destroy the recording.
    persistResult(completed)
    // A newly completed trial supersedes whatever startup offered to restore.
    setRestorable(null)
  }, [buildSession, persistResult, result, size, trial.status, trial.task, trial.trial])

  const handleRetrySave = useCallback((): void => {
    if (result === null || resultSource === 'imported') return
    persistResult(result)
  }, [persistResult, result, resultSource])

  /**
   * Looks for a previously stored result once, on startup.
   *
   * Only OFFERED, never loaded automatically: silently replacing the workspace
   * with an old trial would be its own kind of surprise. Nothing is deleted
   * either way.
   */
  useEffect(() => {
    let cancelled = false
    getLatestTrialResult().then(
      (stored) => {
        if (cancelled || stored === null) return
        setRestorable(stored)
      },
      () => {
        // No local storage available - the flow simply starts empty.
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Shows a stored result.
   *
   * The record goes through the same validator the file importer uses, so its
   * features are RECOMPUTED from the embedded canonical session rather than
   * trusted. A row written by an older build therefore cannot present stale
   * numbers as measurement.
   */
  const handleRestoreResult = useCallback((): void => {
    if (restorable === null) return

    const parsed = validateTrialResult(restorable.result)
    if (!parsed.ok) {
      setNotice({
        kind: 'error',
        message: `نتیجه ذخیره‌شده معتبر نبود و بارگذاری نشد: ${parsed.error}`,
      })
      setRestorable(null)
      return
    }

    setResult(parsed.value)
    setResultSource('restored')
    // Already on disk, by definition - this row was just read from it.
    setSaveState('saved')
    setRestorable(null)
    setNotice({
      kind: 'success',
      message: 'نتیجه ذخیره‌شده بازیابی شد؛ ویژگی‌ها دوباره از روی جلسه محاسبه شدند.',
    })
  }, [restorable])

  /**
   * Hides the banner WITHOUT deleting the stored row: a mis-click must not be
   * able to destroy a recording. Deletion is a separate, explicit action.
   */
  const handleDismissRestore = useCallback((): void => {
    setRestorable(null)
  }, [])

  const handleCancel = useCallback((): void => {
    const confirmed = window.confirm(
      'آزمون لغو می‌شود و نقاشی فعلی ثبت نخواهد شد. ادامه می‌دهید؟',
    )
    if (!confirmed) return
    trial.cancel()
    setResult(null)
    // Nothing was completed, so nothing was stored. Any previously stored row
    // is left exactly where it is.
    setSaveState(isIndexedDbSupported() ? 'idle' : 'unsupported')
  }, [trial])

  const handleReset = useCallback((): void => {
    trial.reset()
    setResult(null)
    setResultSource('live')
    setSaveState(isIndexedDbSupported() ? 'idle' : 'unsupported')
    startNewSession()
  }, [startNewSession, trial])

  const handleExportResult = useCallback((): void => {
    if (result === null) return
    downloadText(
      serializeTrialResult(result),
      buildTrialResultFileName(result, todayFileStamp()),
    )
    setNotice({ kind: 'success', message: 'فایل نتیجه آزمون دانلود شد.' })
  }, [result])

  const handleExportPng = useCallback((): void => {
    const stage = stageRef.current
    if (stage === null || result === null) {
      setNotice({ kind: 'error', message: 'بوم نقاشی هنوز آماده نیست.' })
      return
    }
    try {
      downloadStagePng(stage, result.session)
      setNotice({ kind: 'success', message: 'تصویر PNG دانلود شد.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'خطای ناشناخته'
      setNotice({ kind: 'error', message: `ساخت تصویر PNG ناموفق بود: ${message}` })
    }
  }, [result])

  /**
   * Reads a saved result file back for display.
   *
   * The imported result is NEVER loaded into the live recorder: it describes a
   * trial that already happened, and treating it as a drawing to continue would
   * let new strokes be appended to someone else's session id. Its features are
   * recomputed from the embedded session by the validator, so a tampered
   * feature block cannot influence what is shown.
   */
  const handleImportResult = useCallback(
    (file: File): void => {
      if (isTrialActive) {
        if (!window.confirm(REPLACE_ACTIVE_TRIAL_MESSAGE)) return
        trial.cancel()
      }

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

        const parsed = deserializeTrialResult(text)
        if (!parsed.ok) {
          setNotice({ kind: 'error', message: parsed.error })
          return
        }

        setResult(parsed.value)
        setResultSource('imported')
        // An imported file is not written to local storage: it already exists
        // as a file, and storing it would clutter the store with copies.
        setSaveState(isIndexedDbSupported() ? 'idle' : 'unsupported')
        setNotice({
          kind: 'success',
          message: `نتیجه آزمون «${parsed.value.task.labelFa}» از فایل خوانده شد؛ ویژگی‌ها دوباره محاسبه شدند.`,
        })
      }

      reader.readAsText(file)
    },
    [isTrialActive, trial],
  )

  const isDrawing = trial.isDrawingPhase

  return (
    <div className={pageStyles.page}>
      {/*
        A completed result found in local storage. Offered, never auto-loaded,
        and dismissing it deletes nothing.
      */}
      {restorable !== null && result === null ? (
        <section className={pageStyles.restorePrompt} role="status">
          <p>
            یک نتیجه آزمون ذخیره‌شده در این مرورگر پیدا شد (
            {new Date(restorable.createdAt).toLocaleString('fa-IR')}). می‌خواهید آن را ببینید؟
          </p>
          <div className={pageStyles.restoreActions}>
            <button type="button" onClick={handleRestoreResult}>
              نمایش نتیجه ذخیره‌شده
            </button>
            <button type="button" onClick={handleDismissRestore}>
              بستن
            </button>
          </div>
        </section>
      ) : null}

      <TaskSelector
        tasks={enabledTasks}
        selectedTaskId={trial.task?.id ?? null}
        disabled={!trial.canChangeTask}
        onSelect={handleSelectTask}
        onPickRandom={handlePickRandom}
      />

      <TrialStagePanel
        status={trial.status}
        task={trial.task}
        countdownRemaining={trial.countdownRemaining}
        elapsedMs={trial.elapsedMs}
        countdownSeconds={DEFAULT_COUNTDOWN_SECONDS}
        canComplete={strokes.length > 0}
        onBeginCountdown={handleBeginCountdown}
        onComplete={handleComplete}
        onCancel={handleCancel}
        onReset={handleReset}
      />

      {notice !== null ? (
        <p
          className={notice.kind === 'error' ? pageStyles.errorNotice : pageStyles.successNotice}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.message}
        </p>
      ) : null}

      {/*
        Only the drawing controls are handed over. The session-level actions -
        raw JSON import and export, PNG, new session - are simply not passed, so
        the toolbar does not render them at all. Result-specific exports live
        with the result, where they mean something.
      */}
      <div
        className={isDrawing ? pageStyles.toolbarWrap : pageStyles.toolbarWrapDisabled}
        aria-hidden={!isDrawing}
        inert={!isDrawing}
      >
        <DrawingToolbar
          tool={session.tool}
          color={session.color}
          width={session.width}
          canUndo={session.canUndo}
          canRedo={session.canRedo}
          onToolChange={session.setTool}
          onColorChange={session.setColor}
          onColorInteractionBegin={session.beginColorInteraction}
          onColorPreview={session.previewColor}
          onColorInteractionCommit={session.commitColorInteraction}
          onWidthChange={session.setWidth}
          onWidthInteractionBegin={session.beginWidthInteraction}
          onWidthPreview={session.previewWidth}
          onWidthInteractionCommit={session.commitWidthInteraction}
          onUndo={session.undo}
          onRedo={session.redo}
          onClear={session.clear}
        />
      </div>

      <main className={pageStyles.canvasArea} ref={containerRef}>
        <DrawingCanvas
          size={size}
          strokes={session.visibleStrokes}
          session={session}
          stageRef={stageRef}
        />
        {/*
          Blocks pointer input outside the drawing phase. The canvas itself stays
          mounted so the Konva stage and its listeners are never rebuilt.
        */}
        {isDrawing ? null : (
          <div className={pageStyles.canvasBlocker}>
            <span className={pageStyles.blockerText}>
              {trial.status === 'completed'
                ? 'نقاشی ثبت‌شده این آزمون'
                : 'بوم پس از شمارش معکوس فعال می‌شود'}
            </span>
          </div>
        )}
      </main>

      <p className={styles.blockNote}>
        خطوط ثبت‌شده: {session.strokes.length} | خطوط قابل مشاهده:{' '}
        {session.visibleStrokes.length}
      </p>

      {/*
        Save status, reported honestly: 'saved' appears only after the write
        resolved, and a failure offers a retry instead of quietly giving up.
      */}
      {result !== null && resultSource !== 'imported' ? (
        <p
          className={saveState === 'saved' ? pageStyles.successNotice : pageStyles.errorNotice}
          role={saveState === 'error' ? 'alert' : 'status'}
        >
          {SAVE_STATE_LABELS[saveState]}
          {saveState === 'error' ? (
            <button type="button" className={pageStyles.retryButton} onClick={handleRetrySave}>
              تلاش دوباره
            </button>
          ) : null}
        </p>
      ) : null}

      {result !== null ? (
        <TrialResultSummary
          result={result}
          source={resultSource}
          onExportJson={handleExportResult}
          // An imported result has no pixels on this canvas, so no PNG button is
          // offered for it - an empty image would be worse than no button.
          {...(resultSource === 'live' ? { onExportPng: handleExportPng } : {})}
        />
      ) : null}

      {/*
        Replay of the finished recording.

        Offered for a live, restored or imported result alike - it reads the
        canonical session and nothing else, so where that session came from
        makes no difference to what it can reconstruct. It is read-only: the
        panel has no path back into the recorder.
      */}
      {result !== null ? <ReplayPanel session={result.session} /> : null}

      {/*
        Derived artifact exports. Offered only once a result exists, and always
        alongside the raw exports rather than instead of them - the lossy files
        are additions to the record, never replacements for it.
      */}
      {result !== null ? <ArtifactExportPanel session={result.session} /> : null}

      <TrialResultImport onFileSelected={handleImportResult} />
    </div>
  )
}
