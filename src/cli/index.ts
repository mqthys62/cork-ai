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
 *   cork-ai hook                  Internal: handle Claude Code PreToolUse hook (stdin/stdout)
 *   cork-ai reset                 Reset all stats
 *   cork-ai --version             Show version
 *   cork-ai --help                Show help
 */

import fs from 'fs'
import { spawn } from 'child_process'
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
} from './persistent-stats.js'
import { inputPriceForModel } from '../pricing/index.js'
import {
  CALIBRATION_FILE,
  countTokensRaw,
  estimateTokensFast,
  modelFamily,
  saveCalibrationFactor,
} from '../core/tokenizer.js'

const VERSION = '0.4.2'
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const CORK_HOME = process.env.CORK_AI_HOME ?? path.join(os.homedir(), '.cork-ai')
const CONFIG_FILE = path.join(CORK_HOME, 'config.json')

const TELEMETRY_ENDPOINT = 'https://corktelemetry.essenly.fr/telemetry-server.php'

// ─── Config (~/.cork-ai/config.json) ─────────────────────────────────────────

interface CorkConfig {
  telemetry?: boolean   // undefined = never asked, true = opted in, false = opted out
  detectedModel?: string  // last model seen in a hook event — used for cost estimates
}

// Pricing lives in src/pricing (single source of truth, shared with the
// library) — per-model, four billing tiers, date-dependent introductory rates.

// The PreToolUse hook payload has no `model` field — Claude Code only sends
// session_id, transcript_path, cwd, tool_name, tool_input. The active model
// lives in the transcript: each assistant turn carries `message.model`.
// Read the tail of the transcript and take the most recent main-thread one.
function detectModelFromTranscript(transcriptPath?: string): string | undefined {
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
      if (!line.includes('"assistant"')) continue
      try {
        const entry = JSON.parse(line) as {
          type?: string
          isSidechain?: boolean
          message?: { model?: string }
        }
        if (entry.type !== 'assistant' || entry.isSidechain) continue
        const model = entry.message?.model
        // Skip synthetic entries like "<synthetic>"
        if (typeof model === 'string' && /^claude/i.test(model)) return model
      } catch { /* partial line at the tail cut — skip */ }
    }
  } catch { /* transcript unreadable — fall back to config */ }
  return undefined
}

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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
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

// ─── Colors (no deps — raw ANSI) ─────────────────────────────────────────────

const C = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
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
  cork-ai hooks install     Add PreToolUse hook (compresses Read outputs)
  cork-ai hooks remove      Remove cork-ai hooks
  cork-ai hooks status      Show hook configuration

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
  console.log(`  ${C.dim('Total tokens in')}   ${C.cyan(fmt(totalOriginal))}`)
  console.log(`  ${C.dim('Total tokens out')}  ${C.green(fmt(totalOriginal - totalSaved))}`)
  console.log(`  ${C.dim('Total saved')}       ${C.green(fmt(totalSaved))} tokens`)
  console.log()
  console.log(`  ${C.bold('Overall savings')}   ${C.green(bar(pct))}`)
  console.log(`  ${C.bold('Total cost saved')}  ${C.green(fmtUsdLong(totalCost))} USD`)
  console.log(`  ${C.bold('Avg / session')}     ${C.green(fmt(Math.round(avgPerSession)))} tokens`)

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
  if (stats?.allTime.reReads) {
    console.log(`  ${C.yellow('Re-reads')}           ${fmt(stats.allTime.reReads)} (${fmtTokens(stats.allTime.reReadTokensServed ?? 0)} tokens served raw — cost deducted)`)
  }
  if (stats?.allTime.editFailuresAfterCompression) {
    console.log(`  ${C.yellow('Edit failures')}      ${fmt(stats.allTime.editFailuresAfterCompression)} on compressed-only files (auto-whitelisted)`)
  }
  console.log(divider())
  console.log()
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
  hooks?: {
    PreToolUse?: HookGroup[]
    PostToolUse?: HookGroup[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface HookGroup {
  matcher?: string
  hooks: { type: string; command: string }[]
}

const CORK_HOOK_MATCHER = 'Read'
const CORK_POST_HOOK_MATCHER = 'Edit|MultiEdit'
const CORK_HOOK_FALLBACK = 'cork-ai hook'

function loadClaudeSettings(): ClaudeSettings {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf-8')) as ClaudeSettings }
  catch { return {} }
}

function saveClaudeSettings(settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true })
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8')
}

