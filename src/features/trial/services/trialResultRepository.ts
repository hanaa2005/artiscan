/**
 * Local persistence for COMPLETED trial results.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A finished trial lived only in React state. The participant drew, the trial
 * completed, the result was assembled - and a reload, a crash or an accidental
 * tab close destroyed it, because nothing was written anywhere until the user
 * clicked "export JSON". The recording that the whole system exists to produce
 * was the one thing that was never persisted.
 *
 * WHAT IS STORED
 *
 * The complete DrawingTrialResult, canonical session included, exactly as it
 * would be exported. `features` travels with it as a cached derivation and is
 * RECOMPUTED from the embedded session on the way back in, so a stale or
 * tampered feature block can never be presented as measurement - the same rule
 * the file importer follows.
 *
 * ONLY COMPLETE RESULTS
 *
 * saveTrialResult refuses anything whose trial is not genuinely finished. A
 * half-written record that reads back as "completed" would be indistinguishable
 * from a real observation, which is the failure mode this repository exists to
 * prevent - not one it is allowed to introduce.
 *
 * DELETION IS ALWAYS EXPLICIT
 *
 * Nothing in this module is called on a timer or on startup. Records are
 * removed only by deleteTrialResult, or by clearExpiredTrialResults with an
 * age the caller states outright.
 */

import type { DrawingTrialResult } from '../types/trial.types'
import {
  CREATED_AT_INDEX,
  TRIAL_RESULT_STORE,
  UPDATED_AT_INDEX,
  createGuardedWriter,
  registerWriterForReset,
  requestToPromise,
  withStore,
  type GuardedWriteOptions,
} from '../../drawing/services/indexedDb'

export { isIndexedDbSupported } from '../../drawing/services/indexedDb'

/**
 * One stored row.
 *
 * The envelope fields exist so the store can be queried and aged without
 * reaching inside the result - and, deliberately, without adding a single field
 * to DrawingTrialResult or to the canonical DrawingSession. Storage metadata is
 * not research data and must not leak into the exported schema.
 */
export interface StoredTrialResult {
  /** The trial id. One row per trial; re-saving the same trial replaces it. */
  id: string
  /** ISO label for when the trial completed. Indexed, for newest-first reads. */
  createdAt: string
  /** ISO label for when this row was last written. Indexed, for cleanup. */
  updatedAt: string
  /** The exact result, as it would be exported. */
  result: DrawingTrialResult
}

/** Options accepted by saveTrialResult. See GuardedWriteOptions for semantics. */
export type SaveTrialResultOptions = GuardedWriteOptions

/**
 * True when this result describes a trial that genuinely finished.
 *
 * All three conditions are required: a status without timing, or timing without
 * a status, is a partially built object rather than an observation.
 */
export function isCompleteTrialResult(result: DrawingTrialResult): boolean {
  const { trial } = result
  if (trial.status !== 'completed') return false
  if (trial.timing.completedAt === null) return false
  const { durationMs } = trial.timing
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return false
  return true
}

const writer = createGuardedWriter<StoredTrialResult>(async (snapshot) => {
  await withStore(TRIAL_RESULT_STORE, 'readwrite', async (store) => {
    await requestToPromise(store.put(snapshot))
  })
})
registerWriterForReset(writer)

/**
 * Inserts or replaces one completed trial result.
 *
 * Rejects an incomplete result rather than storing it. Writes are queued per
 * trial id and checked against the revision high-water mark, so a slow older
 * snapshot can never overwrite a newer one.
 */
export function saveTrialResult(
  result: DrawingTrialResult,
  options: SaveTrialResultOptions = {},
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  if (!isCompleteTrialResult(result)) {
    return Promise.reject(
      new Error('نتیجه ناقص ذخیره نمی‌شود: این آزمون هنوز به‌طور کامل ثبت نشده است.'),
    )
  }

  const record: StoredTrialResult = {
    id: result.trial.id,
    // completedAt is non-null here; isCompleteTrialResult has already checked.
    createdAt: result.trial.timing.completedAt ?? result.trial.timing.startedAt,
    updatedAt: now(),
    result,
  }

  return writer.save(record.id, record, options)
}

/** Resolves once every queued write for this trial has settled. */
export function flushPendingTrialWrites(trialId: string): Promise<void> {
  return writer.flush(trialId)
}

/** Reads one stored result by trial id, or null when it does not exist. */
export function getTrialResult(trialId: string): Promise<StoredTrialResult | null> {
  return withStore(TRIAL_RESULT_STORE, 'readonly', async (store) => {
    const record = await requestToPromise<unknown>(store.get(trialId))
    return (record as StoredTrialResult | undefined) ?? null
  })
}

/** Every stored result, newest completion first. */
export function listTrialResults(): Promise<StoredTrialResult[]> {
  return withStore(TRIAL_RESULT_STORE, 'readonly', async (store) => {
    const index = store.index(CREATED_AT_INDEX)
    // 'prev' walks the index from the highest createdAt downwards.
    const records = await requestToPromise<unknown[]>(index.getAll())
    return (records as StoredTrialResult[]).slice().reverse()
  })
}

/** The most recently completed stored result, or null when the store is empty. */
export async function getLatestTrialResult(): Promise<StoredTrialResult | null> {
  const all = await listTrialResults()
  return all[0] ?? null
}

/** Deletes one stored result. Only ever called from an explicit user action. */
export function deleteTrialResult(trialId: string): Promise<void> {
  return withStore(TRIAL_RESULT_STORE, 'readwrite', async (store) => {
    await requestToPromise(store.delete(trialId))
  })
}

export interface ExpiryPolicy {
  /** Rows last written longer ago than this are removed. Must be finite and > 0. */
  maxAgeMs: number
  /** Injected for tests; defaults to the wall clock. */
  now?: () => number
}

/**
 * Removes rows older than an age the CALLER states.
 *
 * There is deliberately no default age and no automatic invocation. Research
 * data is not garbage-collected behind the user's back: a policy has to be
 * chosen and applied on purpose, and the number of rows removed is returned so
 * the caller can report it honestly.
 *
 * A row with an unreadable `updatedAt` is KEPT: it simply does not fall inside
 * the queried range. Deleting a record because its timestamp could not be
 * parsed would destroy data on the strength of a bug.
 */
export async function clearExpiredTrialResults(policy: ExpiryPolicy): Promise<number> {
  const { maxAgeMs } = policy
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error('سیاست انقضا نامعتبر است: بیشینه سن باید عددی مثبت باشد.')
  }

  const nowMs = (policy.now ?? Date.now)()
  const cutoffIso = new Date(nowMs - maxAgeMs).toISOString()

  return withStore(TRIAL_RESULT_STORE, 'readwrite', async (store) => {
    // Every `updatedAt` is written by toISOString(), so all rows share one
    // fixed-width UTC format and lexicographic order IS chronological order.
    // The range therefore selects exactly the rows older than the cutoff.
    const index = store.index(UPDATED_AT_INDEX)
    const keys = await requestToPromise<IDBValidKey[]>(
      index.getAllKeys(IDBKeyRange.upperBound(cutoffIso, true)),
    )
    for (const key of keys) {
      await requestToPromise(store.delete(key))
    }
    return keys.length
  })
}

/** Removes every stored result. Explicit, destructive, never called on startup. */
export function clearTrialResults(): Promise<void> {
  // The revision high-water marks describe rows that no longer exist, so they
  // must go too - otherwise a later save of the same id looks stale.
  writer.reset()
  return withStore(TRIAL_RESULT_STORE, 'readwrite', async (store) => {
    await requestToPromise(store.clear())
  })
}
