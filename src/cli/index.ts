#!/usr/bin/env node
/**
 * cork-ai CLI — stats, savings report, and project setup.
 *
 * Commands:
 *   cork-ai init             Auto-integrate cork-ai into the current project
 *   cork-ai gain             Show savings from the last session
 *   cork-ai gain --history   Show all recorded sessions
 *   cork-ai gain --all       Show all-time totals
 *   cork-ai reset            Reset all stats
 *   cork-ai --version        Show version
 *   cork-ai --help           Show help
 */

import fs from 'fs'
import path from 'path'
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
  cork-ai init              Auto-integrate cork-ai into the current project
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

// ─── Init command ─────────────────────────────────────────────────────────────

function findFiles(dir: string, exts: string[], ignore: string[]): string[] {
  const results: string[] = []
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return results }
  for (const e of entries) {
    if (ignore.includes(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      results.push(...findFiles(full, exts, ignore))
    } else if (exts.some(x => e.name.endsWith(x))) {
      results.push(full)
    }
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
  // Already patched
  if (content.includes('wrapClient') || content.includes('cork-ai')) return null

  const newAnthropicRe = /new Anthropic\s*\([^)]*\)/g
  if (!newAnthropicRe.test(content)) return null

  // Add import after existing Anthropic import
  const importLine = content.includes("from '@anthropic-ai/sdk'")
    ? `from '@anthropic-ai/sdk'`
    : `from "@anthropic-ai/sdk"`

  const withImport = content.replace(
    new RegExp(`(import[^\\n]*${importLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`),
    `$1\nimport { wrapClient } from 'cork-ai'`,
  )

  // Wrap every `new Anthropic(...)` call
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
`.trimStart() + `\n// Replace all \`new Anthropic()\` imports with this file.\n`
  + `// Usage: import { claude } from './cork-ai-client${isTs ? '' : '.js'}'\n`
}

function runInit(): void {
  const cwd = process.cwd()
  const pkg = readPkg(cwd)
  const isTs = detectIsTypeScript(cwd)

  console.log(`\n${C.bold('cork-ai init')} — Auto-integrating into ${C.cyan(cwd)}\n`)

  // 1. Check @anthropic-ai/sdk is installed
  if (!hasSdkDep(pkg)) {
    console.log(`${C.yellow('⚠')}  @anthropic-ai/sdk not found in package.json.`)
    console.log(`   Run: ${C.cyan('npm install @anthropic-ai/sdk')}\n`)
  }

  // 2. Scan project files for `new Anthropic(`
  const IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.cork-ai']
  const EXTS = isTs ? ['.ts', '.tsx'] : ['.js', '.mjs', '.cjs', '.jsx']
  const files = findFiles(cwd, EXTS, IGNORE)
  const SDK_IMPORT_RE = /^(?:import|const|var|let)\s+\w[\s\S]{0,60}['"]@anthropic-ai\/sdk['"]/m
  const matches = files.filter(f => {
    try {
      const c = fs.readFileSync(f, 'utf8')
      return c.includes('new Anthropic(') && SDK_IMPORT_RE.test(c)
    } catch { return false }
  })

  if (matches.length === 0) {
    // 3a. No existing client — generate a wrapper file
    const wrapperName = `cork-ai-client.${isTs ? 'ts' : 'js'}`
    const wrapperPath = path.join(cwd, 'src', wrapperName)
    const wrapperDir = path.join(cwd, 'src')
    const dest = fs.existsSync(wrapperDir) ? wrapperPath : path.join(cwd, wrapperName)
    fs.writeFileSync(dest, generateWrapperFile(isTs), 'utf8')
    const rel = path.relative(cwd, dest)

    console.log(`${C.green('✔')}  No existing Anthropic client found.`)
    console.log(`   Generated wrapper: ${C.cyan(rel)}\n`)
    console.log(`   Import it in your code:`)
    console.log(`   ${C.dim(`import { claude } from './${rel.replace(/\\/g, '/').replace(/\.(ts|js)$/, '')}'`)}`)
    console.log(`   ${C.dim(`const response = await claude.messages.create({ ... })`)}`)
    console.log(`\n   Then run ${C.cyan('cork-ai gain')} after a session to see savings.\n`)
    return
  }

  if (matches.length === 1) {
    // 3b. Exactly one file — auto-patch
    const file = matches[0]
    const rel = path.relative(cwd, file)
    const content = fs.readFileSync(file, 'utf8')
    const patched = patchFile(file, content)

    if (!patched) {
      console.log(`${C.green('✔')}  ${C.cyan(rel)} — already integrated or no patchable pattern found.`)
      console.log(`   Run ${C.cyan('cork-ai gain')} after a session to check savings.\n`)
      return
    }

    fs.writeFileSync(file, patched, 'utf8')
    console.log(`${C.green('✔')}  Patched ${C.cyan(rel)}`)
    console.log(`   Added: ${C.dim("import { wrapClient } from 'cork-ai'")}`)
    console.log(`   Wrapped: ${C.dim('new Anthropic(...)  →  wrapClient(new Anthropic(...))')}`)
    console.log(`\n   Run ${C.cyan('cork-ai gain')} after a session to see savings.\n`)
    return
  }

  // 3c. Multiple files — show manual instructions
  console.log(`${C.yellow('!')}  Found ${matches.length} files with Anthropic client instantiation:`)
  for (const f of matches) {
    console.log(`   ${C.cyan(path.relative(cwd, f))}`)
  }
  console.log()
  console.log(`   Add these two lines to the file where you instantiate the client:`)
  console.log()
  console.log(`   ${C.dim("import { wrapClient } from 'cork-ai'")}`)
  console.log(`   ${C.dim('const client = wrapClient(new Anthropic(), { maxContextTokens: 150_000 })')}`)
  console.log()
  console.log(`   Run ${C.cyan('cork-ai gain')} after a session to see savings.\n`)
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
} else if (cmd === 'init') {
  runInit()
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
