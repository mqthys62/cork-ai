/**
 * The hook, path by path, in-process. Everything persistent goes to
 * CORK_AI_HOME (isolated by vitest.config.ts); files and transcripts live in
 * a temp directory created per test.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_FILE, saveConfig } from '../../src/cli/config.js'
import { HEARTBEAT_FILE, SESSIONS_SEEN_FILE } from '../../src/cli/heartbeat.js'
import { DIGEST_DIR, handleHookEvent, loadSessionReads } from '../../src/cli/hook.js'
import { LIVE_DIR, readActiveLiveSessions } from '../../src/cli/persistent-stats.js'
import { POLICY_FILE, loadPolicy } from '../../src/cli/policy.js'
import { SKIP_FILE, isSkipped } from '../../src/cli/skip-list.js'
import type { TelemetryEvent } from '../../src/cli/telemetry.js'

let dir: string
let transcript: string
let bigFile: string
let events: TelemetryEvent[]
let sessionCounter = 0
let sessionId: string

const HOME = process.env.CORK_AI_HOME!

function transcriptLines(contextTokens: number, userText = 'Please review the architecture', model = 'claude-opus-5'): string {
  return [
    JSON.stringify({ type: 'user', version: '2.1.263', message: { role: 'user', content: userText } }),
    JSON.stringify({ type: 'assistant', version: '2.1.263', message: { id: 'a1', model, usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: contextTokens, cache_creation_input_tokens: 1000 } } }),
  ].join('\n') + '\n'
}

function bigTs(): string {
  const out = ["import fs from 'fs'", '']
  for (let i = 0; i < 80; i++) {
    out.push(`export function handler${i}(input: string, options: { retries: number; verbose: boolean }): Promise<string> {`)
    out.push(`  const value = input.trim().toLowerCase().split(',').map(s => s.trim()).filter(Boolean)`)
    out.push(`  if (options.verbose) console.log('handler${i}', value, options.retries)`)
    out.push(`  return Promise.resolve(value.join(';'))`)
    out.push('}', '')
  }
  return out.join('\n')
}

function pre(tool: 'Read' | 'Bash', input: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: sessionId, transcript_path: transcript, cwd: dir, permission_mode: 'auto', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...extra }
}

let snapshots: string[] = []
// `session_start` fires on the first event of every session: the tests below look past it.
const deps = () => ({
  telemetry: (e: TelemetryEvent) => { if (e.event !== 'session_start') events.push(e) },
  snapshot: (reason: string) => { snapshots.push(reason) },
  now: () => new Date('2026-09-09T10:00:00Z'),
})
const allEvents: TelemetryEvent[] = []
const rawDeps = () => ({ telemetry: (e: TelemetryEvent) => { allEvents.push(e) }, snapshot: (reason: string) => { snapshots.push(reason) }, now: () => new Date('2026-09-09T10:00:00Z') })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-hook-'))
  transcript = path.join(dir, 'session.jsonl')
  bigFile = path.join(dir, 'src', 'big.ts')
  fs.mkdirSync(path.dirname(bigFile))
  fs.writeFileSync(bigFile, bigTs())
  fs.writeFileSync(transcript, transcriptLines(40_000))
  events = []
  snapshots = []
  allEvents.length = 0
  sessionId = `hook-test-${++sessionCounter}-${Date.now()}`
  for (const f of [POLICY_FILE, SKIP_FILE, HEARTBEAT_FILE, CONFIG_FILE, SESSIONS_SEEN_FILE]) { try { fs.unlinkSync(f) } catch { /* none */ } }
  saveConfig({ telemetry: false, contextGuard: { enabled: true } })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  try { for (const f of fs.readdirSync(LIVE_DIR)) if (f.includes(sessionId)) fs.unlinkSync(path.join(LIVE_DIR, f)) } catch { /* none */ }
  fs.rmSync(DIGEST_DIR, { recursive: true, force: true })
})

