/**
 * Small UI preferences (last used tool, color, width).
 *
 * localStorage is appropriate HERE and only here: these are three tiny values,
 * they are not research data, and losing them is harmless. Raw drawing data
 * goes to IndexedDB instead - see drawingSessionRepository.ts.
 */

import type { DrawingTool } from '../types/drawing.types'

const STORAGE_KEY = 'artiscan:preferences'

export interface DrawingPreferences {
  tool: DrawingTool
  color: string
  width: number
}

export const DEFAULT_PREFERENCES: DrawingPreferences = {
  tool: 'pen',
  color: '#1f2933',
  width: 4,
}

/** Reads preferences, falling back to defaults on any problem. */
export function loadPreferences(): DrawingPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_PREFERENCES

    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFERENCES

    const record = parsed as Record<string, unknown>
    const tool = record['tool']
    const color = record['color']
    const width = record['width']

    return {
      tool: tool === 'pen' || tool === 'eraser' ? tool : DEFAULT_PREFERENCES.tool,
      color: typeof color === 'string' ? color : DEFAULT_PREFERENCES.color,
      width:
        typeof width === 'number' && Number.isFinite(width) && width > 0
          ? width
          : DEFAULT_PREFERENCES.width,
    }
  } catch {
    // Private browsing modes can make localStorage throw on read.
    return DEFAULT_PREFERENCES
  }
}

/** Persists preferences, silently ignoring quota or privacy-mode failures. */
export function savePreferences(preferences: DrawingPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Preferences are a convenience; failing to store them must never break the app.
  }
}
