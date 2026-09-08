import { describe, it, expect } from 'vitest'
import { corkHookEntry, renderHookEntry, isCorkCmd, isShellFormOnWindows, isCorkHookInstalled, installedCorkHooks, ensureHookGroup, CORK_HOOK_FALLBACK, type ClaudeSettings } from '../../src/cli/claude-settings.js'

const WIN = 'C:\\Users\\ami\\AppData\\Local\\cork-ai\\bin\\cork-ai.exe'
const NIX = '/home/ami/.local/bin/cork-ai'

describe('corkHookEntry', () => {
  it('POSIX : forme shell, chemin cité', () => {
    expect(corkHookEntry(NIX, 'linux')).toEqual({ type: 'command', command: `"${NIX}" hook` })
    expect(corkHookEntry(NIX, 'darwin').args).toBeUndefined()
  })

  it('Windows : forme exec (command + args), sans guillemets ni shell', () => {
    const e = corkHookEntry(WIN, 'win32')
    expect(e).toEqual({ type: 'command', command: WIN, args: ['hook'] })
    // La forme shell `"C:\…\cork-ai.exe" hook` est une erreur de parse PowerShell.
    expect(e.command.startsWith('"')).toBe(false)
  })

  it('sans binaire résolu : repli sur PATH, quelle que soit la plateforme', () => {
    expect(corkHookEntry('', 'win32')).toEqual({ type: 'command', command: CORK_HOOK_FALLBACK })
    expect(corkHookEntry('', 'linux')).toEqual({ type: 'command', command: CORK_HOOK_FALLBACK })
  })
})

describe('isCorkCmd / renderHookEntry', () => {
  it('reconnaît les deux formes et l’ancienne chaîne', () => {
    expect(isCorkCmd(`"${NIX}" hook`)).toBe(true)
    expect(isCorkCmd({ type: 'command', command: `"${WIN}" hook` })).toBe(true)
    expect(isCorkCmd({ type: 'command', command: WIN, args: ['hook'] })).toBe(true)
    expect(isCorkCmd(CORK_HOOK_FALLBACK)).toBe(true)
  })

  it('ignore les autres hooks, même s’ils mentionnent cork-ai', () => {
    expect(isCorkCmd({ type: 'command', command: WIN, args: ['gain'] })).toBe(false)
    expect(isCorkCmd({ type: 'command', command: 'echo cork-ai' })).toBe(false)
    expect(isCorkCmd({ type: 'command', command: 'node /x/read-cache.js' })).toBe(false)
    expect(isCorkCmd({ type: 'command', command: undefined as unknown as string })).toBe(false)
  })

  it('rend command + args sur une ligne', () => {
    expect(renderHookEntry({ type: 'command', command: WIN, args: ['hook'] })).toBe(`${WIN} hook`)
    expect(renderHookEntry({ type: 'command', command: `"${NIX}" hook` })).toBe(`"${NIX}" hook`)
  })
})

describe('isShellFormOnWindows', () => {
  it('signale la forme shell sous Windows seulement', () => {
    const shell = { type: 'command', command: `"${WIN}" hook` }
    expect(isShellFormOnWindows(shell, 'win32')).toBe(true)
    expect(isShellFormOnWindows(shell, 'linux')).toBe(false)
    expect(isShellFormOnWindows({ type: 'command', command: WIN, args: ['hook'] }, 'win32')).toBe(false)
    expect(isShellFormOnWindows({ type: 'command', command: CORK_HOOK_FALLBACK }, 'win32')).toBe(false)
  })
})

describe('installedCorkHooks', () => {
  it('liste les hooks présents dans les deux formes', () => {
    const settings: ClaudeSettings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Read', hooks: [{ type: 'command', command: WIN, args: ['hook'] }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: `"${WIN}" hook` }] }, // legacy matcher (< 1.0)
        ],
        SessionEnd: [{ hooks: [{ type: 'command', command: CORK_HOOK_FALLBACK }] }],
      },
    }
    expect(isCorkHookInstalled(settings)).toBe(true)
    const rows = installedCorkHooks(settings)
    const by = (e: string, m?: string) => rows.find(r => r.event === e && r.matcher === m)!
    expect(by('PreToolUse', 'Read')).toMatchObject({ present: true, command: `${WIN} hook` })
    expect(by('PreToolUse', 'Read').entry?.args).toEqual(['hook'])
    expect(by('PreToolUse', 'Bash|PowerShell')).toMatchObject({ present: true, command: `"${WIN}" hook` })
    expect(by('SessionEnd')).toMatchObject({ present: true, command: CORK_HOOK_FALLBACK })
    expect(by('Stop').present).toBe(false)
    expect(rows.filter(r => r.present)).toHaveLength(3)
  })
})

describe('ensureHookGroup (migration)', () => {
  const READ = { event: 'PreToolUse', matcher: 'Read' }

  it('Windows : réécrit la forme shell en forme exec, sans doublon', () => {
    const settings: ClaudeSettings = { hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `"${WIN}" hook` }] }] } }
    expect(ensureHookGroup(settings, READ, corkHookEntry(WIN, 'win32'))).toBe(true)
    expect(settings.hooks!.PreToolUse).toEqual([{ matcher: 'Read', hooks: [{ type: 'command', command: WIN, args: ['hook'] }] }])
    // idempotent
    expect(ensureHookGroup(settings, READ, corkHookEntry(WIN, 'win32'))).toBe(false)
    expect(settings.hooks!.PreToolUse![0].hooks).toHaveLength(1)
  })

  it('Windows : migre aussi la commande nue `cork-ai hook` et un binaire déplacé', () => {
    const settings: ClaudeSettings = { hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: CORK_HOOK_FALLBACK }] }] } }
    expect(ensureHookGroup(settings, READ, corkHookEntry(WIN, 'win32'))).toBe(true)
    const moved = 'D:\\tools\\cork-ai.exe'
    expect(ensureHookGroup(settings, READ, corkHookEntry(moved, 'win32'))).toBe(true)
    expect(settings.hooks!.PreToolUse![0].hooks[0]).toEqual({ type: 'command', command: moved, args: ['hook'] })
  })

  it('POSIX : passe de la forme exec à la forme shell en retirant args', () => {
    const settings: ClaudeSettings = { hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: NIX, args: ['hook'], timeout: 30 }] }] } }
    expect(ensureHookGroup(settings, READ, corkHookEntry(NIX, 'linux'))).toBe(true)
    expect(settings.hooks!.PreToolUse![0].hooks[0]).toEqual({ type: 'command', command: `"${NIX}" hook`, timeout: 30 })
  })

  it('le repli PATH ne remplace jamais un chemin absolu déjà posé', () => {
    const settings: ClaudeSettings = { hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: WIN, args: ['hook'] }] }] } }
    expect(ensureHookGroup(settings, READ, corkHookEntry('', 'win32'))).toBe(false)
    expect(settings.hooks!.PreToolUse![0].hooks[0].args).toEqual(['hook'])
  })

  it('ajoute l’entrée à côté d’un hook étranger sur le même matcher, sans partager le tableau args', () => {
    const settings: ClaudeSettings = { hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'node /x/other.js' }] }] } }
    const desired = corkHookEntry(WIN, 'win32')
    expect(ensureHookGroup(settings, READ, desired)).toBe(true)
    const installed = settings.hooks!.PreToolUse![0].hooks
    expect(installed.map(h => h.command)).toEqual(['node /x/other.js', WIN])
    expect(installed[1].args).not.toBe(desired.args)
  })
})
