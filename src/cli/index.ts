#!/usr/bin/env node
/**
 * cork-ai CLI — stats, savings report, project setup, and Claude Code hooks.
 *
 * Commands:
 *   cork-ai gain                  Show current session + all-time savings
 *   cork-ai gain --all            Show all-time totals
 *   cork-ai gain --sessions [N]   The last N finished sessions (digests)
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
 *   cork-ai reset [--all]         Clear stats / learned policy / skip-list / caches
 *   cork-ai config                Read and edit ~/.cork-ai/config.json
 *   cork-ai update                Replace the standalone binary with the latest release
 *   cork-ai --version             Show version
 *   cork-ai --help                Show help
 */

import fs from 'fs'
import { spawnSync } from 'child_process'
import os from 'os'
import path from 'path'
import readline from 'readline'
import {
  readGlobalStats,
  resetGlobalStats,
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
import { scanAllTranscripts, contextReport, listTranscriptFiles } from './transcript-usage.js'
import { DIGEST_DIR, DIGEST_MAX_AGE_DAYS, latestDigest, listDigests, type SessionDigest } from './digests.js'
import { DEBUG_LOG_FILE, debugEnabled, debugLog, debugTrace } from './fs-utils.js'
import { lifetimeSavings, reReadPenalty, buildSavingsSnapshot, runSendSnapshot, snapshotDue, snapshotInputs } from './savings.js'
import { CLAUDE_SETTINGS, CORK_HOOKS, CORK_HOOK_FALLBACK, CLAUDE_EXEC_FORM_SINCE, CLAUDE_CODE_MIN, CLAUDE_CODE_TESTED_MAX, loadClaudeSettings, saveClaudeSettings, isCorkCmd, isCorkHookInstalled, installedCorkHooks, corkHookEntry, ensureHookGroup, renderHookEntry, isShellFormOnWindows, type ClaudeSettings } from './claude-settings.js'
import { policySummary, POLICY_FILE } from './policy.js'
import { skippedCount, SKIP_FILE } from './skip-list.js'
import { handleHookEvent, type HookOutput } from './hook.js'
import { VERSION, compareVersions } from './version.js'
import { CONFIG_FILE, CONFIG_KEYS, CORK_HOME, getConfigValue, loadConfig, saveConfig, setConfigValue, updateConfig, parseTokens, isTelemetryEnabled } from './config.js'
import { readHeartbeat } from './heartbeat.js'
import { sendTelemetry, runSendTelemetry, sendSnapshotDetached, capturePayload, POSTHOG_HOST } from './telemetry.js'
import {
  CALIBRATION_FILE,
  countTokensRaw,
  modelFamily,
  saveCalibrationFactor,
} from '../core/tokenizer.js'
import { SPEND_CACHE_FILE, ANALYSIS_CACHE_FILE } from './transcript-usage.js'

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
  cork-ai hooks install     Install/upgrade the Claude Code hooks (asks about auto-compaction)
  cork-ai doctor            Check that everything is wired and being called

${C.bold('Stats:')}
  cork-ai gain              Current session + all-time savings
  cork-ai gain --all        All-time totals only
  cork-ai gain --sessions   Last 10 finished sessions: turns, context, cost, saving at 200k (--sessions 30, --json)
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
  cork-ai doctor [--json]   Check the install: binary, hooks, self-test, coverage of recent sessions
  cork-ai context [--json]  Where the money goes: context size per turn, what auto-compaction would save
  cork-ai context --set-autocompact 200k   Set Claude Code's autoCompactWindow
  cork-ai context guard [on|off]           Toggle the live context notices
  cork-ai statusline        Status-line segment (reads Claude Code's status JSON on stdin)

${C.bold('Precision:')}
  cork-ai calibrate [model] Measure real token factors via the count_tokens API
                            (needs ANTHROPIC_API_KEY — makes every count model-exact)

${C.bold('Maintenance:')}
  cork-ai update            Replace the binary with the latest release (--check to only look)
  cork-ai config            List settings · config get|set|unset <key> [value]
  cork-ai reset             Clear stats (--policy, --skip-list, --spend-cache, --digests, --all)
  cork-ai telemetry on|off  Anonymous usage stats, opt-in (docs/TELEMETRY.md)
  cork-ai telemetry preview Show exactly what the daily snapshot would send
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

  // ── Section 1b: the last finished session's digest (SessionEnd hook) ──
  if (!live) {
    const digest = latestDigest()
    if (digest) printDigest(digest)
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

function fmtDuration(min: number | undefined): string {
  if (min === undefined) return '?'
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
}

/** One finished session, as the SessionEnd hook saw it. */
function printDigest(d: SessionDigest): void {
  const saving200k = d.costUSD > 0 ? Math.round(((d.costUSD - d.cappedCost200kUSD) / d.costUSD) * 100) : 0
  console.log(`${C.bold('cork-ai — Last Finished Session')} ${C.dim(`(${fmtDate(d.endedAt)}${d.project ? ' · ' + d.project : ''}${d.reason ? ' · ' + d.reason : ''})`)}`)
  console.log(divider())
  console.log(`  ${C.dim('Turns')}       ${fmt(d.turns)}   ${C.dim('Duration')} ${fmtDuration(d.durationMin)}   ${C.dim('Model')} ${C.cyan(d.model ?? '?')}${d.permissionMode ? C.dim(` · ${d.permissionMode} mode`) : ''}`)
  console.log(`  ${C.dim('Context')}     avg ${fmtTokens(d.avgContextTokens)} · max ${fmtTokens(d.maxContextTokens)} tokens   ${C.dim('Compactions')} ${d.compactions}`)
  console.log(`  ${C.dim('Cost')}        ${fmtUsdLong(d.costUSD)}   ${C.dim('with auto-compact at 200k')} ${fmtUsdLong(d.cappedCost200kUSD)} ${saving200k > 0 ? C.green(`(−${saving200k}%)`) : C.dim('(same)')}`)
  console.log(`  ${C.dim('cork-ai')}     ${d.compressions} outline${d.compressions === 1 ? '' : 's'} · ${C.green(fmt(d.savedTokens))} tokens saved · ${d.reReads ? C.yellow(`${d.reReads} re-read${d.reReads > 1 ? 's' : ''}`) : '0 re-reads'} · ${d.editFailures ? C.red(`${d.editFailures} edit failure${d.editFailures > 1 ? 's' : ''}`) : '0 edit failures'}${d.guardBands.length ? `   ${C.dim('Guard')} ${d.guardBands.map(fmtTokens).join(', ')}` : ''}`)
  console.log()
}

/** `cork-ai gain --sessions [N] [--json]`: the last N finished sessions. */
function showSessions(args: string[]): void {
  const json = args.includes('--json')
  const n = Number(args.find(a => /^\d+$/.test(a)) ?? 10)
  const digests = listDigests().slice(0, n)
  if (json) { console.log(JSON.stringify(digests, null, 2)); return }
  if (digests.length === 0) {
    console.log(`\n${C.yellow('No finished session recorded yet.')} ${C.dim('Digests are written by the SessionEnd hook (Claude Code ≥ 2.0.60) — end a session and come back.')}\n`)
    return
  }
  console.log(`\n${C.bold(`cork-ai — Last ${digests.length} finished session${digests.length > 1 ? 's' : ''}`)}  ${C.dim(`(${DIGEST_DIR}, kept ${DIGEST_MAX_AGE_DAYS} days)`)}`)
  console.log(divider('─', 110))
  console.log(C.dim(`  ${'Ended'.padEnd(7)} ${'Project'.padEnd(20)} ${'Turns'.padStart(5)} ${'Time'.padStart(7)} ${'Ctx avg'.padStart(8)} ${'Ctx max'.padStart(8)} ${'Cost'.padStart(8)} ${'@200k'.padStart(6)} ${'Cmp'.padStart(3)} ${'Outl'.padStart(5)} ${'Saved'.padStart(8)} ${'ReRd'.padStart(4)} ${'Fail'.padStart(4)}  Model`))
  let cost = 0, capped = 0, saved = 0, turns = 0
  for (const d of digests) {
    const saving200k = d.costUSD > 0 ? Math.round(((d.costUSD - d.cappedCost200kUSD) / d.costUSD) * 100) : 0
    cost += d.costUSD; capped += d.cappedCost200kUSD; saved += d.savedTokens; turns += d.turns
    console.log(`  ${new Date(d.endedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).padEnd(7)} ${(d.project ?? '').slice(0, 20).padEnd(20)} ${fmt(d.turns).padStart(5)} ${fmtDuration(d.durationMin).padStart(7)} ${fmtTokens(d.avgContextTokens).padStart(8)} ${fmtTokens(d.maxContextTokens).padStart(8)} ${fmtUsdLong(d.costUSD).padStart(8)} ${(saving200k > 0 ? `−${saving200k}%` : '—').padStart(6)} ${String(d.compactions).padStart(3)} ${String(d.compressions).padStart(5)} ${fmtTokens(d.savedTokens).padStart(8)} ${(d.reReads ? C.yellow(String(d.reReads).padStart(4)) : String(d.reReads).padStart(4))} ${(d.editFailures ? C.red(String(d.editFailures).padStart(4)) : String(d.editFailures).padStart(4))}  ${C.dim(d.model ?? '?')}`)
  }
  console.log(divider('─', 110))
  const total200k = cost > 0 ? Math.round(((cost - capped) / cost) * 100) : 0
  console.log(`  ${C.dim('Total')}   ${fmt(turns)} turns · ${fmtUsdLong(cost)} spent · ${fmtUsdLong(capped)} with auto-compact at 200k ${total200k > 0 ? C.green(`(−${total200k}%)`) : ''} · ${C.green(fmtTokens(saved))} tokens kept out of context by cork-ai`)
  console.log(`  ${C.dim('Cmp = compactions · Outl = outlines served · ReRd = full re-reads after an outline · Fail = failed edits on outlined files')}\n`)
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

async function hooksInstall(): Promise<void> {
  const settings = loadClaudeSettings()

  // Use the absolute binary path so the hook works
  // even if ~/.local/bin is not in Claude Code's PATH (Mac / Electron)
  const binaryPath = resolveHookBinary()
  const entry = corkHookEntry(binaryPath)

  const changed = CORK_HOOKS.map(spec => ({ spec, changed: ensureHookGroup(settings, spec, entry) })).filter(x => x.changed)

  // The guard is on by default once installed; keep any explicit user choice.
  const cfg = loadConfig()
  if (cfg.contextGuard?.enabled === undefined) saveConfig({ ...cfg, contextGuard: { ...(cfg.contextGuard ?? {}), enabled: true } })

  if (changed.length === 0) {
    console.log(`\n${C.green('✔')}  cork-ai hooks already installed in ${C.cyan(CLAUDE_SETTINGS)}\n`)
    await askAutoCompact(settings)
    return
  }

  saveClaudeSettings(settings)
  console.log(`\n${C.green('✔')}  cork-ai hooks installed.`)
  for (const { spec } of changed) {
    console.log(`   ${spec.event}${spec.matcher ? ` (${spec.matcher})` : ''} → ${C.cyan(CLAUDE_SETTINGS)}`)
  }
  if (binaryPath) console.log(`   Binary: ${C.dim(binaryPath)}${entry.args ? C.dim(' (exec form, no shell — needs Claude Code ≥ ' + CLAUDE_EXEC_FORM_SINCE + ')') : ''}`)
  console.log()
  console.log(`   ${C.dim('Read / Bash:')} whole-file reads (Read tool, cat, …) get a numbered outline when it pays off.`)
  console.log(`   ${C.dim('Context guard:')} a notice at 150k / 300k / 500k / 750k tokens of context — the cost that matters.`)
  console.log(`   ${C.dim('Check:')} ${C.cyan('cork-ai doctor')}   ${C.dim('Report:')} ${C.cyan('cork-ai context')}`)
  console.log()

  if (cfg.telemetry === undefined) await askTelemetryConsent()
  await askAutoCompact(settings)
  sendTelemetry({ event: 'install', properties: { hooks: changed.length, upgrade: changed.length < CORK_HOOKS.length, autocompact: loadClaudeSettings().autoCompactWindow ?? null } })
  sendSnapshotDetached('install', true)

  console.log(`   Restart Claude Code for the hooks to take effect.`)
  console.log(`   Run ${C.cyan('cork-ai gain')} after sessions to see savings.\n`)
}

/**
 * Asks a yes/no question on the real terminal. Works from `curl | sh` (stdin
 * is the pipe, so /dev/tty is read directly). Returns undefined when nothing
 * interactive is available (CI, container) — callers pick the safe default.
 */
async function askYesNo(prompt: string): Promise<boolean | undefined> {
  const parse = (a: string) => { const v = a.trim().toLowerCase(); return v === 'y' || v === 'yes' ? true : v === 'n' || v === 'no' || v === '' ? false : undefined }
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>(resolve => rl.question(prompt, a => { rl.close(); resolve(a) }))
    return parse(answer)
  }
  if (process.platform !== 'win32') {
    try {
      const tty = fs.openSync('/dev/tty', 'r+')
      fs.writeSync(tty, '\n' + prompt)
      const buf = Buffer.alloc(64)
      const n = fs.readSync(tty, buf, 0, 63, null)
      fs.closeSync(tty)
      return parse(buf.subarray(0, n).toString())
    } catch { /* /dev/tty unavailable */ }
  }
  return undefined
}

async function askTelemetryConsent(): Promise<void> {
  const answer = await askYesNo(`   ${C.dim('Help improve cork-ai? Send anonymous usage stats (no file paths, no names, no content — docs/TELEMETRY.md).')} [y/N]: `)
  if (answer === undefined) {
    updateConfig({ telemetry: false })
    console.log(`   ${C.dim('Telemetry off by default. Enable later: cork-ai telemetry on')}`)
    return
  }
  updateConfig({ telemetry: answer })
  if (answer) {
    sendTelemetry({ event: 'telemetry_toggled', properties: { enabled: true, at: 'install' } })
    console.log(`   ${C.green('✔')}  Telemetry enabled — thank you! Run ${C.cyan('cork-ai telemetry off')} to disable.`)
  } else {
    console.log(`   ${C.dim('Telemetry off. Enable later with: cork-ai telemetry on')}`)
  }
  console.log()
}

/**
 * The one setting that moves the bill: Claude Code's auto-compaction window.
 * Measured on real history, contexts left to grow towards 1M cost 2× what the
 * same work costs compacted at 200k. Asked once; `cork-ai context` explains.
 */
async function askAutoCompact(settings: ClaudeSettings): Promise<void> {
  const cfg = loadConfig()
  if (cfg.autoCompactAnswered || settings.autoCompactWindow) return
  console.log(`   ${C.bold('Auto-compaction.')} Every tool call re-sends the whole context. Left to grow towards 1M tokens,`)
  console.log(`   that is most of the bill; compacting at 200k roughly halves it on long sessions (${C.cyan('cork-ai context')} shows yours).`)
  const answer = await askYesNo(`   Set Claude Code's autoCompactWindow to 200k tokens now? [y/N]: `)
  if (answer === undefined) {
    console.log(`   ${C.dim('Skipped (non-interactive). Later: cork-ai context --set-autocompact 200k')}`)
    return
  }
  updateConfig({ autoCompactAnswered: true })
  if (answer) {
    const fresh = loadClaudeSettings()
    fresh.autoCompactWindow = 200_000
    saveClaudeSettings(fresh)
    console.log(`   ${C.green('✔')}  autoCompactWindow = 200k in ${C.dim(CLAUDE_SETTINGS)} ${C.dim('(/autocompact auto in Claude Code restores the default)')}`)
  } else {
    console.log(`   ${C.dim('Kept as is. Later: cork-ai context --set-autocompact 200k')}`)
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
      group.hooks = group.hooks.filter(h => !isCorkCmd(h))
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

// ─── hook (called by Claude Code on every hook event) ────────────────────────

// All the logic lives in src/cli/hook.ts (pure, unit-tested). This is the I/O shell.
async function runHook(): Promise<void> {
  const started = Date.now()
  let input = ''
  try { for await (const chunk of process.stdin) input += chunk } catch (err) { debugLog('hook.stdin', err); return }
  if (!input.trim()) return
  let event: Record<string, unknown>
  try { event = JSON.parse(input) as Record<string, unknown> } catch (err) { debugLog('hook.parse', err, { bytes: input.length }); return }
  // Whatever happens, the tool call must go through: an exception here would
  // surface as a hook error in Claude Code and, worse, hide the cause.
  let output: HookOutput
  try { output = handleHookEvent(event) } catch (err) { debugLog('hook.handle', err, { event: event.hook_event_name, tool: event.tool_name }); return }
  if (output) console.log(JSON.stringify(output))
  debugTrace('hook.event', { event: event.hook_event_name, tool: event.tool_name, agent: typeof event.agent_type === 'string' ? event.agent_type : undefined, decision: output ? 'deny' : 'pass', ms: Date.now() - started })
}

// ─── context (the report that explains the bill) ─────────────────────────────

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
  if (before === tokens) {
    console.log(`\n${C.green('✔')}  autoCompactWindow is already ${C.cyan(fmtTokens(tokens))} tokens in ${C.dim(CLAUDE_SETTINGS)} — nothing to do.\n`)
    return
  }
  settings.autoCompactWindow = tokens
  saveClaudeSettings(settings)
  updateConfig({ autoCompactAnswered: true })
  console.log(`\n${C.green('✔')}  autoCompactWindow set to ${C.cyan(fmtTokens(tokens))} tokens in ${C.dim(CLAUDE_SETTINGS)}` +
    (before ? ` ${C.dim(`(was ${fmtTokens(before)})`)}` : ''))
  console.log(`   Claude Code compacts automatically once the context reaches it. Takes effect on the next session;`)
  console.log(`   ${C.dim('/autocompact auto')} in Claude Code restores the model default.\n`)
}

function showContext(args: string[]): void {
  const setRaw = flagValue(args, '--set-autocompact')
  if (setRaw !== undefined) {
    const tokens = parseTokens(setRaw)
    if (!tokens) { console.error(`\nUsage: cork-ai context --set-autocompact 200k\n`); process.exit(1) }
    setAutoCompactWindow(tokens)
    return
  }

  const days = Number(flagValue(args, '--days') ?? 30)
  const ceiling = parseTokens(flagValue(args, '--ceiling')) ?? 200_000
  const ceilings = [...new Set([150_000, 200_000, 300_000, ceiling])].sort((a, b) => a - b)
  const since = new Date(Date.now() - days * 86_400_000)
  const report = contextReport({ since, ceilings, minTurns: 20 })
  const settings = loadClaudeSettings()

  if (args.includes('--json')) {
    console.log(JSON.stringify({
      days, ceiling, ceilings,
      totals: { sessions: report.sessions.length, turns: report.turns, costUSD: report.costUSD, cacheReadCostUSD: report.cacheReadCostUSD, avgContextTokens: report.avgContextTokens, cappedCostUSD: report.cappedCostUSD },
      settings: { autoCompactWindow: settings.autoCompactWindow ?? null, model: settings.model ?? null },
      sessions: report.sessions,
    }, null, 2))
    return
  }

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
        else if ((block.name === 'Bash' || block.name === 'PowerShell') && /(?:^|[;&|]\s*)(?:rtk proxy )?(?:cat|sed -n|head|tail|nl|bat|Get-Content|gc|type)\b/i.test(String(block.input?.command ?? ''))) bashReads++
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

interface DoctorCheck {
  name: string
  status: 'ok' | 'warn' | 'fail' | 'info'
  summary: string
  /** Extra lines under the check (text mode) */
  lines?: string[]
  data?: Record<string, unknown>
}

async function runDoctor(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const checks: DoctorCheck[] = []
  const push = (c: DoctorCheck) => { checks.push(c); return c }

  // 1. Binary
  const binary = resolveHookBinary()
  if (binary) {
    let executable = true
    try { fs.accessSync(binary, fs.constants.X_OK) } catch { executable = false }
    push({ name: 'binary', status: executable ? 'ok' : 'fail', summary: `${binary}${executable ? '' : '  not executable'}`, data: { path: binary, executable, version: VERSION } })
  } else {
    push({ name: 'binary', status: 'warn', summary: 'not found in the usual locations — hooks fall back to PATH lookup (fragile)', data: { path: null, version: VERSION } })
  }

  // 2. Hooks in settings
  const settings = loadClaudeSettings()
  const hooks = installedCorkHooks(settings)
  const missing = hooks.filter(h => !h.present)
  const stale = hooks.filter(h => h.present && h.command && h.command !== CORK_HOOK_FALLBACK && binary && !h.command.includes(binary))
  // Windows: the shell form runs through PowerShell when Git Bash is absent
  // (Claude Code ≥ 2.1.120) and `"…\cork-ai.exe" hook` is a parse error there.
  const shellForm = hooks.filter(h => h.present && h.entry && isShellFormOnWindows(h.entry))
  push({
    name: 'hooks',
    status: missing.length === 0 && shellForm.length === 0 ? 'ok' : 'fail',
    summary: `${hooks.length - missing.length}/${hooks.length} installed in ${CLAUDE_SETTINGS}${shellForm.length > 0 ? `  ${shellForm.length} in shell form (never fires under PowerShell)` : ''}`,
    lines: [
      ...missing.map(h => `${C.yellow('missing')} ${h.event}${h.matcher ? ` (${h.matcher})` : ''}`),
      ...(missing.length > 0 ? [`→ ${C.cyan('cork-ai hooks install')}`] : []),
      ...(stale.length > 0 ? [`${C.yellow('!')} ${stale.length} hook(s) point at another binary path — ${C.cyan('cork-ai hooks install')} re-targets them`] : []),
      ...(shellForm.length > 0 ? [`${C.yellow('!')} On Windows the hook must be in exec form (command + args) — ${C.cyan('cork-ai hooks install')} rewrites it. Needs Claude Code ≥ ${CLAUDE_EXEC_FORM_SINCE}.`] : []),
    ],
    data: { installed: hooks.filter(h => h.present).map(h => `${h.event}${h.matcher ? `:${h.matcher}` : ''}`), missing: missing.map(h => `${h.event}${h.matcher ? `:${h.matcher}` : ''}`), stale: stale.length, shellFormOnWindows: shellForm.length },
  })

  // 3. Other hooks on the same matchers
  for (const spec of CORK_HOOKS.filter(h => h.event === 'PreToolUse')) {
    const others = (settings.hooks?.PreToolUse ?? [])
      .filter(g => g.matcher === spec.matcher)
      .flatMap(g => g.hooks.filter(h => !isCorkCmd(h)).map(h => renderHookEntry(h)))
    if (others.length > 0) {
      push({
        name: `neighbours:${spec.matcher}`, status: 'warn',
        summary: `${others.length} other PreToolUse hook(s) on ${spec.matcher}: ${others.map(o => o.split(' ').slice(-1)[0]).join(', ')}`,
        lines: [C.dim('If one of them blocks reads (e.g. a read cache), both views may be sent; not a cork-ai failure, but worth knowing.')],
        data: { matcher: spec.matcher, count: others.length },
      })
    }
  }

  // 4. Self-test
  if (binary) {
    const test = selfTestHook(binary)
    push({ name: 'self-test', status: test.ok ? 'ok' : 'fail', summary: test.detail, data: { ok: test.ok } })
  }

  // 5. Heartbeat
  const beat = readHeartbeat()
  if (beat) {
    const ageMin = Math.round((Date.now() - new Date(beat.at).getTime()) / 60_000)
    const age = ageMin < 60 ? `${ageMin} min ago` : ageMin < 60 * 48 ? `${Math.round(ageMin / 60)} h ago` : `${Math.round(ageMin / 1440)} days ago`
    push({ name: 'heartbeat', status: 'ok', summary: `last hook event ${age} (${beat.event}${beat.toolName ? ' ' + beat.toolName : ''} · Claude Code ${beat.claudeVersion ?? '?'}${beat.permissionMode ? ' · ' + beat.permissionMode + ' mode' : ''} · cork-ai ${beat.corkVersion})`, data: { ...beat, ageMinutes: ageMin } })
  } else {
    push({ name: 'heartbeat', status: 'warn', summary: 'no hook event recorded yet (appears after the first Read/Bash/Edit in a session started after install)', data: {} })
  }

  // 6. Coverage
  const rows = coverage(14)
  const unseen = rows.filter(r => !r.seen)
  const totalReads = rows.reduce((s, r) => s + r.reads, 0)
  const totalBash = rows.reduce((s, r) => s + r.bashReads, 0)
  if (rows.length === 0) {
    push({ name: 'coverage', status: 'info', summary: 'no Claude Code session with 5+ turns in the last 14 days', data: { sessions: 0 } })
  } else {
    const lines = rows.slice(0, 8).map(r => {
      const date = r.startedAt ? new Date(r.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?'
      const project = r.project.replace(/^-home-[^-]+-projects-/, '').replace(/^-/, '').slice(0, 22)
      return `${r.seen ? C.green('●') : C.red('○')} ${date.padEnd(7)} ${project.padEnd(23)} ${fmt(r.turns).padStart(5)} turns  ${fmt(r.reads).padStart(4)} Read  ${fmt(r.bashReads).padStart(4)} Bash-read  ${C.dim(`${r.claudeVersion ?? ''}${r.permissionMode ? ' ' + r.permissionMode : ''}`)}`
    })
    if (totalBash > totalReads && !hooks.find(h => h.matcher?.startsWith('Bash'))?.present) {
      lines.push(`${C.red('→')} the model reads through Bash (auto mode) and the Bash hook is missing: ${C.cyan('cork-ai hooks install')}`)
    }
    push({
      name: 'coverage',
      status: unseen.length === 0 ? 'ok' : unseen.length === rows.length ? 'fail' : 'warn',
      summary: `${rows.length - unseen.length}/${rows.length} sessions (14 days) produced cork-ai events · reads: ${fmt(totalReads)} via Read, ${fmt(totalBash)} via Bash (cat/sed/head)`,
      lines,
      data: { sessions: rows.length, seen: rows.length - unseen.length, reads: totalReads, bashReads: totalBash, rows: rows.map(r => ({ sessionId: r.sessionId, startedAt: r.startedAt, turns: r.turns, reads: r.reads, bashReads: r.bashReads, seen: r.seen, claudeVersion: r.claudeVersion, permissionMode: r.permissionMode })) },
    })
  }

  // 6b. Claude Code version: inside the range cork-ai was built and tested against?
  {
    const cc = beat?.claudeVersion ?? rows.find(r => r.claudeVersion)?.claudeVersion
    const min = process.platform === 'win32' ? CLAUDE_EXEC_FORM_SINCE : CLAUDE_CODE_MIN
    const tooOld = cc !== undefined && compareVersions(cc, min) < 0
    const newer = cc !== undefined && compareVersions(cc, CLAUDE_CODE_TESTED_MAX) > 0
    push({
      name: 'claude-code',
      status: tooOld ? (process.platform === 'win32' ? 'fail' : 'warn') : cc ? 'ok' : 'info',
      summary: tooOld
        ? `Claude Code ${cc} is older than ${min}${process.platform === 'win32' ? ' — hooks in exec form need it on Windows' : ' — the oldest version the hook payload was verified against'}: update Claude Code`
        : cc
          ? `Claude Code ${cc}${newer ? ` (newer than ${CLAUDE_CODE_TESTED_MAX}, the last version tested — see docs/METHODOLOGY.md)` : ' (tested range)'}`
          : `Claude Code version unknown yet (appears with the first hook event) — supported: ${min} … ${CLAUDE_CODE_TESTED_MAX}`,
      data: { claudeVersion: cc ?? null, minimum: min, testedMax: CLAUDE_CODE_TESTED_MAX },
    })
  }

  // 6c. Telemetry snapshot and caches
  const cfgNow = loadConfig()
  if (cfgNow.telemetry) {
    const last = cfgNow.lastSnapshotAt ? new Date(cfgNow.lastSnapshotAt).getTime() : undefined
    const ageH = last ? Math.round((Date.now() - last) / 3_600_000) : undefined
    push({
      name: 'snapshot',
      status: ageH === undefined || ageH > 48 ? 'warn' : 'ok',
      summary: ageH === undefined ? 'telemetry on but no daily snapshot sent yet — cork-ai gain or the end of a session sends one' : ageH > 48 ? `last daily snapshot ${ageH} h ago — cork-ai gain sends a new one` : `last daily snapshot ${ageH} h ago`,
      data: { lastSnapshotAt: cfgNow.lastSnapshotAt ?? null, ageHours: ageH ?? null },
    })
  }
  {
    const has = (f: string) => { try { return fs.statSync(f).size > 2 } catch { return false } }
    const spend = has(SPEND_CACHE_FILE), analysis = has(ANALYSIS_CACHE_FILE)
    push({ name: 'caches', status: 'info', summary: `transcript caches: spend ${spend ? 'present' : 'absent'}, analysis ${analysis ? 'present' : 'absent'} ${C.dim('(built by gain --all / context; reset --spend-cache clears them)')}`, data: { spendCache: spend, analysisCache: analysis } })
  }
  {
    let errors24h = 0, lines = 0
    try {
      const cutoff = Date.now() - 86_400_000
      for (const line of fs.readFileSync(DEBUG_LOG_FILE, 'utf-8').split('\n')) {
        if (!line) continue
        lines++
        try { const r = JSON.parse(line) as { at?: string; error?: string }; if (r.error && r.at && new Date(r.at).getTime() > cutoff) errors24h++ } catch { /* partial */ }
      }
    } catch { /* no log */ }
    if (debugEnabled() || lines > 0) {
      push({
        name: 'debug',
        status: errors24h > 0 ? 'warn' : 'info',
        summary: `${debugEnabled() ? 'CORK_AI_DEBUG on' : 'debug log present'} — ${DEBUG_LOG_FILE}: ${lines} line(s), ${errors24h} error(s) in 24 h`,
        data: { enabled: debugEnabled(), file: DEBUG_LOG_FILE, lines, errors24h },
      })
    }
  }

  // 7. Context settings
  const acw = settings.autoCompactWindow
  const model = String(settings.model ?? '')
  push(acw
    ? { name: 'compaction', status: 'ok', summary: `autoCompactWindow = ${fmtTokens(acw)} tokens`, data: { autoCompactWindow: acw, model } }
    : { name: 'compaction', status: 'warn', summary: `autoCompactWindow unset${/\[1m\]/.test(model) ? ` and model is ${model} — contexts can reach 1M` : ''}: ${C.cyan('cork-ai context')} shows what that costs`, data: { autoCompactWindow: null, model } })
  const guard = loadConfig().contextGuard
  push({ name: 'guard', status: guard?.enabled === false ? 'warn' : 'ok', summary: `context guard ${guard?.enabled === false ? 'off' : 'on'} (bands ${(guard?.bands ?? [150_000, 300_000, 500_000, 750_000]).map(fmtTokens).join(' / ')})`, data: { enabled: guard?.enabled !== false, bands: guard?.bands ?? [150_000, 300_000, 500_000, 750_000] } })

  // 8. Policy
  const policy = policySummary()
  const onProbation = policy.filter(p => p.probation)
  if (policy.length > 0) {
    push({ name: 'policy', status: 'ok', summary: `${policy.length} extension(s) learned` + (onProbation.length > 0 ? `, ${onProbation.length} on probation: ${onProbation.map(p => `${p.ext} ${Math.round(p.reReadRate * 100)}%`).join(', ')}` : ''), data: { extensions: policy } })
  }

  // 9. Version check (best effort, 6 s budget)
  const latest = await fetchLatestRelease()
  if (latest) {
    const behind = compareVersions(latest.version, VERSION) > 0
    push({ name: 'version', status: behind ? 'warn' : 'ok', summary: behind ? `v${VERSION} installed, ${latest.tag} available → ${C.cyan('cork-ai update')}` : `v${VERSION} is the latest release`, data: { installed: VERSION, latest: latest.version } })
  } else {
    push({ name: 'version', status: 'info', summary: `v${VERSION} (could not check GitHub for a newer release)`, data: { installed: VERSION, latest: null } })
  }

  const problems = checks.filter(c => c.status === 'fail').length
  const telemetry = isTelemetryEnabled()

  if (json) {
    console.log(JSON.stringify({ version: VERSION, ok: problems === 0, problems, telemetry, checks: checks.map(c => ({ name: c.name, status: c.status, summary: stripAnsi(c.summary), ...c.data })) }, null, 2))
    if (problems > 0) process.exitCode = 1
    return
  }

  const marks = { ok: C.green('✔'), warn: C.yellow('!'), fail: C.red('✗'), info: C.dim('·') }
  console.log(`\n${C.bold('cork-ai doctor')} v${VERSION}`)
  console.log(divider())
  for (const c of checks) {
    const label = c.name.replace(/:.*$/, '').replace(/^\w/, ch => ch.toUpperCase())
    console.log(`  ${marks[c.status]} ${label.padEnd(13)} ${c.summary}`)
    for (const l of c.lines ?? []) console.log(`      ${l}`)
  }
  console.log(divider())
  if (problems === 0) console.log(`  ${C.green('All good.')} cork-ai is wired and being called.${telemetry ? '' : C.dim('  (telemetry off — cork-ai telemetry on helps improve it)')}\n`)
  else console.log(`  ${C.yellow(`${problems} problem(s) found.`)} Fix them above, restart Claude Code, then run ${C.cyan('cork-ai doctor')} again.\n`)
  if (problems > 0) process.exitCode = 1
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
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

// ─── Telemetry commands ───────────────────────────────────────────────────────

function telemetryOn(): void {
  updateConfig({ telemetry: true })
  sendTelemetry({ event: 'telemetry_toggled', properties: { enabled: true } })
  sendSnapshotDetached('telemetry_on', true)
  console.log(`\n${C.green('✔')}  Telemetry enabled. Thank you — anonymous usage events go to PostHog (EU).`)
  console.log(`   ${C.dim('What is sent: version, OS, model family, token buckets, hook decisions, aggregate savings. Never paths, names or content.')}`)
  console.log(`   ${C.dim('See exactly what leaves this machine:')} ${C.cyan('cork-ai telemetry preview')}`)
  console.log(`   ${C.dim('Details: docs/TELEMETRY.md')}   Run ${C.cyan('cork-ai telemetry off')} to disable.\n`)
}

function telemetryOff(): void {
  // Sent before the switch so the opt-out itself is visible in the numbers.
  sendTelemetry({ event: 'telemetry_toggled', properties: { enabled: false } })
  updateConfig({ telemetry: false })
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
  if (cfg.installId) console.log(`  Install id: ${C.dim(cfg.installId)} ${C.dim('(random, not derived from this machine)')}`)
  console.log(`  Endpoint:   ${C.dim(`${POSTHOG_HOST} (PostHog Cloud EU)`)}`)
  if (enabled) console.log(`  Last daily snapshot: ${C.dim(cfg.lastSnapshotAt ? fmtDate(cfg.lastSnapshotAt) : 'not yet — sent after the next session ends, or on cork-ai gain')}`)
  console.log(`  ${C.dim('Preview the exact payloads:')} ${C.cyan('cork-ai telemetry preview')}`)
  console.log()
}

/**
 * Prints, byte for byte, what the daily snapshot would send right now — plus
 * the person profile every event refreshes. Trust is easier to earn when the
 * payload is one command away.
 */
function telemetryPreview(json: boolean): void {
  const cfg = loadConfig()
  const distinctId = cfg.installId ?? '<random uuid minted when telemetry is enabled>'
  const payload = capturePayload(buildSavingsSnapshot('preview'), distinctId)
  if (json) { console.log(JSON.stringify(payload, null, 2)); return }
  console.log()
  console.log(`  ${C.bold('savings_snapshot')} — sent once a day at most, when a session ends or on ${C.cyan('cork-ai gain')}`)
  console.log(`  ${C.dim('Built locally from:')}`)
  for (const src of snapshotInputs()) console.log(`    ${C.dim('·')} ${C.dim(src)}`)
  console.log()
  console.log(JSON.stringify(payload, null, 2).split('\n').map(l => `  ${l}`).join('\n'))
  console.log()
  console.log(`  ${C.dim('Not in there, and never sent: file paths or names, project names, prompts, file content, command lines, session ids, exact spend.')}`)
  console.log(`  ${C.dim('Telemetry is')} ${isTelemetryEnabled() ? C.green('on') : C.yellow('off')}${isTelemetryEnabled() ? '' : C.dim(' — nothing is sent until cork-ai telemetry on')}`)
  console.log()
}

// ─── config ──────────────────────────────────────────────────────────────────

function runConfig(args: string[]): void {
  const [sub, key, ...rest] = args
  const cfg = loadConfig()
  if (!sub || sub === 'list') {
    console.log(`\n${C.bold('cork-ai config')} ${C.dim(CONFIG_FILE)}`)
    console.log(divider())
    for (const [k, meta] of Object.entries(CONFIG_KEYS)) {
      const v = getConfigValue(cfg, k)
      console.log(`  ${k.padEnd(30)} ${C.cyan(v === undefined ? C.dim('(default)') : JSON.stringify(v)).padEnd(24)} ${C.dim(meta.description)}`)
    }
    console.log(`  ${'detectedModel'.padEnd(30)} ${C.cyan(cfg.detectedModel ?? C.dim('(none yet)'))}`)
    console.log(divider())
    console.log(`  ${C.dim('cork-ai config get <key> · cork-ai config set <key> <value> · cork-ai config unset <key>')}\n`)
    return
  }
  if (sub === 'get') {
    if (!key) { console.error('\nUsage: cork-ai config get <key>\n'); process.exit(1) }
    const v = getConfigValue(cfg, key)
    console.log(v === undefined ? '' : JSON.stringify(v))
    return
  }
  if (sub === 'set') {
    const meta = key ? CONFIG_KEYS[key] : undefined
    if (!key || !meta || rest.length === 0) {
      console.error(`\nUsage: cork-ai config set <key> <value>\nKeys: ${Object.keys(CONFIG_KEYS).join(', ')}\n`)
      process.exit(1)
    }
    const value = meta.parse(rest.join(' '))
    saveConfig(setConfigValue(cfg, key, value))
    console.log(`\n${C.green('✔')}  ${key} = ${JSON.stringify(value)}\n`)
    return
  }
  if (sub === 'unset') {
    if (!key) { console.error('\nUsage: cork-ai config unset <key>\n'); process.exit(1) }
    saveConfig(setConfigValue(cfg, key, undefined))
    console.log(`\n${C.green('✔')}  ${key} reset to default\n`)
    return
  }
  console.error(`\nUsage: cork-ai config [list|get <key>|set <key> <value>|unset <key>]\n`)
  process.exit(1)
}

// ─── reset ────────────────────────────────────────────────────────────────────

function runReset(args: string[]): void {
  const what = args[0] ?? '--stats'
  const targets: Record<string, { label: string; run: () => void }> = {
    '--stats': {
      label: 'stats.json and live sessions',
      run: () => { resetGlobalStats(); clearLiveSession() },
    },
    '--policy': {
      label: 'learned re-read rates (policy.json)',
      run: () => { try { fs.unlinkSync(POLICY_FILE) } catch { /* none */ } },
    },
    '--skip-list': {
      label: 'files served raw for good (skip-list.json)',
      run: () => { try { fs.unlinkSync(SKIP_FILE) } catch { /* none */ } },
    },
    '--spend-cache': {
      label: 'transcript caches (spend-cache.json, analysis-cache.json)',
      run: () => { for (const f of [SPEND_CACHE_FILE, ANALYSIS_CACHE_FILE]) { try { fs.unlinkSync(f) } catch { /* none */ } } },
    },
    '--digests': {
      label: 'session digests',
      run: () => { try { fs.rmSync(path.join(CORK_HOME, 'digests'), { recursive: true, force: true }) } catch { /* none */ } },
    },
  }
  const chosen = what === '--all' ? Object.keys(targets) : [what]
  const unknown = chosen.filter(c => !targets[c])
  if (unknown.length > 0) {
    console.error(`\nUsage: cork-ai reset [--stats|--policy|--skip-list|--spend-cache|--digests|--all]\n`)
    process.exit(1)
  }
  console.log()
  for (const c of chosen) {
    targets[c].run()
    console.log(`  ${C.green('✔')}  cleared ${targets[c].label}`)
  }
  console.log(`  ${C.dim(`Config (${CONFIG_FILE}) and the heartbeat are kept.`)}\n`)
}

// ─── update (replace the standalone binary with the latest release) ───────────

const RELEASE_REPO = 'mqthys62/cork-ai'

interface LatestRelease { tag: string; version: string; assets: Record<string, string> }

async function fetchLatestRelease(timeoutMs = 6_000): Promise<LatestRelease | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `cork-ai/${VERSION}` },
      signal: controller.signal,
    })
    if (!res.ok) return undefined
    const json = await res.json() as { tag_name?: string; assets?: Array<{ name: string; browser_download_url: string }> }
    if (!json.tag_name) return undefined
    const assets: Record<string, string> = {}
    for (const a of json.assets ?? []) assets[a.name] = a.browser_download_url
    return { tag: json.tag_name, version: json.tag_name.replace(/^v/, ''), assets }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function releaseAssetName(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `cork-ai-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`
}

async function runUpdate(args: string[]): Promise<void> {
  const checkOnly = args.includes('--check')
  const latest = await fetchLatestRelease()
  if (!latest) {
    console.error(`\n${C.yellow('Could not reach GitHub releases.')} Check https://github.com/${RELEASE_REPO}/releases\n`)
    process.exit(1)
  }
  const cmp = compareVersions(latest.version, VERSION)
  console.log(`\n  Installed ${C.cyan(`v${VERSION}`)} · latest ${C.cyan(latest.tag)}`)
  if (cmp <= 0) { console.log(`  ${C.green('✔')}  Up to date.\n`); return }
  if (checkOnly) { console.log(`  ${C.yellow('!')}  Update available: ${C.cyan('cork-ai update')}\n`); return }

  const binary = resolveHookBinary()
  const compiled = binary && binary === process.execPath
  if (!compiled) {
    console.log(`  ${C.yellow('!')}  This cork-ai runs from node/npm, not the standalone binary. Update with your package manager, or reinstall:`)
    console.log(`     ${C.cyan(`curl -fsSL https://raw.githubusercontent.com/${RELEASE_REPO}/main/scripts/install.sh | sh`)}\n`)
    return
  }
  const asset = releaseAssetName()
  const url = latest.assets[asset]
  if (!url) { console.error(`  ${C.red('✗')}  No asset ${asset} in ${latest.tag}.\n`); process.exit(1) }

  console.log(`  Downloading ${C.dim(asset)}…`)
  const res = await fetch(url, { headers: { 'User-Agent': `cork-ai/${VERSION}` } })
  if (!res.ok) { console.error(`  ${C.red('✗')}  Download failed (${res.status}).\n`); process.exit(1) }
  const bytes = Buffer.from(await res.arrayBuffer())
  const tmp = `${binary}.new`
  fs.writeFileSync(tmp, bytes)
  try { fs.chmodSync(tmp, 0o755) } catch { /* windows */ }

  if (process.platform === 'win32') {
    // A running .exe cannot be replaced on Windows: leave the new file next to it.
    console.log(`  ${C.green('✔')}  Saved to ${C.dim(tmp)}. Close Claude Code, then replace the binary:`)
    console.log(`     ${C.cyan(`Move-Item -Force "${tmp}" "${binary}"`)}   ${C.dim('(PowerShell)')}\n`)
    return
  }
  fs.renameSync(tmp, binary)  // atomic on POSIX; the running process keeps its old inode
  console.log(`  ${C.green('✔')}  Updated to ${latest.tag}. Hooks keep pointing at ${C.dim(binary)} — nothing else to do.`)
  console.log(`  ${C.dim('Run cork-ai doctor to confirm.')}\n`)
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

;(async () => {
  const args = process.argv.slice(2)
  const cmd = args[0]
  const sub = args[1]

  // Usage telemetry for the CLI itself (never for the hook, which is called per tool use).
  if (cmd && cmd !== 'hook' && cmd !== '__send-telemetry') sendTelemetry({ event: 'command', properties: { command: cmd, sub: sub?.startsWith('--') || ['install', 'remove', 'status', 'on', 'off', 'guard', 'list', 'get', 'set'].includes(sub ?? '') ? sub : undefined } })

  if (!cmd || cmd === '--help' || cmd === '-h') {
    showHelp()
  } else if (cmd === '--version' || cmd === '-v') {
    showVersion()
  } else if (cmd === 'hook') {
    await runHook().catch(() => { /* a hook must never fail a tool call */ })
  } else if (cmd === '__send-telemetry') {
    await runSendTelemetry(sub)
  } else if (cmd === '__send-snapshot') {
    await runSendSnapshot(sub, args.includes('--force'))
  } else if (cmd === 'calibrate') {
    await runCalibrate(sub).catch(err => {
      console.error(`\n${C.yellow('Calibration failed:')} ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    })
  } else if (cmd === 'hooks') {
    if (sub === 'install') await hooksInstall()
    else if (sub === 'remove' || sub === 'uninstall') hooksRemove()
    else if (sub === 'status') hooksStatus()
    else { console.error(`\nUsage: cork-ai hooks [install|remove|status]\n`); process.exit(1) }
  } else if (cmd === 'telemetry') {
    if (sub === 'on') telemetryOn()
    else if (sub === 'off') telemetryOff()
    else if (sub === 'status' || !sub) telemetryStatus()
    else if (sub === 'preview') telemetryPreview(args.includes('--json'))
    else { console.error(`\nUsage: cork-ai telemetry [on|off|status|preview [--json]]\n`); process.exit(1) }
  } else if (cmd === 'config') {
    runConfig(args.slice(1))
  } else if (cmd === 'update') {
    await runUpdate(args.slice(1))
  } else if (cmd === 'gain') {
    if (sub === '--all') showAllTime()
    else if (sub === '--sessions') showSessions(args.slice(2))
    else if (sub === '--history') showHistory()
    else if (sub === '--models') showModels()
    else showLastSession()
    if (snapshotDue()) sendSnapshotDetached('gain')
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
    runReset(args.slice(1))
  } else if (cmd === 'doctor') {
    await runDoctor(args.slice(1))
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
