/**
 * Small file helpers shared by the hook and the CLI.
 *
 * Every state file cork-ai keeps (heartbeat, session reads, policy, config,
 * caches) is written by short-lived processes that can overlap: Claude Code
 * fires several hook events at once for parallel tool calls, and a subagent
 * can be reading while the main conversation writes. A plain writeFileSync
 * truncates then writes, so a concurrent reader can see an empty or half
 * file. Writing to a temp file and renaming it is atomic on POSIX and on
 * Windows (MoveFileEx with replace) — readers see the old or the new file,
 * never a mix.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

export function writeFileAtomic(file: string, data: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    fs.writeFileSync(tmp, data, 'utf-8')
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* already gone */ }
    throw err
  }
}

// ─── Debug log ───────────────────────────────────────────────────────────────

/**
 * The hook swallows every error by design (a read must never fail because of
 * cork-ai). `CORK_AI_DEBUG=1` writes them to ~/.cork-ai/debug.log instead of
 * nowhere, one line per error, so a silent failure can be diagnosed.
 */
const CORK_HOME = process.env.CORK_AI_HOME ?? path.join(os.homedir(), '.cork-ai')
export const DEBUG_LOG_FILE = path.join(CORK_HOME, 'debug.log')
const DEBUG_LOG_MAX_BYTES = 1024 * 1024

export function debugEnabled(): boolean {
  const v = process.env.CORK_AI_DEBUG
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

function writeDebug(record: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...record }) + '\n'
    fs.mkdirSync(CORK_HOME, { recursive: true })
    try { if (fs.statSync(DEBUG_LOG_FILE).size > DEBUG_LOG_MAX_BYTES) fs.renameSync(DEBUG_LOG_FILE, DEBUG_LOG_FILE + '.1') } catch { /* no log yet */ }
    fs.appendFileSync(DEBUG_LOG_FILE, line, 'utf-8')
  } catch { /* debugging must not fail either */ }
}

/** An error that was swallowed. */
export function debugLog(where: string, err: unknown, extra?: Record<string, unknown>): void {
  if (!debugEnabled()) return
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  writeDebug({ where, error: message, ...(extra ?? {}) })
}

/** A step that went fine — one line per hook event, to see the hook is alive and what it decided. */
export function debugTrace(where: string, extra?: Record<string, unknown>): void {
  if (!debugEnabled()) return
  writeDebug({ where, ...(extra ?? {}) })
}
