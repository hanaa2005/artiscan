/**
 * Task selection. Presentational only.
 */

import { memo } from 'react'
import type { DrawingTask } from '../types/trial.types'
import styles from './TrialFlow.module.css'

interface TaskSelectorProps {
  tasks: readonly DrawingTask[]
  selectedTaskId: string | null
  disabled: boolean
  onSelect: (task: DrawingTask) => void
  onPickRandom: () => void
}

function TaskSelectorComponent({
  tasks,
  selectedTaskId,
  disabled,
  onSelect,
  onPickRandom,
}: TaskSelectorProps): React.JSX.Element {
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null

  /*
    Once the task is locked the grid is dead weight, and on a laptop screen it
    pushes the canvas below the fold - the participant would have to scroll to
    reach the surface they are being timed on. So it collapses to a one-line
    summary and gives the space back to the drawing area.
  */
  if (disabled) {
    return (
      <section className={styles.lockedPanel} aria-labelledby="task-selector-heading">
        <h2 id="task-selector-heading" className={styles.lockedHeading}>
          تکلیف
        </h2>
        <p className={styles.lockedTask}>
          {selectedTask === null ? '—' : `${selectedTask.labelFa} (${selectedTask.labelEn})`}
        </p>
        <p className={styles.lockNote}>در حین آزمون قابل تغییر نیست.</p>
      </section>
    )
  }

  return (
    <section className={styles.panel} aria-labelledby="task-selector-heading">
      <h2 id="task-selector-heading" className={styles.heading}>
        ۱. انتخاب تکلیف
      </h2>

      <div className={styles.taskGrid} role="group" aria-label="فهرست تکالیف">
        {tasks.map((task) => {
          const isSelected = task.id === selectedTaskId
          return (
            <button
              key={task.id}
              type="button"
              className={isSelected ? styles.taskButtonActive : styles.taskButton}
              aria-pressed={isSelected}
              disabled={disabled}
              onClick={() => {
                onSelect(task)
              }}
            >
              <span className={styles.taskLabelFa}>{task.labelFa}</span>
              <span className={styles.taskLabelEn}>{task.labelEn}</span>
            </button>
          )
        })}
      </div>

      <button type="button" className={styles.secondaryButton} onClick={onPickRandom}>
        انتخاب تصادفی
      </button>
    </section>
  )
}

export const TaskSelector = memo(TaskSelectorComponent)
