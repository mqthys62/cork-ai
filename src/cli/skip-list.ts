/**
 * Skip list — files cork-ai has learned not to compress, across sessions.
 *
 * The re-read whitelist used to live in the per-session reads file, so the
 * lesson died with the session: a file the model had to re-read in one session
 * was compressed again in the next, and the same round-trip was paid forever.
 * Measured re-read rate under that scheme was 54%, and a re-read is strictly
 * worse than not compressing — the file is sent twice, compressed then raw.
 *
 * This list is the memory. Once a file proves it needs its real content, it is
 * served raw from then on.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

const GLOBAL_DIR = process.env.CORK_AI_HOME ?? path.join(os.homedir(), '.cork-ai')
const SKIP_FILE = path.join(GLOBAL_DIR, 'skip-list.json')

/** Entries expire so a rewritten file gets another chance eventually. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Bounded so the file cannot grow without limit on a long-lived install. */
const MAX_ENTRIES = 5000

export type SkipReason = 're-read' | 'edit-failure'

interface SkipEntry {
  reason: SkipReason
  /** ISO timestamp of the most recent evidence. */
  at: string
  /** How many times this file has proved the point. */
  hits: number
}

interface SkipList {
  files: Record<string, SkipEntry>
}

function load(): SkipList {
  try {
    const parsed = JSON.parse(fs.readFileSync(SKIP_FILE, 'utf-8')) as SkipList
    return parsed && typeof parsed.files === 'object' ? parsed : { files: {} }
  } catch {
    return { files: {} }
  }
}

function save(list: SkipList): void {
  try {
    fs.mkdirSync(GLOBAL_DIR, { recursive: true })
    fs.writeFileSync(SKIP_FILE, JSON.stringify(list), 'utf-8')
  } catch { /* non-critical: the hook must never break a Read */ }
}

function isFresh(entry: SkipEntry, now: number): boolean {
  return now - new Date(entry.at).getTime() < MAX_AGE_MS
}

/** True when this file has previously proved it needs its real content. */
export function isSkipped(filePath: string): boolean {
  const entry = load().files[filePath]
  return entry !== undefined && isFresh(entry, Date.now())
}

/**
 * Records that compressing this file harmed the model, so future sessions
 * serve it raw. Repeated evidence refreshes the entry rather than duplicating.
 */
export function markSkipped(filePath: string, reason: SkipReason): void {
  const list = load()
  const existing = list.files[filePath]
  list.files[filePath] = {
    reason,
    at: new Date().toISOString(),
    hits: (existing?.hits ?? 0) + 1,
  }

  const now = Date.now()
  const entries = Object.entries(list.files).filter(([, e]) => isFresh(e, now))
  if (entries.length > MAX_ENTRIES) {
    // Drop the oldest evidence first — recent lessons are the useful ones.
    entries.sort((a, b) => new Date(b[1].at).getTime() - new Date(a[1].at).getTime())
    entries.length = MAX_ENTRIES
  }
  save({ files: Object.fromEntries(entries) })
}

/** Live entry count, for `cork-ai gain` to report what cork-ai has learned. */
export function skippedCount(): number {
  const now = Date.now()
  return Object.values(load().files).filter(e => isFresh(e, now)).length
}

export { SKIP_FILE }
