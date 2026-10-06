/**
 * File picker for importing a session.
 *
 * A native <input type="file"> cannot be styled to match the other buttons, so
 * it is hidden and driven by a real <button>. The input value is reset after
 * every pick, otherwise choosing the SAME file twice in a row fires no change
 * event and the import would appear to do nothing.
 */

import { memo, useRef } from 'react'
import styles from './DrawingToolbar.module.css'

interface JsonImportControlProps {
  onFileSelected: (file: File) => void
}

function JsonImportControlComponent({
  onFileSelected,
}: JsonImportControlProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)

  return (
    <>
      <button
        type="button"
        className={styles.button}
        onClick={() => {
          inputRef.current?.click()
        }}
      >
        ورود JSON
      </button>
      <input
        ref={inputRef}
        type="file"
        /*
          Both encodings are offered, but the picker filter is a convenience,
          not the decision: the reader sniffs the bytes, so a mislabelled file
          still opens correctly.
        */
        accept="application/json,.json,application/gzip,.gz,.json.gz"
        className={styles.hiddenFileInput}
        aria-label="انتخاب فایل JSON یا JSON.GZ جلسه"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) {
            onFileSelected(file)
          }
        }}
      />
    </>
  )
}

export const JsonImportControl = memo(JsonImportControlComponent)
