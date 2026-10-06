/**
 * Importing a DrawingTrialResult file.
 *
 * Deliberately its own control, clearly separated from the week-1 "ورود JSON"
 * that loads a raw DrawingSession into the recorder. The two take different
 * files and do different things: this one DISPLAYS a finished result and never
 * loads anything into the live canvas, because a completed trial is a record of
 * something that already happened, not a drawing to continue.
 */

import { memo, useRef } from 'react'
import styles from './TrialFlow.module.css'

interface TrialResultImportProps {
  onFileSelected: (file: File) => void
}

function TrialResultImportComponent({
  onFileSelected,
}: TrialResultImportProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)

  return (
    <section className={styles.panel} aria-labelledby="result-import-heading">
      <h2 id="result-import-heading" className={styles.lockedHeading}>
        بازخوانی نتیجه ذخیره‌شده
      </h2>
      <p className={styles.blockNote}>
        فایل خروجی یک آزمون کامل‌شده را باز می‌کند و آن را فقط نمایش می‌دهد. این کار نقاشی
        فعلی را روی بوم بارگذاری نمی‌کند.
      </p>
      <button
        type="button"
        className={styles.secondaryButton}
        onClick={() => {
          inputRef.current?.click()
        }}
      >
        ورود فایل نتیجه آزمون
      </button>
      {/*
        The value is cleared after every pick, otherwise choosing the SAME file
        twice fires no change event and the import appears to do nothing.
      */}
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className={styles.hiddenFileInput}
        aria-label="انتخاب فایل نتیجه آزمون"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) {
            onFileSelected(file)
          }
        }}
      />
    </section>
  )
}

export const TrialResultImport = memo(TrialResultImportComponent)