function isCorkHookInstalled(settings: ClaudeSettings): boolean {
  const pre = settings.hooks?.PreToolUse ?? []
  // Accepts both formats: 'cork-ai hook' and '"/full/path/to/cork-ai" hook'
  return pre.some(g =>
    g.hooks?.some(h => h.command.includes('cork-ai') && h.command.endsWith('hook'))
  )
}

// Resolves the absolute path to the cork-ai binary so the hook
// works even when Claude Code does not inherit the shell PATH (Mac, Electron).
function resolveHookBinary(): string {
  // Standalone compiled binary (bun build --compile): execPath = the binary itself
  const exec = process.execPath
  if (exec && !/\bnode(\.exe)?\b/i.test(path.basename(exec)) && fs.existsSync(exec)) {
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

  return ''  // fallback : on utilisera CORK_HOOK_FALLBACK
}

function isCorkCmd(command: string): boolean {
  return command.includes('cork-ai') && command.endsWith('hook')
}

/** Adds the cork-ai command to a hook event group if absent. Returns true if added or upgraded. */
function ensureHookGroup(
  settings: ClaudeSettings,
  eventName: 'PreToolUse' | 'PostToolUse',
  matcher: string,
  hookCmd: string,
): boolean {
  settings.hooks ??= {}
  settings.hooks[eventName] ??= []
  const groups = settings.hooks[eventName] as HookGroup[]

  for (const g of groups) {
    const existing = g.hooks?.find(h => isCorkCmd(h.command))
    if (existing) {
      // Migrate a bare "cork-ai hook" fallback (pre-dates resolveHookBinary())
      // to a resolved absolute path. The bare form depends on Claude Code's
      // hook subprocess inheriting a shell PATH that includes the binary,
      // which isn't guaranteed — it fails as a silent, non-blocking hook
      // error ("cork-ai: not found") in some launch contexts.
      if (existing.command === CORK_HOOK_FALLBACK && hookCmd !== CORK_HOOK_FALLBACK) {
        existing.command = hookCmd
        return true
      }
      return false
    }
  }

  const existingGroup = groups.find(g => g.matcher === matcher)
  if (existingGroup) {
    existingGroup.hooks.push({ type: 'command', command: hookCmd })
  } else {
    groups.push({ matcher, hooks: [{ type: 'command', command: hookCmd }] })
  }
  return true
}

async function hooksInstall(): Promise<void> {
  const settings = loadClaudeSettings()

  // Use the absolute binary path so the hook works
  // even if ~/.local/bin is not in Claude Code's PATH (Mac / Electron)
  const binaryPath = resolveHookBinary()
  const hookCmd = binaryPath ? `"${binaryPath}" hook` : CORK_HOOK_FALLBACK

  const addedPre = ensureHookGroup(settings, 'PreToolUse', CORK_HOOK_MATCHER, hookCmd)
  // PostToolUse on Edit detects edits that fail on files only seen compressed
  // (also upgrades pre-0.4.0 installs that only had the PreToolUse hook)
  const addedPost = ensureHookGroup(settings, 'PostToolUse', CORK_POST_HOOK_MATCHER, hookCmd)

  if (!addedPre && !addedPost) {
    console.log(`\n${C.green('✔')}  cork-ai hooks already installed in ${C.cyan(CLAUDE_SETTINGS)}\n`)
    return
  }

  saveClaudeSettings(settings)
  console.log(`\n${C.green('✔')}  cork-ai hooks installed.`)
  if (addedPre) console.log(`   Added PreToolUse hook for Read tool → ${C.cyan(CLAUDE_SETTINGS)}`)
  if (addedPost) console.log(`   Added PostToolUse hook for Edit tool (compression-harm detection) → ${C.cyan(CLAUDE_SETTINGS)}`)
  if (binaryPath) {
    console.log(`   Binary: ${C.dim(binaryPath)}`)
  }
  console.log()
  console.log(`   ${C.dim('What it does:')} compresses file contents before Claude reads them.`)
  console.log(`   ${C.dim('Large files')} (>500 tokens) → extracted signatures + key sections.`)
  console.log(`   ${C.dim('Savings:')} 40-90% on code files, 20-50% on text files.`)
  console.log()

  // Telemetry — ask if never configured
  // Use /dev/tty if available to work even from curl | sh
  const cfg = loadConfig()
  if (cfg.telemetry === undefined) {
    await askTelemetryConsent(cfg)
  }

  console.log(`   Restart Claude Code for the hook to take effect.`)
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
  saveConfig({ ...cfg, telemetry: false })
  console.log(`   ${C.dim('Telemetry off by default. Enable later: cork-ai telemetry on')}`)
}

function applyTelemetryChoice(cfg: CorkConfig, answer: string): void {
  const opted = answer === 'y' || answer === 'yes'
  saveConfig({ ...cfg, telemetry: opted })
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

  for (const eventName of ['PreToolUse', 'PostToolUse'] as const) {
    const groups = settings.hooks?.[eventName] ?? []
    for (const group of groups) {
      group.hooks = group.hooks.filter(h => !isCorkCmd(h.command))
    }
    if (settings.hooks) {
      settings.hooks[eventName] = groups.filter(g => g.hooks.length > 0)
    }
  }

  saveClaudeSettings(settings)
  console.log(`\n${C.green('✔')}  cork-ai hook removed from ${C.cyan(CLAUDE_SETTINGS)}\n`)
  console.log(`   Restart Claude Code to apply.\n`)
}

function hooksStatus(): void {
  const settings = loadClaudeSettings()
  const installed = isCorkHookInstalled(settings)
  console.log()
  console.log(`  cork-ai hook: ${installed ? C.green('● installed') : C.yellow('○ not installed')}`)
  console.log(`  Settings file: ${C.dim(CLAUDE_SETTINGS)}`)
  if (installed) {
    for (const eventName of ['PreToolUse', 'PostToolUse'] as const) {
      const groups = settings.hooks?.[eventName] ?? []
      for (const g of groups) {
        const h = g.hooks?.find(h => isCorkCmd(h.command))
        if (h) console.log(`  ${eventName} (${g.matcher ?? '*'}): ${C.dim(h.command)}`)
      }
    }
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
  files: Record<string, number>  // filePath → times served compressed
}

function readsFileFor(sessionId: string): string {
  const safe = sessionId.replace(/[^\w.-]/g, '_').slice(0, 80)
  return path.join(LIVE_DIR, `reads-${safe}.json`)
}

function loadSessionReads(sessionId: string): SessionReads {
  try {
    return JSON.parse(fs.readFileSync(readsFileFor(sessionId), 'utf-8')) as SessionReads
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

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cs', '.cpp', '.c', '.h',
  '.rb', '.php', '.swift', '.kt', '.scala', '.r',
])


function extractCodeSignatures(content: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const lines = content.split('\n')
  const total = lines.length
  const kept: string[] = []

  let inImports = true
  for (const line of lines) {
    const trimmed = line.trim()
    if (inImports) {
      if (/^(import|export|from|require|use |#include|package |using )/.test(trimmed) || trimmed === '') {
        kept.push(line)
      } else {
        inImports = false
      }
    }
    if (!inImports) break
  }

  if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('')

  const signatureRe = /^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|def |fn |pub |impl |struct |trait )\s+\w/
  const methodRe = /^(\s{2,})(async\s+)?(\w+)\s*[\(<]/
  const decoratorRe = /^\s*@\w+/

  let lastWasSignature = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (decoratorRe.test(line)) {
      kept.push(line)
      lastWasSignature = true
      continue
    }

    if (signatureRe.test(trimmed)) {
      if (!lastWasSignature && kept.length > 0 && kept[kept.length - 1] !== '') kept.push('')
      kept.push(line)
      if (!line.includes('{') && i + 1 < lines.length && lines[i + 1].trim() === '{') {
        kept.push(lines[i + 1])
        i++
      }
      kept.push('  // ...')
      lastWasSignature = true
      continue
    }

    if ((ext === '.ts' || ext === '.js') && methodRe.test(line)) {
      kept.push(line.replace(/\{.*$/, '{ // ...'))
      lastWasSignature = true
      continue
    }

    lastWasSignature = false
  }

  const header = `// ${path.basename(filePath)} — ${total} lines → signatures extracted`
  const savedTokens = estimateTokens(content) - estimateTokens(kept.join('\n'))
  const pct = Math.round((savedTokens / estimateTokens(content)) * 100)
  const hint = '// Need the full content? Re-read this exact file (served raw on re-read) or pass an explicit offset/limit.'

  return `${header} (${pct}% compression)\n${hint}\n\n${kept.join('\n')}`
}

function compressJson(content: string): string {
  try {
    const obj = JSON.parse(content) as unknown
    const slim = JSON.stringify(obj, (_k, v) => {
      if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '…'
      if (Array.isArray(v) && v.length > 20) return [...v.slice(0, 20), `… (${v.length - 20} more)`]
      return v
    }, 2)
    const ratio = Math.round((1 - slim.length / content.length) * 100)
    return `// JSON compressed (${ratio}% reduction)\n${slim}`
  } catch {
    return compressText(content)
  }
}

function compressText(content: string): string {
  const lines = content.split('\n')
  if (lines.length <= 60) return content
  const head = lines.slice(0, 30)
  const tail = lines.slice(-15)
  const omitted = lines.length - 45
  return `${head.join('\n')}\n\n[... ${omitted} lines omitted — use Read with offset to see more ...]\n\n${tail.join('\n')}`
}

type CompressType = 'code' | 'json' | 'text'

function compressContent(content: string, filePath: string): { result: string; compressType: CompressType } {
  const ext = path.extname(filePath).toLowerCase()
  if (CODE_EXTS.has(ext)) return { result: extractCodeSignatures(content, filePath), compressType: 'code' }
  if (ext === '.json') return { result: compressJson(content), compressType: 'json' }
  return { result: compressText(content), compressType: 'text' }
}

// PostToolUse on Edit: an Edit that fails on a file we only ever served
// compressed means the model's old_string came from signatures, not the real
// file — direct compression harm. Count it and auto-whitelist the file.
// Failure detection is best-effort (matches Claude Code's known Edit errors);
// if the payload shape differs, this is a silent no-op.
const EDIT_FAILURE_MARKERS =
  /String to replace not found|matches of the string to replace|has not been read yet|"is_error"\s*:\s*true/i

function handlePostToolUseEdit(event: Record<string, unknown>): void {
  const toolName = (event.tool_name as string) ?? ''
  if (toolName !== 'Edit' && toolName !== 'MultiEdit') return
  const toolInput = (event.tool_input as Record<string, unknown>) ?? {}
  const filePath = toolInput.file_path as string
  const sessionId = (event.session_id as string) || ''
  if (!filePath || !sessionId) return

  const reads = loadSessionReads(sessionId)
  if (!reads.files[filePath]) return  // file was never served compressed — not our fault

  let respText = ''
  try { respText = JSON.stringify(event.tool_response ?? '') } catch { return }
  if (!EDIT_FAILURE_MARKERS.test(respText)) return

  // Whitelist: the next Read of this file is served raw so the retry can work
  // from the real content.
  reads.files[filePath] += 1
  saveSessionReads(sessionId, reads)

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

async function runHook(): Promise<void> {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  if (!input.trim()) process.exit(0)

  let event: Record<string, unknown>
  try { event = JSON.parse(input) as Record<string, unknown> } catch { process.exit(0) }

  const toolName = (event.tool_name as string) ?? ''
  const toolInput = (event.tool_input as Record<string, unknown>) ?? {}
  const hookEvent = (event.hook_event_name as string) ?? ''

  if (hookEvent === 'PostToolUse') {
    handlePostToolUseEdit(event)
    process.exit(0)
  }

  if (hookEvent !== 'PreToolUse' || toolName !== 'Read') process.exit(0)

  const filePath = toolInput.file_path as string
  if (!filePath) process.exit(0)

  // Explicit offset/limit = the model is targeting a precise zone (often to
  // recover content hidden by a previous compression). Never compress those.
  if (toolInput.offset !== undefined || toolInput.limit !== undefined) process.exit(0)

  // Never compress the file the user is explicitly asking about — the model
  // almost certainly needs its real content, and a compressed view forces a
  // re-read round-trip that costs more than the compression saves.
  const userPrompt = lastUserPromptFromTranscript(event.transcript_path as string | undefined)
  if (userPrompt && userPrompt.toLowerCase().includes(path.basename(filePath).toLowerCase())) {
    process.exit(0)
  }

  let content: string
  try { content = fs.readFileSync(filePath, 'utf-8') } catch { process.exit(0) }

  const lines = content.split('\n')
  const slice = lines.slice(0, 2000).join('\n')

  const ext = path.extname(filePath).toLowerCase() || 'none'
  const originalTokens = estimateTokens(slice)

  const sessionId = (event.session_id as string) || ''
  const reads = sessionId ? loadSessionReads(sessionId) : null

  // Re-read of a file we already compressed this session: the compressed view
  // wasn't enough for the model. Serve it raw, auto-whitelist it for the rest
  // of the session, and account the induced cost against our savings.
  if (reads && reads.files[filePath]) {
    reads.files[filePath] += 1
    saveSessionReads(sessionId, reads)
    try {
      const cfg = loadConfig()
      const detectedModel =
        detectModelFromTranscript(event.transcript_path as string | undefined)
        || (event.model as string)
        || cfg.detectedModel
      accumulateInSession({
        projectPath: (event.cwd as string) || process.cwd(),
        originalTokens: 0,
        compressedTokens: 0,
        savedTokens: 0,
        // The second read only exists because the first one was compressed —
        // its full raw cost is induced by us. Deduct it.
        estimatedCostSaved: -(originalTokens / 1_000_000) * inputPriceForModel(detectedModel),
        byModule: {},
        model: detectedModel,
        sessionId,
        reRead: true,
        reReadTokensServed: originalTokens,
      })
    } catch { /* non-critical */ }
    process.exit(0)  // passthrough: Claude gets the raw file
  }

  if (originalTokens < 400) {
    if (isTelemetryEnabled()) sendTelemetry({ v: VERSION, os: process.platform, arch: process.arch, savings_pct: 0, file_ext: ext, compress_type: 'text', skipped: true })
    process.exit(0)
  }

  const { result: compressed, compressType } = compressContent(slice, filePath)
  const compressedTokens = estimateTokens(compressed)

  if (compressedTokens >= originalTokens * 0.85) {
    if (isTelemetryEnabled()) sendTelemetry({ v: VERSION, os: process.platform, arch: process.arch, savings_pct: 0, file_ext: ext, compress_type: compressType, skipped: true })
    process.exit(0)
  }

  const saved = originalTokens - compressedTokens
  const savingsPct = Math.round((saved / originalTokens) * 1000) / 10

  // Remember we served this file compressed — a re-read in the same session
  // will be served raw (auto-whitelist) and counted as compression harm.
  if (reads && sessionId) {
    reads.files[filePath] = 1
    saveSessionReads(sessionId, reads)
  }

  // Accumulate in the live session (keyed by Claude Code session_id)
  try {
    const cfg = loadConfig()
    const detectedModel =
      detectModelFromTranscript(event.transcript_path as string | undefined)
      || (event.model as string)  // future-proofing: if Claude Code ever adds it
      || cfg.detectedModel
    if (detectedModel && cfg.detectedModel !== detectedModel) {
      saveConfig({ ...cfg, detectedModel })
    }
    accumulateInSession({
      projectPath: (event.cwd as string) || process.cwd(),
      originalTokens,
      compressedTokens,
      savedTokens: saved,
      estimatedCostSaved: (saved / 1_000_000) * inputPriceForModel(detectedModel),
      byModule: { hookReadCompressor: saved },
      model: detectedModel,
      sessionId: sessionId || undefined,
    })
  } catch { /* non-critical */ }

  if (isTelemetryEnabled()) {
    sendTelemetry({
      v: VERSION,
      os: process.platform,
      arch: process.arch,
      savings_pct: savingsPct,
      file_ext: ext,
      compress_type: compressType,
      skipped: false,
    })
  }

  console.log(JSON.stringify({
    decision: 'block',
    reason: compressed,
  }))
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
  } else {
    console.error(`\nUnknown command: ${cmd}\nRun \`cork-ai --help\` for usage.\n`)
    process.exit(1)
  }
})()
