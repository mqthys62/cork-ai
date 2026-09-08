/**
 * Bash read detection — which shell commands are really file reads.
 *
 * Claude Code's auto mode steers the model away from the dedicated Read tool:
 * files are read with `cat`, `sed -n`, `head` and `tail` through Bash. A hook
 * that only matches `Read` then sees nothing (0 events on a 961-command
 * session, measured 2026-08-30). This module recognises the shell equivalents
 * so the same compression, re-read tracking and accounting apply.
 *
 * Only unambiguous, single-file, un-piped commands are recognised. A command
 * with pipes, redirections, command substitution or several operands is left
 * alone — mis-classifying a compound command is worse than missing a read.
 */

import fs from 'fs'
import path from 'path'

export interface BashRead {
  /** `full`: the whole file is dumped (compressible). `range`: a targeted slice. */
  kind: 'full' | 'range'
  /** Absolute path of the file read. */
  file: string
  /** The command word that did the reading (`cat`, `sed`, …). */
  tool: string
}

export interface BashEdit {
  /** Absolute path of the file written in place. */
  file: string
  tool: string
}

/** Anything that turns a simple command into a pipeline or a script. */
const COMPOUND_RE = /[|;&<>`\n]|\$\(/

/** `cat` options that don't change the fact that the whole file is printed. */
const CAT_FLAG_RE = /^-(?:[nbsAvetETu]+|-number|-number-nonblank|-squeeze-blank|-show-all|-show-ends|-show-tabs)$/

const FULL_READ_TOOLS = new Set(['cat', 'nl', 'less', 'more', 'bat', 'batcat'])
const RANGE_READ_TOOLS = new Set(['head', 'tail', 'sed'])

/**
 * PowerShell: Claude Code runs a PowerShell tool on Windows when Git Bash is
 * absent. `Get-Content` and its aliases (`gc`, `cat`, `type`) are its `cat`;
 * `-TotalCount` / `-Head` / `-Tail` make it a range read. `type` is only
 * recognised under PowerShell — in bash it describes a command.
 */
const PS_READ_TOOLS = new Set(['get-content', 'gc'])
const PS_PARAM_RE = /^-(?:Path|LiteralPath|TotalCount|Head|Tail|Raw|Encoding|ReadCount|Delimiter|Force|Stream|Wait)(?::.*)?$/i
const PS_RANGE_PARAM_RE = /^-(?:TotalCount|Head|Tail)(?::.*)?$/i
/** Parameters that take a value in the next word (unless given as `-Name:value`). */
const PS_VALUE_PARAM_RE = /^-(?:Path|LiteralPath|TotalCount|Head|Tail|Encoding|ReadCount|Delimiter|Stream)$/i

export type ShellKind = 'bash' | 'powershell'

function parsePowerShellRead(tool: string, args: string[], cwd: string): BashRead | undefined {
  const operands: string[] = []
  let range = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('-')) {
      if (!PS_PARAM_RE.test(a)) return undefined
      if (PS_RANGE_PARAM_RE.test(a)) range = true
      if (/^-(?:Path|LiteralPath)$/i.test(a) && i + 1 < args.length) { operands.push(args[++i]); continue }
      if (PS_VALUE_PARAM_RE.test(a)) i++
      continue
    }
    operands.push(a)
  }
  if (operands.length !== 1 || /[*?]/.test(operands[0])) return undefined
  const file = resolveFile(operands[0], cwd)
  return file ? { kind: range ? 'range' : 'full', file, tool } : undefined
}

/** Shell words, honouring single/double quotes (no escapes beyond that). */
export function splitWords(command: string): string[] | undefined {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasWord = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; hasWord = true; continue }
    if (ch === '\\' && i + 1 < command.length) { current += command[++i]; hasWord = true; continue }
    if (/\s/.test(ch)) {
      if (hasWord) { words.push(current); current = ''; hasWord = false }
      continue
    }
    current += ch
    hasWord = true
  }
  if (quote) return undefined // unbalanced quotes: not a simple command
  if (hasWord) words.push(current)
  return words
}

function resolveFile(operand: string, cwd: string): string | undefined {
  if (!operand || operand.startsWith('-')) return undefined
  const expanded = operand.startsWith('~/') ? path.join(process.env.HOME ?? '', operand.slice(2)) : operand
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded)
  try {
    if (!fs.statSync(abs).isFile()) return undefined
  } catch {
    return undefined
  }
  return abs
}

/**
 * Recognises a shell command that reads exactly one existing file.
 *
 * Returns `undefined` for anything compound or unusual, which the caller must
 * treat as "not a read we understand" — never as "not a read".
 */
export function parseBashRead(command: string, cwd: string, shell: ShellKind = 'bash'): BashRead | undefined {
  const trimmed = command.trim()
  if (!trimmed || COMPOUND_RE.test(trimmed)) return undefined

  let words = splitWords(trimmed)
  if (!words || words.length < 2) return undefined

  // `rtk proxy cat file` — RTK's escape hatch is a plain read.
  if (words[0] === 'rtk' && words[1] === 'proxy') words = words.slice(2)
  // A leading environment assignment or `command`/`exec` prefix is not a read.
  if (words.length < 2 || /=/.test(words[0])) return undefined

  const tool = path.basename(words[0])
  const args = words.slice(1)

  const lower = tool.toLowerCase()
  if (PS_READ_TOOLS.has(lower) || (shell === 'powershell' && (lower === 'type' || lower === 'cat'))) {
    return parsePowerShellRead(lower === 'gc' || lower === 'get-content' ? 'Get-Content' : tool, args, cwd)
  }
  // `cat file -TotalCount 40` in Git Bash is still PowerShell muscle memory.
  if (lower === 'cat' && args.some(a => PS_PARAM_RE.test(a))) return parsePowerShellRead('cat', args, cwd)

  if (FULL_READ_TOOLS.has(tool)) {
    const flags = args.filter(a => a.startsWith('-') && a !== '-')
    const operands = args.filter(a => !a.startsWith('-') || a === '-')
    if (operands.length !== 1 || operands[0] === '-') return undefined
    if (tool === 'cat' && !flags.every(f => CAT_FLAG_RE.test(f))) return undefined
    const file = resolveFile(operands[0], cwd)
    return file ? { kind: 'full', file, tool } : undefined
  }

  if (RANGE_READ_TOOLS.has(tool)) {
    if (tool === 'sed') {
      // sed -n '12,80p' file  |  sed -n 12,80p file  |  sed -n -e '/x/p' file
      if (!args.includes('-n') && !args.some(a => /^-n/.test(a))) return undefined
      const operand = args[args.length - 1]
      if (/^-/.test(operand) || /[,p/]$/.test(operand) && !/\.\w+$/.test(operand)) return undefined
      const file = resolveFile(operand, cwd)
      return file ? { kind: 'range', file, tool } : undefined
    }
    // head / tail: `-n 40`, `-40`, `-c 200`, `--lines=40`
    const operands: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '-n' || a === '-c') { i++; continue }
      if (a.startsWith('-')) continue
      operands.push(a)
    }
    if (operands.length !== 1) return undefined
    const file = resolveFile(operands[0], cwd)
    return file ? { kind: 'range', file, tool } : undefined
  }

  return undefined
}

/**
 * Recognises a shell command that edits a file in place: `sed -i`, a heredoc
 * or redirection into a file, `tee file`. Used only to mark the file as
 * "being edited this session" so its next read is served raw — so a partial
 * match is fine and a miss is harmless.
 */
export function parseBashEdit(command: string, cwd: string): BashEdit | undefined {
  const trimmed = command.trim()
  if (!trimmed) return undefined

  // sed -i[.bak] [-e expr]... file   (any position, first path-looking operand after -i)
  const sed = /(?:^|[;&|]\s*)sed\s+(?:-[a-zA-Z]*i\S*|--in-place\S*)\s+(.*)$/m.exec(trimmed)
  if (sed) {
    const words = splitWords(sed[1]) ?? []
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i]
      if (w.startsWith('-') || /[|;&]/.test(w)) continue
      const file = resolveFile(w, cwd)
      if (file) return { file, tool: 'sed -i' }
      break
    }
  }

  // > file, >> file, tee file, tee -a file
  const redirect = /(?:>>?|\btee(?:\s+-a)?)\s*['"]?([^\s'"|;&]+)['"]?/.exec(trimmed)
  if (redirect && !/^\/dev\//.test(redirect[1]) && !/^&/.test(redirect[1])) {
    const file = resolveFile(redirect[1], cwd)
    if (file) return { file, tool: trimmed.includes('tee') ? 'tee' : 'redirect' }
  }
  return undefined
}
