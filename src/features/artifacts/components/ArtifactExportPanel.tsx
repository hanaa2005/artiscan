/**
 * Artifact exports, labelled so nobody mistakes a derivative for the record.
 *
 * THE RULE THIS PANEL EXISTS TO ENFORCE
 *
 * Three of these files are lossy and one is not, and the difference is
 * invisible once the file is on disk. So the lossless and the lossy exports are
 * in separately headed groups, and every lossy control carries the same plain
 * warning: this file is a selection of points and does not replace the raw
 * recording.
 *
 * Every button here does something. A control whose capability is missing -
 * gzip on a browser without CompressionStream - is not rendered as a dead
 * button; it is replaced by an explanation.
 *
 * Double-clicking cannot start two exports: the panel tracks which export is
 * running and disables the group while it is, because a second run of a
 * multi-second derivation on a large session would compete for the main thread
 * and could deliver two downloads for one intent.
 */

import { useCallback, useRef, useState } from 'react'
import type { DrawingSession } from '../../drawing/types/drawing.types'
import { serializeSession } from '../../drawing/services/drawingSerializer'
import { todayFileStamp } from '../../drawing/utils/timing'
import {
  buildCriticalTrajectory,
  buildCriticalTrajectoryFileName,
} from '../services/criticalTrajectory'
import { serializeCriticalTrajectory } from '../services/criticalTrajectoryValidator'
import { buildGzipFileName, gzipText, isCompressionSupported } from '../services/gzipCodec'
import {
  buildCriticalPngFileName,
  buildMaskFileName,
  renderCriticalTrajectoryPng,
  renderReconstructionMaskPng,
} from '../services/artifactPngRenderer'
import {
  buildBinaryMaskFileName,
  renderBinaryMaskPng,
} from '../services/binaryMaskPng'
import type { GraphMode, QualityProfileName } from '../types/criticalTrajectory.types'
import styles from './ArtifactExportPanel.module.css'

interface ArtifactExportPanelProps {
  /** The canonical recording every artifact is derived from. Never modified. */
  session: DrawingSession
}

/** Which export is currently running, or null. */
type RunningExport =
  | 'gzip'
  | 'critical-json'
  | 'critical-png'
  | 'mask-png'
  | 'binary-mask-png'
  | null

const LOSSY_WARNING =
  'این فایل فقط شامل نقاط منتخب است و جایگزین داده خام آزمون نمی‌شود.'

/**
 * What each mode means, in the words shown to the operator.
 *
 * The distinction is the whole point of having two of everything: one picture
 * answers "what was drawn during the session", the other "what was on the paper
 * at the end". Mixing them up would present erased work as the final drawing.
 */
