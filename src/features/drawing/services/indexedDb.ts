/**
 * Shared IndexedDB infrastructure (native, no library).
 *
 * WHY THIS MODULE EXISTS
 *
 * Week 1A added a second store - completed trial results - alongside the
 * drawing sessions that were already persisted. One browser database cannot be
 * opened at two different versions at the same time, and two modules each
 * caching their own connection would race on the upgrade transaction. So the
 * connection, the version number and the store definitions live in exactly one
 * place, and each repository is a thin typed layer on top.
 *
 * It also owns the STALE-WRITE GUARD, because both repositories need the same
 * one and a second copy of that logic would be a second chance to get it wrong.
 *
 * Nothing here imports React, and nothing here knows what a stroke is.
 */

const DATABASE_NAME = 'artiscan'

/**
 * Version 2 adds the `trialResults` store. Version 1 shipped with
 * `drawingSessions` only; an existing v1 database is upgraded in place and its
 * stored sessions are left completely untouched.
 */
const DATABASE_VERSION = 2

export const DRAWING_SESSION_STORE = 'drawingSessions'
export const TRIAL_RESULT_STORE = 'trialResults'
export const CREATED_AT_INDEX = 'createdAt'
export const UPDATED_AT_INDEX = 'updatedAt'

/** True when this browser exposes IndexedDB at all (e.g. false in some private modes). */
export function isIndexedDbSupported(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

/** Wraps an IDBRequest in a promise so the rest of the code can use async/await. */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
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
 * Opens (and on first run creates or upgrades) the database.
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

    /*
      Every store is created defensively rather than keyed to a specific
      `oldVersion`. The upgrade therefore does the right thing whether it runs
      on a brand-new database or on one left behind by version 1, and it never
      touches - let alone rewrites - a record that already exists.
    */
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(DRAWING_SESSION_STORE)) {
        const store = database.createObjectStore(DRAWING_SESSION_STORE, { keyPath: 'id' })
        // Lets getLatestSession() read the newest record without scanning all rows.
        store.createIndex(CREATED_AT_INDEX, CREATED_AT_INDEX, { unique: false })
      }
      if (!database.objectStoreNames.contains(TRIAL_RESULT_STORE)) {
        const store = database.createObjectStore(TRIAL_RESULT_STORE, { keyPath: 'id' })
        store.createIndex(CREATED_AT_INDEX, CREATED_AT_INDEX, { unique: false })
        // Cleanup policies age records by when they were last written, not by
        // when the trial happened.
        store.createIndex(UPDATED_AT_INDEX, UPDATED_AT_INDEX, { unique: false })
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
export async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const store = transaction.objectStore(storeName)

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
 * Per-key write queue and revision high-water mark.
 *
 * THE PROBLEM THESE SOLVE
 *
 * Autosave fires on every meaningful change, and an IndexedDB write is async.
 * Two writes issued a moment apart can therefore complete in either order - and
 * because each write stores a WHOLE snapshot rather than a delta, an older
 * snapshot landing last silently rolls the record back. The user draws a fifth
 * stroke, the write for four strokes finishes late, and the restored session is
 * missing a stroke that was never deleted.
 *
 * TWO GUARDS, BECAUSE THEY COVER DIFFERENT CASES
 *
 * 1. `pendingWrites` chains every write for a key, so two writes are never in
 *    flight at once. This fixes ordering for writes issued in order.
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
 * Ordering between the two is still guaranteed by the per-key queue.
 */
interface AcceptedRevision {
  epoch: string
  revision: number
}

export interface GuardedWriteOptions {
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

export interface GuardedWriter<T> {
  /** Queues a guarded write. Resolves when this snapshot has been stored, or skipped. */
  save: (key: string, value: T, options?: GuardedWriteOptions) => Promise<void>
  /** Resolves once every queued write for this key has settled. */
  flush: (key: string) => Promise<void>
  /** Forgets all queues and high-water marks. */
  reset: () => void
}

/**
 * Builds a writer that applies both guards above around `put`.
 *
 * `put` receives an already-cloned snapshot and is responsible only for the
 * store call itself.
 */
export function createGuardedWriter<T>(put: (snapshot: T) => Promise<void>): GuardedWriter<T> {
  const pendingWrites = new Map<string, Promise<void>>()
  const acceptedRevisions = new Map<string, AcceptedRevision>()

  const save = (key: string, value: T, options: GuardedWriteOptions = {}): Promise<void> => {
    const { epoch, revision } = options
    const isGuarded = epoch !== undefined && revision !== undefined

    // Remembered so a failed write can release its claim - see releaseClaim.
    let previousAccepted: AcceptedRevision | undefined

    if (isGuarded) {
      const accepted = acceptedRevisions.get(key)
      if (accepted !== undefined && accepted.epoch === epoch && revision <= accepted.revision) {
        // Same editor lifetime, and a newer snapshot has already been accepted.
        // Writing this one would move the stored record backwards.
        return Promise.resolve()
      }
      previousAccepted = accepted
      acceptedRevisions.set(key, { epoch, revision })
    }

    /**
     * Undoes the revision claim after a write that never reached the store.
     *
     * A claim exists to protect a snapshot that WAS stored. If the write failed,
     * holding the claim would block a retry at the same logical revision and
     * lose that change for good - the guard would be defending data that does
     * not exist. The claim is only released if no later save has taken the slot
     * meanwhile, since that newer snapshot is the one worth protecting.
     */
    const releaseClaim = (): void => {
      if (!isGuarded) return
      const current = acceptedRevisions.get(key)
      if (current === undefined || current.epoch !== epoch || current.revision !== revision) return

      if (previousAccepted === undefined) {
        acceptedRevisions.delete(key)
      } else {
        acceptedRevisions.set(key, previousAccepted)
      }
    }

    // Snapshot now, before queueing: the caller's object may keep changing
    // while this write waits its turn.
    //
    // structuredClone throws SYNCHRONOUSLY on a non-serializable value, which
    // is the most common way an IndexedDB write fails in practice. Converting
    // it to a rejected promise keeps the contract callers rely on - they await
    // this, they do not wrap it in try/catch - and lets the claim be released
    // like any other failure.
    let snapshot: T
    try {
      snapshot = structuredClone(value)
    } catch (error) {
      releaseClaim()
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }

    const previous = pendingWrites.get(key) ?? Promise.resolve()
    const write = previous
      // A failed earlier write must not cancel this one, so the chain swallows
      // it; the original caller still receives its own rejection.
      .catch(() => undefined)
      .then(() => put(snapshot))
      .catch((error: unknown) => {
        releaseClaim()
        throw error
      })

    pendingWrites.set(
      key,
      write.then(
        () => undefined,
        () => undefined,
      ),
    )

    return write
  }

  return {
    save,
    flush: (key) => (pendingWrites.get(key) ?? Promise.resolve()).then(() => undefined),
    reset: () => {
      pendingWrites.clear()
      acceptedRevisions.clear()
    },
  }
}

/** Writers registered here are cleared by resetDatabaseConnectionForTests(). */
const registeredWriters: Array<{ reset: () => void }> = []

export function registerWriterForReset(writer: { reset: () => void }): void {
  registeredWriters.push(writer)
}

/** Test hook: forgets the cached connection so a fresh one is opened. */
export function resetDatabaseConnectionForTests(): void {
  databasePromise = null
  for (const writer of registeredWriters) {
    writer.reset()
  }
}
