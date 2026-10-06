/**
 * The local task catalog.
 *
 * Ten common categories that also exist in Google QuickDraw, so these
 * recordings can later be lined up with that dataset. Nothing is downloaded and
 * nothing is bundled from it: `quickDrawCategory` is a label recorded for the
 * future, and the app has no network behaviour at all.
 *
 * Ids are STABLE. A result file references a task by id forever, so an id is
 * never renamed or reused - a task that falls out of use is marked
 * `enabled: false` and stays here so old results remain readable.
 */

import type { DrawingTask } from '../types/trial.types'

export const DEFAULT_TIME_LIMIT_SECONDS = 60

export const TASK_CATALOG: readonly DrawingTask[] = [
  {
    id: 'house',
    labelFa: 'خانه',
    labelEn: 'House',
    quickDrawCategory: 'house',
    instructionFa: 'یک خانه بکشید؛ هر شکلی که دوست دارید.',
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    enabled: true,
  },
  {
    id: 'tree',
    labelFa: 'درخت',
    labelEn: 'Tree',
    quickDrawCategory: 'tree',
    instructionFa: 'یک درخت بکشید.',
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    enabled: true,
  },
  {
    id: 'cat',
    labelFa: 'گربه',
    labelEn: 'Cat',
    quickDrawCategory: 'cat',
    instructionFa: 'یک گربه بکشید.',
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    enabled: true,
  },
  {
    id: 'flower',
    labelFa: 'گل',
    labelEn: 'Flower',
    quickDrawCategory: 'flower',
    instructionFa: 'یک گل بکشید.',
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    enabled: true,
  },
  {
    id: 'sun',
    labelFa: 'خورشید',
    labelEn: 'Sun',
    quickDrawCategory: 'sun',
    instructionFa: 'یک خورشید بکشید.',
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    enabled: true,
  },
  {
    id: 'car',
    labelFa: 'ماشین',
    labelEn: 'Car',
    quickDrawCategory: 'car',
    instructionFa: 'یک ماشین بکشید.',
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    enabled: true,
  },
  {
    id: 'fish',
    labelFa: 'ماهی',
    labelEn: 'Fish',
    quickDrawCategory: 'fish',
    instructionFa: 'یک ماهی بکشید.',
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    enabled: true,
  },
  {
    id: 'bird',
    labelFa: 'پرنده',
    labelEn: 'Bird',
    quickDrawCategory: 'bird',
    instructionFa: 'یک پرنده بکشید.',
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    enabled: true,
  },
  {
    id: 'star',
    labelFa: 'ستاره',
    labelEn: 'Star',
    quickDrawCategory: 'star',
    instructionFa: 'یک ستاره بکشید.',
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    enabled: true,
  },
  {
    id: 'face',
    labelFa: 'صورت',
    labelEn: 'Face',
    quickDrawCategory: 'face',
    instructionFa: 'یک صورت بکشید.',
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    enabled: true,
  },
]
