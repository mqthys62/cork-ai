/**
 * The spool: events wait on disk, and leave in one batch.
 *
 * Before this, every event spawned its own detached cork-ai — an 81 MB binary,
 * ~28 MB of RSS and one TLS handshake each. `hook_read` fires once per file
 * read, and Claude Code runs parallel tool calls concurrently, so a burst of 30
 * reads meant up to 60 live processes and 30 handshakes. Fine for eight
 * installs; not fine for a few thousand.
 *
 * So events are appended here instead, and drained together at the moments a
 * session naturally pauses (Stop, SessionEnd) or when the spool grows past
 * FLUSH_AT. PostHog's /capture/ takes `{ api_key, batch: [...] }` — the same
 * endpoint, the same key, already used by scripts/adoption.mjs.
 *
 * Three properties matter more than throughput here:
 *
 *   - Losing an event must never break a read. Every failure path swallows.
 *   - The spool must not grow without bound when someone is offline for a week.
 *   - Concurrent hooks must not lose each other's writes — the same defect
 *     policy.ts measured (69% of increments vanished under six processes).
 */

import fs from 'fs'
import path from 'path'

import { CORK_HOME } from './config.js'
import { writeFileAtomic } from './fs-utils.js'

export const SPOOL_FILE = path.join(CORK_HOME, 'telemetry-spool.json')
const LOCK_FILE = SPOOL_FILE + '.lock'

/** Long enough for a slow read-modify-write, short enough that a crashed hook frees it fast. */
const LOCK_STALE_MS = 2_000

/**
 * Drain once the spool reaches this many events, even mid-session. A long
 * session that never stops would otherwise hold everything until it ends.
 */
export const FLUSH_AT = 25

/**
 * Hard ceiling. Past this the oldest events are dropped rather than let a
 * week offline turn into an unbounded file. PostHog's own batch limit is well
 * above this, so a full spool still leaves in one request.
 */
export const SPOOL_MAX = 500

/**
 * Events older than this are dropped unsent. A fortnight-old `hook_read` tells
 * nobody anything, and sending it would date the machine's downtime.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface SpooledEvent {
  event: string
  distinct_id?: string
  properties?: Record<string, unknown>
  timestamp?: string
  $set?: Record<string, unknown>
  $set_once?: Record<string, unknown>
}

/**
 * Runs `fn` with exclusive access to the spool.
 *
 * Same shape as policy.ts's lock, and for the same measured reason: parallel
 * hooks share this file, and a plain load-modify-save loses whatever landed
 * between the read and the write. `mkdir` is atomic on every platform we
 * target. Acquisition is bounded and best-effort — if the lock cannot be taken
 * we run anyway rather than drop the event, because a rare duplicate or lost
 * append beats a hook that stalls a read.
 */
function withSpoolLock<T>(fn: () => T): T {
  let held = false
  const deadline = Date.now() + LOCK_STALE_MS
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCK_FILE)
      held = true
      break
    } catch {
      try {
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(LOCK_FILE)
          continue
        }
      } catch { /* vanished between statSync and now: retry */ }
      const spin = Date.now() + 2
      while (Date.now() < spin) { /* busy wait — these sections are sub-millisecond */ }
    }
  }
  try {
    return fn()
  } finally {
    if (held) { try { fs.rmdirSync(LOCK_FILE) } catch { /* already gone */ } }
  }
}

/** Whatever is on disk, or an empty spool. Never throws. */
export function readSpool(): SpooledEvent[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(SPOOL_FILE, 'utf-8'))
    return Array.isArray(raw) ? (raw as SpooledEvent[]) : []
  } catch { return [] }
}

function writeSpool(events: SpooledEvent[]): void {
  try {
    if (events.length === 0) { try { fs.unlinkSync(SPOOL_FILE) } catch { /* already gone */ } ; return }
    fs.mkdirSync(CORK_HOME, { recursive: true })
    writeFileAtomic(SPOOL_FILE, JSON.stringify(events))
  } catch { /* a spool we cannot write is a spool we do without */ }
}

/** Drops what is too old to mean anything, then the oldest above the ceiling. */
function prune(events: SpooledEvent[], now = Date.now()): SpooledEvent[] {
  const fresh = events.filter(e => {
    if (!e.timestamp) return true
    const at = new Date(e.timestamp).getTime()
    return !Number.isFinite(at) || now - at < MAX_AGE_MS
  })
  return fresh.length > SPOOL_MAX ? fresh.slice(fresh.length - SPOOL_MAX) : fresh
}

/**
 * Appends one event. Returns true when the spool has reached FLUSH_AT and the
 * caller should drain it.
 */
export function spool(event: SpooledEvent): boolean {
  return withSpoolLock(() => {
    const events = prune([...readSpool(), event])
    writeSpool(events)
    return events.length >= FLUSH_AT
  })
}

/**
 * Takes everything out of the spool, atomically, and hands it to the caller.
 *
 * Take-then-send, not send-then-clear: if the sender dies mid-flight we lose
 * that batch rather than send it twice. Duplicated events would inflate every
 * count in the dashboard, and a count that overstates the tool's own activity
 * is worse than a count that misses a few.
 */
export function takeSpool(): SpooledEvent[] {
  return withSpoolLock(() => {
    const events = prune(readSpool())
    writeSpool([])
    return events
  })
}

/** How many events are waiting. For `doctor`, and for tests. */
export function spoolSize(): number {
  return readSpool().length
}
