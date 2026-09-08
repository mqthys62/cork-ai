/**
 * ~/.claude/settings.json — the slice of Claude Code's settings cork-ai reads
 * and writes: the hooks it installs and `autoCompactWindow`.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

export const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')

export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[] | undefined>
  autoCompactWindow?: number
  model?: string
  [key: string]: unknown
}

export interface HookEntry {
  type: string
  command: string
  /** Exec form (Claude Code ≥ 2.1.139): spawned directly, no shell. */
  args?: string[]
  timeout?: number
}

export interface HookGroup {
  matcher?: string
  hooks: HookEntry[]
}

/**
 * Every hook cork-ai installs. One binary, one `hook` subcommand: the payload's
 * `hook_event_name` and `tool_name` decide what happens.
 *
 *   PreToolUse Read       compress whole-file reads (the original hook)
 *   PreToolUse Bash|PowerShell  same for `cat file` & co — auto mode reads through Bash;
 *                         `Get-Content` under Claude Code's PowerShell tool (Windows without Git Bash)
 *   PostToolUse Edit…     failed-edit detection, edited-file tracking, context guard
 *   UserPromptSubmit/Stop context guard (band notices to the user and the model)
 *   SessionEnd            session digest (~/.cork-ai/digests, telemetry)
 */
export const CORK_HOOKS: Array<{ event: string; matcher?: string; legacyMatchers?: string[] }> = [
  { event: 'PreToolUse', matcher: 'Read' },
  { event: 'PreToolUse', matcher: 'Bash|PowerShell', legacyMatchers: ['Bash'] },
  { event: 'PostToolUse', matcher: 'Edit|MultiEdit|Write', legacyMatchers: ['Edit|MultiEdit'] },
  { event: 'UserPromptSubmit' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
]
export const CORK_HOOK_FALLBACK = 'cork-ai hook'

/** Claude Code version that introduced the exec form (`args`) of command hooks. */
export const CLAUDE_EXEC_FORM_SINCE = '2.1.139'

/**
 * The hook entry to install for a resolved binary path ('' → PATH fallback).
 *
 * POSIX: shell form `"<path>" hook` — every Claude Code version runs it through
 * bash, quoting handles spaces. Windows: exec form. Since Claude Code 2.1.120
 * the shell form runs through PowerShell when Git Bash is absent, and
 * `"C:\…\cork-ai.exe" hook` is a PowerShell parse error ("unexpected token
 * 'hook'") — the hook silently never fires. The exec form spawns the .exe
 * directly with no shell in between, whatever shell Claude Code picked.
 */
export function corkHookEntry(binaryPath: string, platform: NodeJS.Platform = process.platform): HookEntry {
  if (!binaryPath) return { type: 'command', command: CORK_HOOK_FALLBACK }
  if (platform === 'win32') return { type: 'command', command: binaryPath, args: ['hook'] }
  return { type: 'command', command: `"${binaryPath}" hook` }
}

/** `command` plus `args`, as one line — what `hooks status` and `doctor` print. */
export function renderHookEntry(h: HookEntry): string {
  return h.args?.length ? `${h.command} ${h.args.join(' ')}` : h.command
}

/** True when the entry is in shell form although this platform needs the exec form. */
export function isShellFormOnWindows(h: HookEntry, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && !h.args?.length && h.command !== CORK_HOOK_FALLBACK
}

export function loadClaudeSettings(): ClaudeSettings {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf-8')) as ClaudeSettings }
  catch { return {} }
}

export function saveClaudeSettings(settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true })
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8')
}

/** Recognises both forms: `"…/cork-ai" hook` and `{ command: '…/cork-ai.exe', args: ['hook'] }`. */
export function isCorkCmd(entry: HookEntry | string): boolean {
  const h = typeof entry === 'string' ? { type: 'command', command: entry } : entry
  if (typeof h.command !== 'string' || !h.command.includes('cork-ai')) return false
  if (h.args?.length) return h.args[0] === 'hook'
  return h.command.trim().endsWith('hook')
}

export function isCorkHookInstalled(settings: ClaudeSettings): boolean {
  const pre = settings.hooks?.PreToolUse ?? []
  return pre.some(g => g.hooks?.some(h => isCorkCmd(h)))
}

/** Which of CORK_HOOKS are present (matcher-exact, or via a legacy matcher). */
export function installedCorkHooks(settings: ClaudeSettings): Array<{ event: string; matcher?: string; present: boolean; command?: string; entry?: HookEntry }> {
  return CORK_HOOKS.map(spec => {
    const groups = settings.hooks?.[spec.event] ?? []
    const accepted = [spec.matcher, ...(spec.legacyMatchers ?? [])]
    for (const g of groups) {
      const h = g.hooks?.find(h => isCorkCmd(h))
      if (!h) continue
      if (spec.matcher === undefined || accepted.includes(g.matcher)) return { ...spec, present: true, command: renderHookEntry(h), entry: h }
    }
    return { ...spec, present: false }
  })
}

/**
 * Makes one hook spec present in the settings. Returns true when something
 * changed: added, migrated from the bare `cork-ai hook` form to the absolute
 * path, migrated from a legacy matcher, or the command path updated.
 */
export function ensureHookGroup(settings: ClaudeSettings, spec: { event: string; matcher?: string; legacyMatchers?: string[] }, desired: HookEntry): boolean {
  settings.hooks ??= {}
  settings.hooks[spec.event] ??= []
  const groups = settings.hooks[spec.event] as HookGroup[]
  const accepted = [spec.matcher, ...(spec.legacyMatchers ?? [])]

  for (const g of groups) {
    const existing = g.hooks?.find(h => isCorkCmd(h))
    if (!existing) continue
    if (spec.matcher !== undefined && !accepted.includes(g.matcher)) continue
    let changed = false
    // Migrate a bare "cork-ai hook" fallback (pre-dates resolveHookBinary())
    // to a resolved absolute path. The bare form depends on Claude Code's
    // hook subprocess inheriting a shell PATH that includes the binary,
    // which isn't guaranteed — it fails as a silent, non-blocking hook error.
    // Same for the shell form on Windows → exec form (see corkHookEntry).
    if (desired.command !== CORK_HOOK_FALLBACK && renderHookEntry(existing) !== renderHookEntry(desired)) {
      existing.command = desired.command
      if (desired.args) existing.args = [...desired.args]
      else delete existing.args
      changed = true
    }
    if (spec.matcher !== undefined && g.matcher !== spec.matcher) { g.matcher = spec.matcher; changed = true }
    return changed
  }

  const entry: HookEntry = { ...desired, ...(desired.args ? { args: [...desired.args] } : {}) }
  const existingGroup = spec.matcher !== undefined ? groups.find(g => g.matcher === spec.matcher) : undefined
  if (existingGroup) {
    existingGroup.hooks.push(entry)
  } else {
    groups.push(spec.matcher !== undefined ? { matcher: spec.matcher, hooks: [entry] } : { hooks: [entry] })
  }
  return true
}
