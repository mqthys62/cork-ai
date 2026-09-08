#!/usr/bin/env node
/**
 * cork-ai CLI — stats, savings report, project setup, and Claude Code hooks.
 *
 * Commands:
 *   cork-ai init                  Auto-integrate cork-ai into the current project
 *   cork-ai gain                  Show current session + all-time savings
 *   cork-ai gain --all            Show all-time totals
 *   cork-ai gain --history        Show all recorded sessions
 *   cork-ai models                Per-model usage, frequency & cost breakdown
 *   cork-ai report                Full enterprise report (trends + projects + forecast)
 *   cork-ai report --daily        Daily breakdown (last 30 days)
 *   cork-ai report --weekly       Weekly breakdown (last 12 weeks)
 *   cork-ai report --monthly      Monthly breakdown (last 12 months)
 *   cork-ai report --projects     Stats per project
 *   cork-ai report --forecast     Annual projection
 *   cork-ai report --json         Export all data as JSON
 *   cork-ai hooks install         Add cork-ai hooks to Claude Code settings
 *   cork-ai hooks remove          Remove cork-ai hooks from Claude Code settings
 *   cork-ai hooks status          Show hook installation status
 *   cork-ai doctor                Diagnose the install and hook coverage
 *   cork-ai context               Context-size cost report; --set-autocompact <tokens>
 *   cork-ai statusline            Status-line segment
 *   cork-ai hook                  Internal: handle Claude Code hook events (stdin/stdout)
 *   cork-ai reset                 Reset all stats
 *   cork-ai --version             Show version
 *   cork-ai --help                Show help
 */

import fs from 'fs'
import { spawn, spawnSync } from 'child_process'
import os from 'os'
import path from 'path'
import readline from 'readline'
import {
  readGlobalStats,
  resetGlobalStats,
  accumulateInSession,
  readLiveSession,
  clearLiveSession,
  getStatsByProject,
  getStatsByPeriod,
  getStatsByModel,
  getForecast,
  STATS_FILE,
  LIVE_DIR,
  type SessionRecord,
  type ModelUsage,
} from './persistent-stats.js'
import { inputPriceForModel, costOfAvoidedTokens } from '../pricing/index.js'
import { scanAllTranscripts, sessionAmplification, lastMainTurnUsage, contextReport, listTranscriptFiles, sessionReReadTurns } from './transcript-usage.js'
import { parseBashRead, parseBashEdit } from './bash-read.js'
import { outline } from './outline.js'
import { gate, recordCompression, recordReRead, recordRangeRead, recordEditAfter, policySummary } from './policy.js'
import { evaluateGuard, guardHookOutput, type ContextGuardConfig } from './context-guard.js'
import { eligibility } from './file-eligibility.js'
import { isSkipped, markSkipped, skippedCount } from './skip-list.js'
import {
  CALIBRATION_FILE,
  countTokensRaw,
  estimateTokensFast,
  modelFamily,
  saveCalibrationFactor,
} from '../core/tokenizer.js'

const VERSION = '0.7.0'
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const CORK_HOME = process.env.CORK_AI_HOME ?? path.join(os.homedir(), '.cork-ai')
const CONFIG_FILE = path.join(CORK_HOME, 'config.json')

const TELEMETRY_ENDPOINT = 'https://corktelemetry.essenly.fr/telemetry-server.php'

// ─── Config (~/.cork-ai/config.json) ─────────────────────────────────────────

interface CorkConfig {
  telemetry?: boolean   // undefined = never asked, true = opted in, false = opted out
  detectedModel?: string  // last model seen in a hook event — used for cost estimates
  /** Median cache reads per token written, measured by `gain --all`; feeds the EV gate. */
  measuredAmplification?: number
  contextGuard?: ContextGuardConfig
}

// Pricing lives in src/pricing (single source of truth, shared with the
// library) — per-model, four billing tiers, date-dependent introductory rates.

// Extracts the last REAL user prompt from the transcript (skipping user-role
// entries that only carry tool_result blocks — those are agentic plumbing).
// Used to avoid compressing a file the user explicitly asked about.
function lastUserPromptFromTranscript(transcriptPath?: string): string | undefined {
  if (!transcriptPath) return undefined
  try {
    const stat = fs.statSync(transcriptPath)
    const TAIL_BYTES = 256 * 1024
    const start = Math.max(0, stat.size - TAIL_BYTES)
    const fd = fs.openSync(transcriptPath, 'r')
    const buf = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)

    const lines = buf.toString('utf-8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"user"')) continue
      try {
        const entry = JSON.parse(line) as {
          type?: string
          isSidechain?: boolean
          message?: { role?: string; content?: unknown }
        }
        if (entry.type !== 'user' || entry.isSidechain) continue
        const content = entry.message?.content
        let text = ''
        if (typeof content === 'string') {
          text = content
        } else if (Array.isArray(content)) {
          text = content
            .filter((b): b is { type: string; text: string } =>
              typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
            .map(b => b.text)
            .join('\n')
        }
        if (text.trim().length > 0) return text
      } catch { /* partial line at the tail cut — skip */ }
    }
  } catch { /* transcript unreadable */ }
  return undefined
}

function loadConfig(): CorkConfig {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as CorkConfig } catch { return {} }
}

function saveConfig(cfg: CorkConfig): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8')
  } catch { /* non-critical */ }
}

function isTelemetryEnabled(): boolean {
  if (process.env.CORK_AI_TELEMETRY === '0' || process.env.DO_NOT_TRACK === '1') return false
  return loadConfig().telemetry === true
}

// ─── Telemetry (fire-and-forget, anonymous) ───────────────────────────────────

interface TelemetryPayload {
  v: string
  os: string
  arch: string
  savings_pct: number
  file_ext: string
  compress_type: string
  skipped: boolean
}

function sendTelemetry(payload: TelemetryPayload): void {
  if (TELEMETRY_ENDPOINT.includes('YOUR_DOMAIN')) return
  try {
    const body = JSON.stringify(payload)
    const url = new URL(TELEMETRY_ENDPOINT)
    // Spawn a detached child so the request survives process.exit() and never delays the hook.
    const script = [
      "const https=require('https'),b=process.argv[1];",
      `const req=https.request({hostname:${JSON.stringify(url.hostname)},path:${JSON.stringify(url.pathname)},method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)},timeout:4000},()=>process.exit(0));`,
      "req.on('error',()=>process.exit(0));",
      "req.on('timeout',()=>{req.destroy();process.exit(0)});",
      "req.end(b);",
    ].join('')
    const child = spawn(process.execPath, ['-e', script, body], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch { /* never blocks execution */ }
}
// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt(n: number): string { return n.toLocaleString('en-US') }
function fmtPct(n: number): string { return `${n.toFixed(1)}%` }
function fmtUsd(n: number): string { return `$${n.toFixed(4)}` }
function fmtUsdLong(n: number): string { return `$${n.toFixed(2)}` }

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return n % 1_000 === 0 ? `${n / 1_000}k` : `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function bar(percent: number, width = 30): string {
  const filled = Math.round((percent / 100) * width)
  const empty = width - filled
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${fmtPct(percent)}`
}

function miniBar(percent: number, width = 15): string {
  const filled = Math.round((percent / 100) * width)
  const empty = width - filled
  return `${'█'.repeat(filled)}${'░'.repeat(empty)}`
}

function divider(char = '─', len = 66): string { return char.repeat(len) }

/**
 * USD already deducted from the displayed savings by re-reads.
 *
 * `estimatedCostSaved` is stored net: every re-read subtracted
 * `rawTokens × inputPrice(model)` at the time it happened. Only the token
 * volume survives in the stats file, so the penalty is reconstructed per
 * session at that session's own model price — sessions are effectively
 * single-model, which keeps this faithful to what was originally deducted.
 */
interface LifetimeSavings {
  /** What cork-ai reported before: every saved token valued once at 1× input. */
  firstPass: number
  /** Cache write + one cache read per subsequent turn, per the transcripts. */
  lifetime: number
  /** Re-read cost, valued on the same lifetime basis (raw tokens re-injected). */
  penalty: number
  /** Real cost of the assistant turns that issued a re-read: the extra API round trip each one is. */
  extraTurnPenalty: number
  /** Re-read turns found in the transcripts. */
  extraTurns: number
  /** Sessions whose transcript was found, over sessions considered. */
  measured: number
  total: number
  /** Median amplification across measured sessions — the headline multiplier. */
  medianAmplification: number
  compactions: number
}

/**
 * Values saved tokens over their life in context rather than on first send.
 *
 * The hook cannot do this at write time: when it fires, the session is still
 * running and the number of turns that will re-read the context is unknowable.
 * The transcript knows after the fact, and `SessionRecord.sessionId` is the
 * transcript's filename, so the two join with no stored schema change.
 *
 * Sessions with no transcript fall back to the first-pass value and are
 * excluded from `measured` so partial coverage stays visible.
 */
function lifetimeSavings(
  sessions: Array<{ sessionId: string; byModel?: Record<string, ModelUsage>; reReadTokensServed?: number }>,
): LifetimeSavings {
  const out: LifetimeSavings = {
    firstPass: 0,
    lifetime: 0,
    penalty: 0,
    extraTurnPenalty: 0,
    extraTurns: 0,
    measured: 0,
    total: 0,
    medianAmplification: 0,
    compactions: 0,
  }
  // cork-ai flushes a SessionRecord per activity window, so one Claude Code
  // session can produce several records. Amplification and compaction counts
  // are properties of the transcript, so they are gathered once per session id
  // — counting a 1000-turn session nine times would drag the median with it.
  const ampBySession = new Map<string, number>()
  const cache = new Map<string, ReturnType<typeof sessionAmplification>>()
  const seenSessions = new Set<string>()

  for (const session of sessions) {
    const models = Object.entries(session.byModel ?? {})
    if (models.length === 0) continue
    seenSessions.add(session.sessionId)

    let amp = cache.get(session.sessionId)
    if (!amp) {
      amp = sessionAmplification(session.sessionId)
      cache.set(session.sessionId, amp)
      if (amp.found && amp.cacheWriteTokens > 0) {
        out.compactions += amp.compactions
        ampBySession.set(session.sessionId, amp.amplification)
      }
      // The turn that re-reads a compressed file exists only because of the
      // compression: bill it at its real, transcript-recorded cost. The
      // token-based penalty below never saw this — it counted the raw file
      // being re-sent, not the whole context being re-read once more.
      const turns = sessionReReadTurns(session.sessionId)
      if (turns.found) {
        out.extraTurnPenalty += turns.extraTurnCostUSD
        out.extraTurns += turns.reReads
      }
    }
    // No transcript → amplification 0, which collapses costOfAvoidedTokens()
    // to the cache-write tier: close to the old 1× figure, never inflated.
    const factor = amp.found ? amp.amplification : 0

    let saved = 0
    let weightedPrice = 0
    let totalTokens = 0
    for (const [, usage] of models) totalTokens += usage.savedTokens

    for (const [model, usage] of models) {
      out.firstPass += (usage.savedTokens / 1_000_000) * inputPriceForModel(model)
      saved += costOfAvoidedTokens(usage.savedTokens, model, factor)
      if (totalTokens > 0) {
        weightedPrice += inputPriceForModel(model) * (usage.savedTokens / totalTokens)
      }
    }
    out.lifetime += saved

    // Symmetric treatment: a re-read puts raw content back into the context and
    // is re-billed every subsequent turn exactly like anything else. Valuing it
    // at 1× while savings run at the lifetime rate would bias the net in
    // cork-ai's favour.
    const reRead = session.reReadTokensServed ?? 0
    if (reRead > 0 && weightedPrice > 0) {
      const model = models.sort((a, b) => b[1].savedTokens - a[1].savedTokens)[0][0]
      out.penalty += costOfAvoidedTokens(reRead, model, factor)
    }
  }

  out.measured = ampBySession.size
  out.total = seenSessions.size

  const sorted = [...ampBySession.values()].sort((a, b) => a - b)
  if (sorted.length > 0) {
    const mid = Math.floor(sorted.length / 2)
    out.medianAmplification =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  }
  return out
}

function reReadPenalty(stats: { sessions: SessionRecord[] } | null | undefined): number {
  if (!stats) return 0
  let total = 0
  for (const session of stats.sessions) {
    const served = session.reReadTokensServed ?? 0
    if (served <= 0) continue
    const model = Object.entries(session.byModel ?? {})
      .sort((a, b) => b[1].requests - a[1].requests)[0]?.[0]
    total += (served / 1_000_000) * inputPriceForModel(model)
  }
  return total
}

// ─── Colors (no deps — raw ANSI) ─────────────────────────────────────────────

const C = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  blue:   (s: string) => `\x1b[34m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
}

// ─── Help / version ───────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
${C.bold('cork-ai')} v${VERSION} — Context optimization for Claude Code

${C.bold('Quick start:')}
  cork-ai init              Auto-integrate into the current project
  cork-ai hooks install     Add hooks so Claude Code uses cork-ai directly

${C.bold('Stats:')}
  cork-ai gain              Current session + all-time savings
  cork-ai gain --all        All-time totals only
  cork-ai gain --history    All recorded sessions
  cork-ai models            Per-model usage, frequency & cost breakdown

${C.bold('Enterprise report:')}
  cork-ai report            Full report (trends + projects + forecast)
  cork-ai report --daily    Daily breakdown (last 30 days)
  cork-ai report --weekly   Weekly breakdown (last 12 weeks)
  cork-ai report --monthly  Monthly breakdown (last 12 months)
  cork-ai report --projects Per-project breakdown
  cork-ai report --models   Per-model breakdown
  cork-ai report --forecast Annual cost projection
  cork-ai report --json     Export full data as JSON

${C.bold('Claude Code integration:')}
  cork-ai hooks install     Install/upgrade the hooks (Read + Bash reads, edits, context guard)
  cork-ai hooks remove      Remove cork-ai hooks
  cork-ai hooks status      Show hook configuration
  cork-ai doctor            Check the install: binary, hooks, self-test, coverage of recent sessions
  cork-ai context           Where the money goes: context size per turn, what auto-compaction would save
  cork-ai context --set-autocompact 200k   Set Claude Code's autoCompactWindow
  cork-ai context guard [on|off]           Toggle the live context notices
  cork-ai statusline        Status-line segment (reads Claude Code's status JSON on stdin)

${C.bold('Precision:')}
  cork-ai calibrate [model] Measure real token factors via the count_tokens API
                            (needs ANTHROPIC_API_KEY — makes every count model-exact)

${C.bold('Other:')}
  cork-ai reset             Reset all stats
  cork-ai telemetry on      Enable anonymous usage stats (opt-in)
  cork-ai telemetry off     Disable telemetry
  cork-ai telemetry status  Show telemetry state
  cork-ai --version         Show version

${C.bold('Stats file:')} ${STATS_FILE}
`)
}

