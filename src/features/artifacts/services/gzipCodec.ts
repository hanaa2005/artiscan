/**
 * Gzip for the canonical session - LOSSLESS, and nothing else.
 *
 * WHAT THIS IS
 *
 * A second encoding of exactly the bytes `serializeSession()` already produces.
 * Decompressing gives back that string character for character, so the gzipped
 * file is canonical-equivalent: it is the raw session, stored smaller. No point
 * is dropped, no array is reordered, no float is rounded, no field is renamed.
 *
 * WHY THAT MATTERS ENOUGH TO SAY TWICE
 *
 * Everything else added in week 1C - the critical trajectory, the graph, the
 * mask - is explicitly LOSSY and derived. This one is not, and the distinction
 * is the whole point of the artifact policy. A gzip that quietly re-serialized
 * the session (re-ordering keys, re-rounding numbers) would look lossless while
 * silently producing a different file, so the codec works on the STRING and
 * never on the object.
 *
 * NO DEPENDENCY
 *
 * CompressionStream and DecompressionStream are part of the platform in every
 * current browser and in Node 18+. Adding a gzip library would mean shipping
 * tens of kilobytes to duplicate something already present, so instead the
 * capability is detected and the feature is offered only when it exists.
 */

import type { ParseResult } from '../../drawing/types/drawing.types'

/** Gzip's magic number and deflate method byte: 1f 8b 08. */
const GZIP_MAGIC = [0x1f, 0x8b, 0x08] as const

/**
 * True when this runtime can gzip.
 *
 * Checked rather than assumed: without it the export button would be offered
 * and then fail at the moment the user clicked it.
 */
export function isCompressionSupported(): boolean {
  try {
    return (
      typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
    )
  } catch {
    return false
  }
}

/**
 * Pushes `input` through a transform stream and collects the result.
 *
 * The bytes are written straight into the stream rather than wrapped in a Blob:
 * Blob.stream() is missing in jsdom, so a Blob-based implementation could not
 * be tested at all - and an untestable compression path is exactly the kind of
 * thing that silently breaks the lossless guarantee.
 *
 * The write is deliberately NOT awaited before reading starts. A large session
 * exceeds the stream's internal buffer, and awaiting the write first would
 * deadlock: the writer waits for backpressure to clear while nothing is
 * draining the readable end.
 */
async function pumpThrough(
  // BufferSource, matching what a stream writer accepts, so neither caller has
  // to copy its bytes just to satisfy the narrower Uint8Array generic.
  input: BufferSource,
  // The writable side is typed WritableStream<BufferSource> by the platform
  // definitions, which a Uint8Array satisfies.
  transform: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = transform.writable.getWriter()

  /*
    When the data is corrupt BOTH ends fail: the readable rejects with the
    decode error and the writable rejects too. The write rejection must have a
    handler attached from the outset, or it surfaces as an unhandled promise
    rejection - a crash in strict environments, and noise everywhere else. The
    error is captured rather than swallowed, and re-thrown below only when the
    read side did not already report a better one.
  */
  let writeError: unknown = null
  const written = (async () => {
    await writer.write(input)
    await writer.close()
  })().catch((error: unknown) => {
    writeError = error
  })

  const output = await readAllBytes(transform.readable)
  await written
  if (writeError !== null) throw writeError
  return output
}

/** Reads a whole stream into one contiguous byte array. */
async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      chunks.push(value)
      total += value.length
    }
  }

  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

/**
 * Compresses UTF-8 text to gzip bytes.
 *
 * The text is encoded as UTF-8 first, so Persian metadata and any other
 * non-ASCII content round-trips exactly.
 */
export async function gzipText(text: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!isCompressionSupported()) {
    throw new Error('فشرده‌سازی در این مرورگر پشتیبانی نمی‌شود.')
  }

  const input = new TextEncoder().encode(text)
  return pumpThrough(input, new CompressionStream('gzip'))
}

/** True when the bytes begin with a gzip header. */
export function looksLikeGzip(bytes: Uint8Array): boolean {
  if (bytes.length < GZIP_MAGIC.length) return false
  return GZIP_MAGIC.every((byte, index) => bytes[index] === byte)
}

/**
 * Decompresses gzip bytes back to text.
 *
 * Returns a ParseResult rather than throwing: every caller is a user action
 * that must end in a Persian message rather than an unhandled rejection. The
 * three failure modes the user can actually produce - the wrong file, a
 * truncated download, a corrupted byte - are reported distinctly, because
 * "the file is not gzip" and "the file is gzip but incomplete" call for
 * different responses from the user.
 */
export async function gunzipToText(
  // Narrowed to an ArrayBuffer-backed view: a SharedArrayBuffer cannot be
  // handed to a stream writer, and no caller here produces one.
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ParseResult<string>> {
  if (!isCompressionSupported()) {
    return { ok: false, error: 'باز کردن فایل فشرده در این مرورگر پشتیبانی نمی‌شود.' }
  }
  if (bytes.length === 0) {
    return { ok: false, error: 'فایل خالی است.' }
  }
  if (!looksLikeGzip(bytes)) {
    return {
      ok: false,
      error: 'این فایل یک فایل gzip معتبر نیست؛ لطفاً فایل با پسوند .json.gz را انتخاب کنید.',
    }
  }

  try {
    const output = await pumpThrough(bytes, new DecompressionStream('gzip'))
    return { ok: true, value: new TextDecoder().decode(output) }
  } catch {
    /*
      The header was right but the body did not decode. In practice this is a
      truncated or corrupted file - the distinction the header check above
      cannot make - so the message points at that rather than at the format.
    */
    return {
      ok: false,
      error: 'فایل فشرده ناقص یا خراب است و باز نشد؛ لطفاً فایل سالم را دوباره تهیه کنید.',
    }
  }
}

/** The filename for a compressed raw session. */
export function buildGzipFileName(sessionId: string, stamp: string): string {
  return `artiscan-raw-session-${sessionId.slice(0, 8)}-${stamp}.json.gz`
}
