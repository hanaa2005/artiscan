/**
 * Reading a session file, compressed or not.
 *
 * WHY SNIFF INSTEAD OF TRUSTING THE NAME
 *
 * A file's extension is a label the operating system lets anyone change, and
 * browsers, chat clients and cloud drives all rename downloads. So the decision
 * is made on the first three bytes - gzip's magic number - and never on
 * `.json.gz`. A file called `session.json` that is really gzip opens correctly;
 * a file called `session.json.gz` that is really plain JSON does too.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not validate. It hands back TEXT, and the existing validator decides
 * whether that text is a session. Compression is a transport encoding: it
 * changes how the bytes travel, never what they mean, so it must not have an
 * opinion about the schema.
 */

import type { ParseResult } from '../types/drawing.types'
import { gunzipToText, looksLikeGzip } from '../../artifacts/services/gzipCodec'

/** How a file turned out to be encoded, so the UI can say which path it took. */
export type SessionFileEncoding = 'plain' | 'gzip'

export interface SessionFileContent {
  text: string
  encoding: SessionFileEncoding
  /** Bytes on disk. Reported so a compressed import can show what it saved. */
  byteLength: number
}

/** Reads a File into bytes, as a ParseResult rather than a throw. */
async function readBytes(file: File): Promise<ParseResult<Uint8Array<ArrayBuffer>>> {
  try {
    return { ok: true, value: new Uint8Array(await file.arrayBuffer()) }
  } catch {
    return { ok: false, error: 'خواندن فایل ناموفق بود.' }
  }
}

/**
 * Reads a session file and returns its text.
 *
 * Both encodings end at the same place - a UTF-8 string - so every caller
 * downstream stays identical whether the file was compressed or not.
 */
export async function readSessionFile(file: File): Promise<ParseResult<SessionFileContent>> {
  const bytes = await readBytes(file)
  if (!bytes.ok) return bytes

  if (bytes.value.length === 0) {
    return { ok: false, error: 'فایل خالی است.' }
  }

  if (!looksLikeGzip(bytes.value)) {
    /*
      Decoded as UTF-8 with a BOM stripped. Some editors and export tools on
      Windows write one, and JSON.parse rejects a leading U+FEFF - which would
      surface to the user as "the file is invalid" for a file that is fine.
    */
    const text = new TextDecoder('utf-8').decode(bytes.value).replace(/^﻿/, '')
    return {
      ok: true,
      value: { text, encoding: 'plain', byteLength: bytes.value.length },
    }
  }

  const unzipped = await gunzipToText(bytes.value)
  if (!unzipped.ok) return unzipped

  return {
    ok: true,
    value: {
      text: unzipped.value.replace(/^﻿/, ''),
      encoding: 'gzip',
      byteLength: bytes.value.length,
    },
  }
}