function showVersion(): void { console.log(`cork-ai v${VERSION}`) }

// ─── gain ─────────────────────────────────────────────────────────────────────

function showLastSession(): void {
  const live = readLiveSession()
  const stats = readGlobalStats()

  const hasHistory = stats && stats.allTime.totalRequests > 0
  const hasCompletedSessions = stats && stats.sessions.length > 0

  if (!live && !hasHistory) {
    console.log(`\n${C.yellow('No sessions recorded yet.')}\n`)
    console.log(`Run ${C.cyan('cork-ai hooks install')} to start tracking automatically.`)
    console.log(`Stats file: ${C.dim(STATS_FILE)}\n`)
    return
  }

  // ── Section 1: current session (or last completed session) ──
  if (live) {
    const pct = live.originalTokens > 0 ? (live.savedTokens / live.originalTokens) * 100 : 0
    console.log(`\n${C.bold('cork-ai — Current Session')}`)
    console.log(divider())
    console.log(`  ${C.dim('Started')}    ${fmtDate(live.startedAt)}`)
    if (live.projectPath) console.log(`  ${C.dim('Project')}      ${C.cyan(path.basename(live.projectPath))}`)
    const liveModels = Object.keys(live.byModel ?? {})
    if (liveModels.length > 0) {
      console.log(`  ${C.dim('Model')}        ${C.cyan(liveModels.join(', '))}`)
    }
    console.log(`  ${C.dim('Requests')}    ${C.bold(fmt(live.requests))}`)
    console.log()
    console.log(`  ${C.dim('Tokens in')}   ${C.cyan(fmt(live.originalTokens))}`)
    console.log(`  ${C.dim('Tokens out')}  ${C.green(fmt(live.compressedTokens))}`)
    console.log(`  ${C.dim('Saved')}  ${C.green(fmt(live.savedTokens))} tokens`)
    console.log()
    console.log(`  ${C.bold('Savings')}   ${C.green(bar(pct))}`)
    console.log(`  ${C.bold('Cost saved')} ${C.green(fmtUsd(live.estimatedCostSaved))} USD`)
    if (live.reReads) {
      console.log(`  ${C.yellow('Re-reads')}   ${live.reReads} file${live.reReads > 1 ? 's' : ''} re-read after compression (${fmtTokens(live.reReadTokensServed ?? 0)} tokens served raw — cost deducted)`)
    }
    if (live.editFailuresAfterCompression) {
      console.log(`  ${C.yellow('Edit fails')} ${live.editFailuresAfterCompression} edit${live.editFailuresAfterCompression > 1 ? 's' : ''} failed on compressed-only files (auto-whitelisted)`)
    }
    console.log()

    if (Object.keys(live.byModule).length > 0) {
      console.log(`  ${C.dim('By module:')}`)
      const sorted = Object.entries(live.byModule).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a)
      for (const [name, saved] of sorted) {
        const modPct = live.originalTokens > 0 ? (saved / live.originalTokens) * 100 : 0
        console.log(`    ${name.padEnd(24)} ${C.green(fmt(saved).padStart(8))} tokens  (${fmtPct(modPct)})`)
      }
      console.log()
    }
  } else if (hasCompletedSessions) {
    // No live session → show last completed session
    const last = stats!.sessions[stats!.sessions.length - 1]
    const pct = last.originalTokens > 0 ? (last.savedTokens / last.originalTokens) * 100 : 0
    console.log(`\n${C.bold('cork-ai — Last Session')}`)
    console.log(divider())
    console.log(`  ${C.dim('Date')}        ${fmtDate(last.startedAt)}`)
    if (last.projectPath) console.log(`  ${C.dim('Project')}     ${C.cyan(path.basename(last.projectPath))}`)
    console.log(`  ${C.dim('Requests')}    ${fmt(last.requests)}`)
    console.log()
    console.log(`  ${C.dim('Tokens in')}   ${C.cyan(fmt(last.originalTokens))}`)
    console.log(`  ${C.dim('Tokens out')}  ${C.green(fmt(last.compressedTokens))}`)
    console.log(`  ${C.dim('Saved')}  ${C.green(fmt(last.savedTokens))} tokens`)
    console.log()
    console.log(`  ${C.bold('Économies')}   ${C.green(bar(pct))}`)
    console.log(`  ${C.bold('Cost saved')} ${C.green(fmtUsd(last.estimatedCostSaved))} USD`)
    console.log()
  }

  // ── Section 2: global totals (live session included if active) ──
  if (stats) {
    const liveSaved  = live?.savedTokens ?? 0
    const liveCost   = live?.estimatedCostSaved ?? 0
    const liveReqs   = live?.requests ?? 0
    const totalSaved = stats.allTime.totalSavedTokens + liveSaved
    const totalCost  = stats.allTime.estimatedCostSaved + liveCost
    const totalReqs  = stats.allTime.totalRequests + liveReqs
    const sessionCnt = stats.sessions.length + (live ? 1 : 0)

    console.log(divider())
    console.log(
      `  ${C.dim('Global:')} ${C.green(fmt(totalSaved))} tokens saved` +
      ` — ${C.green(fmtUsd(totalCost))} USD` +
      `  ${C.dim(`(${fmt(totalReqs)} req · ${fmt(sessionCnt)} sessions)`)}`
    )
    const beat = readHeartbeat()
    const lastSeen = live?.lastActivityAt ?? stats.sessions[stats.sessions.length - 1]?.endedAt
    if (!beat && lastSeen && Date.now() - new Date(lastSeen).getTime() > 3 * 86_400_000) {
      console.log(`  ${C.yellow('!')} ${C.dim('No hook event for')} ${Math.round((Date.now() - new Date(lastSeen).getTime()) / 86_400_000)} ${C.dim('days — run')} ${C.cyan('cork-ai doctor')}`)
    }
    console.log()
  }
}

function showAllTime(): void {
  const stats = readGlobalStats()
  const live = readLiveSession()

  // Include the live session in totals
  const liveSaved  = live?.savedTokens ?? 0
  const liveCost   = live?.estimatedCostSaved ?? 0
  const liveReqs   = live?.requests ?? 0
  const liveOrig   = live?.originalTokens ?? 0


  const totalRequests = (stats?.allTime.totalRequests ?? 0) + liveReqs
  const totalOriginal = (stats?.allTime.totalOriginalTokens ?? 0) + liveOrig
  const totalSaved    = (stats?.allTime.totalSavedTokens ?? 0) + liveSaved
  const totalCost     = (stats?.allTime.estimatedCostSaved ?? 0) + liveCost
  const sessionCnt    = (stats?.sessions.length ?? 0) + (live ? 1 : 0)

  if (totalRequests === 0) {
    console.log(`\n${C.yellow('No data recorded yet.')}\n`); return
  }

  const pct = totalOriginal > 0 ? (totalSaved / totalOriginal) * 100 : 0
  const avgPerSession = sessionCnt > 0 ? totalSaved / sessionCnt : 0

  console.log(`\n${C.bold('cork-ai — All-Time Stats')}`)
  console.log(divider())
  if (stats) console.log(`  ${C.dim('Tracking since')} ${fmtDate(stats.createdAt)}`)
  console.log(`  ${C.dim('Sessions')}       ${fmt(sessionCnt)}`)
  console.log(`  ${C.dim('Requests')}       ${fmt(totalRequests)}`)
  console.log()
  // These count the Read tool outputs the hook saw, before/after compression.
  // They are NOT the API's input/output tokens — labelling them "tokens in/out"
  // read as prompt/completion tokens, which cork-ai never sees via the hook.
  console.log(`  ${C.dim('Read raw')}            ${C.cyan(fmt(totalOriginal))} tokens`)
  console.log(`  ${C.dim('After compression')}   ${C.green(fmt(totalOriginal - totalSaved))} tokens`)
  console.log(`  ${C.dim('Saved')}               ${C.green(fmt(totalSaved))} tokens`)
  console.log()
  console.log(`  ${C.bold('Overall savings')}   ${C.green(bar(pct))}`)
  console.log(`  ${C.bold('Avg / session')}     ${C.green(fmt(Math.round(avgPerSession)))} tokens`)
  console.log()

  // Cost saved. A token kept out of the context is not saved once — it avoids
  // a cache write plus one cache read on every later turn. Both bounds are
  // shown: the first-pass floor keeps the headline auditable.
  const sessionsForLifetime = [...(stats?.sessions ?? []), ...(live ? [live] : [])]
  const life = lifetimeSavings(sessionsForLifetime)
  const penalty = life.measured > 0 ? life.penalty : reReadPenalty(stats)

  console.log(`  ${C.bold('Cost saved')}`)
  if (life.measured > 0) {
    console.log(`    ${C.dim('First pass only')}      ${C.dim(`${fmtUsdLong(life.firstPass)} USD`)}`)
    console.log(`    ${C.dim('Lifetime in context')}  ${C.green(fmtUsdLong(life.lifetime))} USD`)
    console.log(`    ${C.dim('Re-read penalty')}      ${C.yellow(`-${fmtUsdLong(penalty)}`)} USD ${C.dim(`(${fmt(stats?.allTime.reReads ?? 0)} re-reads · ${fmtTokens(stats?.allTime.reReadTokensServed ?? 0)} raw)`)}`)
    if (life.extraTurns > 0) {
      console.log(`    ${C.dim('Re-read extra turns')}  ${C.yellow(`-${fmtUsdLong(life.extraTurnPenalty)}`)} USD ${C.dim(`(${fmt(life.extraTurns)} turns that only existed to re-read a compressed file, at their real cost)`)}`)
    }
    const net = life.lifetime - penalty - life.extraTurnPenalty
    console.log(`    ${C.bold('Net')}                  ${(net >= 0 ? C.green : C.red)(fmtUsdLong(net))} USD`)
    console.log(
      `    ${C.dim('Amplification')}        ${C.cyan(`${life.medianAmplification.toFixed(1)}x`)} ` +
      `${C.dim(`median cache reads per token written · ${life.measured}/${life.total} sessions measured` +
        (life.compactions > 0 ? ` · ${life.compactions} compactions` : ''))}`,
    )
  } else if (penalty > 0) {
    console.log(`    ${C.dim('Gross')}                ${C.green(fmtUsdLong(totalCost + penalty))} USD`)
    console.log(`    ${C.dim('Re-read penalty')}      ${C.yellow(`-${fmtUsdLong(penalty)}`)} USD`)
    console.log(`    ${C.bold('Net')}                  ${C.green(fmtUsdLong(totalCost))} USD`)
    console.log(`    ${C.dim('No transcripts found — first-pass estimate only')}`)
  } else {
    console.log(`    ${C.bold('Net')}                  ${C.green(fmtUsdLong(totalCost))} USD`)
  }

  // Per-model breakdown — byModel[].costSaved has always been recorded but was
  // never surfaced here, so a mixed-model history showed one blended number.
  const models = getStatsByModel(stats, live)
  if (models.length > 0) {
    console.log()
    console.log(`  ${C.bold('By model')} ${C.dim('(gross, before the re-read penalty)')}`)
    for (const m of models) {
      console.log(
        `    ${C.cyan(m.model.padEnd(20))} ${C.green(fmtTokens(m.savedTokens).padStart(8))} saved  ` +
        `${C.green(fmtUsd(m.costSaved).padStart(9))}  ${C.dim(`${fmt(m.requests)} req`)}`,
      )
    }
  }

  // Ground truth from wrapClient sessions (response.usage), when available
  const measured = stats?.allTime.measured
  if (measured && measured.requests > 0) {
    console.log()
    console.log(`  ${C.bold('Measured (API ground truth)')}  ${C.dim(`${fmt(measured.requests)} requests`)}`)
    console.log(`  ${C.dim('Input / output')}     ${fmt(measured.inputTokens)} / ${fmt(measured.outputTokens)} tokens`)
    console.log(`  ${C.dim('Cache read / write')} ${fmt(measured.cacheReadInputTokens)} / ${fmt(measured.cacheCreationInputTokens)} tokens`)
    console.log(`  ${C.dim('Real cost')}          ${fmtUsdLong(measured.costUSD)} USD`)
    const promptTotal = measured.inputTokens + measured.cacheReadInputTokens + measured.cacheCreationInputTokens
    if (promptTotal > 0) {
      const cacheHit = (measured.cacheReadInputTokens / promptTotal) * 100
      console.log(`  ${C.dim('Cache hit rate')}     ${fmtPct(cacheHit)}`)
    }

    // Estimate accuracy: locally-estimated sent tokens vs real prompt tokens,
    // over sessions that carry both numbers (wrapClient sessions).
    const withBoth = (stats?.sessions ?? []).filter(s => s.measured && s.measured.requests > 0)
    if (withBoth.length > 0) {
      const estSent = withBoth.reduce((s, r) => s + r.compressedTokens, 0)
      const realPrompt = withBoth.reduce(
        (s, r) => s + r.measured!.inputTokens + r.measured!.cacheReadInputTokens + r.measured!.cacheCreationInputTokens, 0)
      if (realPrompt > 0 && estSent > 0) {
        const acc = (estSent / realPrompt) * 100
        console.log(`  ${C.dim('Estimate accuracy')}  ${fmtPct(acc)} ${C.dim('of real prompt tokens — improve with cork-ai calibrate')}`)
      }
    }
  }
  // Ground truth for what was actually *spent*, read back from Claude Code's
  // transcripts. Everything above is an estimate of avoided cost on the Read
  // outputs the hook touched; this covers the entire bill.
  const spend = scanAllTranscripts(stats ? new Date(stats.createdAt) : undefined)
  if (spend.messages > 0) {
    const promptTokens = spend.inputTokens + spend.cacheReadTokens + spend.cacheWriteTokens
    console.log()
    console.log(`  ${C.bold('Real spend')} ${C.dim(`(Claude Code transcripts · ${fmt(spend.messages)} assistant turns)`)}`)
    console.log(`    ${C.dim('Prompt')}             ${fmt(promptTokens)} tokens ${C.dim(`(${fmtTokens(spend.inputTokens)} fresh · ${fmtTokens(spend.cacheReadTokens)} cache read · ${fmtTokens(spend.cacheWriteTokens)} cache write)`)}`)
    console.log(`    ${C.dim('Output')}             ${fmt(spend.outputTokens)} tokens`)
    if (promptTokens > 0) {
      console.log(`    ${C.dim('Cache hit rate')}     ${fmtPct((spend.cacheReadTokens / promptTokens) * 100)}`)
    }
    if (spend.sidechainMessages > 0) {
      console.log(`    ${C.dim('Subagent turns')}     ${fmt(spend.sidechainMessages)} ${C.dim('(included above)')}`)
    }
    console.log(`    ${C.bold('Total')}              ${C.yellow(fmtUsdLong(spend.costUSD))} USD`)

    const modelRows = Object.entries(spend.byModel).sort((a, b) => b[1].costUSD - a[1].costUSD)
    if (modelRows.length > 1) {
      for (const [model, m] of modelRows) {
        console.log(`      ${C.dim(model.padEnd(20))} ${C.yellow(fmtUsdLong(m.costUSD).padStart(8))} ${C.dim(`${fmt(m.messages)} turns`)}`)
      }
    }
    if (spend.costUSD > 0) {
      const net = life.measured > 0 ? life.lifetime - penalty - life.extraTurnPenalty : totalCost
      const ratio = (net / spend.costUSD) * 100
      console.log(`    ${C.dim('Estimated savings vs spend')}  ${(ratio >= 0 ? C.green : C.red)(fmtPct(ratio))} ${C.dim('— cork-ai avoided cost as a share of what you paid')}`)
    }
  }

  // Remember the measured amplification for the hook's expected-value gate.
  if (life.measured > 0 && life.medianAmplification > 0) {
    const cfg = loadConfig()
    const rounded = Math.round(Math.min(life.medianAmplification, 150))
    if (cfg.measuredAmplification !== rounded) saveConfig({ ...cfg, measuredAmplification: rounded })
  }

  // Context: where the money actually goes. Cache reads of an oversized
  // context dwarf anything a Read compressor can do, so the summary belongs
  // here, next to the savings it puts in perspective.
  const ctx = contextReport({ since: new Date(Date.now() - 30 * 86_400_000), ceilings: [200_000], minTurns: 20 })
  if (ctx.sessions.length > 0 && ctx.costUSD > 0) {
    const share = (ctx.cacheReadCostUSD / ctx.costUSD) * 100
    const saving = ctx.costUSD - ctx.cappedCostUSD[200_000]
    console.log()
    console.log(`  ${C.bold('Context')} ${C.dim(`(last 30 days · ${ctx.sessions.length} sessions ≥ 20 turns)`)}`)
    console.log(`    ${C.dim('Cache reads')}          ${C.yellow(fmtPct(share))} of spend ${C.dim(`— the context re-read on every turn, ${fmtTokens(ctx.avgContextTokens)} tokens on average`)}`)
    if (saving > 0) {
      console.log(`    ${C.dim('Auto-compact at 200k')} would have saved ${C.green(fmtUsdLong(saving))} USD ${C.dim(`(−${fmtPct((saving / ctx.costUSD) * 100)}) → cork-ai context`)}`)
    }
  }

  // Health. A re-read means the file was sent twice — compressed, then raw —
  // which is strictly worse than never compressing it. This ratio, not the
  // savings percentage, is what says whether cork-ai is helping.
  const reReads = stats?.allTime.reReads ?? 0
  const learned = skippedCount()
  if (totalRequests > 0 && (reReads > 0 || learned > 0)) {
    const rate = (reReads / totalRequests) * 100
    const colour = rate > 30 ? C.red : rate > 15 ? C.yellow : C.green
    console.log()
    console.log(`  ${C.bold('Health')}`)
    console.log(
      `    ${C.dim('Re-read rate')}         ${colour(fmtPct(rate))} ` +
      `${C.dim(`(${fmt(reReads)} of ${fmt(totalRequests)} compressions sent twice)`)}`,
    )
    if (stats?.allTime.editFailuresAfterCompression) {
      console.log(`    ${C.dim('Edit failures')}        ${C.yellow(fmt(stats.allTime.editFailuresAfterCompression))} ${C.dim('on compressed-only files')}`)
    }
    console.log(`    ${C.dim('Learned skips')}        ${fmt(learned)} ${C.dim('files served raw from now on')}`)
    const probation = policySummary().filter(p => p.probation)
    if (probation.length > 0) {
      console.log(`    ${C.dim('On probation')}         ${probation.map(p => `${p.ext} (${Math.round(p.reReadRate * 100)}%)`).join(', ')} ${C.dim('— served raw, probed 1 in 10')}`)
    }
  }
  showHookLiveness()

  console.log(divider())
  console.log()
}

