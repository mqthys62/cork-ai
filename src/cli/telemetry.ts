/**
 * Telemetry — anonymous, opt-in, and off by default.
 *
 * Events go to PostHog Cloud EU (`eu.i.posthog.com`). The project token is a
 * write-only key designed to be embedded in clients; it cannot read anything.
 * There is no server of our own to run — the previous PHP endpoint never
 * worked reliably and this replaces it.
 *
 * What is sent is listed in docs/TELEMETRY.md and enforced by the event
 * builders below: version, OS, model family, token *buckets*, decisions and
 * their reasons. Never a path, a file name, a project name, prompt text or
 * file content. The `distinct_id` is a random UUID minted locally when the
 * user opts in — not a machine id.
 *
 * Sending never blocks a hook: the event is handed to a detached child
 * process (`cork-ai __send-telemetry`) that does the HTTP call and exits.
 */

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { installId, isTelemetryEnabled, loadConfig } from './config.js'
import { readHeartbeat } from './heartbeat.js'
import { spool, takeSpool, type SpooledEvent } from './telemetry-spool.js'
import { VERSION } from './version.js'

export const POSTHOG_HOST = 'https://eu.i.posthog.com'
export const POSTHOG_PROJECT_TOKEN = 'phc_u5LpaZ4J9TNdPbZU3UF3Jh5Egn3BTFxcBxtX9FNJ7ove'

export type TelemetryEventName =
  | 'install'
  | 'uninstall'
  | 'telemetry_toggled'
  | 'command'
  | 'session_start'
  | 'hook_read'
  | 'hook_reread'
  | 'guard_notice'
  | 'session_digest'
  | 'savings_snapshot'
  | 'hook_error'
  | 'doctor'

export type TelemetryValue = string | number | boolean | null | undefined

export interface TelemetryEvent {
  event: TelemetryEventName
  properties: Record<string, TelemetryValue>
  /** Person properties (`$set`): the install's current state, overwritten each time. */
  set?: Record<string, TelemetryValue>
  /** Person properties written once (`$set_once`): first version, first seen. */
  setOnce?: Record<string, TelemetryValue>
}

/** Rounds a token count to a coarse bucket so no value can identify a file. */
export function tokenBucket(tokens: number): string {
  if (tokens < 500) return '<500'
  if (tokens < 1_500) return '500-1.5k'
  if (tokens < 3_000) return '1.5k-3k'
  if (tokens < 6_000) return '3k-6k'
  if (tokens < 15_000) return '6k-15k'
  return '>15k'
}

/** Context size bucket, in the same bands the guard uses. */
export function contextBucket(tokens: number): string {
  if (tokens < 50_000) return '<50k'
  if (tokens < 150_000) return '50k-150k'
  if (tokens < 300_000) return '150k-300k'
  if (tokens < 500_000) return '300k-500k'
  if (tokens < 750_000) return '500k-750k'
  return '>750k'
}

/** USD bucket for a session's spend. */
export function costBucket(usd: number): string {
  if (usd < 1) return '<$1'
  if (usd < 5) return '$1-5'
  if (usd < 20) return '$5-20'
  if (usd < 100) return '$20-100'
  return '>$100'
}

/** `claude-opus-5` → `opus-5`; unknown → `other`. Never the raw string. */
export function modelFamily(model?: string): string {
  if (!model) return 'unknown'
  const m = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+(?:-\d+)?)/i.exec(model)
  return m ? `${m[1].toLowerCase()}-${m[2]}` : 'other'
}

/**
 * Whether Claude Code's managed settings file exists — the file an IT team
 * deploys to every workstation. Its presence (never its content) is the one
 * signal that an install sits inside a company-managed Claude Code.
 */
export function managedSettingsPresent(): boolean {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')]
    : process.platform === 'darwin'
      ? ['/Library/Application Support/ClaudeCode/managed-settings.json']
      : ['/etc/claude-code/managed-settings.json']
  return candidates.some(f => { try { return fs.statSync(f).isFile() } catch { return false } })
}