describe('PreToolUse Read', () => {
  it('sert un outline sur un gros fichier, enregistre la session, la policy et un événement', () => {
    const out = handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    expect(out).toBeDefined()
    const hso = out!.hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string }
    expect(hso.permissionDecision).toBe('deny')
    expect(hso.permissionDecisionReason).toContain('[cork-ai] big.ts')
    expect(hso.permissionDecisionReason).toContain('export function handler0(')
    expect(out!.decision).toBe('block') // legacy field kept

    expect(loadSessionReads(sessionId).files[bigFile]).toBe(1)
    expect(loadPolicy().ext['.ts'].compressions).toBe(1)
    const live = readActiveLiveSessions().find(s => s.sessionId === sessionId)!
    expect(live.requests).toBe(1)
    expect(live.savedTokens).toBeGreaterThan(1_500)
    expect(live.byModel?.['claude-opus-5']).toBeDefined()
    expect(events.map(e => e.event)).toEqual(['hook_read'])
    expect(events[0].properties).toMatchObject({ decision: 'outline', ext: '.ts', source: 'Read', context: '<50k', model: 'opus-5' })
    // no path, no name in telemetry
    expect(JSON.stringify(events)).not.toContain('big.ts')
  })

  it('une relecture complète est servie brute, déduite, apprise et mise en skip-list', () => {
    handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    const again = handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    expect(again).toBeUndefined()
    expect(isSkipped(bigFile)).toBe(true)
    expect(loadPolicy().ext['.ts'].reReads).toBe(1)
    const live = readActiveLiveSessions().find(s => s.sessionId === sessionId)!
    expect(live.reReads).toBe(1)
    expect(live.estimatedCostSaved).toBeLessThan(0)
    expect(events.at(-1)).toMatchObject({ event: 'hook_reread', properties: { kind: 'full' } })
  })

  it('offset/limit passe et compte comme suite ciblée (pas comme relecture)', () => {
    handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    expect(handleHookEvent(pre('Read', { file_path: bigFile, offset: 10, limit: 20 }), deps())).toBeUndefined()
    const policy = loadPolicy().ext['.ts']
    expect(policy.rangeReads).toBe(1)
    expect(policy.reReads).toBe(0)
    expect(isSkipped(bigFile)).toBe(false)
    expect(loadSessionReads(sessionId).files[bigFile]).toBe(2)
  })

  it('le fichier cité dans le dernier message utilisateur passe brut', () => {
    fs.writeFileSync(transcript, transcriptLines(40_000, 'Fix the bug in big.ts please'))
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeUndefined()
    expect(events[0].properties.reason).toBe('user-mentioned')
  })

  it('un contexte énorme fait refuser la compression (porte EV)', () => {
    fs.writeFileSync(transcript, transcriptLines(950_000))
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeUndefined()
    expect(events[0].properties).toMatchObject({ decision: 'raw', context: '>750k' })
  })

  it('petit fichier, image, fichier absent : brut', () => {
    const small = path.join(dir, 'small.ts')
    fs.writeFileSync(small, 'export const a = 1\n')
    expect(handleHookEvent(pre('Read', { file_path: small }), deps())).toBeUndefined()
    const png = path.join(dir, 'x.png')
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))
    expect(handleHookEvent(pre('Read', { file_path: png }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties.reason).toContain('ineligible')
    expect(handleHookEvent(pre('Read', { file_path: path.join(dir, 'missing.ts') }), deps())).toBeUndefined()
  })

  it('un fichier édité dans la session est servi brut', () => {
    handleHookEvent({ session_id: sessionId, transcript_path: transcript, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: bigFile, old_string: 'a', new_string: 'b' }, tool_response: { ok: true } }, deps())
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties.reason).toBe('editing')
  })

  it('un appel de sous-agent est traité et marqué comme tel', () => {
    const out = handleHookEvent(pre('Read', { file_path: bigFile }, { agent_type: 'Explore', agent_id: 'a1' }), deps())
    expect(out).toBeDefined()
    expect(events[0].properties.subagent).toBe(true)
  })
})

describe('PreToolUse Bash', () => {
  it('cat fichier → même outline que Read, source = cat', () => {
    const out = handleHookEvent(pre('Bash', { command: 'cat src/big.ts' }), deps())
    expect((out!.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason).toContain('[cork-ai] big.ts')
    expect(events[0].properties.source).toBe('cat')
    const live = readActiveLiveSessions().find(s => s.sessionId === sessionId)!
    expect(live.byModule.hookBashReadCompressor).toBeGreaterThan(0)
  })

  it('sed -n après un outline : passe, compte comme suite ciblée', () => {
    handleHookEvent(pre('Bash', { command: 'cat src/big.ts' }), deps())
    expect(handleHookEvent(pre('Bash', { command: "sed -n '10,40p' src/big.ts" }), deps())).toBeUndefined()
    expect(loadPolicy().ext['.ts'].rangeReads).toBe(1)
  })

  it('sed -i marque le fichier édité, et la lecture suivante est brute', () => {
    handleHookEvent(pre('Bash', { command: 'cat src/big.ts' }), deps())
    expect(handleHookEvent(pre('Bash', { command: "sed -i 's/a/b/' src/big.ts" }), deps())).toBeUndefined()
    expect(loadSessionReads(sessionId).edited?.[bigFile]).toBeTruthy()
    expect(loadPolicy().ext['.ts'].editsAfter).toBe(1)
    fs.writeFileSync(transcript, transcriptLines(40_000)) // fresh context, no skip-list entry
    expect(handleHookEvent(pre('Bash', { command: 'cat src/big.ts' }), deps())).toBeUndefined()
  })

  it('les commandes qui ne sont pas des lectures ne produisent rien', () => {
    for (const command of ['npm test', 'cat src/big.ts | head -5', 'ls -la', 'git status']) {
      expect(handleHookEvent(pre('Bash', { command }), deps()), command).toBeUndefined()
    }
    expect(events).toHaveLength(0)
  })
})

describe('PostToolUse Edit', () => {
  it('un Edit qui échoue sur un fichier vu en outline : compteur + skip-list', () => {
    handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    handleHookEvent({ session_id: sessionId, transcript_path: transcript, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: bigFile, old_string: 'zzz' }, tool_response: { error: 'String to replace not found in file.' } }, deps())
    expect(isSkipped(bigFile)).toBe(true)
    const live = readActiveLiveSessions().find(s => s.sessionId === sessionId)!
    expect(live.editFailuresAfterCompression).toBe(1)
  })
})