/**
 * Is Claude Code still calling the hook? Compares the heartbeat with the
 * transcripts: a recent session without a cork-ai event is the silent failure
 * that hid for weeks when auto mode moved reads to Bash.
 */
function showHookLiveness(): void {
  const beat = readHeartbeat()
  const rows = coverage(14)
  if (!beat && rows.length === 0) return
  console.log()
  console.log(`  ${C.bold('Hook')}`)
  if (beat) {
    const ageMin = Math.round((Date.now() - new Date(beat.at).getTime()) / 60_000)
    const age = ageMin < 60 ? `${ageMin} min ago` : ageMin < 60 * 48 ? `${Math.round(ageMin / 60)} h ago` : `${Math.round(ageMin / 1440)} days ago`
    console.log(`    ${C.dim('Last event')}           ${age} ${C.dim(`(Claude Code ${beat.claudeVersion ?? '?'}${beat.permissionMode ? ` · ${beat.permissionMode} mode` : ''})`)}`)
  } else {
    console.log(`    ${C.dim('Last event')}           ${C.yellow('none recorded')}`)
  }
  if (rows.length > 0) {
    const seen = rows.filter(r => r.seen).length
    const colour = seen === rows.length ? C.green : seen === 0 ? C.red : C.yellow
    console.log(`    ${C.dim('Coverage (14 days)')}   ${colour(`${seen}/${rows.length} sessions`)} ${C.dim('with cork-ai events')}${seen < rows.length ? `  → ${C.cyan('cork-ai doctor')}` : ''}`)
  }
}

function showHistory(): void {
  const stats = readGlobalStats()
  const live = readLiveSession()
  if (!stats || stats.sessions.length === 0) {
    console.log(`\n${C.yellow('No sessions recorded yet.')}\n`); return
  }

  const totalSessions = stats.sessions.length + (live ? 1 : 0)
  console.log(`\n${C.bold('cork-ai — Session History')} (${totalSessions} sessions)`)
  console.log(divider())
  console.log(`  ${'Date'.padEnd(20)} ${'Project'.padEnd(18)} ${'Saved tokens'.padStart(13)} ${'Savings'.padStart(9)} ${'Cost saved'.padStart(11)}`)
  console.log(divider())

  // Live session first if active
  if (live) {
    const pct = live.originalTokens > 0 ? (live.savedTokens / live.originalTokens) * 100 : 0
    const project = path.basename(live.projectPath).slice(0, 17)
    console.log(
      `  ${(fmtDate(live.startedAt) + ' ●').padEnd(20)} ${project.padEnd(18)} ` +
      `${C.green(fmt(live.savedTokens).padStart(13))} ` +
      `${C.green(fmtPct(pct).padStart(9))} ` +
      `${C.green(fmtUsd(live.estimatedCostSaved).padStart(11))}`
    )
  }

  const recent = stats.sessions.slice(-25).reverse()
  for (const s of recent) {
    const pct = s.originalTokens > 0 ? (s.savedTokens / s.originalTokens) * 100 : 0
    const project = s.projectPath ? path.basename(s.projectPath).slice(0, 17) : 'unknown'
    console.log(
      `  ${fmtDate(s.startedAt).padEnd(20)} ${project.padEnd(18)} ` +
      `${C.green(fmt(s.savedTokens).padStart(13))} ` +
      `${C.green(fmtPct(pct).padStart(9))} ` +
      `${C.green(fmtUsd(s.estimatedCostSaved).padStart(11))}`
    )
  }

  if (stats.sessions.length > 25) {
    console.log(`  ${C.dim(`... and ${stats.sessions.length - 25} older sessions`)}`)
  }

  const liveSaved = live?.savedTokens ?? 0
  const liveCost  = live?.estimatedCostSaved ?? 0
  const totalSaved = stats.allTime.totalSavedTokens + liveSaved
  const totalCost  = stats.allTime.estimatedCostSaved + liveCost
  const totalOrig  = stats.allTime.totalOriginalTokens + (live?.originalTokens ?? 0)
  const totalPct   = totalOrig > 0 ? (totalSaved / totalOrig) * 100 : 0

  console.log(divider())
  console.log(
    `  ${'TOTAL'.padEnd(20)} ${''.padEnd(18)} ` +
    `${C.green(fmt(totalSaved).padStart(13))} ` +
    `${C.green(fmtPct(totalPct).padStart(9))} ` +
    `${C.green(fmtUsdLong(totalCost).padStart(11))}`
  )
  console.log()
}

// ─── report ───────────────────────────────────────────────────────────────────

function reportPeriod(period: 'day' | 'week' | 'month'): void {
  const stats = readGlobalStats()
  if (!stats || stats.sessions.length === 0) {
    console.log(`\n${C.yellow('No data yet.')}\n`); return
  }

  const lookback = period === 'day' ? 30 : period === 'week' ? 12 : 12
  const buckets = getStatsByPeriod(stats, period, lookback)
  const label = period === 'day' ? 'Daily (last 30 days)' : period === 'week' ? 'Weekly (last 12 weeks)' : 'Monthly (last 12 months)'

  const maxSaved = Math.max(...buckets.map(b => b.totalSavedTokens), 1)

  console.log(`\n${C.bold(`cork-ai — ${label}`)}`)
  console.log(divider())
  console.log(`  ${'Period'.padEnd(14)} ${'Sessions'.padStart(8)} ${'Tokens saved'.padStart(13)} ${' Trend'.padEnd(18)} ${'Savings%'.padStart(9)} ${'Cost saved'.padStart(11)}`)
  console.log(divider())

  for (const b of buckets) {
    const barWidth = Math.round((b.totalSavedTokens / maxSaved) * 16)
    const trend = C.green('█'.repeat(barWidth) + '░'.repeat(16 - barWidth))
    console.log(
      `  ${b.label.padEnd(14)} ${String(b.sessionCount).padStart(8)} ` +
      `${C.green(fmtTokens(b.totalSavedTokens).padStart(13))} ` +
      ` ${trend} ` +
      `${C.green(fmtPct(b.avgSavingsPercent).padStart(9))} ` +
      `${C.green(fmtUsdLong(b.totalCostSaved).padStart(11))}`
    )
  }

  if (buckets.length === 0) {
    console.log(`  ${C.dim('No sessions in this period.')}`)
  }

  console.log(divider())
  console.log()
}

function reportProjects(): void {
  const stats = readGlobalStats()
  if (!stats || stats.sessions.length === 0) {
    console.log(`\n${C.yellow('No data yet.')}\n`); return
  }

  const projects = getStatsByProject(stats)
  console.log(`\n${C.bold('cork-ai — Per-Project Breakdown')} (${projects.length} projects)`)
  console.log(divider())
  console.log(`  ${'Project'.padEnd(22)} ${'Sessions'.padStart(8)} ${'Tokens saved'.padStart(13)} ${'Savings%'.padStart(9)} ${'Cost saved'.padStart(11)} ${'Last session'.padStart(14)}`)
  console.log(divider())

  for (const p of projects) {
    const name = p.projectName.slice(0, 21)
    console.log(
      `  ${name.padEnd(22)} ${String(p.sessionCount).padStart(8)} ` +
      `${C.green(fmtTokens(p.totalSavedTokens).padStart(13))} ` +
      `${C.green(fmtPct(p.avgSavingsPercent).padStart(9))} ` +
      `${C.green(fmtUsdLong(p.totalCostSaved).padStart(11))} ` +
      `${C.dim(fmtDate(p.lastSessionAt).padStart(14))}`
    )
  }

  const at = stats.allTime
  const totalPct = at.totalOriginalTokens > 0 ? (at.totalSavedTokens / at.totalOriginalTokens) * 100 : 0
  console.log(divider())
  console.log(
    `  ${'ALL PROJECTS'.padEnd(22)} ${String(stats.sessions.length).padStart(8)} ` +
    `${C.green(fmtTokens(at.totalSavedTokens).padStart(13))} ` +
    `${C.green(fmtPct(totalPct).padStart(9))} ` +
    `${C.green(fmtUsdLong(at.estimatedCostSaved).padStart(11))}`
  )
  console.log()
}