/** How the binary got here, from a fixed list — the installers set `CORK_AI_INSTALLER`. */
export function installChannel(): 'sh' | 'ps1' | 'manual' {
  const v = process.env.CORK_AI_INSTALLER
  return v === 'sh' || v === 'ps1' ? v : 'manual'
}

/**
 * The class of an error and nothing else: `TypeError`, `SyntaxError`, plus
 * Node's `code` (`ENOENT`, `EACCES`) when there is one. Never the message —
 * a message can quote a path.
 */
export function errorClass(err: unknown): { error: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return { error: err.name || 'Error', code: typeof code === 'string' ? code.slice(0, 24) : undefined }
  }
  return { error: typeof err }
}

/** `bun-1` for the standalone binary, `node-22` from npm. */
export function runtimeLabel(): string {
  return process.versions.bun ? `bun-${process.versions.bun.split('.')[0]}` : `node-${process.versions.node.split('.')[0]}`
}

/** Properties every event carries. */
export function baseProperties(): Record<string, string | undefined> {
  return {
    $lib: 'cork-ai',
    $lib_version: VERSION,
    version: VERSION,
    os: process.platform,
    arch: process.arch,
    runtime: runtimeLabel(),
    // Claude Code stamps its version on every transcript line; the heartbeat keeps the last one seen.
    claude_version: readHeartbeat()?.claudeVersion,
  }
}

/**
 * Person properties every event refreshes: what an install looks like *now*.
 * PostHog keeps one profile per `distinct_id`, so the Persons table becomes
 * the list of installs with their version, OS and setup — no query needed.
 */
export function personProperties(): { set: Record<string, TelemetryValue>; setOnce: Record<string, TelemetryValue> } {
  const cfg = loadConfig()
  return {
    set: {
      version: VERSION,
      os: process.platform,
      arch: process.arch,
      runtime: runtimeLabel(),
      claude_version: readHeartbeat()?.claudeVersion ?? null,
      telemetry: cfg.telemetry === true,
      context_guard: cfg.contextGuard?.enabled !== false,
      managed_settings: managedSettingsPresent(),
    },
    setOnce: { first_version: VERSION, first_seen: new Date().toISOString() },
  }
}

/** The JSON body PostHog's /capture endpoint expects. */
export function capturePayload(e: TelemetryEvent, distinctId: string, timestamp: Date = new Date()): Record<string, unknown> {
  const person = personProperties()
  const properties: Record<string, unknown> = {
    ...baseProperties(),
    ...e.properties,
    $set: { ...person.set, ...(e.set ?? {}) },
    $set_once: { ...person.setOnce, ...(e.setOnce ?? {}) },
  }
  for (const key of Object.keys(properties)) if (properties[key] === undefined) delete properties[key]
  for (const bag of ['$set', '$set_once'] as const) {
    const obj = properties[bag] as Record<string, unknown>
    for (const key of Object.keys(obj)) if (obj[key] === undefined) delete obj[key]
  }
  return { api_key: POSTHOG_PROJECT_TOKEN, event: e.event, distinct_id: distinctId, properties, timestamp: timestamp.toISOString() }
}

