/**
 * ~/.claude/settings.json — the slice of Claude Code's settings cork-ai reads
 * and writes: the hooks it installs and `autoCompactWindow`.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { compareVersions } from './version.js'

/** Claude Code honours `CLAUDE_CONFIG_DIR` for its whole config directory; so does cork-ai. */
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
export const CLAUDE_SETTINGS = path.join(CLAUDE_CONFIG_DIR, 'settings.json')

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
 *   PostToolUse Edit…     edited-file tracking, context guard
 *   PostToolUseFailure Edit…  failed-edit detection: an Edit that fails on a file the model
 *                         only saw outlined is the strongest compression-harm signal there is.
 *                         PostToolUse fires on success only, so this needs its own event —
 *                         documented since Claude Code 2.1.119, hence `since`.
 *   UserPromptSubmit/Stop context guard (band notices to the user and the model)
 *   SessionEnd            session digest (~/.cork-ai/digests, telemetry)
 */
export interface CorkHookSpec {
  event: string
  matcher?: string
  legacyMatchers?: string[]
  /** Oldest Claude Code version known to have this event; not installed on older ones. */
  since?: string
}

export const CORK_HOOKS: CorkHookSpec[] = [
  { event: 'PreToolUse', matcher: 'Read' },
  { event: 'PreToolUse', matcher: 'Bash|PowerShell', legacyMatchers: ['Bash'] },
  { event: 'PostToolUse', matcher: 'Edit|MultiEdit|Write', legacyMatchers: ['Edit|MultiEdit'] },
  { event: 'PostToolUseFailure', matcher: 'Edit|MultiEdit|Write', since: '2.1.119' },
  { event: 'UserPromptSubmit' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
]

/**
 * The hooks that make sense on a given Claude Code version. Unknown version
 * (fresh install, no transcript yet): all of them — an event a version does not
 * know is, as far as the docs say, ignored, and a fresh install today runs a
 * recent Claude Code.
 */
export function applicableCorkHooks(claudeVersion?: string): CorkHookSpec[] {
  return CORK_HOOKS.filter(h => !h.since || !claudeVersion || compareVersions(claudeVersion, h.since) >= 0)
}
export const CORK_HOOK_FALLBACK = 'cork-ai hook'

/** Claude Code version that introduced the exec form (`args`) of command hooks. */
export const CLAUDE_EXEC_FORM_SINCE = '2.1.139'
/**
 * Oldest Claude Code the hook payload was verified against (session_id,
 * transcript_path, cwd, permission_mode, agent_type/agent_id, tool_input,
 * SessionEnd). Older versions probably work; `doctor` says so.
 */
export const CLAUDE_CODE_MIN = '2.1.47'
/** Last Claude Code version the 1.0 test pass ran on. Newer is fine until proven otherwise. */
export const CLAUDE_CODE_TESTED_MAX = '2.1.263'

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

/**
 * Thrown when `~/.claude/settings.json` exists but cannot be read as a JSON
 * object: a BOM, a trailing comma, a half-written file (Claude Code was saving
 * it), a permission error. Writers must stop here — saving `{}` over the user's
 * settings would erase their permissions, model, env, and every other hook.
 */
export class ClaudeSettingsUnreadable extends Error {
  constructor(public readonly file: string, public readonly cause: unknown) {
    super(`${file} exists but could not be read as a JSON object: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'ClaudeSettingsUnreadable'
  }
}

/**
 * Reads the settings. A missing file is `{}`; an unreadable or non-object one
 * throws `ClaudeSettingsUnreadable` — callers that only *read* may catch it
 * and treat the settings as empty, callers that *write* must not.
 */
export function loadClaudeSettings(): ClaudeSettings {
  let raw: string
  try { raw = fs.readFileSync(CLAUDE_SETTINGS, 'utf-8') }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ClaudeSettingsUnreadable(CLAUDE_SETTINGS, err)
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) }
  catch (err) { throw new ClaudeSettingsUnreadable(CLAUDE_SETTINGS, err) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ClaudeSettingsUnreadable(CLAUDE_SETTINGS, new Error('top-level value is not an object'))
  return parsed as ClaudeSettings
}

/** Read-only convenience: unreadable settings count as empty (status, doctor, gain). */
export function loadClaudeSettingsOrEmpty(): ClaudeSettings {
  try { return loadClaudeSettings() } catch { return {} }
}

/** Atomic (tmp + rename), so a crash mid-write never leaves Claude Code a truncated settings file. */
export function saveClaudeSettings(settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true })
  const tmp = `${CLAUDE_SETTINGS}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8')
  try { fs.renameSync(tmp, CLAUDE_SETTINGS) }
  catch (err) { try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ } throw err }
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

/** Which of the applicable hooks are present (matcher-exact, or via a legacy matcher). */
export function installedCorkHooks(settings: ClaudeSettings, claudeVersion?: string): Array<{ event: string; matcher?: string; since?: string; present: boolean; command?: string; entry?: HookEntry }> {
  return applicableCorkHooks(claudeVersion).map(spec => {
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
export function ensureHookGroup(settings: ClaudeSettings, spec: CorkHookSpec, desired: HookEntry): boolean {
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
    if (spec.matcher !== undefined && g.matcher !== spec.matcher) {
      const others = (g.hooks ?? []).filter(h => !isCorkCmd(h))
      if (others.length === 0) {
        g.matcher = spec.matcher
      } else {
        // The group is shared with someone else's hooks: renaming its matcher
        // would fire *their* hooks on tools they never asked for. Leave the
        // group to them and give cork-ai its own group under the new matcher.
        g.hooks = others
        const target = groups.find(x => x.matcher === spec.matcher)
        if (target) (target.hooks ??= []).push(existing)
        else groups.push({ matcher: spec.matcher, hooks: [existing] })
      }
      changed = true
    }
    return changed
  }

  const entry: HookEntry = { ...desired, ...(desired.args ? { args: [...desired.args] } : {}) }
  const existingGroup = spec.matcher !== undefined ? groups.find(g => g.matcher === spec.matcher) : undefined
  if (existingGroup) {
    ;(existingGroup.hooks ??= []).push(entry)
  } else {
    groups.push(spec.matcher !== undefined ? { matcher: spec.matcher, hooks: [entry] } : { hooks: [entry] })
  }
  return true
}
