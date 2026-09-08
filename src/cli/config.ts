/**
 * ~/.cork-ai/config.json — the tool's persistent settings.
 *
 * Every key is optional; absence means "default". `cork-ai config` lists and
 * edits them. Nothing here is ever sent anywhere except the anonymous
 * `installId` when telemetry is on.
 */

import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ContextGuardConfig } from './context-guard.js'

export const CORK_HOME = process.env.CORK_AI_HOME ?? path.join(os.homedir(), '.cork-ai')
export const CONFIG_FILE = path.join(CORK_HOME, 'config.json')

export interface CorkConfig {
  /** undefined = never asked, true = opted in, false = opted out */
  telemetry?: boolean
  /** Random id generated when telemetry is first enabled. Not derived from the machine. */
  installId?: string
  /** Last model seen in a hook event — used for cost estimates when the transcript is silent. */
  detectedModel?: string
  /** Median cache reads per token written, measured by `gain --all`; feeds the EV gate. */
  measuredAmplification?: number
  contextGuard?: ContextGuardConfig
  /** Set when the user answered the auto-compaction question at install (true, false, or the value chosen). */
  autoCompactAnswered?: boolean
}

/** Keys `cork-ai config set` accepts, with a one-line description and a parser. */
export const CONFIG_KEYS: Record<string, { description: string; parse: (raw: string) => unknown }> = {
  'telemetry': { description: 'Anonymous usage telemetry (true/false)', parse: raw => raw === 'true' },
  'contextGuard.enabled': { description: 'Live context notices (true/false)', parse: raw => raw === 'true' },
  'contextGuard.nudgeModel': { description: 'Also nudge the model, not only the user (true/false)', parse: raw => raw === 'true' },
  'contextGuard.bands': { description: 'Context sizes that trigger a notice, e.g. 150k,300k,500k', parse: raw => raw.split(',').map(s => parseTokens(s.trim())).filter((n): n is number => n !== undefined) },
  'contextGuard.everyNthToolUse': { description: 'Evaluate the guard every N edits (PostToolUse)', parse: raw => Number(raw) },
  'measuredAmplification': { description: 'Cache reads per token written used by the EV gate (auto-measured by gain --all)', parse: raw => Number(raw) },
}

/** `200k`, `1M`, `200` (thousands) or a plain token count → tokens. */
export function parseTokens(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(raw.trim())
  if (!m) return undefined
  const n = Number(m[1])
  if (m[2]?.toLowerCase() === 'k') return Math.round(n * 1_000)
  if (m[2]?.toLowerCase() === 'm') return Math.round(n * 1_000_000)
  return n <= 1000 ? Math.round(n * 1_000) : Math.round(n)
}

export function loadConfig(): CorkConfig {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as CorkConfig } catch { return {} }
}

export function saveConfig(cfg: CorkConfig): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8')
  } catch { /* non-critical */ }
}

/** Read-modify-write helper so concurrent hook processes don't clobber each other's keys. */
export function updateConfig(patch: Partial<CorkConfig>): CorkConfig {
  const next = { ...loadConfig(), ...patch }
  saveConfig(next)
  return next
}

export function isTelemetryEnabled(cfg: CorkConfig = loadConfig()): boolean {
  if (process.env.CORK_AI_TELEMETRY === '0' || process.env.DO_NOT_TRACK === '1') return false
  return cfg.telemetry === true
}

/** The anonymous install id, created on first use. */
export function installId(): string {
  const cfg = loadConfig()
  if (cfg.installId) return cfg.installId
  const id = crypto.randomUUID()
  updateConfig({ installId: id })
  return id
}

/** Dotted-path get/set on the config object, for `cork-ai config`. */
export function getConfigValue(cfg: CorkConfig, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), cfg)
}

export function setConfigValue(cfg: CorkConfig, key: string, value: unknown): CorkConfig {
  const parts = key.split('.')
  const next = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>
  let cursor = next
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]] = value
  return next as CorkConfig
}