function reportForecast(): void {
  const stats = readGlobalStats()
  if (!stats || stats.sessions.length === 0) {
    console.log(`\n${C.yellow('Not enough data for a forecast. Run a few sessions first.')}\n`); return
  }

  const f = getForecast(stats)
  const at = stats.allTime

  console.log(`\n${C.bold('cork-ai — Cost Projection & ROI')}`)
  console.log(divider())
  console.log(`  ${C.dim('Based on')}       last ${f.basedOnDays} day${f.basedOnDays > 1 ? 's' : ''} of data`)
  console.log(`  ${C.dim('Total sessions')} ${fmt(stats.sessions.length)}`)
  console.log()
  console.log(`  ${C.bold('Historical')}`)
  console.log(`  ${C.dim('Total tokens saved')}   ${C.green(fmt(at.totalSavedTokens))}`)
  console.log(`  ${C.dim('Total cost saved')}     ${C.green(fmtUsdLong(at.estimatedCostSaved))} USD`)
  console.log()
  console.log(`  ${C.bold('Projections')}`)
  console.log(`  ${C.dim('Daily avg')}            ${C.cyan(fmtTokens(f.avgDailyTokensSaved))} tokens — ${C.green(fmtUsd(f.avgDailyCostSaved))} USD`)
  console.log()

  const monthBar = miniBar(Math.min(100, (f.projectedMonthlyCostSaved / Math.max(f.projectedAnnualCostSaved, 0.001)) * 100 * 12))
  const yearBar = miniBar(100)

  console.log(`  ${C.dim('Monthly')}              ${C.green(fmtTokens(f.projectedMonthlyTokensSaved))} tokens`)
  console.log(`                        ${C.green(fmtUsdLong(f.projectedMonthlyCostSaved))} USD saved  ${C.green(monthBar)}`)
  console.log()
  console.log(`  ${C.bold('Annual')}               ${C.green(fmtTokens(f.projectedAnnualTokensSaved))} tokens`)
  console.log(`                        ${C.green(fmtUsdLong(f.projectedAnnualCostSaved))} USD saved  ${C.green(yearBar)}`)
  console.log()

  if (f.projectedAnnualCostSaved > 0) {
    const devCostPerHour = 75
    const setupMinutes = 5
    const setupCost = (setupMinutes / 60) * devCostPerHour
    const roi = ((f.projectedAnnualCostSaved - setupCost) / setupCost) * 100
    const roiColor = roi > 0 ? C.green : C.yellow
    const paybackNote = roi > 0
      ? 'payback in < 1 day'
      : `projection based on ${stats.sessions.length} session${stats.sessions.length !== 1 ? 's' : ''} — grows with usage`

    console.log(`  ${C.dim('ROI estimate (vs. 5-min setup)')}`)
    console.log(`  Setup cost:  ~${fmtUsdLong(setupCost)} (5 min dev time)`)
    console.log(`  Annual gain: ${C.green(fmtUsdLong(f.projectedAnnualCostSaved))} API savings`)
    console.log(`  ${C.bold('ROI:')}        ${roiColor(fmtPct(roi))} — ${paybackNote}`)
  }

  console.log(divider())
  const cfgModel = loadConfig().detectedModel
  const priceNote = cfgModel
    ? `Pricing: ${cfgModel} — $${inputPriceForModel(cfgModel).toFixed(2)}/1M input tokens (auto-detected)`
    : 'Pricing: $3/1M input tokens (Sonnet fallback — no model detected yet)'
  console.log(`  ${C.dim(priceNote)}`)
  console.log()
}

function showModels(): void {
  const stats = readGlobalStats()
  const live = readLiveSession()
  const models = getStatsByModel(stats, live)
  const cfg = loadConfig()

  console.log(`\n${C.bold('cork-ai — Model Usage & Costs')}`)
  console.log(divider())

  if (cfg.detectedModel) {
    console.log(`  ${C.dim('Active model')}  ${C.cyan(cfg.detectedModel)}  ${C.dim(`($${inputPriceForModel(cfg.detectedModel).toFixed(2)}/M input tokens)`)}`)
    console.log()
  }

  if (models.length === 0) {
    console.log(`  ${C.yellow('No per-model data yet.')}`)
    console.log(`  ${C.dim('Model usage is recorded on each compressed Read once the hook is installed.')}`)
    console.log(`  ${C.dim('Older sessions (recorded before per-model tracking) are not included.')}`)
    console.log(divider())
    console.log()
    return
  }

  const totalRequests = models.reduce((s, m) => s + m.requests, 0)
  const totalSaved = models.reduce((s, m) => s + m.savedTokens, 0)
  const totalCost = models.reduce((s, m) => s + m.costSaved, 0)
  const nameWidth = Math.max(...models.map(m => m.model.length), 12) + 2

  for (const m of models) {
    const price = inputPriceForModel(m.model)
    console.log(`  ${C.bold(m.model.padEnd(nameWidth))} ${C.dim(`$${price.toFixed(2)}/MTok`)}`)
    console.log(`    ${C.green(miniBar(m.requestShare))} ${fmtPct(m.requestShare).padStart(6)}  ${C.cyan(fmt(m.requests))} request${m.requests !== 1 ? 's' : ''}`)
    console.log(`    ${C.dim('Saved')} ${C.green(fmtTokens(m.savedTokens))} tokens ${C.dim('→')} ${C.green(fmtUsd(m.costSaved))} USD   ${C.dim('Last used')} ${fmtDate(m.lastUsedAt)}`)
    console.log()
  }

  console.log(divider())
  console.log(`  ${C.bold('Total')}  ${fmt(totalRequests)} requests across ${models.length} model${models.length !== 1 ? 's' : ''} — ${C.green(fmtTokens(totalSaved))} tokens, ${C.green(fmtUsdLong(totalCost))} USD saved`)
  console.log(`  ${C.dim('Costs are computed at each model\'s input price at the time of use.')}`)
  console.log()
}

function reportFull(): void {
  const stats = readGlobalStats()
  if (!stats || stats.sessions.length === 0) {
    console.log(`\n${C.yellow('No sessions recorded yet.')}\n`)
    console.log(`Run ${C.cyan('cork-ai hooks install')} to start tracking.\n`)
    return
  }

  reportPeriod('month')
  reportProjects()
  showModels()
  reportForecast()
}

function reportJson(): void {
  const stats = readGlobalStats()
  if (!stats) { console.log('{}'); return }

  const projects = getStatsByProject(stats)
  const daily = getStatsByPeriod(stats, 'day', 30)
  const weekly = getStatsByPeriod(stats, 'week', 12)
  const monthly = getStatsByPeriod(stats, 'month', 12)
  const forecast = getForecast(stats)
  const models = getStatsByModel(stats, readLiveSession())

  console.log(JSON.stringify({ summary: stats.allTime, models, projects, trends: { daily, weekly, monthly }, forecast, sessions: stats.sessions }, null, 2))
}

// ─── hooks install / remove / status ─────────────────────────────────────────

interface ClaudeSettings {
  hooks?: Record<string, HookGroup[] | undefined>
  autoCompactWindow?: number
  model?: string
  [key: string]: unknown
}

interface HookGroup {
  matcher?: string
  hooks: { type: string; command: string; timeout?: number }[]
}

/**
 * Every hook cork-ai installs. One binary, one `hook` subcommand: the payload's
 * `hook_event_name` and `tool_name` decide what happens.
 *
 *   PreToolUse Read       compress whole-file reads (the original hook)
 *   PreToolUse Bash       same for `cat file` & co — auto mode reads through Bash
 *   PostToolUse Edit…     failed-edit detection, edited-file tracking, context guard
 *   UserPromptSubmit/Stop context guard (band notices to the user and the model)
 */
const CORK_HOOKS: Array<{ event: string; matcher?: string; legacyMatchers?: string[] }> = [
  { event: 'PreToolUse', matcher: 'Read' },
  { event: 'PreToolUse', matcher: 'Bash' },
  { event: 'PostToolUse', matcher: 'Edit|MultiEdit|Write', legacyMatchers: ['Edit|MultiEdit'] },
  { event: 'UserPromptSubmit' },
  { event: 'Stop' },
]
const CORK_HOOK_FALLBACK = 'cork-ai hook'

function loadClaudeSettings(): ClaudeSettings {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf-8')) as ClaudeSettings }
  catch { return {} }
}

function saveClaudeSettings(settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true })
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8')
}

function isCorkCmd(command: string): boolean {
  return command.includes('cork-ai') && command.trim().endsWith('hook')
}

function isCorkHookInstalled(settings: ClaudeSettings): boolean {
  const pre = settings.hooks?.PreToolUse ?? []
  return pre.some(g => g.hooks?.some(h => isCorkCmd(h.command)))
}

/** Which of CORK_HOOKS are present (matcher-exact, or via a legacy matcher). */
function installedCorkHooks(settings: ClaudeSettings): Array<{ event: string; matcher?: string; present: boolean; command?: string }> {
  return CORK_HOOKS.map(spec => {
    const groups = settings.hooks?.[spec.event] ?? []
    const accepted = [spec.matcher, ...(spec.legacyMatchers ?? [])]
    for (const g of groups) {
      const h = g.hooks?.find(h => isCorkCmd(h.command))
      if (!h) continue
      if (spec.matcher === undefined || accepted.includes(g.matcher)) return { ...spec, present: true, command: h.command }
    }
    return { ...spec, present: false }
  })
}

// Resolves the absolute path to the cork-ai binary so the hook
// works even when Claude Code does not inherit the shell PATH (Mac, Electron).
function resolveHookBinary(): string {
  // Standalone compiled binary (bun build --compile): execPath = the binary itself
  const exec = process.execPath
  if (exec && !/\bnode(\.exe)?\b/i.test(path.basename(exec)) && !/\bbun(\.exe)?\b/i.test(path.basename(exec)) && fs.existsSync(exec)) {
    return exec
  }

  // Common installation locations
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'cork-ai'),
    '/usr/local/bin/cork-ai',
    '/opt/homebrew/bin/cork-ai',
    '/usr/bin/cork-ai',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }

  return ''  // fallback: CORK_HOOK_FALLBACK, resolved through PATH
}

/**
 * Makes one hook spec present in the settings. Returns true when something
 * changed: added, migrated from the bare `cork-ai hook` form to the absolute
 * path, migrated from a legacy matcher, or the command path updated.
 */
function ensureHookGroup(settings: ClaudeSettings, spec: { event: string; matcher?: string; legacyMatchers?: string[] }, hookCmd: string): boolean {
  settings.hooks ??= {}
  settings.hooks[spec.event] ??= []
  const groups = settings.hooks[spec.event] as HookGroup[]
  const accepted = [spec.matcher, ...(spec.legacyMatchers ?? [])]

  for (const g of groups) {
    const existing = g.hooks?.find(h => isCorkCmd(h.command))
    if (!existing) continue
    if (spec.matcher !== undefined && !accepted.includes(g.matcher)) continue
    let changed = false
    // Migrate a bare "cork-ai hook" fallback (pre-dates resolveHookBinary())
    // to a resolved absolute path. The bare form depends on Claude Code's
    // hook subprocess inheriting a shell PATH that includes the binary,
    // which isn't guaranteed — it fails as a silent, non-blocking hook error.
    if (existing.command !== hookCmd && hookCmd !== CORK_HOOK_FALLBACK) { existing.command = hookCmd; changed = true }
    if (spec.matcher !== undefined && g.matcher !== spec.matcher) { g.matcher = spec.matcher; changed = true }
    return changed
  }

  const existingGroup = spec.matcher !== undefined ? groups.find(g => g.matcher === spec.matcher) : undefined
  if (existingGroup) {
    existingGroup.hooks.push({ type: 'command', command: hookCmd })
  } else {
    groups.push(spec.matcher !== undefined
      ? { matcher: spec.matcher, hooks: [{ type: 'command', command: hookCmd }] }
      : { hooks: [{ type: 'command', command: hookCmd }] })
  }
  return true
}

async function hooksInstall(): Promise<void> {
  const settings = loadClaudeSettings()

  // Use the absolute binary path so the hook works
  // even if ~/.local/bin is not in Claude Code's PATH (Mac / Electron)
  const binaryPath = resolveHookBinary()
  const hookCmd = binaryPath ? `"${binaryPath}" hook` : CORK_HOOK_FALLBACK

  const changed = CORK_HOOKS.map(spec => ({ spec, changed: ensureHookGroup(settings, spec, hookCmd) })).filter(x => x.changed)

  // The guard is on by default once installed; keep any explicit user choice.
  const cfg = loadConfig()
  if (cfg.contextGuard?.enabled === undefined) saveConfig({ ...cfg, contextGuard: { ...(cfg.contextGuard ?? {}), enabled: true } })

  if (changed.length === 0) {
    console.log(`\n${C.green('✔')}  cork-ai hooks already installed in ${C.cyan(CLAUDE_SETTINGS)}\n`)
    return
  }

  saveClaudeSettings(settings)
  console.log(`\n${C.green('✔')}  cork-ai hooks installed.`)
  for (const { spec } of changed) {
    console.log(`   ${spec.event}${spec.matcher ? ` (${spec.matcher})` : ''} → ${C.cyan(CLAUDE_SETTINGS)}`)
  }
  if (binaryPath) console.log(`   Binary: ${C.dim(binaryPath)}`)
  console.log()
  console.log(`   ${C.dim('Read / Bash:')} whole-file reads (Read tool, cat, …) get a numbered outline when it pays off.`)
  console.log(`   ${C.dim('Context guard:')} a notice at 150k / 300k / 500k / 750k tokens of context — the cost that matters.`)
  console.log(`   ${C.dim('Check:')} ${C.cyan('cork-ai doctor')}   ${C.dim('Report:')} ${C.cyan('cork-ai context')}`)
  console.log()

  if (cfg.telemetry === undefined) await askTelemetryConsent(cfg)

  console.log(`   Restart Claude Code for the hooks to take effect.`)
  console.log(`   Run ${C.cyan('cork-ai gain')} after sessions to see savings.\n`)
}

