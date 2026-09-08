/**
 * Session digests — one JSON per finished session, written by the SessionEnd
 * hook: what the session cost, how big its context got, what cork-ai did in
 * it. `cork-ai gain` shows the last one, `gain --sessions` the last N.
 *
 * Kept 30 days, like Claude Code keeps its transcripts (`cleanupPeriodDays`).
 */

import fs from 'fs'
import path from 'path'
import { CORK_HOME } from './config.js'
import { writeFileAtomic, debugLog } from './fs-utils.js'

export const DIGEST_DIR = path.join(CORK_HOME, 'digests')
export const DIGEST_MAX_AGE_DAYS = 30

export interface SessionDigest {
  sessionId: string
  endedAt: string
  /** ISO time of the first hook event of the session, when known. */
  startedAt?: string
  durationMin?: number
  /** Project directory name (local file only — never sent). */
  project?: string
  reason?: string
  model?: string
  permissionMode?: string
  turns: number
  avgContextTokens: number
  maxContextTokens: number
  costUSD: number
  /** What the same session would have cost with auto-compaction at 200k. */
  cappedCost200kUSD: number
  compactions: number
  /** Outlines served / full re-reads / edit failures, from the live session record. */
  compressions: number
  reReads: number
  editFailures: number
  savedTokens: number
  guardBands: number[]
}

function digestFile(sessionId: string, dir = DIGEST_DIR): string {
  return path.join(dir, `${sessionId.replace(/[^\w.-]/g, '_').slice(0, 80)}.json`)
}

export function writeDigest(digest: SessionDigest, now: Date = new Date(), dir = DIGEST_DIR): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    writeFileAtomic(digestFile(digest.sessionId, dir), JSON.stringify(digest, null, 2))
  } catch (err) { debugLog('digests.write', err) }
  pruneDigests(now, dir)
}

/** Drops digests older than DIGEST_MAX_AGE_DAYS. Best effort. */
export function pruneDigests(now: Date = new Date(), dir = DIGEST_DIR): number {
  const cutoff = now.getTime() - DIGEST_MAX_AGE_DAYS * 86_400_000
  let removed = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const file = path.join(dir, f)
      let endedAt: number | undefined
      try { endedAt = new Date((JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionDigest).endedAt).getTime() } catch { /* unreadable: judge by mtime */ }
      if (endedAt === undefined || Number.isNaN(endedAt)) { try { endedAt = fs.statSync(file).mtimeMs } catch { continue } }
      if (endedAt < cutoff) { try { fs.unlinkSync(file); removed++ } catch { /* next */ } }
    }
  } catch { /* no directory yet */ }
  return removed
}

/** All digests, most recent first. */
export function listDigests(dir = DIGEST_DIR): SessionDigest[] {
  const out: SessionDigest[] = []
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as SessionDigest
        if (d && typeof d.sessionId === 'string' && typeof d.endedAt === 'string') out.push(d)
      } catch { /* skip */ }
    }
  } catch { /* none */ }
  return out.sort((a, b) => b.endedAt.localeCompare(a.endedAt))
}

export function latestDigest(dir = DIGEST_DIR): SessionDigest | undefined {
  return listDigests(dir)[0]
}