/** Performs the HTTP call. Used by the detached child; exported for tests. */
export async function postCapture(body: Record<string, unknown>, host = POSTHOG_HOST, timeoutMs = 4_000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Queues an event without waiting. No-op unless telemetry is on.
 *
 * The child is the cork-ai executable itself: in the compiled binary
 * `process.execPath` *is* cork-ai; under node it is node plus our script.
 * (The old implementation spawned `node -e …` — which, inside the bun-compiled
 * binary, ran `cork-ai -e …` and silently sent nothing.)
 */
export function sendTelemetry(e: TelemetryEvent): void {
  if (!isTelemetryEnabled()) return
  try {
    const payload = capturePayload(e, installId())
    // High-frequency events wait in the spool and leave together. One read used
    // to mean one 81 MB process and one TLS handshake; a burst of thirty
    // parallel reads meant thirty of each. The rare events keep going out
    // immediately — waiting would cost more than it saves, and `uninstall` in
    // particular has to leave before the person stops running cork-ai at all.
    if (SPOOLED_EVENTS.has(e.event)) {
      if (spool(payload as unknown as SpooledEvent)) flushTelemetryDetached()
      return
    }
    sendOneDetached(payload)
  } catch { /* never blocks execution */ }
}

/**
 * The events that go through the spool: the ones tied to a file read, which
 * arrive in bursts and dominate the volume. Everything else — install,
 * uninstall, doctor, a CLI command — is rare enough to send on the spot.
 */
const SPOOLED_EVENTS = new Set<TelemetryEventName>(['hook_read', 'hook_reread', 'guard_notice', 'session_start'])

/** One event, one detached child. The path the rare events still take. */
function sendOneDetached(payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload)
  const compiled = !/\b(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))
  const args = compiled ? ['__send-telemetry', body] : [process.argv[1], '__send-telemetry', body]
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

/**
 * Asks a detached child to drain the spool. Called when the spool fills up and
 * at the moments a session pauses — the hook itself never waits for the network.
 */
export function flushTelemetryDetached(): void {
  if (!isTelemetryEnabled()) return
  try {
    const compiled = !/\b(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))
    const args = compiled ? ['__flush-telemetry'] : [process.argv[1], '__flush-telemetry']
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch { /* never blocks execution */ }
}

/**
 * Queues the daily savings snapshot without waiting. The child parses the
 * transcripts (seconds on a big history), which is why the hook never builds
 * the snapshot itself. No-op unless telemetry is on and a day has passed —
 * the child re-checks that before sending.
 */
export function sendSnapshotDetached(reason: string, force = false): void {
  if (!isTelemetryEnabled()) return
  try {
    const compiled = !/\b(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))
    const tail = ['__send-snapshot', reason, ...(force ? ['--force'] : [])]
    const args = compiled ? tail : [process.argv[1], ...tail]
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch { /* never blocks execution */ }
}

/** Entry point of the detached child: `cork-ai __send-telemetry <json>`. */
export async function runSendTelemetry(rawBody: string | undefined): Promise<void> {
  if (!rawBody) return
  let body: Record<string, unknown>
  try { body = JSON.parse(rawBody) } catch { return }
  await postCapture(body)
}

/**
 * Posts many events in one request. PostHog's /capture/ accepts
 * `{ api_key, batch: [...] }` on the same endpoint with the same write-only
 * key — the form scripts/adoption.mjs already uses.
 *
 * The per-event `api_key` is dropped: it belongs to the envelope here, and
 * repeating it in every entry would trip PostHog's own validation.
 */
export async function postBatch(events: Array<Record<string, unknown>>, host = POSTHOG_HOST, timeoutMs = 10_000): Promise<boolean> {
  if (events.length === 0) return true
  const batch = events.map(({ api_key: _drop, ...rest }) => rest)
  return postCapture({ api_key: POSTHOG_PROJECT_TOKEN, batch }, host, timeoutMs)
}

/**
 * Entry point of the detached child: `cork-ai __flush-telemetry`.
 *
 * Takes the spool and sends it as one batch. On failure the events are put
 * back, so a machine that is briefly offline keeps them for the next flush
 * rather than losing them — bounded by the spool's own ceiling and max age,
 * which is what stops a week offline from growing without limit.
 */
export async function runFlushTelemetry(): Promise<void> {
  const events = takeSpool()
  if (events.length === 0) return
  const ok = await postBatch(events as unknown as Array<Record<string, unknown>>)
  if (!ok) for (const e of events) spool(e)
}
