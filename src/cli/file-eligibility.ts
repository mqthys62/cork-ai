/**
 * File eligibility — decides whether the Read hook may touch a file at all.
 *
 * This module exists because the hook used to compress anything it could read.
 * `fs.readFileSync(png, 'utf-8')` does not throw: it returns mojibake. A 3.5 MB
 * PNG came back as ~12,700 "lines" of binary garbage, got truncated to a head
 * and a tail, and was handed to the model in place of the image — silently
 * removing Claude's vision on every image read, while booking ~1M tokens of
 * "savings" for content the API would have billed at roughly 1,600 vision
 * tokens. Guessing wrong here is far more expensive than compressing nothing,
 * so the rule is now allowlist-first: if we don't know how to compress it, we
 * leave it alone.
 */

import path from 'path'

/** Handled by `extractCodeSignatures` — structure survives compression. */
export const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.rb', '.php', '.swift', '.kt', '.scala', '.r',
  // Added after measuring a 70% re-read rate on .luau: unlisted code languages
  // fell through to the head/tail text path, which destroys the middle of the
  // file and forces the model to re-read it whole.
  '.luau', '.lua', '.vue', '.svelte', '.dart', '.ex', '.exs', '.zig', '.sql',
])

/**
 * Prose and markup, where dropping the middle is survivable.
 *
 * Measured re-read rates: .md 15%, .css/.scss 25%, .html 38%. Anything not
 * listed here is skipped rather than guessed at.
 */
export const TEXT_EXTS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.adoc',
  '.html', '.htm', '.xml', '.svg',
  '.css', '.scss', '.sass', '.less',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.csv', '.tsv', '.log',
])

/**
 * Never intercept: Claude Code reads these for vision or as opaque blobs, and
 * a compressed view is not a degraded version of them — it is nonsense.
 */
export const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico', '.avif', '.heic',
  '.pdf',
  '.zip', '.gz', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi', '.flac',
  '.so', '.dll', '.dylib', '.exe', '.bin', '.wasm', '.class', '.o', '.a',
  '.db', '.sqlite', '.sqlite3',
  '.pyc', '.pyo', '.jar', '.node',
])

/** Bytes inspected for the content sniff — enough to catch any real binary. */
const SNIFF_BYTES = 8192

/**
 * Content-based binary detection, for files whose extension tells us nothing.
 *
 * A NUL byte is the classic tell (no text encoding we care about emits one),
 * and a high share of C0 control characters catches the rest. Both are checked
 * over a prefix, so a huge file costs nothing to classify.
 */
export function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, SNIFF_BYTES)
  if (end === 0) return false

  let control = 0
  for (let i = 0; i < end; i++) {
    const byte = buf[i]
    if (byte === 0) return true
    // C0 controls except tab (9), LF (10), CR (13), and form feed (12).
    if (byte < 9 || byte === 11 || (byte > 13 && byte < 32)) control++
  }
  return control / end > 0.02
}

export type CompressionKind = 'code' | 'json' | 'text'

export type Eligibility =
  | { compress: false; reason: string }
  | { compress: true; kind: CompressionKind }

/**
 * Whether the hook may compress this file, and how.
 *
 * @param buf - Raw bytes. Read as a Buffer, never as a utf-8 string: the
 *   string form of a binary file is lossy mojibake that passes every check.
 */
export function eligibility(filePath: string, buf: Buffer): Eligibility {
  const ext = path.extname(filePath).toLowerCase()

  if (BINARY_EXTS.has(ext)) return { compress: false, reason: `binary type (${ext})` }
  if (looksBinary(buf)) return { compress: false, reason: 'binary content' }

  if (CODE_EXTS.has(ext)) return { compress: true, kind: 'code' }
  if (ext === '.json' || ext === '.jsonc') return { compress: true, kind: 'json' }
  if (TEXT_EXTS.has(ext)) return { compress: true, kind: 'text' }

  // Unknown extension. The old behaviour was to head/tail-truncate anyway;
  // that is what produced the worst re-read rates, so abstain instead.
  return { compress: false, reason: `unknown type (${ext || 'no extension'})` }
}
