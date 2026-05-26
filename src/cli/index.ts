#!/usr/bin/env node
/**
 * cork-ai CLI — stats, savings report, project setup, and Claude Code hooks.
 *
 * Commands:
 *   cork-ai init                  Auto-integrate cork-ai into the current project
 *   cork-ai gain                  Show savings from the last session
 *   cork-ai gain --all            Show all-time totals
 *   cork-ai gain --history        Show all recorded sessions
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
import https from 'https'
import os from 'os'
import path from 'path'
import readline from 'readline'
import {
  readGlobalStats,
  resetGlobalStats,
  recordSession,
  getStatsByProject,
  getStatsByPeriod,
  getForecast,
  STATS_FILE,
} from './persistent-stats.js'

const VERSION = '0.1.0'
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const HOOK_SAVINGS_FILE = path.join(os.homedir(), '.cork-ai', 'hook-savings.json')
const CONFIG_FILE = path.join(os.homedir(), '.cork-ai', 'config.json')

// Replace with your actual telemetry endpoint after deploying scripts/telemetry-server.php
const TELEMETRY_ENDPOINT = 'https://YOUR_DOMAIN/cork-ai-telemetry.php'

// ─── Config (~/.cork-ai/config.json) ─────────────────────────────────────────

interface CorkConfig {
  telemetry?: boolean  // undefined = never asked, true = opted in, false = opted out
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
  requests: number
  duration_min: number
  modules: Record<string, number>
}

function sendTelemetry(payload: TelemetryPayload): void {
  if (TELEMETRY_ENDPOINT.includes('YOUR_DOMAIN')) return  // not configured yet
  try {
    const body = JSON.stringify(payload)
    const url = new URL(TELEMETRY_ENDPOINT)
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 2000,
    }, () => {})
    req.on('error', () => {})
    req.on('timeout', () => req.destroy())
    req.write(body)
    req.end()
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
  cork-ai gain              Last session savings
  cork-ai gain --all        All-time totals
  cork-ai gain --history    All recorded sessions

${C.bold('Enterprise report:')}
  cork-ai report            Full report (trends + projects + forecast)
  cork-ai report --daily    Daily breakdown (last 30 days)
  cork-ai report --weekly   Weekly breakdown (last 12 weeks)
  cork-ai report --monthly  Monthly breakdown (last 12 months)
  cork-ai report --projects Per-project breakdown
  cork-ai report --forecast Annual cost projection
  cork-ai report --json     Export full data as JSON

${C.bold('Claude Code integration:')}
  cork-ai hooks install     Add PreToolUse hook (compresses Read outputs)
  cork-ai hooks remove      Remove cork-ai hooks
  cork-ai hooks status      Show hook configuration

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
  const stats = readGlobalStats()
  if (!stats || stats.sessions.length === 0) {
    console.log(`\n${C.yellow('No sessions recorded yet.')}\n`)
    console.log(`Run ${C.cyan('cork-ai init')} to integrate, or ${C.cyan('cork-ai hooks install')} to add Claude Code hooks.`)
    console.log(`Stats file: ${C.dim(STATS_FILE)}\n`)
    return
  }

  const last = stats.sessions[stats.sessions.length - 1]
  const pct = last.originalTokens > 0 ? (last.savedTokens / last.originalTokens) * 100 : 0

  console.log(`\n${C.bold('cork-ai — Last Session')}`)
  console.log(divider())
  console.log(`  ${C.dim('Date')}        ${fmtDate(last.startedAt)}`)
  if (last.projectPath) console.log(`  ${C.dim('Project')}     ${C.cyan(path.basename(last.projectPath))}`)
  console.log(`  ${C.dim('Requests')}    ${fmt(last.requests)}`)
  console.log()
  console.log(`  ${C.dim('Tokens in')}   ${C.cyan(fmt(last.originalTokens))}`)
  console.log(`  ${C.dim('Tokens out')}  ${C.green(fmt(last.compressedTokens))}`)
  console.log(`  ${C.dim('Saved')}       ${C.green(fmt(last.savedTokens))} tokens`)
  console.log()
  console.log(`  ${C.bold('Savings')}     ${C.green(bar(pct))}`)
  console.log(`  ${C.bold('Cost saved')}  ${C.green(fmtUsd(last.estimatedCostSaved))} USD`)
  console.log()

  if (Object.keys(last.byModule).length > 0) {
    console.log(`  ${C.dim('By module:')}`)
    const sorted = Object.entries(last.byModule).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a)
    for (const [name, saved] of sorted) {
      const modPct = last.originalTokens > 0 ? (saved / last.originalTokens) * 100 : 0
      console.log(`    ${name.padEnd(24)} ${C.green(fmt(saved).padStart(8))} tokens  (${fmtPct(modPct)})`)
    }
    console.log()
  }

  console.log(divider())
  console.log(`  ${C.dim('All-time:')} ${C.green(fmt(stats.allTime.totalSavedTokens))} tokens saved — ${C.green(fmtUsd(stats.allTime.estimatedCostSaved))} USD`)
  console.log()
}

function showAllTime(): void {
  const stats = readGlobalStats()
  if (!stats || stats.allTime.totalRequests === 0) {
    console.log(`\n${C.yellow('No data recorded yet.')}\n`); return
  }

  const at = stats.allTime
  const pct = at.totalOriginalTokens > 0 ? (at.totalSavedTokens / at.totalOriginalTokens) * 100 : 0
  const avgPerSession = stats.sessions.length > 0 ? at.totalSavedTokens / stats.sessions.length : 0

  console.log(`\n${C.bold('cork-ai — All-Time Stats')}`)
  console.log(divider())
  console.log(`  ${C.dim('Tracking since')} ${fmtDate(stats.createdAt)}`)
  console.log(`  ${C.dim('Sessions')}       ${fmt(stats.sessions.length)}`)
  console.log(`  ${C.dim('Requests')}       ${fmt(at.totalRequests)}`)
  console.log()
  console.log(`  ${C.dim('Total tokens in')}   ${C.cyan(fmt(at.totalOriginalTokens))}`)
  console.log(`  ${C.dim('Total tokens out')}  ${C.green(fmt(at.totalCompressedTokens))}`)
  console.log(`  ${C.dim('Total saved')}       ${C.green(fmt(at.totalSavedTokens))} tokens`)
  console.log()
  console.log(`  ${C.bold('Overall savings')}   ${C.green(bar(pct))}`)
  console.log(`  ${C.bold('Total cost saved')}  ${C.green(fmtUsdLong(at.estimatedCostSaved))} USD`)
  console.log(`  ${C.bold('Avg / session')}     ${C.green(fmt(Math.round(avgPerSession)))} tokens`)
  console.log(divider())
  console.log()
}

function showHistory(): void {
  const stats = readGlobalStats()
  if (!stats || stats.sessions.length === 0) {
    console.log(`\n${C.yellow('No sessions recorded yet.')}\n`); return
  }

  console.log(`\n${C.bold('cork-ai — Session History')} (${stats.sessions.length} sessions)`)
  console.log(divider())
  console.log(`  ${'Date'.padEnd(20)} ${'Project'.padEnd(18)} ${'Saved tokens'.padStart(13)} ${'Savings'.padStart(9)} ${'Cost saved'.padStart(11)}`)
  console.log(divider())

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

  const at = stats.allTime
  const totalPct = at.totalOriginalTokens > 0 ? (at.totalSavedTokens / at.totalOriginalTokens) * 100 : 0
  console.log(divider())
  console.log(
    `  ${'TOTAL'.padEnd(20)} ${''.padEnd(18)} ` +
    `${C.green(fmt(at.totalSavedTokens).padStart(13))} ` +
    `${C.green(fmtPct(totalPct).padStart(9))} ` +
    `${C.green(fmtUsdLong(at.estimatedCostSaved).padStart(11))}`
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

  // ROI story for teams
  if (f.projectedAnnualCostSaved > 0) {
    const devCostPerHour = 75  // conservative estimate
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
  console.log(`  ${C.dim('Pricing: Claude Sonnet 4 — $3/1M input tokens (update via wrapClient options)')}`)
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

  console.log(JSON.stringify({ summary: stats.allTime, projects, trends: { daily, weekly, monthly }, forecast, sessions: stats.sessions }, null, 2))
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

const CORK_HOOK_COMMAND = 'cork-ai hook'
const CORK_HOOK_MATCHER = 'Read'

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
  return pre.some(g =>
    g.hooks?.some(h => h.command === CORK_HOOK_COMMAND)
  )
}

async function hooksInstall(): Promise<void> {
  const settings = loadClaudeSettings()
  settings.hooks ??= {}
  settings.hooks.PreToolUse ??= []

  if (isCorkHookInstalled(settings)) {
    console.log(`\n${C.green('✔')}  cork-ai hook already installed in ${C.cyan(CLAUDE_SETTINGS)}\n`)
    return
  }

  // Find existing Read group or create one
  const existingGroup = settings.hooks.PreToolUse.find(g => g.matcher === CORK_HOOK_MATCHER)
  if (existingGroup) {
    existingGroup.hooks.push({ type: 'command', command: CORK_HOOK_COMMAND })
  } else {
    settings.hooks.PreToolUse.push({
      matcher: CORK_HOOK_MATCHER,
      hooks: [{ type: 'command', command: CORK_HOOK_COMMAND }],
    })
  }

  saveClaudeSettings(settings)
  console.log(`\n${C.green('✔')}  cork-ai hook installed.`)
  console.log(`   Added PreToolUse hook for Read tool → ${C.cyan(CLAUDE_SETTINGS)}`)
  console.log()
  console.log(`   ${C.dim('What it does:')} compresses file contents before Claude reads them.`)
  console.log(`   ${C.dim('Large files')} (>500 tokens) → extracted signatures + key sections.`)
  console.log(`   ${C.dim('Savings:')} 40-90% on code files, 20-50% on text files.`)
  console.log()

  // Ask for telemetry consent (only if never asked and stdin is interactive)
  const cfg = loadConfig()
  if (cfg.telemetry === undefined && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>(resolve => {
      rl.question(
        `   ${C.dim('Help improve cork-ai? Send anonymous compression stats (no file paths, no content).')} [y/N]: `,
        a => { rl.close(); resolve(a.trim().toLowerCase()) }
      )
    })
    const opted = answer === 'y' || answer === 'yes'
    saveConfig({ ...cfg, telemetry: opted })
    if (opted) {
      console.log(`   ${C.green('✔')}  Telemetry enabled — thank you! Run ${C.cyan('cork-ai telemetry off')} to disable.`)
    } else {
      console.log(`   ${C.dim('Telemetry off. Enable later with: cork-ai telemetry on')}`)
    }
    console.log()
  }

  console.log(`   Restart Claude Code for the hook to take effect.`)
  console.log(`   Run ${C.cyan('cork-ai gain')} after sessions to see savings.\n`)
}

function hooksRemove(): void {
  const settings = loadClaudeSettings()
  if (!isCorkHookInstalled(settings)) {
    console.log(`\n${C.yellow('cork-ai hook not found in settings.')}\n`); return
  }

  const pre = settings.hooks?.PreToolUse ?? []
  for (const group of pre) {
    group.hooks = group.hooks.filter(h => h.command !== CORK_HOOK_COMMAND)
  }
  if (settings.hooks) {
    settings.hooks.PreToolUse = pre.filter(g => g.hooks.length > 0)
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
  if (!installed) {
    console.log(`\n  Run ${C.cyan('cork-ai hooks install')} to enable Claude Code integration.`)
  }
  console.log()
}

// ─── hook (PreToolUse handler called by Claude Code) ─────────────────────────

// Token estimator (no external deps in hook path)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cs', '.cpp', '.c', '.h',
  '.rb', '.php', '.swift', '.kt', '.scala', '.r',
])

const TEXT_EXTS = new Set(['.md', '.txt', '.rst', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env'])

function extractCodeSignatures(content: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const lines = content.split('\n')
  const total = lines.length
  const kept: string[] = []

  // Always keep imports block (first contiguous block of imports)
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

  // Extract function/class/interface/type signatures
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
      // Include opening brace line if separate
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

  return `${header} (${pct}% compression)\n\n${kept.join('\n')}`
}

function compressJson(content: string): string {
  try {
    const obj = JSON.parse(content) as unknown
    // Keep structure but truncate deep/long values
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

function compressContent(content: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (CODE_EXTS.has(ext)) return extractCodeSignatures(content, filePath)
  if (ext === '.json') return compressJson(content)
  if (TEXT_EXTS.has(ext)) return compressText(content)
  return compressText(content)
}

function saveHookSavings(savedTokens: number, filePath: string): void {
  try {
    fs.mkdirSync(path.dirname(HOOK_SAVINGS_FILE), { recursive: true })
    let data: { total: number; byFile: Record<string, number> } = { total: 0, byFile: {} }
    try { data = JSON.parse(fs.readFileSync(HOOK_SAVINGS_FILE, 'utf-8')) as typeof data } catch { /* fresh */ }
    data.total += savedTokens
    data.byFile[path.basename(filePath)] = (data.byFile[path.basename(filePath)] ?? 0) + savedTokens
    fs.writeFileSync(HOOK_SAVINGS_FILE, JSON.stringify(data, null, 2), 'utf-8')
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

  if (hookEvent !== 'PreToolUse' || toolName !== 'Read') process.exit(0)

  const filePath = toolInput.file_path as string
  if (!filePath) process.exit(0)

  let content: string
  try { content = fs.readFileSync(filePath, 'utf-8') } catch { process.exit(0) }

  // Respect offset/limit from tool_input
  const offset = (toolInput.offset as number) ?? 0
  const limit = (toolInput.limit as number) ?? 2000
  const lines = content.split('\n')
  const slice = lines.slice(offset, offset + limit).join('\n')

  const originalTokens = estimateTokens(slice)
  if (originalTokens < 400) process.exit(0)  // not worth compressing

  const compressed = compressContent(slice, filePath)
  const compressedTokens = estimateTokens(compressed)
  if (compressedTokens >= originalTokens * 0.85) process.exit(0)  // less than 15% gain, skip

  const saved = originalTokens - compressedTokens
  saveHookSavings(saved, filePath)

  // Record this hook compression as a session in global stats
  // (lightweight: 1 "request" = 1 hook call)
  const savingsPct = Math.round((saved / originalTokens) * 1000) / 10
  try {
    recordSession({
      projectPath: (event.cwd as string) || process.cwd(),
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      requests: 1,
      originalTokens,
      compressedTokens,
      savedTokens: saved,
      savingsPercent: savingsPct,
      estimatedCostSaved: (saved / 1_000_000) * 3.0,
      byModule: { hookReadCompressor: saved },
    })
  } catch { /* non-critical */ }

  if (isTelemetryEnabled()) {
    sendTelemetry({
      v: VERSION,
      os: process.platform,
      arch: process.arch,
      savings_pct: savingsPct,
      requests: 1,
      duration_min: 0,
      modules: { hookReadCompressor: 100 },
    })
  }

  console.log(JSON.stringify({
    decision: 'block',
    reason: compressed,
  }))
}

// ─── Init command (previously implemented) ────────────────────────────────────

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
  console.log()
  console.log(`  Telemetry: ${enabled ? C.green('● enabled') : C.yellow('○ disabled')}`)
  if (cfg.telemetry === undefined) console.log(`  ${C.dim('(never configured — run cork-ai telemetry on to enable)')}`)
  if (process.env.DO_NOT_TRACK === '1') console.log(`  ${C.dim('(overridden by DO_NOT_TRACK=1)')}`)
  if (process.env.CORK_AI_TELEMETRY === '0') console.log(`  ${C.dim('(overridden by CORK_AI_TELEMETRY=0)')}`)
  console.log()
}

function resetStats(): void {
  const stats = readGlobalStats()
  if (!stats || stats.allTime.totalRequests === 0) {
    console.log('Nothing to reset.'); return
  }
  resetGlobalStats()
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
    // Internal: called by Claude Code PreToolUse hook
    await runHook().catch(() => process.exit(0))
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
    else showLastSession()
  } else if (cmd === 'report') {
    if (sub === '--daily') reportPeriod('day')
    else if (sub === '--weekly') reportPeriod('week')
    else if (sub === '--monthly') reportPeriod('month')
    else if (sub === '--projects') reportProjects()
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