async function askTelemetryConsent(cfg: CorkConfig): Promise<void> {
  const prompt = `   ${C.dim('Help improve cork-ai? Send anonymous compression stats (no file paths, no content).')} [y/N]: `

  // Attempt 1: interactive stdin
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>(resolve => {
      rl.question(prompt, a => { rl.close(); resolve(a.trim().toLowerCase()) })
    })
    applyTelemetryChoice(cfg, answer)
    return
  }

  // Attempt 2: /dev/tty (works when stdin is piped, e.g. curl | sh)
  if (process.platform !== 'win32') {
    try {
      const tty = fs.openSync('/dev/tty', 'r+')

      // Write prompt directly to terminal
      fs.writeSync(tty, '\n' + prompt)
      const buf = Buffer.alloc(64)
      const n = fs.readSync(tty, buf, 0, 63, null)
      fs.closeSync(tty)
      const answer = buf.subarray(0, n).toString().trim().toLowerCase()
      applyTelemetryChoice(cfg, answer)
      return
    } catch { /* /dev/tty unavailable (CI, container) */ }
  }

  // No interactivity: telemetry disabled by default
  saveConfig({ ...loadConfig(), telemetry: false })
  console.log(`   ${C.dim('Telemetry off by default. Enable later: cork-ai telemetry on')}`)
}

function applyTelemetryChoice(cfg: CorkConfig, answer: string): void {
  const opted = answer === 'y' || answer === 'yes'
  saveConfig({ ...loadConfig(), ...cfg, telemetry: opted })
  if (opted) {
    console.log(`   ${C.green('✔')}  Telemetry enabled — thank you! Run ${C.cyan('cork-ai telemetry off')} to disable.`)
  } else {
    console.log(`   ${C.dim('Telemetry off. Enable later with: cork-ai telemetry on')}`)
  }
  console.log()
}

function hooksRemove(): void {
  const settings = loadClaudeSettings()
  if (!isCorkHookInstalled(settings)) {
    console.log(`\n${C.yellow('cork-ai hook not found in settings.')}\n`); return
  }

  for (const eventName of Object.keys(settings.hooks ?? {})) {
    const groups = settings.hooks?.[eventName] ?? []
    for (const group of groups) {
      group.hooks = group.hooks.filter(h => !isCorkCmd(h.command))
    }
    if (settings.hooks) {
      const kept = groups.filter(g => g.hooks.length > 0)
      if (kept.length > 0) settings.hooks[eventName] = kept
      else delete settings.hooks[eventName]
    }
  }

  saveClaudeSettings(settings)
  console.log(`\n${C.green('✔')}  cork-ai hooks removed from ${C.cyan(CLAUDE_SETTINGS)}\n`)
  console.log(`   Restart Claude Code to apply.\n`)
}

function hooksStatus(): void {
  const settings = loadClaudeSettings()
  const installed = isCorkHookInstalled(settings)
  console.log()
  console.log(`  cork-ai hooks: ${installed ? C.green('● installed') : C.yellow('○ not installed')}`)
  console.log(`  Settings file: ${C.dim(CLAUDE_SETTINGS)}`)
  if (installed) {
    let missing = 0
    for (const h of installedCorkHooks(settings)) {
      const label = `${h.event}${h.matcher ? ` (${h.matcher})` : ''}`
      if (h.present) console.log(`  ${C.green('●')} ${label.padEnd(36)} ${C.dim(h.command ?? '')}`)
      else { console.log(`  ${C.yellow('○')} ${label.padEnd(36)} ${C.yellow('missing')}`); missing++ }
    }
    if (missing > 0) console.log(`\n  Run ${C.cyan('cork-ai hooks install')} to add the missing hooks (upgrade from an older install).`)
  } else {
    console.log(`\n  Run ${C.cyan('cork-ai hooks install')} to enable Claude Code integration.`)
  }
  console.log()
}

// ─── hook (PreToolUse handler called by Claude Code) ─────────────────────────

// Shared calibrated estimator (chars-based fast path, same unit as the
// library's tiktoken path thanks to ~/.cork-ai/calibration.json).
function estimateTokens(text: string): number {
  return estimateTokensFast(text)
}

// ─── Per-session read tracking (re-read = compression harmed the model) ──────

interface SessionReads {
  /** filePath → times served compressed this session */
  files: Record<string, number>
  /** filePath → ISO time of the last edit seen this session (Edit/Write tool, sed -i, redirection) */
  edited?: Record<string, string>
}

function readsFileFor(sessionId: string): string {
  const safe = sessionId.replace(/[^\w.-]/g, '_').slice(0, 80)
  return path.join(LIVE_DIR, `reads-${safe}.json`)
}

function loadSessionReads(sessionId: string): SessionReads {
  try {
    const parsed = JSON.parse(fs.readFileSync(readsFileFor(sessionId), 'utf-8')) as SessionReads
    return parsed && typeof parsed.files === 'object' ? parsed : { files: {} }
  } catch {
    return { files: {} }
  }
}

function saveSessionReads(sessionId: string, reads: SessionReads): void {
  try {
    fs.mkdirSync(LIVE_DIR, { recursive: true })
    fs.writeFileSync(readsFileFor(sessionId), JSON.stringify(reads), 'utf-8')
  } catch { /* non-critical */ }
}

function markEdited(sessionId: string, filePath: string): void {
  if (!sessionId || !filePath) return
  const reads = loadSessionReads(sessionId)
  reads.edited ??= {}
  reads.edited[filePath] = new Date().toISOString()
  // A file that was served compressed and then edited: the model needed the
  // real content after all. Learn it for the extension.
  if (reads.files[filePath]) recordEditAfter(filePath)
  saveSessionReads(sessionId, reads)
}

// ─── Heartbeat (proof that Claude Code still calls us) ───────────────────────

export const HEARTBEAT_FILE = path.join(CORK_HOME, 'heartbeat.json')

interface Heartbeat {
  at: string
  sessionId: string
  event: string
  toolName?: string
  permissionMode?: string
  claudeVersion?: string
  corkVersion: string
}

