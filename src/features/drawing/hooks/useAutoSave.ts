/**
 * Debounced automatic persistence of the current session to IndexedDB.
 *
 * The hook watches a `revision` value that only changes at meaningful moments
 * (a stroke committed, undo, redo, clear, import). It deliberately does NOT
 * watch anything that changes during pointer movement: writing to IndexedDB on
 * every sample would serialize thousands of points dozens of times a second.
 *
 * If IndexedDB is unavailable the app keeps working; only the status message
 * changes. Drawing data is never downgraded to localStorage.
 */

import { useEffect, useRef, useState } from 'react'
import type { DrawingSession } from '../types/drawing.types'
import { isIndexedDbSupported, saveSession } from '../services/drawingSessionRepository'

const DEBOUNCE_MS = 500

export type AutoSaveState = 'unsupported' | 'idle' | 'saving' | 'saved' | 'error'

const STATUS_LABELS: Record<AutoSaveState, string> = {
  unsupported: 'غیرفعال (IndexedDB در دسترس نیست)',
  idle: 'آماده',
  saving: 'در حال ذخیره...',
  saved: 'ذخیره شد',
  error: 'خطا در ذخیره‌سازی',
}

export function useAutoSave(
  buildSnapshot: () => DrawingSession,
  revision: number,
): { state: AutoSaveState; statusLabel: string } {
  const supported = isIndexedDbSupported()
  const [state, setState] = useState<AutoSaveState>(supported ? 'idle' : 'unsupported')

  /**
   * Identifies THIS editor lifetime.
   *
   * `revision` restarts at zero on every mount, so a bare number cannot be
   * compared across mounts - see the epoch explanation in the repository. The
   * token is created once per hook instance and travels with every write, so
   * the repository knows which revisions are comparable with which.
   */
  const epochRef = useRef<string>(null)
  epochRef.current ??= crypto.randomUUID()

  // Read the latest builder from a ref so a new inline function on every render
  // does not restart the debounce timer.
  const buildSnapshotRef = useRef(buildSnapshot)
  buildSnapshotRef.current = buildSnapshot

  useEffect(() => {
    if (!supported) return
    // revision 0 is the empty initial session; nothing worth storing yet.
    if (revision === 0) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      setState('saving')
      // Epoch + revision travel with the write so the repository can discard
      // this snapshot if a newer one from THIS lifetime has already been
      // stored - see saveSession.
      const epoch = epochRef.current
      const options = epoch === null ? {} : { epoch, revision }

      saveSession(buildSnapshotRef.current(), options).then(
        () => {
          if (!cancelled) setState('saved')
        },
        (error: unknown) => {
          if (!cancelled) setState('error')
          console.warn('ArtiScan: ذخیره خودکار ناموفق بود.', error)
        },
      )
    }, DEBOUNCE_MS)

    // Clearing the timer on cleanup is what makes this a debounce: a change
    // arriving within 500 ms cancels the pending write and restarts the wait.
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [revision, supported])

  return { state, statusLabel: STATUS_LABELS[state] }
}

/**
 * Counts how many times the recorded data has changed.
 *
 * `strokes` and `actions` are replaced by new array instances only at the five
 * moments we want to persist at - stroke committed, undo, redo, clear, import -
 * so a reference comparison is exactly the right trigger. Nothing here reacts
 * to pointer movement, because movement never touches these arrays.
 */
export function useRevision(strokes: unknown, actions: unknown): number {
  const [revision, setRevision] = useState(0)
  const isFirstRun = useRef(true)

  useEffect(() => {
    if (isFirstRun.current) {
      // Skip the initial mount: an empty session is not worth writing.
      isFirstRun.current = false
      return
    }
    setRevision((previous) => previous + 1)
  }, [strokes, actions])

  return revision
}
