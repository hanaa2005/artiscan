/**
 * Turning a session into text and back again.
 *
 * Kept separate from the validator so the two concerns stay testable in
 * isolation: this file knows about JSON text, the validator knows about shape.
 */

import type { DrawingSession, ParseResult } from '../types/drawing.types'
import { validateSession } from './drawingValidator'

/** Serializes a session to pretty-printed, human-readable JSON. */
export function serializeSession(session: DrawingSession): string {
  return JSON.stringify(session, null, 2)
}

/**
 * Parses JSON text into a validated session.
 *
 * JSON.parse throws on malformed text, so it is wrapped: a truncated or
 * non-JSON file must produce a friendly message, never an unhandled exception.
 */
export function deserializeSession(text: string): ParseResult<DrawingSession> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ok: false,
      error: 'فایل انتخاب‌شده یک JSON معتبر نیست و قابل خواندن نبود.',
    }
  }
  return validateSession(parsed)
}

/** Builds the download file name, e.g. `artiscan-session-a1b2c3d4-2026-08-09.json`. */
export function buildSessionFileName(session: DrawingSession, dateStamp: string): string {
  const shortId = session.id.slice(0, 8)
  return `artiscan-session-${shortId}-${dateStamp}.json`
}