describe('Context guard', () => {
  it('UserPromptSubmit au-dessus d’une bande : systemMessage + additionalContext, une seule fois', () => {
    fs.writeFileSync(transcript, transcriptLines(320_000))
    const ev = { session_id: sessionId, transcript_path: transcript, cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: 'go' }
    const out = handleHookEvent(ev, deps())!
    expect(String(out.systemMessage)).toContain('321k tokens')
    expect((out.hookSpecificOutput as { hookEventName: string; additionalContext: string }).hookEventName).toBe('UserPromptSubmit')
    expect(events[0]).toMatchObject({ event: 'guard_notice', properties: { band: 300_000, on: 'UserPromptSubmit' } })
    expect(handleHookEvent(ev, deps())).toBeUndefined()
    expect(handleHookEvent({ ...ev, hook_event_name: 'Stop' }, deps())).toBeUndefined()
  })
})

describe('SessionEnd', () => {
  it('écrit un digest local et envoie un événement bucketé', () => {
    handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    events = []
    handleHookEvent({ session_id: sessionId, transcript_path: transcript, cwd: dir, hook_event_name: 'SessionEnd', reason: 'exit', permission_mode: 'auto' }, deps())
    const file = path.join(DIGEST_DIR, `${sessionId}.json`)
    const digest = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(digest).toMatchObject({ sessionId, reason: 'exit', turns: 1, compressions: 1, model: 'claude-opus-5', permissionMode: 'auto' })
    expect(digest.avgContextTokens).toBe(41_010)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: 'session_digest', properties: { model: 'opus-5', turns: 1, avg_context: '<50k', compressions: 1, reason: 'exit', duration_min: 0 } })
    expect(events[0].properties.saved_tokens).toBeGreaterThan(1000)
    expect(JSON.stringify(events[0])).not.toContain(sessionId)
  })

  it('déclenche le snapshot quotidien seulement si la télémétrie est active et qu’aucun n’est parti depuis 24 h', () => {
    const end = { session_id: sessionId, transcript_path: transcript, cwd: dir, hook_event_name: 'SessionEnd', reason: 'exit' }
    handleHookEvent(end, deps())
    expect(snapshots).toEqual([]) // telemetry off
    saveConfig({ telemetry: true, contextGuard: { enabled: true } })
    handleHookEvent(end, deps())
    expect(snapshots).toEqual(['session_end'])
    saveConfig({ telemetry: true, contextGuard: { enabled: true }, lastSnapshotAt: '2026-09-09T02:00:00Z' })
    handleHookEvent(end, deps())
    expect(snapshots).toEqual(['session_end']) // 8 hours ago: not due
    saveConfig({ telemetry: true, contextGuard: { enabled: true }, lastSnapshotAt: '2026-09-08T02:00:00Z' })
    handleHookEvent(end, deps())
    expect(snapshots).toEqual(['session_end', 'session_end'])
  })
})

describe('session_start', () => {
  it('part une seule fois par session, sur le premier événement, sans identifiant de session', () => {
    handleHookEvent(pre('Bash', { command: 'ls' }), rawDeps())
    handleHookEvent(pre('Bash', { command: 'git status' }), rawDeps())
    handleHookEvent({ session_id: sessionId, transcript_path: transcript, cwd: dir, hook_event_name: 'Stop' }, rawDeps())
    const starts = allEvents.filter(e => e.event === 'session_start')
    expect(starts).toHaveLength(1)
    expect(starts[0].properties).toMatchObject({ on: 'PreToolUse', permission_mode: 'auto', subagent: false })
    expect(JSON.stringify(starts[0])).not.toContain(sessionId)
    expect(JSON.parse(fs.readFileSync(SESSIONS_SEEN_FILE, 'utf-8'))[sessionId]).toBe('2026-09-09T10:00:00.000Z')
    // A different session is a new start.
    handleHookEvent({ ...pre('Bash', { command: 'ls' }), session_id: `${sessionId}-other` }, rawDeps())
    expect(allEvents.filter(e => e.event === 'session_start')).toHaveLength(2)
  })
})

describe('Heartbeat and unknown events', () => {
  it('chaque événement écrit le heartbeat avec la version de Claude Code lue dans le transcript', () => {
    handleHookEvent(pre('Bash', { command: 'ls' }), deps())
    const beat = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf-8'))
    expect(beat).toMatchObject({ sessionId, event: 'PreToolUse', toolName: 'Bash', permissionMode: 'auto', claudeVersion: '2.1.263' })
  })
  it('un événement inconnu ne produit rien', () => {
    expect(handleHookEvent({ session_id: sessionId, hook_event_name: 'Notification' }, deps())).toBeUndefined()
    expect(handleHookEvent({}, deps())).toBeUndefined()
  })
})