const MODE_LABELS: Record<GraphMode, string> = {
  full_process: 'کل فرایند (شامل خطوط پاک‌شده و واگردشده)',
  final_visible: 'نتیجه نهایی (فقط خطوط باقی‌مانده روی بوم)',
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function ArtifactExportPanel({ session }: ArtifactExportPanelProps): React.JSX.Element {
  const [running, setRunning] = useState<RunningExport>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [profile, setProfile] = useState<QualityProfileName>('high')
  /**
   * Which slice of the recording the derived files describe.
   *
   * One selector rather than two of every button: the two files are produced by
   * exporting twice, and each carries its mode in its own filename, so the pair
   * can never be confused once downloaded.
   */
  const [mode, setMode] = useState<GraphMode>('full_process')

  /**
   * The authoritative "an export is running" flag.
   *
   * State cannot do this job. A double-click delivers both events in ONE tick,
   * before React has re-rendered, so both handlers would read `running` as null
   * from the same stale closure and both would start - producing two files for
   * one intent. The ref is written synchronously, so the second click sees it.
   */
  const runningRef = useRef<RunningExport>(null)

  const compressionSupported = isCompressionSupported()

  /**
   * Runs one export, guarding against a second one starting.
   *
   * Every failure ends in a Persian message on screen. An export that failed
   * silently would look exactly like one that succeeded and produced nothing.
   */
  const run = useCallback(
    async (kind: Exclude<RunningExport, null>, work: () => Promise<string>): Promise<void> => {
      if (runningRef.current !== null) return
      runningRef.current = kind
      setRunning(kind)
      setError(null)
      setNotice(null)
      try {
        setNotice(await work())
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'خطای ناشناخته'
        setError(`ساخت خروجی ناموفق بود: ${message}`)
      } finally {
        runningRef.current = null
        setRunning(null)
      }
    },
    [],
  )

  const handleGzip = useCallback((): void => {
    void run('gzip', async () => {
      const text = serializeSession(session)
      const bytes = await gzipText(text)
      downloadBlob(
        new Blob([bytes as BlobPart], { type: 'application/gzip' }),
        buildGzipFileName(session.id, todayFileStamp()),
      )
      const percent = Math.round((1 - bytes.length / new TextEncoder().encode(text).length) * 100)
      return `فایل فشرده دانلود شد (${String(percent)}٪ کوچک‌تر از JSON خام).`
    })
  }, [run, session])

  const handleCriticalJson = useCallback((): void => {
    void run('critical-json', async () => {
      // Yield once so the "preparing" state paints before a long derivation
      // blocks the main thread on a large session.
      await new Promise((resolve) => setTimeout(resolve, 0))
      const artifact = buildCriticalTrajectory(session, { profile, mode })
      downloadBlob(
        new Blob([serializeCriticalTrajectory(artifact)], {
          type: 'application/json;charset=utf-8',
        }),
        buildCriticalTrajectoryFileName(session.id, todayFileStamp(), mode),
      )
      const kept = artifact.quality.criticalPointCount
      const total = artifact.quality.rawPointCount
      const met = artifact.quality.meetsProfile
        ? 'معیار کیفیت این پروفایل برآورده شد.'
        : `هشدار: معیار کیفیت برآورده نشد (${artifact.quality.qualityFailureReason ?? ''}).`
      return `گراف «${MODE_LABELS[mode]}» دانلود شد: ${String(kept)} از ${String(total)} نقطه. ${met}`
    })
  }, [mode, profile, run, session])

  const handleCriticalPng = useCallback((): void => {
    void run('critical-png', async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const artifact = buildCriticalTrajectory(session, { profile, mode })
      downloadBlob(
        await renderCriticalTrajectoryPng(artifact),
        buildCriticalPngFileName(session.id, todayFileStamp(), mode),
      )
      return `تصویر گراف «${MODE_LABELS[mode]}» دانلود شد.`
    })
  }, [mode, profile, run, session])

  const handleMaskPng = useCallback((): void => {
    void run('mask-png', async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const artifact = buildCriticalTrajectory(session, { profile, mode })
      const { blob } = await renderReconstructionMaskPng(artifact, session)
      downloadBlob(blob, buildMaskFileName(session.id, todayFileStamp()))
      return 'ماسک بازسازی دانلود شد (این ماسک باینری نیست).'
    })
  }, [mode, profile, run, session])

  /**
   * The binary mask.
   *
   * Built from the RAW strokes, not from the simplified graph: this file is a
   * geometric statement about where the pen went, and running it through point
   * reduction first would quietly narrow the answer. It is also the only mask
   * here whose pixels are guaranteed to be 0 or 255.
   */
  const handleBinaryMaskPng = useCallback((): void => {
    void run('binary-mask-png', async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const { blob, policy } = await renderBinaryMaskPng(session, mode)
      downloadBlob(blob, buildBinaryMaskFileName(session.id, todayFileStamp(), mode))
      return `ماسک باینری «${MODE_LABELS[mode]}» دانلود شد: ${String(policy.coveredPixelCount)} پیکسل پرشده از ${String(policy.width * policy.height)}.`
    })
  }, [mode, run, session])

  const isBusy = running !== null

  return (
    <section className={styles.panel} aria-labelledby="artifact-exports-heading">
      <h3 id="artifact-exports-heading" className={styles.heading}>
        خروجی‌های تحلیلی
      </h3>

      <div className={styles.group}>
        <h4 className={styles.groupHeading}>داده کامل (بدون کاستی)</h4>
        {compressionSupported ? (
          <button
            type="button"
            className={styles.button}
            onClick={handleGzip}
            disabled={isBusy}
          >
            {running === 'gzip' ? 'در حال آماده‌سازی...' : 'خروجی فشرده JSON.GZ'}
          </button>
        ) : (
          // No dead control: the capability is missing, so the reason is shown
          // instead of a button that could not work.
          <p className={styles.note}>
            این مرورگر از فشرده‌سازی پشتیبانی نمی‌کند؛ از «خروجی خام JSON» استفاده کنید.
          </p>
        )}
        <p className={styles.note}>
          محتوای این فایل دقیقاً همان JSON خام است و هیچ نقطه‌ای از آن حذف نشده است.
        </p>
      </div>

      <div className={styles.group}>
        <h4 className={styles.groupHeading}>خروجی‌های کاسته‌شده (Lossy)</h4>

        <label className={styles.field} htmlFor="artifact-mode">
          <span className={styles.fieldLabel}>محدوده خروجی</span>
          <select
            id="artifact-mode"
            className={styles.select}
            value={mode}
            disabled={isBusy}
            onChange={(event) => {
              setMode(event.target.value as GraphMode)
            }}
          >
            <option value="full_process">{MODE_LABELS.full_process}</option>
            <option value="final_visible">{MODE_LABELS.final_visible}</option>
          </select>
        </label>

        <label className={styles.field} htmlFor="artifact-profile">
          <span className={styles.fieldLabel}>سطح کیفیت</span>
          <select
            id="artifact-profile"
            className={styles.select}
            value={profile}
            disabled={isBusy}
            onChange={(event) => {
              setProfile(event.target.value as QualityProfileName)
            }}
          >
            <option value="high">بالا (بیشترین دقت)</option>
            <option value="balanced">متعادل</option>
            <option value="compact">فشرده (کمترین حجم)</option>
          </select>
        </label>

        <div className={styles.buttonRow}>
          <button
            type="button"
            className={styles.button}
            onClick={handleCriticalJson}
            disabled={isBusy}
          >
            {running === 'critical-json' ? 'در حال آماده‌سازی...' : 'خروجی گراف JSON'}
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={handleCriticalPng}
            disabled={isBusy}
          >
            {running === 'critical-png' ? 'در حال آماده‌سازی...' : 'تصویر گراف PNG'}
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={handleBinaryMaskPng}
            disabled={isBusy}
          >
            {running === 'binary-mask-png' ? 'در حال آماده‌سازی...' : 'ماسک باینری PNG'}
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={handleMaskPng}
            disabled={isBusy}
          >
            {running === 'mask-png' ? 'در حال آماده‌سازی...' : 'ماسک بازسازی PNG'}
          </button>
        </div>

        <p className={styles.warning}>{LOSSY_WARNING}</p>
        <p className={styles.note}>
          «ماسک باینری» از خطوط خام ساخته می‌شود و هر پیکسل آن فقط ۰ یا ۲۵۵ است. «ماسک
          بازسازی» از نقاط ساده‌شده رسم می‌شود و لبه‌های آن نرم (Anti-aliased) هستند؛ آن را
          ماسک باینری فرض نکنید.
        </p>
      </div>

      {notice !== null ? (
        <p className={styles.successNotice} role="status">
          {notice}
        </p>
      ) : null}
      {error !== null ? (
        <p className={styles.errorNotice} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
