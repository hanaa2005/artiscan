/**
 * The toolbar. Presentational only - every action is a callback from its owner.
 *
 * NO NO-OP CONTROLS.
 *
 * The session-level actions (new session, raw JSON import/export, PNG) are
 * OPTIONAL props, and each control renders only when its handler exists. The
 * trial flow simply omits them, instead of passing `() => undefined` and
 * leaving a button that looks live and silently does nothing. A visible,
 * enabled control must always do what it says.
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
  /** Atomic colour change. Used when no picker interaction is in progress. */
  onColorChange: (color: string) => void
  /** Opens a picker interaction. Optional: without it, changes stay atomic. */
  onColorInteractionBegin?: () => void
  /** Paints with a colour without recording it. */
  onColorPreview?: (color: string) => void
  /** Closes the interaction, recording at most one action. */
  onColorInteractionCommit?: () => void
  /** Atomic width change. Used when no slider interaction is in progress. */
  onWidthChange: (width: number) => void
  /** Opens a slider interaction. Optional: without it, changes stay atomic. */
  onWidthInteractionBegin?: () => void
  /** Paints with a width without recording it. */
  onWidthPreview?: (width: number) => void
  /** Closes the interaction, recording at most one action. */
  onWidthInteractionCommit?: () => void
  onUndo: () => void
  onRedo: () => void
  onClear: () => void
  /** Session-level actions. Each control appears only when its handler is given. */
  onNewSession?: () => void
  onExportJson?: () => void
  onImportJson?: (file: File) => void
  onExportPng?: () => void
}

function DrawingToolbarComponent({
  tool,
  color,
  width,
  canUndo,
  canRedo,
  onToolChange,
  onColorChange,
  onColorInteractionBegin,
  onColorPreview,
  onColorInteractionCommit,
  onWidthChange,
  onWidthInteractionBegin,
  onWidthPreview,
  onWidthInteractionCommit,
  onUndo,
  onRedo,
  onClear,
  onNewSession,
  onExportJson,
  onImportJson,
  onExportPng,
}: DrawingToolbarProps): React.JSX.Element {
  const hasSessionGroup =
    onNewSession !== undefined ||
    onExportJson !== undefined ||
    onImportJson !== undefined ||
    onExportPng !== undefined

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
          {/*
            The native picker streams `change` events while the user drags
            through it. Each one is a PREVIEW; the single committed action is
            recorded when the interaction ends - on pointerup, on blur, or when
            the user starts drawing. Commit is idempotent, so all three firing
            for one interaction still produces one action.

            When no interaction handlers are supplied the input falls back to
            atomic changes, which is what a keyboard-only or scripted caller
            gets.
          */}
          <input
            id="artiscan-color"
            type="color"
            className={styles.colorInput}
            value={color}
            onPointerDown={onColorInteractionBegin}
            onFocus={onColorInteractionBegin}
            onChange={(event) => {
              if (onColorPreview === undefined) {
                onColorChange(event.target.value)
                return
              }
              onColorInteractionBegin?.()
              onColorPreview(event.target.value)
            }}
            onPointerUp={onColorInteractionCommit}
            onBlur={onColorInteractionCommit}
          />
        </label>

        <label className={styles.field} htmlFor="artiscan-width">
          <span className={styles.fieldLabel}>ضخامت: {width}</span>
          {/*
            A range input fires `change` on every step the thumb crosses, so a
            single drag used to record a dozen width_change actions. Each one is
            a PREVIEW; the single committed action is recorded when the
            interaction ends - on pointerup, on blur, or when the user starts
            drawing. Commit is idempotent, so all of them firing for one
            interaction still produces one action.

            Keyboard use is covered by the same pair: focus opens the
            interaction, arrow keys preview, and blur (or the first stroke)
            commits the one action from the value the user started on to the
            value they settled on.

            When no interaction handlers are supplied the input falls back to
            atomic changes, which is what a scripted caller gets.
          */}
          <input
            id="artiscan-width"
            type="range"
            className={styles.rangeInput}
            min={WIDTH_MIN}
            max={WIDTH_MAX}
            step={1}
            value={width}
            onPointerDown={onWidthInteractionBegin}
            onFocus={onWidthInteractionBegin}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (onWidthPreview === undefined) {
                onWidthChange(next)
                return
              }
              onWidthInteractionBegin?.()
              onWidthPreview(next)
            }}
            onPointerUp={onWidthInteractionCommit}
            onBlur={onWidthInteractionCommit}
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

      {hasSessionGroup ? (
        <div className={styles.group} role="group" aria-label="جلسه و خروجی">
          {onNewSession === undefined ? null : (
            <button type="button" className={styles.button} onClick={onNewSession}>
              جلسه جدید
            </button>
          )}
          {onExportJson === undefined ? null : (
            <button type="button" className={styles.button} onClick={onExportJson}>
              خروجی JSON
            </button>
          )}
          {onImportJson === undefined ? null : (
            <JsonImportControl onFileSelected={onImportJson} />
          )}
          {onExportPng === undefined ? null : (
            <button type="button" className={styles.button} onClick={onExportPng}>
              خروجی PNG
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}

export const DrawingToolbar = memo(DrawingToolbarComponent)
