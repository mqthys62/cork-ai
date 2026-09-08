/**
 * `cork-ai hooks install|status|remove` against a throwaway HOME. Spawns the
 * real CLI (tsx) because the settings logic lives in the CLI entry point.
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLI = path.resolve(__dirname, '../../src/cli/index.ts')
// Run tsx through the current node binary rather than `npx`: on Windows `npx`
// is a .cmd shim that spawnSync cannot start without a shell.
const TSX = createRequire(import.meta.url).resolve('tsx/cli')
let home: string
let settingsFile: string

function run(...args: string[]): { stdout: string; status: number | null } {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
      HOME: home,
      USERPROFILE: home,
      CORK_AI_HOME: path.join(home, '.cork-ai'),
      CLAUDE_PROJECTS_DIR: path.join(home, 'none'),
    },
    input: '',
    timeout: 60_000,
    windowsHide: true,
  })
  return { stdout: (res.stdout ?? '') + (res.stderr ?? '') + (res.error ? String(res.error) : ''), status: res.status }
}

function settings(): { hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> } {
  return JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))
}

function corkHooks(): Array<{ event: string; matcher?: string; command: string }> {
  const out: Array<{ event: string; matcher?: string; command: string }> = []
  for (const [event, groups] of Object.entries(settings().hooks ?? {})) {
    for (const g of groups) for (const h of g.hooks) if (h.command.includes('cork-ai')) out.push({ event, matcher: g.matcher, command: h.command })
  }
  return out
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-home-'))
  fs.mkdirSync(path.join(home, '.claude'))
  settingsFile = path.join(home, '.claude', 'settings.json')
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('hooks install', () => {
  it('installe les 5 hooks sans toucher au reste des settings, et est idempotent', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'node /x/other.js' }] }] },
    }))
    const first = run('hooks', 'install')
    expect(first.status).toBe(0)
    const hooks = corkHooks()
    expect(hooks.map(h => `${h.event}:${h.matcher ?? '*'}`).sort()).toEqual([
      'PostToolUse:Edit|MultiEdit|Write', 'PreToolUse:Bash', 'PreToolUse:Read', 'Stop:*', 'UserPromptSubmit:*',
    ])
    // the foreign hook on Read is kept, cork-ai appended to the same group
    const readGroup = settings().hooks!.PreToolUse.find(g => g.matcher === 'Read')!
    expect(readGroup.hooks.map(h => h.command)).toEqual(['node /x/other.js', expect.stringContaining('hook')])
    expect((settings() as { permissions?: unknown }).permissions).toEqual({ allow: ['Bash(ls:*)'] })

    const second = run('hooks', 'install')
    expect(second.stdout).toContain('already installed')
    expect(corkHooks()).toHaveLength(5)

    // the guard is switched on by default
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.cork-ai', 'config.json'), 'utf-8'))
    expect(cfg.contextGuard.enabled).toBe(true)
  }, 30_000)

  it('met à niveau une installation 0.4–0.6 (Read + Edit|MultiEdit, commande nue)', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'cork-ai hook' }] }],
        PostToolUse: [{ matcher: 'Edit|MultiEdit', hooks: [{ type: 'command', command: 'cork-ai hook' }] }],
      },
    }))
    run('hooks', 'install')
    const hooks = corkHooks()
    expect(hooks).toHaveLength(5)
    expect(hooks.find(h => h.event === 'PostToolUse')?.matcher).toBe('Edit|MultiEdit|Write')
    // no duplicate group for PostToolUse
    expect(settings().hooks!.PostToolUse).toHaveLength(1)
    const status = run('hooks', 'status')
    expect(status.stdout).toContain('installed')
    expect(status.stdout).not.toContain('missing')
  }, 30_000)
})

describe('hooks remove', () => {
  it('retire tous les hooks cork-ai et laisse les autres', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x/notify.sh' }] }] },
    }))
    run('hooks', 'install')
    expect(corkHooks()).toHaveLength(5)
    run('hooks', 'remove')
    expect(corkHooks()).toHaveLength(0)
    const s = settings()
    expect(s.hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command: '/x/notify.sh' }] }])
    expect(s.hooks!.PreToolUse).toBeUndefined()
    expect(s.hooks!.UserPromptSubmit).toBeUndefined()
  }, 30_000)
})

describe('context --set-autocompact', () => {
  it('écrit autoCompactWindow en tokens et refuse hors bornes', () => {
    fs.writeFileSync(settingsFile, '{}')
    expect(run('context', '--set-autocompact', '200k').status).toBe(0)
    expect((settings() as { autoCompactWindow?: number }).autoCompactWindow).toBe(200_000)
    expect(run('context', '--set-autocompact', '50k').status).toBe(1)
    expect((settings() as { autoCompactWindow?: number }).autoCompactWindow).toBe(200_000)
  }, 30_000)
})
