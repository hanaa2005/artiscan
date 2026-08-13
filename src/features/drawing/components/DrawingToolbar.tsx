/**
 * The toolbar. Presentational only - every action is a callback from App.
 */

import { memo } from 'react'
import type { DrawingTool } from '../types/drawing.types'
import { JsonImportControl } from './JsonImportControl'
import styles from './DrawingToolbar.module.css'

const WIDTH_MIN = 1
const WIDTH_MAX = 40

interface DrawingToolbarProps {
  tool: DrawingTool
  color: string
  width: number
  canUndo: boolean
  canRedo: boolean
  onToolChange: (tool: DrawingTool) => void
  onColorChange: (color: string) => void
  onWidthChange: (width: number) => void
  onUndo: () => void
  onRedo: () => void
  onClear: () => void
  onNewSession: () => void
  onExportJson: () => void
  onImportJson: (file: File) => void
  onExportPng: () => void
}

function DrawingToolbarComponent({
  tool,
  color,
  width,
  canUndo,
  canRedo,
  onToolChange,
  onColorChange,
  onWidthChange,
  onUndo,
  onRedo,
  onClear,
  onNewSession,
  onExportJson,
  onImportJson,
  onExportPng,
}: DrawingToolbarProps): React.JSX.Element {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="ابزارهای نقاشی">
      <div className={styles.group} role="group" aria-label="انتخاب ابزار">
        <button
          type="button"
          className={tool === 'pen' ? styles.toolButtonActive : styles.toolButton}
          onClick={() => {
            onToolChange('pen')
          }}
          aria-pressed={tool === 'pen'}
        >
          قلم
        </button>
        <button
          type="button"
          className={tool === 'eraser' ? styles.toolButtonActive : styles.toolButton}
          onClick={() => {
            onToolChange('eraser')
          }}
          aria-pressed={tool === 'eraser'}
        >
          پاک‌کن
        </button>
      </div>

      <div className={styles.group}>
        <label className={styles.field} htmlFor="artiscan-color">
          <span className={styles.fieldLabel}>رنگ</span>
          <input
            id="artiscan-color"
            type="color"
            className={styles.colorInput}
            value={color}
            onChange={(event) => {
              onColorChange(event.target.value)
            }}
          />
        </label>

        <label className={styles.field} htmlFor="artiscan-width">
          <span className={styles.fieldLabel}>ضخامت: {width}</span>
          <input
            id="artiscan-width"
            type="range"
            className={styles.rangeInput}
            min={WIDTH_MIN}
            max={WIDTH_MAX}
            step={1}
            value={width}
            onChange={(event) => {
              onWidthChange(Number(event.target.value))
            }}
          />
        </label>
      </div>

      <div className={styles.group} role="group" aria-label="تاریخچه">
        <button type="button" className={styles.button} onClick={onUndo} disabled={!canUndo}>
          واگرد
        </button>
        <button type="button" className={styles.button} onClick={onRedo} disabled={!canRedo}>
          ازنو
        </button>
        <button type="button" className={styles.dangerButton} onClick={onClear}>
          پاک کردن همه
        </button>
      </div>

      <div className={styles.group} role="group" aria-label="جلسه و خروجی">
        <button type="button" className={styles.button} onClick={onNewSession}>
          جلسه جدید
        </button>
        <button type="button" className={styles.button} onClick={onExportJson}>
          خروجی JSON
        </button>
        <JsonImportControl onFileSelected={onImportJson} />
        <button type="button" className={styles.button} onClick={onExportPng}>
          خروجی PNG
        </button>
      </div>
    </div>
  )
}

export const DrawingToolbar = memo(DrawingToolbarComponent)
