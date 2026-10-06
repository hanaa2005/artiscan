/**
 * Local persistence for drawing sessions (native IndexedDB, no library).
 *
 * This layer is intentionally free of any React import. It knows only about
 * DrawingSession objects and a store, which means it can be unit tested and
 * later swapped for a real backend (week 3+) without touching any component.
 *
 * Raw drawing data is NEVER put in localStorage: a session with a few thousand
 * points easily exceeds the ~5 MB localStorage quota, and writing it
 * synchronously would block the main thread while the user is drawing.
 *
 * The connection, the schema version and the stale-write guard live in
 * ./indexedDb, shared with the trial-result repository.
 */

import type { DrawingSession } from '../types/drawing.types'
import {
  CREATED_AT_INDEX,
  DRAWING_SESSION_STORE,
  createGuardedWriter,
  registerWriterForReset,
  requestToPromise,
  withStore,
  type GuardedWriteOptions,
} from './indexedDb'

export {
  isIndexedDbSupported,
  openDatabase,
  resetDatabaseConnectionForTests,
} from './indexedDb'

/** Options accepted by saveSession. See GuardedWriteOptions for the semantics. */
export type SaveSessionOptions = GuardedWriteOptions

const writer = createGuardedWriter<DrawingSession>(async (snapshot) => {
  await withStore(DRAWING_SESSION_STORE, 'readwrite', async (store) => {
    await requestToPromise(store.put(snapshot))
  })
})
registerWriterForReset(writer)

/**
 * Inserts or replaces a session.
 *
 * Writes are queued per session id and checked against the revision high-water
 * mark, so a slow older snapshot can never overwrite a newer one.
 */
export function saveSession(
  session: DrawingSession,
  options: SaveSessionOptions = {},
): Promise<void> {
  return writer.save(session.id, session, options)
}

/** Resolves once every queued write for this session has settled. */
export function flushPendingWrites(sessionId: string): Promise<void> {
  return writer.flush(sessionId)
}

/** Reads one session by id, or null when it does not exist. */
export function getSession(id: string): Promise<DrawingSession | null> {
  return withStore(DRAWING_SESSION_STORE, 'readonly', async (store) => {
    const record = await requestToPromise<unknown>(store.get(id))
    return (record as DrawingSession | undefined) ?? null
  })
}

/** Reads the most recently created session, or null when the store is empty. */
export function getLatestSession(): Promise<DrawingSession | null> {
  return withStore(DRAWING_SESSION_STORE, 'readonly', async (store) => {
    const index = store.index(CREATED_AT_INDEX)
    // 'prev' walks the index from the highest createdAt downwards.
    const cursor = await requestToPromise(index.openCursor(null, 'prev'))
    if (cursor === null) return null
    return cursor.value as DrawingSession
  })
}

/** Deletes one session by id. */
export function deleteSession(id: string): Promise<void> {
  return withStore(DRAWING_SESSION_STORE, 'readwrite', async (store) => {
    await requestToPromise(store.delete(id))
  })
}

/** Removes every stored session. */
export function clearSessions(): Promise<void> {
  // The revision high-water marks describe records that no longer exist, so
  // they must go too - otherwise a later save of the same id looks stale.
  writer.reset()
  return withStore(DRAWING_SESSION_STORE, 'readwrite', async (store) => {
    await requestToPromise(store.clear())
  })
}
