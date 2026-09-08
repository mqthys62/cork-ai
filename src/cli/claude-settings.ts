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

export interface HookGroup {
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
 *   SessionEnd            session digest (~/.cork-ai/digests, telemetry)
 */
export const CORK_HOOKS: Array<{ event: string; matcher?: string; legacyMatchers?: string[] }> = [
  { event: 'PreToolUse', matcher: 'Read' },
  { event: 'PreToolUse', matcher: 'Bash' },
  { event: 'PostToolUse', matcher: 'Edit|MultiEdit|Write', legacyMatchers: ['Edit|MultiEdit'] },
  { event: 'UserPromptSubmit' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
]
export const CORK_HOOK_FALLBACK = 'cork-ai hook'

export function loadClaudeSettings(): ClaudeSettings {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf-8')) as ClaudeSettings }
  catch { return {} }
}

export function saveClaudeSettings(settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true })
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8')
}

export function isCorkCmd(command: string): boolean {
  return command.includes('cork-ai') && command.trim().endsWith('hook')
}

export function isCorkHookInstalled(settings: ClaudeSettings): boolean {
  const pre = settings.hooks?.PreToolUse ?? []
  return pre.some(g => g.hooks?.some(h => isCorkCmd(h.command)))
}

/** Which of CORK_HOOKS are present (matcher-exact, or via a legacy matcher). */
export function installedCorkHooks(settings: ClaudeSettings): Array<{ event: string; matcher?: string; present: boolean; command?: string }> {
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

