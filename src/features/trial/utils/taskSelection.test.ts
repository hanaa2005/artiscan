import { describe, expect, it } from 'vitest'
import {
  findTaskById,
  getEnabledTasks,
  hashSeed,
  selectRandomTask,
  selectTaskBySeed,
} from './taskSelection'
import { TASK_CATALOG } from '../data/taskCatalog'
import type { DrawingTask } from '../types/trial.types'

function makeTask(id: string, enabled = true): DrawingTask {
  return {
    id,
    labelFa: id,
    labelEn: id,
    quickDrawCategory: id,
    instructionFa: `${id} بکشید.`,
    timeLimitSeconds: 60,
    enabled,
  }
}

const THREE = [makeTask('a'), makeTask('b'), makeTask('c')]

describe('the shipped catalog', () => {
  it('offers ten tasks', () => {
    expect(TASK_CATALOG).toHaveLength(10)
  })

  it('uses unique, stable ids', () => {
    const ids = TASK_CATALOG.map((task) => task.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every task both labels and a QuickDraw category', () => {
    for (const task of TASK_CATALOG) {
      expect(task.labelFa.length).toBeGreaterThan(0)
      expect(task.labelEn.length).toBeGreaterThan(0)
      expect(task.quickDrawCategory.length).toBeGreaterThan(0)
      expect(task.instructionFa.length).toBeGreaterThan(0)
    }
  })
})

describe('findTaskById', () => {
  it('finds a task that exists', () => {
    expect(findTaskById('b', THREE)?.id).toBe('b')
  })

  it('returns null rather than throwing for an unknown id', () => {
    expect(findTaskById('nope', THREE)).toBeNull()
  })
})

describe('getEnabledTasks', () => {
  it('drops disabled tasks but keeps catalog order', () => {
    const catalog = [makeTask('a'), makeTask('b', false), makeTask('c')]
    expect(getEnabledTasks(catalog).map((t) => t.id)).toEqual(['a', 'c'])
  })

  it('returns an empty list when nothing is enabled', () => {
    expect(getEnabledTasks([makeTask('a', false)])).toEqual([])
  })
})

describe('hashSeed', () => {
  it('is stable for the same input', () => {
    expect(hashSeed('participant-7')).toBe(hashSeed('participant-7'))
  })

  it('produces a non-negative integer', () => {
    for (const seed of ['', 'a', 'participant-7', 'یک دانه فارسی']) {
      const hash = hashSeed(seed)
      expect(Number.isInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(0)
    }
  })

  it('separates similar seeds', () => {
    expect(hashSeed('block-1')).not.toBe(hashSeed('block-2'))
  })
})

describe('selectTaskBySeed', () => {
  it('is deterministic: the same seed always gives the same task', () => {
    // This is what makes a study reproducible - the assignment can be
    // re-derived later instead of having to be stored per participant.
    const first = selectTaskBySeed('participant-7', TASK_CATALOG)
    for (let i = 0; i < 5; i += 1) {
      expect(selectTaskBySeed('participant-7', TASK_CATALOG)?.id).toBe(first?.id)
    }
  })

  it('only ever returns an enabled task', () => {
    const catalog = [makeTask('a', false), makeTask('b'), makeTask('c', false)]
    for (const seed of ['x', 'y', 'z', 'w']) {
      expect(selectTaskBySeed(seed, catalog)?.id).toBe('b')
    }
  })

  it('spreads different seeds across the catalog', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i += 1) {
      const task = selectTaskBySeed(`seed-${i}`, TASK_CATALOG)
      if (task !== null) seen.add(task.id)
    }
    // Not a distribution test - just proof it does not collapse to one task.
    expect(seen.size).toBeGreaterThan(1)
  })

  it('returns null when no task is enabled', () => {
    expect(selectTaskBySeed('anything', [makeTask('a', false)])).toBeNull()
  })
})

describe('selectRandomTask', () => {
  it('uses the injected function, never Math.random', () => {
    // The stub pins the choice exactly, which would be impossible if the
    // implementation reached for Math.random itself.
    expect(selectRandomTask(() => 0, THREE)?.id).toBe('a')
    expect(selectRandomTask(() => 0.5, THREE)?.id).toBe('b')
    expect(selectRandomTask(() => 0.99, THREE)?.id).toBe('c')
  })

  it('never returns undefined for an out-of-range stub', () => {
    // A caller could hand us a badly behaved stub; an unclamped index would
    // read past the end of the array.
    expect(selectRandomTask(() => 1, THREE)?.id).toBe('c')
    expect(selectRandomTask(() => 1.5, THREE)?.id).toBe('c')
    expect(selectRandomTask(() => -1, THREE)?.id).toBe('a')
    expect(selectRandomTask(() => Number.NaN, THREE)?.id).toBe('a')
  })

  it('only ever returns an enabled task', () => {
    const catalog = [makeTask('a', false), makeTask('b'), makeTask('c', false)]
    for (const value of [0, 0.3, 0.7, 0.99]) {
      expect(selectRandomTask(() => value, catalog)?.id).toBe('b')
    }
  })

  it('returns null when no task is enabled', () => {
    expect(selectRandomTask(() => 0.5, [makeTask('a', false)])).toBeNull()
  })

  it('reaches every enabled task across the input range', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 30; i += 1) {
      const task = selectRandomTask(() => i / 30, THREE)
      if (task !== null) seen.add(task.id)
    }
    expect([...seen].sort()).toEqual(['a', 'b', 'c'])
  })
})
