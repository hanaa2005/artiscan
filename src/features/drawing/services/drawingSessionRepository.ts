/**
 * Local persistence for drawing sessions (native IndexedDB, no library).
 *
 * This layer is intentionally free of any React import. It knows only about
 * DrawingSession objects and a database, which means it can be unit tested and
 * later swapped for a real backend (week 3+) without touching any component.
 *
 * Raw drawing data is NEVER put in localStorage: a session with a few thousand
 * points easily exceeds the ~5 MB localStorage quota, and writing it
 * synchronously would block the main thread while the user is drawing.
 */

import type { DrawingSession } from '../types/drawing.types'

const DATABASE_NAME = 'artiscan'
const DATABASE_VERSION = 1
const STORE_NAME = 'drawingSessions'
const CREATED_AT_INDEX = 'createdAt'

/** True when this browser exposes IndexedDB at all (e.g. false in some private modes). */
export function isIndexedDbSupported(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

/** Wraps an IDBRequest in a promise so the rest of the file can use async/await. */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

let databasePromise: Promise<IDBDatabase> | null = null

/**
 * Opens (and on first run creates) the database.
 * The promise is cached so concurrent callers share a single connection.
 */
export function openDatabase(): Promise<IDBDatabase> {
  if (!isIndexedDbSupported()) {
    return Promise.reject(new Error('IndexedDB در این مرورگر در دسترس نیست.'))
  }
  if (databasePromise !== null) {
    return databasePromise
  }

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' })
        // Lets getLatestSession() read the newest record without scanning all rows.
        store.createIndex(CREATED_AT_INDEX, 'createdAt', { unique: false })
      }
    }

    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      databasePromise = null
      reject(request.error ?? new Error('باز کردن پایگاه داده محلی ناموفق بود.'))
    }
    request.onblocked = () => {
      databasePromise = null
      reject(new Error('پایگاه داده محلی توسط یک تب دیگر قفل شده است.'))
    }
  })

  return databasePromise
}

/** Runs `work` inside a transaction and resolves once the transaction commits. */
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)

    let result: T
    work(store).then(
      (value) => {
        result = value
      },
      (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)))
        try {
          transaction.abort()
        } catch {
          // The transaction may already be finished; nothing to clean up.
        }
      },
    )

    transaction.oncomplete = () => {
      resolve(result)
    }
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('تراکنش پایگاه داده محلی ناموفق بود.'))
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('تراکنش پایگاه داده محلی لغو شد.'))
    }
  })
}

/**
 * Per-session write queue and revision high-water mark.
 *
 * THE PROBLEM THESE SOLVE
 *
 * Autosave fires on every meaningful change, and an IndexedDB write is async.
 * Two writes issued a moment apart can therefore complete in either order - and
 * because each write stores a WHOLE session snapshot rather than a delta, an
 * older snapshot landing last silently rolls the record back. The user draws a
 * fifth stroke, the write for four strokes finishes late, and the restored
 * session is missing a stroke that was never deleted.
 *
 * TWO GUARDS, BECAUSE THEY COVER DIFFERENT CASES
 *
 * 1. `pendingWrites` chains every write for a session, so two writes are never
 *    in flight at once. This fixes ordering for writes issued in order.
 * 2. `acceptedRevisions` records the highest revision accepted SO FAR WITHIN ONE
 *    EPOCH, so a save that was already stale before it was enqueued is dropped
 *    outright instead of being queued behind a newer one.
 *
 * WHY REVISIONS ARE SCOPED TO AN EPOCH
 *
 * A revision counter belongs to one editor lifetime. It starts at zero and
 * counts changes; a component remount starts a fresh counter, also at zero.
 * Comparing a number from one lifetime against a number from another is
 * meaningless - they measure different things.
 *
 * Concretely: autosave a session up to revision 10, remount the editor, restore
 * that same session, make a change. That change is revision 1 of the NEW
 * counter, and comparing 1 against the stale high-water mark of 10 would
 * discard every subsequent write until the user made ten more changes - silent
 * data loss that looks exactly like autosave working.
 *
 * So each editor lifetime supplies an `epoch` token, and revisions are only
 * compared within a matching epoch. A save from a different epoch is always
 * accepted and resets the high-water mark: it necessarily comes from a later
 * lifetime, because the previous one had to end before this one could begin.
 * Ordering between the two is still guaranteed by the per-session queue.
 */
interface AcceptedRevision {
  epoch: string
  revision: number
}

const pendingWrites = new Map<string, Promise<void>>()
const acceptedRevisions = new Map<string, AcceptedRevision>()

