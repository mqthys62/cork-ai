#!/usr/bin/env node
/**
 * cork-ai CLI — stats and savings report.
 *
 * Commands:
 *   cork-ai gain             Show savings from the last session
 *   cork-ai gain --history   Show all recorded sessions
 *   cork-ai gain --all       Show all-time totals
 *   cork-ai reset            Reset all stats
 *   cork-ai --version        Show version
 *   cork-ai --help           Show help
 */

import { readGlobalStats, resetGlobalStats, STATS_FILE } from './persistent-stats.js'

const VERSION = '0.1.0'

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function bar(percent: number, width = 30): string {
  const filled = Math.round((percent / 100) * width)
  const empty = width - filled
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${fmtPct(percent)}`
}

function divider(char = '─', len = 60): string {
  return char.repeat(len)
}

// ─── Colors (no deps — raw ANSI) ─────────────────────────────────────────────

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  reset: '\x1b[0m',
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
${C.bold('cork-ai')} v${VERSION} — Context optimization for Claude Code

${C.bold('Usage:')}
  cork-ai gain              Show savings from the last recorded session
  cork-ai gain --all        Show all-time totals
  cork-ai gain --history    Show all recorded sessions
  cork-ai reset             Reset all stats (irreversible)
  cork-ai --version         Show version
  cork-ai --help            Show this help

${C.bold('Stats file:')} ${STATS_FILE}
`)
}

function showVersion(): void {
  console.log(`cork-ai v${VERSION}`)
}

function showLastSession(): void {
  const stats = readGlobalStats()

  if (!stats || stats.sessions.length === 0) {
    console.log(`\n${C.yellow('No sessions recorded yet.')}\n`)
    console.log(`Run cork-ai in your project and sessions will be tracked here.`)
    console.log(`Stats file: ${C.dim(STATS_FILE)}\n`)
    return
  }

  const last = stats.sessions[stats.sessions.length - 1]
  const pct = last.originalTokens > 0
    ? (last.savedTokens / last.originalTokens) * 100
    : 0

  console.log(`\n${C.bold('cork-ai — Last Session')}`)
  console.log(divider())
  console.log(`  ${C.dim('Date')}        ${fmtDate(last.startedAt)}`)
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
    const sorted = Object.entries(last.byModule)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
    for (const [name, saved] of sorted) {
      const modPct = last.originalTokens > 0 ? (saved / last.originalTokens) * 100 : 0
      console.log(`    ${name.padEnd(24)} ${C.green(fmt(saved).padStart(8))} tokens  (${fmtPct(modPct)})`)
    }
    console.log()
  }

  console.log(divider())
  console.log(`  ${C.dim('All-time total saved:')} ${C.green(fmt(stats.allTime.totalSavedTokens))} tokens — ${C.green(fmtUsd(stats.allTime.estimatedCostSaved))} USD`)
  console.log()
}

function showAllTime(): void {
  const stats = readGlobalStats()

  if (!stats || stats.allTime.totalRequests === 0) {
    console.log(`\n${C.yellow('No data recorded yet.')}\n`)
    return
  }

  const at = stats.allTime
  const pct = at.totalOriginalTokens > 0
    ? (at.totalSavedTokens / at.totalOriginalTokens) * 100
    : 0
  const avgPerSession = stats.sessions.length > 0
    ? at.totalSavedTokens / stats.sessions.length
    : 0

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
  console.log(`  ${C.bold('Total cost saved')}  ${C.green(fmtUsd(at.estimatedCostSaved))} USD`)
  console.log(`  ${C.bold('Avg / session')}     ${C.green(fmt(Math.round(avgPerSession)))} tokens`)
  console.log(divider())
  console.log()
}

function showHistory(): void {
  const stats = readGlobalStats()

  if (!stats || stats.sessions.length === 0) {
    console.log(`\n${C.yellow('No sessions recorded yet.')}\n`)
    return
  }

  console.log(`\n${C.bold('cork-ai — Session History')} (${stats.sessions.length} sessions)`)
  console.log(divider())
  console.log(
    `  ${'Date'.padEnd(20)} ${'Reqs'.padStart(5)} ${'Saved tokens'.padStart(14)} ${'Savings'.padStart(9)} ${'Cost saved'.padStart(11)}`
  )
  console.log(divider())

  const recent = stats.sessions.slice(-20).reverse()
  for (const s of recent) {
    const pct = s.originalTokens > 0 ? (s.savedTokens / s.originalTokens) * 100 : 0
    const date = fmtDate(s.startedAt).padEnd(20)
    const reqs = String(s.requests).padStart(5)
    const saved = C.green(fmt(s.savedTokens).padStart(14))
    const savings = C.green(fmtPct(pct).padStart(9))
    const cost = C.green(fmtUsd(s.estimatedCostSaved).padStart(11))
    console.log(`  ${date} ${reqs} ${saved} ${savings} ${cost}`)
  }

  if (stats.sessions.length > 20) {
    console.log(`  ${C.dim(`... and ${stats.sessions.length - 20} older sessions`)}`)
  }

  console.log(divider())

  const at = stats.allTime
  const totalPct = at.totalOriginalTokens > 0
    ? (at.totalSavedTokens / at.totalOriginalTokens) * 100
    : 0
  console.log(
    `  ${'TOTAL'.padEnd(20)} ${String(at.totalRequests).padStart(5)} ` +
    `${C.green(fmt(at.totalSavedTokens).padStart(14))} ` +
    `${C.green(fmtPct(totalPct).padStart(9))} ` +
    `${C.green(fmtUsd(at.estimatedCostSaved).padStart(11))}`
  )
  console.log()
}

function resetStats(): void {
  const stats = readGlobalStats()
  if (!stats || stats.allTime.totalRequests === 0) {
    console.log('Nothing to reset.')
    return
  }

  resetGlobalStats()
  console.log(`\n${C.green('Stats reset.')} All data cleared from ${STATS_FILE}\n`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const cmd = args[0]
const flag = args[1]

if (!cmd || cmd === '--help' || cmd === '-h') {
  showHelp()
} else if (cmd === '--version' || cmd === '-v') {
  showVersion()
} else if (cmd === 'gain') {
  if (flag === '--all') {
    showAllTime()
  } else if (flag === '--history') {
    showHistory()
  } else {
    showLastSession()
  }
} else if (cmd === 'reset') {
  resetStats()
} else {
  console.error(`\nUnknown command: ${cmd}\nRun \`cork-ai --help\` for usage.\n`)
  process.exit(1)
}
