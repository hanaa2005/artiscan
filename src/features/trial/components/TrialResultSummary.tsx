/**
 * The completed-result summary.
 *
 * The layout separates blocks with different epistemic status, because showing
 * them in one undifferentiated table invites reading a computed average as
 * though it were an observation:
 *
 *   RAW          what was actually recorded. The source of truth.
 *   IN-CANVAS    the visible part of that recording, computed by clipping.
 *   INTERACTION  what the participant did to the tools.
 *   TIMING       measured duration against the advisory time.
 *
 * RAW and IN-CANVAS are shown side by side rather than merged, because pointer
 * capture keeps recording off the surface and the two genuinely differ. The UI
 * shows the most useful numbers; the exported JSON always carries the complete
 * feature object.
 *
 * No psychological interpretation appears anywhere here, by design.
 */

import { memo } from 'react'
import type { DrawingTrialResult } from '../types/trial.types'
import { collectPointerTypes, PAUSE_THRESHOLD_MS } from '../utils/featureExtraction'
import styles from './TrialFlow.module.css'

interface TrialResultSummaryProps {
  result: DrawingTrialResult
  /**
   * Where this result came from.
   *
   * 'restored' shares 'imported''s honesty note - the numbers were recomputed
   * from stored raw data rather than measured in this page lifetime - but it
   * refers to a row in local storage, not a file the user chose.
   */
  source: 'live' | 'imported' | 'restored'
  onExportJson: () => void
  /** Omitted for an imported result: the canvas holds no pixels for it. */
  onExportPng?: () => void
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  )
}

/** Formats a nullable number, showing an explicit dash for "not measured". */
function optional(value: number | null, digits = 3): string {
  return value === null ? '—' : value.toFixed(digits)
}

