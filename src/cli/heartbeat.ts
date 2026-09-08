/**
 * Heartbeat — proof that Claude Code is still calling the hook.
 *
 * Written on every hook event, at most once a minute per session. `gain` and
 * `doctor` compare it with the transcripts: sessions that ran without a
 * heartbeat mean the hook is no longer being called — the failure mode that
 * stayed invisible for weeks when auto mode moved reads to Bash.
 */

import fs from 'fs'
import path from 'path'
import { CORK_HOME } from './config.js'
import { VERSION } from './version.js'
import { writeFileAtomic, debugLog } from './fs-utils.js'

export const HEARTBEAT_FILE = path.join(CORK_HOME, 'heartbeat.json')

export interface Heartbeat {
  at: string
  sessionId: string
  event: string
  toolName?: string
  permissionMode?: string
  claudeVersion?: string
  corkVersion: string
}

export function readHeartbeat(): Heartbeat | undefined {
  try { return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf-8')) as Heartbeat } catch { return undefined }
}

/** Claude Code stamps every transcript line with its own `version`. */
export function claudeVersionFromTranscript(transcriptPath?: string): string | undefined {
  if (!transcriptPath) return undefined
  try {
    const stat = fs.statSync(transcriptPath)
    const start = Math.max(0, stat.size - 64 * 1024)
    const fd = fs.openSync(transcriptPath, 'r')
    const buf = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    const m = /"version":"(\d+\.\d+\.\d+)"/.exec(buf.toString('utf-8'))
    return m?.[1]
  } catch {
    return undefined
  }
}

export function writeHeartbeat(event: Record<string, unknown>, now: Date = new Date()): Heartbeat | undefined {
  try {
    const sessionId = (event.session_id as string) || ''
    const prev = readHeartbeat()
    if (prev && prev.sessionId === sessionId && now.getTime() - new Date(prev.at).getTime() < 60_000) return prev
    const beat: Heartbeat = {
      at: now.toISOString(),
      sessionId,
      event: (event.hook_event_name as string) ?? '',
      toolName: event.tool_name as string | undefined,
      permissionMode: event.permission_mode as string | undefined,
      claudeVersion: claudeVersionFromTranscript(event.transcript_path as string | undefined) ?? prev?.claudeVersion,
      corkVersion: VERSION,
    }
    fs.mkdirSync(CORK_HOME, { recursive: true })
    writeFileAtomic(HEARTBEAT_FILE, JSON.stringify(beat))
    return beat
  } catch (err) {
    debugLog('heartbeat.write', err)
    return undefined
  }
}

// ─── Sessions seen (first hook event of a session) ───────────────────────────

export const SESSIONS_SEEN_FILE = path.join(CORK_HOME, 'sessions-seen.json')

/** Keep a week of ids: enough to survive a long-lived `--resume`, small enough to read on every event. */
const SESSIONS_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function readSessionsSeen(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSIONS_SEEN_FILE, 'utf-8')) as Record<string, string>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/**
 * Records that a session produced a hook event. Returns the moment it was
 * first seen, and whether this call was the first — the `session_start` signal
 * that a SessionEnd can never replace (Claude Code killed or crashed never
 * fires one).
 */
export function noteSessionSeen(sessionId: string, now: Date = new Date()): { first: boolean; startedAt: string } {
  if (!sessionId) return { first: false, startedAt: now.toISOString() }
  const seen = readSessionsSeen()
  const existing = seen[sessionId]
  if (existing) return { first: false, startedAt: existing }
  const startedAt = now.toISOString()
  seen[sessionId] = startedAt
  try {
    const cutoff = now.getTime() - SESSIONS_SEEN_TTL_MS
    for (const [id, at] of Object.entries(seen)) if (new Date(at).getTime() < cutoff) delete seen[id]
    fs.mkdirSync(CORK_HOME, { recursive: true })
    writeFileAtomic(SESSIONS_SEEN_FILE, JSON.stringify(seen))
  } catch (err) { debugLog('heartbeat.sessionsSeen', err) }
  return { first: true, startedAt }
}
