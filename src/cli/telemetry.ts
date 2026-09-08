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
import path from 'path'
import { installId, isTelemetryEnabled } from './config.js'
import { VERSION } from './version.js'

export const POSTHOG_HOST = 'https://eu.i.posthog.com'
export const POSTHOG_PROJECT_TOKEN = 'phc_u5LpaZ4J9TNdPbZU3UF3Jh5Egn3BTFxcBxtX9FNJ7ove'

export type TelemetryEventName =
  | 'install'
  | 'telemetry_toggled'
  | 'command'
  | 'hook_read'
  | 'hook_reread'
  | 'guard_notice'
  | 'session_digest'

export interface TelemetryEvent {
  event: TelemetryEventName
  properties: Record<string, string | number | boolean | null | undefined>
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

/** Properties every event carries. */
export function baseProperties(): Record<string, string> {
  return {
    $lib: 'cork-ai',
    version: VERSION,
    os: process.platform,
    arch: process.arch,
    node_major: process.versions.bun ? `bun-${process.versions.bun.split('.')[0]}` : `node-${process.versions.node.split('.')[0]}`,
  }
}

/** The JSON body PostHog's /capture endpoint expects. */
export function capturePayload(e: TelemetryEvent, distinctId: string, timestamp: Date = new Date()): Record<string, unknown> {
  const properties: Record<string, unknown> = { ...baseProperties(), ...e.properties }
  for (const key of Object.keys(properties)) if (properties[key] === undefined) delete properties[key]
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
    const body = JSON.stringify(capturePayload(e, installId()))
    const compiled = !/\b(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))
    const args = compiled ? ['__send-telemetry', body] : [process.argv[1], '__send-telemetry', body]
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