function readHeartbeat(): Heartbeat | undefined {
  try { return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf-8')) as Heartbeat } catch { return undefined }
}

/** Claude Code stamps every transcript line with its own `version`. */
function claudeVersionFromTranscript(transcriptPath?: string): string | undefined {
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

/**
 * Written on every hook event, at most once a minute per session. `gain` and
 * `doctor` compare it with the transcripts: sessions that ran without a
 * heartbeat mean Claude Code is no longer calling the hook — the failure mode
 * that stayed invisible for weeks when auto mode moved reads to Bash.
 */
function writeHeartbeat(event: Record<string, unknown>): void {
  try {
    const sessionId = (event.session_id as string) || ''
    const prev = readHeartbeat()
    if (prev && prev.sessionId === sessionId && Date.now() - new Date(prev.at).getTime() < 60_000) return
    const beat: Heartbeat = {
      at: new Date().toISOString(),
      sessionId,
      event: (event.hook_event_name as string) ?? '',
      toolName: event.tool_name as string | undefined,
      permissionMode: event.permission_mode as string | undefined,
      claudeVersion: claudeVersionFromTranscript(event.transcript_path as string | undefined) ?? prev?.claudeVersion,
      corkVersion: VERSION,
    }
    fs.mkdirSync(CORK_HOME, { recursive: true })
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(beat), 'utf-8')
  } catch { /* non-critical */ }
}

// ─── Hook output ─────────────────────────────────────────────────────────────

/**
 * Deny the tool call and hand the compressed view back as the reason. Claude
 * Code shows `permissionDecisionReason` to the model in place of the tool
 * result. The legacy top-level `decision: "block"` is kept for older versions;
 * when both are present `hookSpecificOutput` takes precedence.
 */
function denyWith(reason: string): void {
  console.log(JSON.stringify({
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
}

// PostToolUse on Edit: an Edit that fails on a file we only ever served
// compressed means the model's old_string came from the outline, not the real
// file — direct compression harm. Count it and auto-whitelist the file.
// Failure detection is best-effort (matches Claude Code's known Edit errors);
// if the payload shape differs, this is a silent no-op.
const EDIT_FAILURE_MARKERS =
  /String to replace not found|matches of the string to replace|has not been read yet|"is_error"\s*:\s*true/i

function handlePostToolUseEdit(event: Record<string, unknown>): void {
  const toolName = (event.tool_name as string) ?? ''
  if (toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write') return
  const toolInput = (event.tool_input as Record<string, unknown>) ?? {}
  const filePath = toolInput.file_path as string
  const sessionId = (event.session_id as string) || ''
  if (!filePath || !sessionId) return

  const reads = loadSessionReads(sessionId)
  const wasCompressed = Boolean(reads.files[filePath])
  markEdited(sessionId, filePath)
  if (!wasCompressed) return  // file was never served compressed — not our fault

  let respText = ''
  try { respText = JSON.stringify(event.tool_response ?? '') } catch { return }
  if (!EDIT_FAILURE_MARKERS.test(respText)) return

  // Whitelist: the next Read of this file is served raw so the retry can work
  // from the real content — permanently, not just for this session. A failed
  // Edit is the strongest possible evidence that the outline was not enough.
  const fresh = loadSessionReads(sessionId)
  fresh.files[filePath] = (fresh.files[filePath] ?? 0) + 1
  saveSessionReads(sessionId, fresh)
  markSkipped(filePath, 'edit-failure')

  try {
    accumulateInSession({
      projectPath: (event.cwd as string) || process.cwd(),
      originalTokens: 0,
      compressedTokens: 0,
      savedTokens: 0,
      estimatedCostSaved: 0,
      byModule: {},
      model: loadConfig().detectedModel,
      sessionId,
      editFailure: true,
    })
  } catch { /* non-critical */ }
}

// ─── Read handling (Read tool and Bash equivalents share one path) ───────────

interface ReadContext {
  event: Record<string, unknown>
  filePath: string
  /** 'Read' or the shell command word ('cat', …) — for the byModule breakdown. */
  source: string
}

/** Books the induced cost of a re-read against the session and learns from it. */
function accountReRead(ctx: ReadContext, sessionId: string, rawTokens: number, detectedModel?: string): void {
  markSkipped(ctx.filePath, 're-read')
  recordReRead(ctx.filePath)
  try {
    accumulateInSession({
      projectPath: (ctx.event.cwd as string) || process.cwd(),
      originalTokens: 0,
      compressedTokens: 0,
      savedTokens: 0,
      // The second read only exists because the first one was compressed —
      // its full raw cost is induced by us. Deduct it.
      estimatedCostSaved: -(rawTokens / 1_000_000) * inputPriceForModel(detectedModel),
      byModule: {},
      model: detectedModel,
      sessionId,
      reRead: true,
      reReadTokensServed: rawTokens,
    })
  } catch { /* non-critical */ }
}

/**
 * A targeted read (sed -n, head, tail, Read with offset/limit) of a file that
 * was served compressed this session: the outline pointed the model at a
 * region and it read just that. This is the intended follow-up, so it is
 * recorded for the record but does *not* count against the extension — only
 * a full re-read does. The file stays whitelisted for the session either way:
 * the model has shown it is working on it.
 */
function noteRangeRead(event: Record<string, unknown>, filePath: string): void {
  const sessionId = (event.session_id as string) || ''
  if (!sessionId) return
  const reads = loadSessionReads(sessionId)
  if (reads.files[filePath] !== 1) return   // not compressed this session, or already noted
  reads.files[filePath] = 2
  saveSessionReads(sessionId, reads)
  recordRangeRead(filePath)
}

function handleRead(ctx: ReadContext): void {
  const { event, filePath } = ctx

  // Never compress the file the user is explicitly asking about — the model
  // almost certainly needs its real content, and a compressed view forces a
  // re-read round-trip that costs more than the compression saves.
  const userPrompt = lastUserPromptFromTranscript(event.transcript_path as string | undefined)
  if (userPrompt && userPrompt.toLowerCase().includes(path.basename(filePath).toLowerCase())) return

  // A file that already proved it needs its real content is served raw for
  // good — the lesson outlives the session that learned it.
  if (isSkipped(filePath)) return

  const sessionId = (event.session_id as string) || ''
  const reads = sessionId ? loadSessionReads(sessionId) : null

  // A file the model is editing in this session is served raw: every measured
  // edit flow (59% of compressed files, 97% of .tsx) ended in a full re-read.
  if (reads?.edited?.[filePath]) return

  // Read bytes, not a utf-8 string. `readFileSync(png, 'utf-8')` does not
  // throw: it returns mojibake that passes every downstream check, which is
  // how images ended up being "compressed" into binary garbage.
  let buf: Buffer
  try { buf = fs.readFileSync(filePath) } catch { return }

  const verdict = eligibility(filePath, buf)
  if (!verdict.compress) return

  const content = buf.toString('utf-8')
  const lines = content.split('\n')
  const slice = lines.slice(0, 2000).join('\n')

  const ext = path.extname(filePath).toLowerCase() || 'none'
  const originalTokens = estimateTokens(slice)

  const cfg = loadConfig()
  const turn = lastMainTurnUsage(event.transcript_path as string | undefined)
  const detectedModel = turn?.model || (event.model as string) || cfg.detectedModel

  // Re-read of a file we already compressed this session: the compressed view
  // wasn't enough for the model. Serve it raw, auto-whitelist it, and account
  // the induced cost against our savings.
  if (reads && reads.files[filePath]) {
    reads.files[filePath] += 1
    saveSessionReads(sessionId, reads)
    accountReRead(ctx, sessionId, originalTokens, detectedModel)
    return  // passthrough: Claude gets the raw file
  }

  const telemetrySkip = (compressType: string) => {
    if (isTelemetryEnabled()) sendTelemetry({ v: VERSION, os: process.platform, arch: process.arch, savings_pct: 0, file_ext: ext, compress_type: compressType, skipped: true })
  }

  const view = outline(slice, filePath, verdict.kind)
  const compressedTokens = estimateTokens(view.text)
  if (compressedTokens >= originalTokens * 0.85) { telemetrySkip(verdict.kind); return }

  // The expected-value gate: is this compression worth the re-read risk, given
  // the live context size and what this extension has done before?
  const decision = gate({
    filePath,
    originalTokens,
    compressedTokens,
    contextTokens: turn?.contextTokens ?? 0,
    model: detectedModel,
    amplification: cfg.measuredAmplification,
  })
  if (!decision.compress) { telemetrySkip(verdict.kind); return }

  const saved = originalTokens - compressedTokens
  const savingsPct = Math.round((saved / originalTokens) * 1000) / 10

  // Remember we served this file compressed — a re-read in the same session
  // will be served raw (auto-whitelist) and counted as compression harm.
  if (reads && sessionId) {
    reads.files[filePath] = 1
    saveSessionReads(sessionId, reads)
  }
  recordCompression(filePath)

  try {
    if (detectedModel && cfg.detectedModel !== detectedModel) saveConfig({ ...cfg, detectedModel })
    const moduleName = ctx.source === 'Read' ? 'hookReadCompressor' : 'hookBashReadCompressor'
    accumulateInSession({
      projectPath: (event.cwd as string) || process.cwd(),
      originalTokens,
      compressedTokens,
      savedTokens: saved,
      estimatedCostSaved: (saved / 1_000_000) * inputPriceForModel(detectedModel),
      byModule: { [moduleName]: saved },
      model: detectedModel,
      sessionId: sessionId || undefined,
    })
  } catch { /* non-critical */ }

  if (isTelemetryEnabled()) {
    sendTelemetry({ v: VERSION, os: process.platform, arch: process.arch, savings_pct: savingsPct, file_ext: ext, compress_type: verdict.kind, skipped: false })
  }

  denyWith(view.text)
}

function handleBash(event: Record<string, unknown>): void {
  const command = ((event.tool_input as Record<string, unknown>)?.command as string) ?? ''
  const cwd = (event.cwd as string) || process.cwd()
  const sessionId = (event.session_id as string) || ''

  const edit = parseBashEdit(command, cwd)
  if (edit) { markEdited(sessionId, edit.file); return }

  const read = parseBashRead(command, cwd)
  if (!read) return
  if (read.kind === 'range') { noteRangeRead(event, read.file); return }
  handleRead({ event, filePath: read.file, source: read.tool })
}

function runGuard(event: Record<string, unknown>, hookEvent: 'UserPromptSubmit' | 'PostToolUse' | 'Stop' | 'SessionStart'): void {
  const cfg = loadConfig()
  const notice = evaluateGuard({
    sessionId: (event.session_id as string) || '',
    transcriptPath: event.transcript_path as string | undefined,
    event: hookEvent,
    config: cfg.contextGuard,
  })
  if (notice) console.log(JSON.stringify(guardHookOutput(notice, hookEvent, cfg.contextGuard?.nudgeModel !== false)))
}

async function runHook(): Promise<void> {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  if (!input.trim()) process.exit(0)

  let event: Record<string, unknown>
  try { event = JSON.parse(input) as Record<string, unknown> } catch { process.exit(0) }

  const toolName = (event.tool_name as string) ?? ''
  const toolInput = (event.tool_input as Record<string, unknown>) ?? {}
  const hookEvent = (event.hook_event_name as string) ?? ''

  writeHeartbeat(event)

  if (hookEvent === 'PostToolUse') {
    handlePostToolUseEdit(event)
    runGuard(event, 'PostToolUse')
    process.exit(0)
  }
  if (hookEvent === 'UserPromptSubmit' || hookEvent === 'Stop' || hookEvent === 'SessionStart') {
    runGuard(event, hookEvent)
    process.exit(0)
  }
  if (hookEvent !== 'PreToolUse') process.exit(0)

  if (toolName === 'Bash') {
    handleBash(event)
    process.exit(0)
  }
  if (toolName !== 'Read') process.exit(0)

  const filePath = toolInput.file_path as string
  if (!filePath) process.exit(0)

  // Explicit offset/limit = the model is targeting a precise zone (often to
  // recover content hidden by a previous compression). Never compress those.
  if (toolInput.offset !== undefined || toolInput.limit !== undefined) {
    noteRangeRead(event, filePath)
    process.exit(0)
  }

  handleRead({ event, filePath, source: 'Read' })
}

// ─── context (the report that explains the bill) ─────────────────────────────

/** `200k`, `1M`, `200` (thousands) or a plain token count → tokens. */
function parseTokenCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(raw.trim())
  if (!m) return undefined
  const n = Number(m[1])
  if (m[2]?.toLowerCase() === 'k') return Math.round(n * 1_000)
  if (m[2]?.toLowerCase() === 'm') return Math.round(n * 1_000_000)
  return n <= 1000 ? Math.round(n * 1_000) : Math.round(n)
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  return args[i + 1]
}

function setAutoCompactWindow(tokens: number): void {
  if (tokens < 100_000 || tokens > 1_000_000) {
    console.error(`\n${C.yellow('autoCompactWindow must be between 100k and 1M tokens.')}\n`)
    process.exit(1)
  }
  const settings = loadClaudeSettings()
  const before = settings.autoCompactWindow
  settings.autoCompactWindow = tokens
  saveClaudeSettings(settings)
  console.log(`\n${C.green('✔')}  autoCompactWindow set to ${C.cyan(fmtTokens(tokens))} tokens in ${C.dim(CLAUDE_SETTINGS)}` +
    (before ? ` ${C.dim(`(was ${fmtTokens(before)})`)}` : ''))
  console.log(`   Claude Code compacts automatically once the context reaches it. Takes effect on the next session;`)
  console.log(`   ${C.dim('/autocompact auto')} in Claude Code restores the model default.\n`)
}

function showContext(args: string[]): void {
  const setRaw = flagValue(args, '--set-autocompact')
  if (setRaw !== undefined) {
    const tokens = parseTokenCount(setRaw)
    if (!tokens) { console.error(`\nUsage: cork-ai context --set-autocompact 200k\n`); process.exit(1) }
    setAutoCompactWindow(tokens)
    return
  }

  const days = Number(flagValue(args, '--days') ?? 30)
  const ceiling = parseTokenCount(flagValue(args, '--ceiling')) ?? 200_000
  const ceilings = [...new Set([150_000, 200_000, 300_000, ceiling])].sort((a, b) => a - b)
  const since = new Date(Date.now() - days * 86_400_000)
  const report = contextReport({ since, ceilings, minTurns: 20 })
  const settings = loadClaudeSettings()

  console.log(`\n${C.bold('cork-ai — Context')} ${C.dim(`(Claude Code transcripts · last ${days} days · sessions ≥ 20 turns)`)}`)
  console.log(divider())
  if (report.sessions.length === 0) {
    console.log(`  ${C.yellow('No session with 20+ turns in this window.')}\n`)
    return
  }

  const cacheShare = report.costUSD > 0 ? (report.cacheReadCostUSD / report.costUSD) * 100 : 0
  console.log(`  ${C.dim('Sessions')}            ${fmt(report.sessions.length)}  ${C.dim(`· ${fmt(report.turns)} turns`)}`)
  console.log(`  ${C.dim('Spend')}               ${C.yellow(fmtUsdLong(report.costUSD))} USD`)
  console.log(`  ${C.dim('Of which cache reads')} ${C.yellow(fmtUsdLong(report.cacheReadCostUSD))} USD ${C.dim(`(${fmtPct(cacheShare)} — the context re-read on every turn)`)}`)
  console.log(`  ${C.dim('Average context')}     ${C.cyan(fmtTokens(report.avgContextTokens))} tokens per turn`)
  console.log()
  console.log(`  ${C.bold('Same work with auto-compaction at')}`)
  for (const c of ceilings) {
    const capped = report.cappedCostUSD[c]
    const saving = report.costUSD - capped
    const pct = report.costUSD > 0 ? (saving / report.costUSD) * 100 : 0
    const mark = c === ceiling ? C.cyan('▶') : ' '
    console.log(`   ${mark} ${fmtTokens(c).padStart(5)}  ${fmtUsdLong(capped).padStart(9)} USD  ${saving > 0 ? C.green(`−${fmtUsdLong(saving)} (−${fmtPct(pct)})`) : C.dim('no change')}`)
  }
  console.log(`  ${C.dim('Replay: each turn re-billed with the context compacted at the ceiling (compaction cost included). A lower bound —')}`)
  console.log(`  ${C.dim('a compacted session also grows slower. Lost detail after /compact is the trade-off; 200k is the classic Claude Code window.')}`)
  console.log()

  console.log(`  ${'Date'.padEnd(13)}${'Project'.padEnd(20)}${'Model'.padEnd(13)}${'Turns'.padStart(6)}${'Avg ctx'.padStart(9)}${'Max'.padStart(7)}${'Cost'.padStart(9)}${`@${fmtTokens(ceiling)}`.padStart(9)}`)
  console.log(`  ${C.dim('─'.repeat(86))}`)
  for (const s of report.sessions.slice(0, 15)) {
    const date = s.startedAt ? new Date(s.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?'
    const project = s.project.replace(/^-home-[^-]+-projects-/, '').replace(/^-/, '').slice(0, 19)
    const model = s.model.replace(/^claude-/, '').slice(0, 12)
    const ctxColour = s.avgContextTokens > 400_000 ? C.red : s.avgContextTokens > 200_000 ? C.yellow : C.green
    console.log(
      `  ${date.padEnd(13)}${project.padEnd(20)}${model.padEnd(13)}${fmt(s.turns).padStart(6)}` +
      `${ctxColour(fmtTokens(s.avgContextTokens).padStart(9))}${fmtTokens(s.maxContextTokens).padStart(7)}` +
      `${fmtUsdLong(s.costUSD).padStart(9)}${C.green(fmtUsdLong(s.cappedCostUSD[ceiling]).padStart(9))}`,
    )
  }
  if (report.sessions.length > 15) console.log(`  ${C.dim(`… ${report.sessions.length - 15} more sessions`)}`)
  console.log()

  console.log(`  ${C.bold('Settings')}`)
  const acw = settings.autoCompactWindow
  console.log(`  ${C.dim('autoCompactWindow')}   ${acw ? C.green(`${fmtTokens(acw)} tokens`) : C.yellow('unset — compaction only near the model limit (1M on [1m] / Fable / Sonnet 5)')}`)
  if (settings.model) console.log(`  ${C.dim('model')}               ${C.cyan(String(settings.model))}${/\[1m\]/.test(String(settings.model)) ? C.dim('  (1M variant: the context can grow 5× past 200k)') : ''}`)
  console.log()
  console.log(`  ${C.bold('Recommendation')}`)
  if (!acw || acw > ceiling) {
    console.log(`  ${C.green('▶')} ${C.cyan(`cork-ai context --set-autocompact ${fmtTokens(ceiling)}`)}  ${C.dim(`or /autocompact ${fmtTokens(ceiling)} inside Claude Code`)}`)
  } else {
    console.log(`  ${C.green('✔')} auto-compaction already at ${fmtTokens(acw)} — the guard notices at 150k+ are your early warning.`)
  }
  console.log(`  ${C.dim('•')} /clear between unrelated tasks; /compact at a natural stopping point rather than at the limit.`)
  console.log(`  ${C.dim('•')} Read line ranges, not whole files; batch shell commands; let subagents absorb exploratory reads.`)
  console.log(divider())
  console.log()
}

// ─── doctor (is cork-ai actually running?) ───────────────────────────────────

interface CoverageRow {
  sessionId: string
  project: string
  startedAt?: string
  turns: number
  reads: number
  bashReads: number
  seen: boolean
  claudeVersion?: string
  permissionMode?: string
}

/**
 * Sessions Claude Code ran versus sessions cork-ai heard about. The gap is the
 * diagnosis: a session with hundreds of Bash reads and no cork-ai event means
 * the hook is not wired for the tool the model actually uses.
 */
function coverage(days = 14): CoverageRow[] {
  const since = new Date(Date.now() - days * 86_400_000)
  const stats = readGlobalStats()
  const known = new Set<string>((stats?.sessions ?? []).map(s => s.sessionId))
  let liveIds: string[] = []
  try { liveIds = fs.readdirSync(LIVE_DIR).map(f => f.replace(/^reads-|^guard-/, '').replace(/\.json$/, '')) } catch { /* none */ }
  for (const id of liveIds) known.add(id)

  const rows: CoverageRow[] = []
  for (const file of listTranscriptFiles(since)) {
    if (file.sidechain) continue
    let raw: string
    try { raw = fs.readFileSync(file.path, 'utf-8') } catch { continue }
    let turns = 0, reads = 0, bashReads = 0
    let startedAt: string | undefined
    let claudeVersion: string | undefined
    let permissionMode: string | undefined
    const seenIds = new Set<string>()
    for (const line of raw.split('\n')) {
      if (!line.includes('"assistant"')) continue
      let entry: { type?: string; isSidechain?: boolean; timestamp?: string; version?: string; permissionMode?: string; message?: { id?: string; content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> } }
      try { entry = JSON.parse(line) } catch { continue }
      if (entry.type !== 'assistant' || entry.isSidechain) continue
      const id = entry.message?.id
      if (id && !seenIds.has(id)) { seenIds.add(id); turns++ }
      startedAt ??= entry.timestamp
      claudeVersion = entry.version ?? claudeVersion
      permissionMode = entry.permissionMode ?? permissionMode
      for (const block of entry.message?.content ?? []) {
        if (block.type !== 'tool_use') continue
        if (block.name === 'Read') reads++
        else if (block.name === 'Bash' && /(?:^|[;&|]\s*)(?:rtk proxy )?(?:cat|sed -n|head|tail|nl|bat)\b/.test(String(block.input?.command ?? ''))) bashReads++
      }
    }
    if (turns < 5) continue
    rows.push({ sessionId: file.sessionId, project: file.project, startedAt, turns, reads, bashReads, seen: known.has(file.sessionId), claudeVersion, permissionMode })
  }
  return rows.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
}

function selfTestHook(binary: string): { ok: boolean; detail: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-doctor-'))
  try {
    const sample = path.join(home, 'sample.ts')
    const body: string[] = ["import fs from 'fs'", '']
    for (let i = 0; i < 60; i++) {
      body.push(`export function handler${i}(input: string, options: { retries: number; verbose: boolean }): Promise<string> {`)
      body.push(`  const value = input.trim().toLowerCase().split(',').map(s => s.trim()).filter(Boolean)`)
      body.push(`  if (options.verbose) console.log('handler${i}', value, options.retries)`)
      body.push(`  return Promise.resolve(value.join(';'))`)
      body.push('}', '')
    }
    fs.writeFileSync(sample, body.join('\n'))
    const payload = JSON.stringify({
      session_id: 'doctor-self-test', transcript_path: path.join(home, 'none.jsonl'), cwd: home,
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: sample },
    })
    const res = spawnSync(binary, ['hook'], { input: payload, encoding: 'utf-8', timeout: 15_000, env: { ...process.env, CORK_AI_HOME: home } })
    if (res.error) return { ok: false, detail: `spawn failed: ${res.error.message}` }
    if (res.status !== 0) return { ok: false, detail: `exit ${res.status}: ${(res.stderr || '').slice(0, 200)}` }
    let out: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
    try { out = JSON.parse(res.stdout.trim()) } catch { return { ok: false, detail: `no JSON on stdout (${res.stdout.slice(0, 80) || 'empty'})` } }
    if (out.hookSpecificOutput?.permissionDecision !== 'deny') return { ok: false, detail: 'hook did not return a deny decision' }
    if (!out.hookSpecificOutput.permissionDecisionReason?.includes('[cork-ai]')) return { ok: false, detail: 'reason is not a cork-ai outline' }
    return { ok: true, detail: `outline served (${out.hookSpecificOutput.permissionDecisionReason.length} chars)` }
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* temp */ }
  }
}

function runDoctor(): void {
  const okMark = C.green('✔')
  const badMark = C.red('✗')
  const warnMark = C.yellow('!')
  let problems = 0

  console.log(`\n${C.bold('cork-ai doctor')} v${VERSION}`)
  console.log(divider())

  // 1. Binary
  const binary = resolveHookBinary()
  if (binary) {
    let executable = true
    try { fs.accessSync(binary, fs.constants.X_OK) } catch { executable = false }
    console.log(`  ${executable ? okMark : badMark} Binary        ${C.dim(binary)}${executable ? '' : C.red('  not executable')}`)
    if (!executable) problems++
  } else {
    console.log(`  ${warnMark} Binary        not found in the usual locations — hooks fall back to PATH lookup (fragile)`)
    problems++
  }

  // 2. Hooks in settings
  const settings = loadClaudeSettings()
  const hooks = installedCorkHooks(settings)
  const missing = hooks.filter(h => !h.present)
  console.log(`  ${missing.length === 0 ? okMark : badMark} Hooks         ${hooks.length - missing.length}/${hooks.length} installed in ${C.dim(CLAUDE_SETTINGS)}`)
  for (const h of missing) console.log(`      ${C.yellow('missing')} ${h.event}${h.matcher ? ` (${h.matcher})` : ''}`)
  if (missing.length > 0) { problems++; console.log(`      → ${C.cyan('cork-ai hooks install')}`) }
  const stale = hooks.filter(h => h.present && h.command && h.command !== CORK_HOOK_FALLBACK && binary && !h.command.includes(binary))
  if (stale.length > 0) {
    console.log(`      ${C.yellow('!')} ${stale.length} hook(s) point at another binary path than ${C.dim(binary)} — ${C.cyan('cork-ai hooks install')} re-targets them`)
  }

  // 3. Other hooks on the same matchers
  for (const spec of CORK_HOOKS.filter(h => h.event === 'PreToolUse')) {
    const others = (settings.hooks?.PreToolUse ?? [])
      .filter(g => g.matcher === spec.matcher)
      .flatMap(g => g.hooks.filter(h => !isCorkCmd(h.command)).map(h => h.command))
    if (others.length > 0) {
      console.log(`  ${warnMark} Neighbours    ${others.length} other PreToolUse hook(s) on ${spec.matcher}: ${C.dim(others.map(o => o.split(' ').slice(-1)[0]).join(', '))}`)
      console.log(`      ${C.dim('If one of them blocks reads (e.g. a read cache), both views may be sent; not a cork-ai failure, but worth knowing.')}`)
    }
  }

  // 4. Self-test
  if (binary) {
    const test = selfTestHook(binary)
    console.log(`  ${test.ok ? okMark : badMark} Self-test     ${test.detail}`)
    if (!test.ok) problems++
  }

  // 5. Heartbeat
  const beat = readHeartbeat()
  if (beat) {
    const ageMin = Math.round((Date.now() - new Date(beat.at).getTime()) / 60_000)
    const age = ageMin < 60 ? `${ageMin} min ago` : ageMin < 60 * 48 ? `${Math.round(ageMin / 60)} h ago` : `${Math.round(ageMin / 1440)} days ago`
    console.log(`  ${okMark} Heartbeat     last hook event ${age} ${C.dim(`(${beat.event}${beat.toolName ? ' ' + beat.toolName : ''} · Claude Code ${beat.claudeVersion ?? '?'}${beat.permissionMode ? ' · ' + beat.permissionMode + ' mode' : ''} · cork-ai ${beat.corkVersion})`)}`)
  } else {
    console.log(`  ${warnMark} Heartbeat     no hook event recorded yet ${C.dim('(this file appears after the first Read/Bash/Edit in a session started after install)')}`)
  }

  // 6. Coverage
  const rows = coverage(14)
  const unseen = rows.filter(r => !r.seen)
  const totalReads = rows.reduce((s, r) => s + r.reads, 0)
  const totalBash = rows.reduce((s, r) => s + r.bashReads, 0)
  if (rows.length === 0) {
    console.log(`  ${C.dim('·')} Coverage      no Claude Code session with 5+ turns in the last 14 days`)
  } else {
    const mark = unseen.length === 0 ? okMark : unseen.length === rows.length ? badMark : warnMark
    console.log(`  ${mark} Coverage      ${rows.length - unseen.length}/${rows.length} sessions (14 days) produced cork-ai events · reads: ${fmt(totalReads)} via Read, ${fmt(totalBash)} via Bash (cat/sed/head)`)
    for (const r of rows.slice(0, 8)) {
      const date = r.startedAt ? new Date(r.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?'
      const project = r.project.replace(/^-home-[^-]+-projects-/, '').replace(/^-/, '').slice(0, 22)
      console.log(`      ${r.seen ? C.green('●') : C.red('○')} ${date.padEnd(7)} ${project.padEnd(23)} ${fmt(r.turns).padStart(5)} turns  ${fmt(r.reads).padStart(4)} Read  ${fmt(r.bashReads).padStart(4)} Bash-read  ${C.dim(`${r.claudeVersion ?? ''}${r.permissionMode ? ' ' + r.permissionMode : ''}`)}`)
    }
    if (unseen.length === rows.length) problems++
    if (totalBash > totalReads && !hooks.find(h => h.matcher === 'Bash')?.present) {
      console.log(`      ${C.red('→')} the model reads through Bash (auto mode) and the Bash hook is missing: ${C.cyan('cork-ai hooks install')}`)
    }
  }

  // 7. Context settings
  const acw = settings.autoCompactWindow
  const model = String(settings.model ?? '')
  if (acw) console.log(`  ${okMark} Compaction    autoCompactWindow = ${fmtTokens(acw)} tokens`)
  else console.log(`  ${warnMark} Compaction    autoCompactWindow unset${/\[1m\]/.test(model) ? ` and model is ${model} — contexts can reach 1M` : ''}: ${C.cyan('cork-ai context')} shows what that costs`)
  const guard = loadConfig().contextGuard
  console.log(`  ${guard?.enabled === false ? warnMark : okMark} Guard         context guard ${guard?.enabled === false ? C.yellow('off') : C.green('on')} ${C.dim(`(bands ${(guard?.bands ?? [150_000, 300_000, 500_000, 750_000]).map(fmtTokens).join(' / ')})`)}`)

  // 8. Policy
  const policy = policySummary()
  const onProbation = policy.filter(p => p.probation)
  if (policy.length > 0) {
    console.log(`  ${okMark} Policy        ${policy.length} extension(s) learned` + (onProbation.length > 0 ? `, ${onProbation.length} on probation: ${C.dim(onProbation.map(p => `${p.ext} ${Math.round(p.reReadRate * 100)}%`).join(', '))}` : ''))
  }

  console.log(divider())
  if (problems === 0) console.log(`  ${C.green('All good.')} cork-ai is wired and being called.\n`)
  else console.log(`  ${C.yellow(`${problems} problem(s) found.`)} Fix them above, restart Claude Code, then run ${C.cyan('cork-ai doctor')} again.\n`)
  if (problems > 0) process.exitCode = 1
}

// ─── statusline (a segment for statusLine.command) ───────────────────────────

/**
 * Reads Claude Code's status-line JSON on stdin and prints one compact
 * segment: context size, cache-read cost of the next call, session cost.
 * Append it to an existing status-line script or use it on its own.
 */
async function runStatusline(): Promise<void> {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  let data: { model?: { id?: string }; cost?: { total_cost_usd?: number }; context_window?: { total_input_tokens?: number; context_window_size?: number; used_percentage?: number; current_usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } }
  try { data = JSON.parse(input) } catch { return }
  const cu = data.context_window?.current_usage
  const ctx = cu ? (cu.input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0) : (data.context_window?.total_input_tokens ?? 0)
  const model = data.model?.id
  const perCall = (ctx / 1_000_000) * inputPriceForModel(model) * (/(fable|mythos)-5-[1-9]/i.test(model ?? '') ? 0.025 : 0.1)
  const colour = ctx > 400_000 ? C.red : ctx > 200_000 ? C.yellow : C.green
  const parts = [`ctx ${colour(fmtTokens(ctx))}`, `~$${perCall.toFixed(3)}/call`]
  if (data.cost?.total_cost_usd !== undefined) parts.push(`session $${data.cost.total_cost_usd.toFixed(2)}`)
  if (ctx >= 150_000) parts.push(C.dim('/compact?'))
  console.log(parts.join(C.dim(' · ')))
}

// ─── calibrate (measure real token factors via count_tokens API) ─────────────

// Representative samples: TS code, English prose, French prose (accents matter —
// Claude tokenizers split accented text differently than cl100k_base).
const CALIBRATION_SAMPLES: Array<{ name: string; text: string }> = [
  {
    name: 'code',
    text: [
      "import fs from 'fs'",
      "import path from 'path'",
      '',
      'export interface CompressionResult {',
      '  messages: Message[]',
      '  savedTokens: number',
      '  byModule: Record<string, number>',
      '}',
      '',
      'export function compressToolResults(messages: Message[], options: ToolResultOptions): CompressionResult {',
      '  const results: Message[] = []',
      '  let savedTokens = 0',
      '  for (const msg of messages) {',
      "    if (typeof msg.content === 'string') { results.push(msg); continue }",
      '    const blocks = msg.content.map(block => {',
      "      if (block.type !== 'tool_result') return block",
      '      const compressed = truncateContent(block.content, options.maxCodeLines)',
      '      savedTokens += estimateSavings(block.content, compressed)',
      '      return { ...block, content: compressed }',
      '    })',
      '    results.push({ ...msg, content: blocks })',
      '  }',
      '  return { messages: results, savedTokens, byModule: { toolResultCompressor: savedTokens } }',
      '}',
    ].join('\n').repeat(3),
  },
  {
    name: 'english',
    text: (
      'Token counting accuracy matters because every downstream number inherits its error: ' +
      'savings percentages, cost estimates, budget thresholds and compression decisions. ' +
      'A tokenizer that undercounts by fifteen percent makes the library claim savings it ' +
      'never delivered, and a budget manager working from wrong counts compresses either ' +
      'too early or too late. Measuring against the real endpoint removes the guesswork. '
    ).repeat(4),
  },
  {
    name: 'french',
    text: (
      'La précision du comptage des tokens est essentielle : chaque chiffre en aval hérite de ' +
      "son erreur — pourcentages d'économies, estimations de coûts, seuils de budget et " +
      'décisions de compression. Un tokenizer qui sous-compte de quinze pour cent fait ' +
      "prétendre à la bibliothèque des économies qu'elle n'a jamais réalisées. Mesurer contre " +
      "le véritable endpoint élimine les approximations et garantit des rapports fiables. "
    ).repeat(4),
  },
]

async function countTokensViaApi(apiKey: string, model: string, text: string): Promise<number> {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`count_tokens HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json() as { input_tokens: number }
  return data.input_tokens
}

async function runCalibrate(modelArg?: string): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error(`\n${C.yellow('ANTHROPIC_API_KEY is not set.')}`)
    console.error(`Calibration measures real Claude token counts via POST /v1/messages/count_tokens (free).`)
    console.error(`Export your API key and retry: ${C.cyan('export ANTHROPIC_API_KEY=sk-ant-...')}\n`)
    process.exit(1)
  }

  const model = modelArg || loadConfig().detectedModel
  if (!model) {
    console.error(`\n${C.yellow('No model detected yet.')}`)
    console.error(`Pass one explicitly: ${C.cyan('cork-ai calibrate claude-sonnet-5')}\n`)
    process.exit(1)
  }

  console.log(`\n${C.bold('cork-ai calibrate')} — measuring real token factors for ${C.cyan(model)}`)
  console.log(divider())

  let realTotal = 0
  let tiktokenTotal = 0
  let charsTotal = 0
  let tiktokenOk = true

  for (const sample of CALIBRATION_SAMPLES) {
    const real = await countTokensViaApi(apiKey, model, sample.text)
    const tk = countTokensRaw(sample.text)
    realTotal += real
    charsTotal += sample.text.length
    if (tk === null) tiktokenOk = false
    else tiktokenTotal += tk
    console.log(`  ${sample.name.padEnd(9)} real: ${String(real).padStart(6)}  tiktoken: ${tk === null ? '  n/a' : String(tk).padStart(6)}  chars: ${String(sample.text.length).padStart(7)}`)
  }

  // count_tokens includes a few tokens of message envelope per call — negligible
  // against multi-KB samples (<1%).
  const tiktokenFactor = tiktokenOk && tiktokenTotal > 0
    ? Math.round((realTotal / tiktokenTotal) * 1000) / 1000
    : 1.0
  const charsPerToken = Math.round((charsTotal / realTotal) * 100) / 100

  const factor = { tiktokenFactor, charsPerToken }
  saveCalibrationFactor(model, factor)
  saveCalibrationFactor(modelFamily(model), factor)

  console.log(divider())
  console.log(`  ${C.bold('tiktoken factor')}   ${C.green(String(tiktokenFactor))}  ${C.dim('(real / cl100k_base)')}`)
  console.log(`  ${C.bold('chars per token')}   ${C.green(String(charsPerToken))}  ${C.dim('(fast path, hook)')}`)
  console.log(`  Saved to ${C.cyan(CALIBRATION_FILE)} under "${model}" and "${modelFamily(model)}".`)
  console.log(`  ${C.dim('All future counts (library + hook) use these factors for this model.')}\n`)
}

// ─── Init command ─────────────────────────────────────────────────────────────

function findFiles(dir: string, exts: string[], ignore: string[]): string[] {
  const results: string[] = []
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return results }
  for (const e of entries) {
    if (ignore.includes(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) results.push(...findFiles(full, exts, ignore))
    else if (exts.some(x => e.name.endsWith(x))) results.push(full)
  }
  return results
}

function detectIsTypeScript(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, 'tsconfig.json'))
}

function readPkg(cwd: string): Record<string, unknown> | null {
  const p = path.join(cwd, 'package.json')
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown> } catch { return null }
}

function hasSdkDep(pkg: Record<string, unknown> | null): boolean {
  if (!pkg) return false
  const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) }
  return '@anthropic-ai/sdk' in deps
}

function patchFile(_filePath: string, content: string): string | null {
  if (content.includes('wrapClient') || content.includes('cork-ai')) return null
  const newAnthropicRe = /new Anthropic\s*\([^)]*\)/g
  if (!newAnthropicRe.test(content)) return null

  const importLine = content.includes("from '@anthropic-ai/sdk'")
    ? `from '@anthropic-ai/sdk'` : `from "@anthropic-ai/sdk"`
  const withImport = content.replace(
    new RegExp(`(import[^\\n]*${importLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`),
    `$1\nimport { wrapClient } from 'cork-ai'`,
  )
  const patched = withImport.replace(/new Anthropic(\s*\([^)]*\))/g, 'wrapClient(new Anthropic$1)')
  return patched === content ? null : patched
}

function generateWrapperFile(isTs: boolean): string {
  const imp = isTs
    ? `import Anthropic from '@anthropic-ai/sdk'\nimport { wrapClient } from 'cork-ai'`
    : `const Anthropic = require('@anthropic-ai/sdk')\nconst { wrapClient } = require('cork-ai')`
  const exp = isTs ? 'export const claude' : 'module.exports.claude'
  return `${imp}

${exp} = wrapClient(new Anthropic(), {
  maxContextTokens: 150_000,
  aggressiveness: 0.6,
  onStats: (stats) => {
    if (stats.request.savingsPercent > 5) {
      process.stderr.write(\`[cork-ai] \${stats.request.savingsPercent}% saved\\n\`)
    }
  },
})
// Replace all \`new Anthropic()\` imports with this file.
// Usage: import { claude } from './cork-ai-client'
`
}

function runInit(): void {
  const cwd = process.cwd()
  const pkg = readPkg(cwd)
  const isTs = detectIsTypeScript(cwd)

  console.log(`\n${C.bold('cork-ai init')} — Auto-integrating into ${C.cyan(cwd)}\n`)

  if (!hasSdkDep(pkg)) {
    console.log(`${C.yellow('⚠')}  @anthropic-ai/sdk not found in package.json.`)
    console.log(`   Run: ${C.cyan('npm install @anthropic-ai/sdk')}\n`)
  }

  const IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.cork-ai']
  const EXTS = isTs ? ['.ts', '.tsx'] : ['.js', '.mjs', '.cjs', '.jsx']
  const SDK_IMPORT_RE = /^(?:import|const|var|let)\s+\w[\s\S]{0,60}['"]@anthropic-ai\/sdk['"]/m
  const files = findFiles(cwd, EXTS, IGNORE)
  const matches = files.filter(f => {
    try {
      const c = fs.readFileSync(f, 'utf8')
      return c.includes('new Anthropic(') && SDK_IMPORT_RE.test(c)
    } catch { return false }
  })

  if (matches.length === 0) {
    const wrapperName = `cork-ai-client.${isTs ? 'ts' : 'js'}`
    const wrapperDir = path.join(cwd, 'src')
    const dest = fs.existsSync(wrapperDir) ? path.join(wrapperDir, wrapperName) : path.join(cwd, wrapperName)
    fs.writeFileSync(dest, generateWrapperFile(isTs), 'utf8')
    const rel = path.relative(cwd, dest)

    console.log(`${C.green('✔')}  No existing Anthropic client found.`)
    console.log(`   Generated wrapper: ${C.cyan(rel)}\n`)
    console.log(`   Import it: ${C.dim(`import { claude } from './${rel.replace(/\\/g, '/').replace(/\.(ts|js)$/, '')}'`)}`)
    console.log(`\n   Then run ${C.cyan('cork-ai gain')} after a session.\n`)
    return
  }

  if (matches.length === 1) {
    const file = matches[0]
    const rel = path.relative(cwd, file)
    const content = fs.readFileSync(file, 'utf8')
    const patched = patchFile(file, content)

    if (!patched) {
      console.log(`${C.green('✔')}  ${C.cyan(rel)} — already integrated.`)
      console.log(`   Run ${C.cyan('cork-ai gain')} after a session.\n`)
      return
    }

    fs.writeFileSync(file, patched, 'utf8')
    console.log(`${C.green('✔')}  Patched ${C.cyan(rel)}`)
    console.log(`   Added: ${C.dim("import { wrapClient } from 'cork-ai'")}`)
    console.log(`   Wrapped: ${C.dim('new Anthropic(...)  →  wrapClient(new Anthropic(...))')}`)
    console.log(`\n   Run ${C.cyan('cork-ai gain')} after a session.\n`)
    return
  }

  console.log(`${C.yellow('!')}  Found ${matches.length} files with Anthropic client:`)
  for (const f of matches) console.log(`   ${C.cyan(path.relative(cwd, f))}`)
  console.log()
  console.log(`   Add to the file that calls the API:`)
  console.log(`   ${C.dim("import { wrapClient } from 'cork-ai'")}`)
  console.log(`   ${C.dim('const client = wrapClient(new Anthropic(), { maxContextTokens: 150_000 })')}`)
  console.log()
  console.log(`   Or run ${C.cyan('cork-ai hooks install')} to optimize Claude Code directly.\n`)
}

// ─── reset ────────────────────────────────────────────────────────────────────

// ─── Telemetry commands ───────────────────────────────────────────────────────

function telemetryOn(): void {
  saveConfig({ ...loadConfig(), telemetry: true })
  console.log(`\n${C.green('✔')}  Telemetry enabled. Anonymous compression stats will be sent after each session.`)
  console.log(`   ${C.dim('What is sent: cork-ai version, OS, compression %, module breakdown. Never file paths or content.')}`)
  console.log(`   Run ${C.cyan('cork-ai telemetry off')} to disable.\n`)
}

function telemetryOff(): void {
  saveConfig({ ...loadConfig(), telemetry: false })
  console.log(`\n${C.green('✔')}  Telemetry disabled. No data will be sent.\n`)
}

function telemetryStatus(): void {
  const enabled = isTelemetryEnabled()
  const cfg = loadConfig()
  const price = inputPriceForModel(cfg.detectedModel)
  console.log()
  console.log(`  Telemetry: ${enabled ? C.green('● enabled') : C.yellow('○ disabled')}`)
  if (cfg.telemetry === undefined) console.log(`  ${C.dim('(never configured — run cork-ai telemetry on to enable)')}`)
  if (process.env.DO_NOT_TRACK === '1') console.log(`  ${C.dim('(overridden by DO_NOT_TRACK=1)')}`)
  if (process.env.CORK_AI_TELEMETRY === '0') console.log(`  ${C.dim('(overridden by CORK_AI_TELEMETRY=0)')}`)
  console.log(`  Model:     ${C.cyan(cfg.detectedModel ?? C.dim('not yet detected — will update on next Read'))}`)
  console.log(`  Pricing:   ${C.cyan(`$${price.toFixed(2)}/M input tokens`)}${cfg.detectedModel ? '' : C.dim(' (Sonnet fallback)')}`)
  console.log()
}

function resetStats(): void {
  const stats = readGlobalStats()
  if (!stats || stats.allTime.totalRequests === 0) {
    const live = readLiveSession()
    if (!live) { console.log('Nothing to reset.'); return }
  }
  resetGlobalStats()
  clearLiveSession()
  console.log(`\n${C.green('Stats reset.')} All data cleared from ${STATS_FILE}\n`)
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

;(async () => {
  const args = process.argv.slice(2)
  const cmd = args[0]
  const sub = args[1]

  if (!cmd || cmd === '--help' || cmd === '-h') {
    showHelp()
  } else if (cmd === '--version' || cmd === '-v') {
    showVersion()
  } else if (cmd === 'hook') {
    await runHook().catch(() => process.exit(0))
  } else if (cmd === 'calibrate') {
    await runCalibrate(sub).catch(err => {
      console.error(`\n${C.yellow('Calibration failed:')} ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    })
  } else if (cmd === 'init') {
    runInit()
  } else if (cmd === 'hooks') {
    if (sub === 'install') await hooksInstall()
    else if (sub === 'remove' || sub === 'uninstall') hooksRemove()
    else if (sub === 'status') hooksStatus()
    else { console.error(`\nUsage: cork-ai hooks [install|remove|status]\n`); process.exit(1) }
  } else if (cmd === 'telemetry') {
    if (sub === 'on') telemetryOn()
    else if (sub === 'off') telemetryOff()
    else if (sub === 'status' || !sub) telemetryStatus()
    else { console.error(`\nUsage: cork-ai telemetry [on|off|status]\n`); process.exit(1) }
  } else if (cmd === 'gain') {
    if (sub === '--all') showAllTime()
    else if (sub === '--history') showHistory()
    else if (sub === '--models') showModels()
    else showLastSession()
  } else if (cmd === 'models') {
    showModels()
  } else if (cmd === 'report') {
    if (sub === '--daily') reportPeriod('day')
    else if (sub === '--weekly') reportPeriod('week')
    else if (sub === '--monthly') reportPeriod('month')
    else if (sub === '--projects') reportProjects()
    else if (sub === '--models') showModels()
    else if (sub === '--forecast') reportForecast()
    else if (sub === '--json') reportJson()
    else reportFull()
  } else if (cmd === 'reset') {
    resetStats()
  } else if (cmd === 'doctor') {
    runDoctor()
  } else if (cmd === 'context') {
    if (sub === 'guard') {
      const cfg = loadConfig()
      const on = args[2]
      if (on === 'on' || on === 'off') {
        saveConfig({ ...cfg, contextGuard: { ...(cfg.contextGuard ?? {}), enabled: on === 'on' } })
        console.log(`\n${C.green('✔')}  context guard ${on}\n`)
      } else {
        console.log(`\n  context guard: ${cfg.contextGuard?.enabled === false ? C.yellow('off') : C.green('on')}\n  Usage: cork-ai context guard [on|off]\n`)
      }
    } else {
      showContext(args.slice(1))
    }
  } else if (cmd === 'statusline') {
    await runStatusline()
  } else {
    console.error(`\nUnknown command: ${cmd}\nRun \`cork-ai --help\` for usage.\n`)
    process.exit(1)
  }
})()