/** Persian labels for the browser-reported pointer types. */
const POINTER_TYPE_LABELS: Record<string, string> = {
  mouse: 'موس',
  pen: 'قلم',
  touch: 'لمسی',
  unknown: 'نامشخص',
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} ثانیه`
}

function TrialResultSummaryComponent({
  result,
  source,
  onExportJson,
  onExportPng,
}: TrialResultSummaryProps): React.JSX.Element {
  const { features, session, trial, task, timePolicy } = result
  const pointerTypes = collectPointerTypes(session)

  return (
    <section className={styles.panel} aria-labelledby="result-heading">
      <h2 id="result-heading" className={styles.heading}>
        {source === 'imported'
          ? '۳. نتیجه واردشده از فایل'
          : source === 'restored'
            ? '۳. نتیجه بازیابی‌شده از حافظه محلی'
            : '۳. نتیجه آزمون'}
      </h2>
      {source === 'imported' ? (
        <p className={styles.blockNote}>
          این نتیجه از یک فایل خوانده شده است. شناسه‌ها و داده خام همان مقادیر فایل هستند و
          ویژگی‌ها دوباره از روی همان داده خام محاسبه شده‌اند.
        </p>
      ) : null}
      {source === 'restored' ? (
        <p className={styles.blockNote}>
          این نتیجه از حافظه محلی مرورگر بازیابی شده است. داده خام همان چیزی است که ثبت شده
          بود و ویژگی‌ها دوباره از روی همان داده محاسبه شده‌اند.
        </p>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <div className={styles.rawBlock}>
        <h3 className={styles.subHeading}>داده خام ثبت‌شده</h3>
        <p className={styles.blockNote}>
          این بخش منبع حقیقت است؛ همه اعداد پایین از روی همین داده محاسبه می‌شوند.
        </p>
        <Row label="تکلیف" value={`${task.labelFa} (${task.labelEn})`} />
        <Row label="شناسه آزمون" value={trial.id} />
        <Row label="شناسه جلسه نقاشی" value={session.id} />
        <Row label="نسخه Schema جلسه" value={String(session.schemaVersion)} />
        <Row label="نسخه Schema نتیجه" value={String(result.resultSchemaVersion)} />
        <Row label="خطوط ثبت‌شده (کل)" value={String(features.totalStrokeCount)} />
        <Row label="تعداد کل نقاط" value={String(features.totalPointCount)} />
        <Row
          label="نوع ورودی گزارش‌شده توسط مرورگر"
          value={
            pointerTypes.length === 0
              ? '—'
              : pointerTypes.map((type) => POINTER_TYPE_LABELS[type] ?? type).join('، ')
          }
        />
        <Row
          label="نقاط خارج از بوم"
          value={`${features.outsideCanvasPointCount} (${(features.outsideCanvasPointRatio * 100).toFixed(1)}٪)`}
        />
        <Row
          label="خطوط دارای نقطه بیرون بوم"
          value={String(features.strokeWithOutsidePointsCount)}
        />
        <Row label="طول مسیر خام (پیکسل)" value={features.rawPathLengthPx.toFixed(1)} />
        <Row label="مدت واقعی آزمون" value={formatSeconds(timePolicy.actualDurationMs)} />
        <p className={styles.thresholdNote}>
          «نوع ورودی» صرفاً مقداری است که Pointer Events مرورگر گزارش می‌کند و سند مربوط به
          سخت‌افزار نیست؛ حالت شبیه‌سازی موبایل در Chrome ممکن است هنگام استفاده از موس واقعی
          مقدار «لمسی» گزارش کند.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <div className={styles.derivedBlock}>
        <h3 className={styles.subHeading}>هندسه داخل بوم (محاسباتی)</h3>
        <p className={styles.blockNote}>
          فقط بخشی از مسیر که واقعاً روی بوم دیده می‌شد. هر پاره‌خط با روش Liang-Barsky به کادر
          بوم بریده می‌شود، بنابراین پاره‌خطی که از روی بوم عبور می‌کند حتی با هر دو سر بیرونی هم
          سهم دیده‌شده خود را دارد.
        </p>
        <Row label="خطوط قابل مشاهده" value={String(features.visibleStrokeCount)} />
        <Row label="خطوط قلم / پاک‌کن" value={`${features.penStrokeCount} / ${features.eraserStrokeCount}`} />
        <Row label="نقاط داخل بوم" value={String(features.insideCanvasPointCount)} />
        <Row label="طول مسیر داخل بوم (پیکسل)" value={features.inCanvasPathLengthPx.toFixed(1)} />
        <Row
          label="طول مسیر داخل بوم (نرمال‌شده)"
          value={features.inCanvasPathLengthNormalized.toFixed(3)}
        />
        <Row
          label="کادر محیطی دیده‌شده (پیکسل)"
          value={
            features.inCanvasBoundingBox === null
              ? '—'
              : `${features.inCanvasBoundingBox.width.toFixed(1)} × ${features.inCanvasBoundingBox.height.toFixed(1)}`
          }
        />
        <Row
          label="پوشش کادر دیده‌شده"
          value={`${(features.visibleCanvasCoverageRatio * 100).toFixed(1)}٪`}
        />
        <Row
          label="سرعت داخل بوم: میانگین / بیشینه"
          value={`${features.meanInCanvasSpeedNormalizedPerSecond.toFixed(3)} / ${features.maxInCanvasSpeedNormalizedPerSecond.toFixed(3)} (واحد نرمال بر ثانیه)`}
        />
        <Row
          label="نمونه‌های معتبر سرعت (داخل بوم / خام)"
          value={`${features.validInCanvasSpeedSampleCount} / ${features.validRawSpeedSampleCount}`}
        />
        <Row label="نمونه‌های فشار" value={String(features.pressureSampleCount)} />
        <Row
          label="فشار کمینه / بیشینه / میانگین"
          value={`${optional(features.minPressure)} / ${optional(features.maxPressure)} / ${optional(features.meanPressure)}`}
        />
        <p className={styles.thresholdNote}>
          «پوشش» مساحت <strong>کادر محیطی</strong> است، نه مساحت پیکسل‌های رنگ‌شده: یک خط
          قطری از گوشه تا گوشه هم پوشش ۱۰۰٪ گزارش می‌کند. حرکت بیرون بوم در این عدد اثری ندارد.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <div className={styles.derivedBlock}>
        <h3 className={styles.subHeading}>تعامل با ابزارها</h3>
        <Row
          label="تغییر رنگ ثبت‌شده"
          value={String(features.colorChangeCount)}
        />
        <Row label="تغییر ابزار / ضخامت" value={`${features.toolChangeCount} / ${features.widthChangeCount}`} />
        <Row
          label="واگرد / ازنو / پاک‌کردن"
          value={`${features.undoCount} / ${features.redoCount} / ${features.clearCount}`}
        />
        <Row label="تعداد مکث" value={String(features.pauseCount)} />
        <Row
          label="مجموع / طولانی‌ترین مکث"
          value={`${Math.round(features.totalPauseMs)} / ${Math.round(features.longestPauseMs)} میلی‌ثانیه`}
        />
        <p className={styles.thresholdNote}>
          آستانه مکث: فاصله بیش از {PAUSE_THRESHOLD_MS} میلی‌ثانیه بین پایان یک خط و شروع خط
          بعدی. این یک آستانه گزارش‌دهی است، نه یک ادعای روان‌شناختی. «تغییر رنگ ثبت‌شده» فقط
          انتخاب‌های نهایی را می‌شمارد؛ رنگ‌هایی که هنگام کشیدن در انتخابگر از آن‌ها عبور شده
          ثبت نمی‌شوند.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <div className={styles.derivedBlock}>
        <h3 className={styles.subHeading}>زمان</h3>
        <Row
          label="زمان پیشنهادی"
          value={
            timePolicy.recommendedSeconds === null
              ? 'ندارد'
              : `${timePolicy.recommendedSeconds} ثانیه`
          }
        />
        <Row label="مدت واقعی" value={formatSeconds(timePolicy.actualDurationMs)} />
        <Row
          label="فراتر از زمان پیشنهادی"
          value={
            timePolicy.exceededRecommendedTime
              ? `بله، ${formatSeconds(timePolicy.overtimeMs)} بیشتر`
              : 'خیر'
          }
        />
        <p className={styles.thresholdNote}>
          زمان پیشنهادی <strong>الزام‌آور نیست</strong>: آزمون هرگز به‌طور خودکار پایان نمی‌یابد،
          چون قطع کردن ضبط در لحظه رسیدن به آن، داده خام را ناقص می‌کند. مدت واقعی همیشه مبنا است.
        </p>
      </div>

      <div className={styles.stageActions}>
        <button type="button" className={styles.primaryButton} onClick={onExportJson}>
          خروجی JSON نتیجه آزمون
        </button>
        {onExportPng === undefined ? null : (
          <button type="button" className={styles.secondaryButton} onClick={onExportPng}>
            خروجی PNG نقاشی
          </button>
        )}
      </div>
    </section>
  )
}

export const TrialResultSummary = memo(TrialResultSummaryComponent)