export interface SaveSessionOptions {
  /**
   * Identifies the editor lifetime this revision counter belongs to. Revisions
   * are only comparable within one epoch. Required whenever `revision` is given.
   */
  epoch?: string
  /**
   * Counter that increases with each change inside one epoch. A save that is
   * not newer than one already accepted FOR THE SAME EPOCH is discarded.
   * Omit it (with `epoch`) to force an unconditional write, as a manual save does.
   */
  revision?: number
}

/**
 * Inserts or replaces a session.
 *
 * `structuredClone` strips any accidental non-serializable value (a React ref,
 * a class instance) that IndexedDB would otherwise reject with a DataCloneError.
 */
export function saveSession(
  session: DrawingSession,
  options: SaveSessionOptions = {},
): Promise<void> {
  const { epoch, revision } = options
  const isGuarded = epoch !== undefined && revision !== undefined

  // Remembered so a failed write can release its claim - see releaseClaim.
  let previousAccepted: AcceptedRevision | undefined

  if (isGuarded) {
    const accepted = acceptedRevisions.get(session.id)
    if (accepted !== undefined && accepted.epoch === epoch && revision <= accepted.revision) {
      // Same editor lifetime, and a newer snapshot has already been accepted.
      // Writing this one would move the stored record backwards.
      return Promise.resolve()
    }
    previousAccepted = accepted
    acceptedRevisions.set(session.id, { epoch, revision })
  }

  /**
   * Undoes the revision claim after a write that never reached the store.
   *
   * A claim exists to protect a snapshot that WAS stored. If the write failed,
   * holding the claim would block a retry at the same logical revision and lose
   * that change for good - the guard would be defending data that does not
   * exist. The claim is only released if no later save has taken the slot
   * meanwhile, since that newer snapshot is the one worth protecting.
   */
  const releaseClaim = (): void => {
    if (!isGuarded) return
    const current = acceptedRevisions.get(session.id)
    if (current === undefined || current.epoch !== epoch || current.revision !== revision) return

    if (previousAccepted === undefined) {
      acceptedRevisions.delete(session.id)
    } else {
      acceptedRevisions.set(session.id, previousAccepted)
    }
  }

  // Snapshot now, before queueing: the caller's object may keep changing while
  // this write waits its turn.
  //
  // structuredClone throws SYNCHRONOUSLY on a non-serializable value, which is
  // the most common way an IndexedDB write fails in practice. Converting it to
  // a rejected promise keeps saveSession's contract - callers await it, they do
  // not wrap it in try/catch - and lets the claim be released like any other
  // failure.
  let snapshot: DrawingSession
  try {
    snapshot = structuredClone(session)
  } catch (error) {
    releaseClaim()
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }

  const previous = pendingWrites.get(session.id) ?? Promise.resolve()
  const write = previous
    // A failed earlier write must not cancel this one, so the chain swallows it;
    // the original caller still receives its own rejection.
    .catch(() => undefined)
    .then(() =>
      withStore('readwrite', async (store) => {
        await requestToPromise(store.put(snapshot))
      }),
    )
    .catch((error: unknown) => {
      releaseClaim()
      throw error
    })

  pendingWrites.set(
    session.id,
    write.then(
      () => undefined,
      () => undefined,
    ),
  )

  return write
}

/** Resolves once every queued write for this session has settled. */
export function flushPendingWrites(sessionId: string): Promise<void> {
  return (pendingWrites.get(sessionId) ?? Promise.resolve()).then(() => undefined)
}

/** Reads one session by id, or null when it does not exist. */
export function getSession(id: string): Promise<DrawingSession | null> {
  return withStore('readonly', async (store) => {
    const record = await requestToPromise<unknown>(store.get(id))
    return (record as DrawingSession | undefined) ?? null
  })
}

/** Reads the most recently created session, or null when the store is empty. */
export function getLatestSession(): Promise<DrawingSession | null> {
  return withStore('readonly', async (store) => {
    const index = store.index(CREATED_AT_INDEX)
    // 'prev' walks the index from the highest createdAt downwards.
    const cursor = await requestToPromise(index.openCursor(null, 'prev'))
    if (cursor === null) return null
    return cursor.value as DrawingSession
  })
}

/** Deletes one session by id. */
export function deleteSession(id: string): Promise<void> {
  return withStore('readwrite', async (store) => {
    await requestToPromise(store.delete(id))
  })
}

/** Removes every stored session. */
export function clearSessions(): Promise<void> {
  // The revision high-water marks describe records that no longer exist, so
  // they must go too - otherwise a later save of the same id looks stale.
  acceptedRevisions.clear()
  return withStore('readwrite', async (store) => {
    await requestToPromise(store.clear())
  })
}

/** Test hook: forgets the cached connection so a fresh one is opened. */
export function resetDatabaseConnectionForTests(): void {
  databasePromise = null
  pendingWrites.clear()
  acceptedRevisions.clear()
}
