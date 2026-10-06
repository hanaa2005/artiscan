/**
 * Choosing a task.
 *
 * Every function here is pure and takes its randomness as an argument. Nothing
 * in this file calls Math.random, reads a clock, or touches global state - so a
 * test can pin down exactly which task comes back, and a future study can
 * reproduce a participant's task order from a recorded seed alone.
 */

import type { DrawingTask } from '../types/trial.types'
import { TASK_CATALOG } from '../data/taskCatalog'

/** A source of randomness in the half-open range [0, 1), like Math.random. */
export type RandomFn = () => number

/** The task with this id, or null. */
export function findTaskById(
  id: string,
  catalog: readonly DrawingTask[] = TASK_CATALOG,
): DrawingTask | null {
  return catalog.find((task) => task.id === id) ?? null
}

/** Only the tasks currently offered to participants, in catalog order. */
export function getEnabledTasks(
  catalog: readonly DrawingTask[] = TASK_CATALOG,
): DrawingTask[] {
  return catalog.filter((task) => task.enabled)
}

/**
 * Hashes a string seed into a non-negative 32-bit integer (FNV-1a).
 *
 * A tiny hash rather than a PRNG library: the job is only to turn "participant
 * 7, block 2" into a stable index, and a dependency for thirty bytes of
 * arithmetic would be hard to justify.
 */
export function hashSeed(seed: string): number {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    // The FNV prime, applied with shifts to stay inside 32-bit integer math.
    hash = Math.imul(hash, 16777619)
  }
  // >>> 0 reinterprets the result as unsigned, so the index is never negative.
  return hash >>> 0
}

/**
 * Picks a task deterministically from a seed.
 *
 * The same seed and the same catalog always yield the same task, which is what
 * makes a study reproducible: the assignment can be re-derived later instead of
 * having to be stored per participant.
 *
 * Returns null when no task is enabled.
 */
export function selectTaskBySeed(
  seed: string,
  catalog: readonly DrawingTask[] = TASK_CATALOG,
): DrawingTask | null {
  const enabled = getEnabledTasks(catalog)
  if (enabled.length === 0) return null
  return enabled[hashSeed(seed) % enabled.length] ?? null
}

/**
 * Picks a task using an injected random function.
 *
 * `random` is a parameter rather than a direct Math.random call so tests can
 * supply a stub and assert the exact choice. The result is clamped defensively:
 * a caller could hand us a stub returning 1 or a negative number, and an
 * out-of-range index would silently return undefined.
 */
export function selectRandomTask(
  random: RandomFn,
  catalog: readonly DrawingTask[] = TASK_CATALOG,
): DrawingTask | null {
  const enabled = getEnabledTasks(catalog)
  if (enabled.length === 0) return null

  const raw = random()
  const fraction = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999) : 0
  return enabled[Math.floor(fraction * enabled.length)] ?? null
}
