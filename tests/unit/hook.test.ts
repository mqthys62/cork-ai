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

  it('PostToolUseFailure : l’échec arrive dans `error`, sans tool_response, et ne marque pas le fichier comme édité', () => {
    handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    handleHookEvent({ session_id: sessionId, transcript_path: transcript, cwd: dir, hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_input: { file_path: bigFile, old_string: 'zzz', new_string: 'y' }, error: 'String to replace not found in file.', tool_use_id: 'toolu_1' }, deps())
    expect(isSkipped(bigFile)).toBe(true)
    const live = readActiveLiveSessions().find(s => s.sessionId === sessionId)!
    expect(live.editFailuresAfterCompression).toBe(1)
    expect(loadSessionReads(sessionId).edited?.[bigFile]).toBeUndefined()   // nothing changed on disk
  })

  it('PostToolUseFailure sur un fichier jamais outliné : rien à apprendre', () => {
    handleHookEvent({ session_id: sessionId, transcript_path: transcript, cwd: dir, hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_input: { file_path: bigFile, old_string: 'zzz' }, error: 'String to replace not found in file.' }, deps())
    expect(isSkipped(bigFile)).toBe(false)
    expect(readActiveLiveSessions().find(s => s.sessionId === sessionId)).toBeUndefined()
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
    expect(digest).toMatchObject({ sessionId, reason: 'exit', turns: 1, compressions: 1, model: 'claude-opus-5', permissionMode: 'auto', project: path.basename(dir), durationMin: 0, startedAt: '2026-09-09T10:00:00.000Z' })
    expect(digest.avgContextTokens).toBe(41_010)
    // the project name stays local
    expect(JSON.stringify(events)).not.toContain(path.basename(dir))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: 'session_digest', properties: { model: 'opus-5', turns: 1, avg_context: '<50k', compressions: 1, reason: 'exit', duration_min: 0 } })
    expect(events[0].properties.saved_tokens).toBeGreaterThan(1000)
    // what the session saved, and the share of the bill it took off — a percentage, never the bill
    expect(events[0].properties.saved_usd).toBeGreaterThan(0)
    expect(events[0].properties.saved_pct_of_cost).toBeGreaterThan(0)
    expect(events[0].properties.saved_pct_of_cost).toBeLessThanOrEqual(100)
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

// ─── Re-read cache (1.0) ────────────────────────────────────────────────────

/** `.ts` on probation: the outline gate serves raw, which is what the cache needs to see first. */
/** `.ts` on probation, with the probe already spent: the next reads are refused (served raw). */
function putTsOnProbation(): void {
  fs.writeFileSync(POLICY_FILE, JSON.stringify({ version: 1, ext: { '.ts': { compressions: 21, reReads: 19, editsAfter: 0, probationReads: 1, lastAt: '' } } }))
}

function mediumTs(n = 20): string {
  const out = ["import fs from 'fs'", '']
  for (let i = 0; i < n; i++) {
    out.push(`export function handler${i}(input: string, options: { retries: number; verbose: boolean }): Promise<string> {`)
    out.push(`  const value = input.trim().toLowerCase().split(',').map(s => s.trim()).filter(Boolean)`)
    out.push(`  if (options.verbose) console.log('handler${i}', value, options.retries)`)
    out.push(`  return Promise.resolve(value.join(';'))`)
    out.push('}', '')
  }
  return out.join('\n')
}

describe('re-read cache', () => {
  it('un fichier servi brut puis relu à l’identique reçoit un rappel, pas le contenu', () => {
    putTsOnProbation()
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeUndefined()
    expect(events[0].properties).toMatchObject({ decision: 'raw', reason: 'probation', agent_class: 'main' })
    const raw = loadSessionReads(sessionId).raw![bigFile]
    expect(raw).toMatchObject({ hits: 0, agent: null, size: fs.statSync(bigFile).size })
    expect(raw.offset).toBe(fs.statSync(transcript).size)

    // the model works a turn, then reads the same file again
    fs.appendFileSync(transcript, transcriptLines(45_000))
    const again = handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    expect(again).toBeDefined()
    const reason = (again!.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason
    expect(reason).toContain('[cork-ai] big.ts — already read 1 turn ago')
    expect(reason).toContain('still in your context')
    expect(reason).not.toContain('export function handler0(')  // the reminder carries no content
    expect(reason.length).toBeLessThan(500)

    expect(loadSessionReads(sessionId).raw![bigFile].hits).toBe(1)
    expect(loadPolicy().ext['cache:.ts']).toMatchObject({ compressions: 1, reReads: 0 })
    const live = readActiveLiveSessions().find(s => s.sessionId === sessionId)!
    expect(live.byModule.hookReadCache).toBeGreaterThan(1_000)
    expect(events.at(-1)).toMatchObject({ event: 'hook_read', properties: { decision: 'cached', ext: '.ts', turns_ago: 1, agent_class: 'main' } })
    expect(JSON.stringify(events)).not.toContain('big.ts')
  })

  it('fichier modifié entre-temps → brut, empreinte rafraîchie', () => {
    putTsOnProbation()
    handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    const before = loadSessionReads(sessionId).raw![bigFile].hash
    fs.appendFileSync(bigFile, '\nexport const extra = 1\n')
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'raw', cache_miss: 'changed' })
    const after = loadSessionReads(sessionId).raw![bigFile]
    expect(after.hash).not.toBe(before)
    expect(after.hits).toBe(0)
  })

  it('compaction après la lecture → le contenu a quitté le contexte, brut', () => {
    putTsOnProbation()
    handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    fs.appendFileSync(transcript, JSON.stringify({ type: 'system', subtype: 'compact_boundary', version: '2.1.263' }) + '\n' + transcriptLines(30_000))
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'raw', cache_miss: 'compacted' })
    // the fresh raw read starts a new cache window past the compaction
    fs.appendFileSync(transcript, transcriptLines(31_000))
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeDefined()
  })

  it('un sous-agent a son propre contexte : pas de rappel entre agents, rappel au sein du même agent', () => {
    putTsOnProbation()
    handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    const worker = { agent_type: 'general-purpose', agent_id: 'agent-1' }
    expect(handleHookEvent(pre('Read', { file_path: bigFile }, worker), deps())).toBeUndefined()
    // no reminder (the agent never saw the file), and no false "re-read" either
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'raw', reason: 'probation', agent_class: 'editing' })
    expect(events.at(-1)!.properties.cache_miss).toBeUndefined()
    expect(isSkipped(bigFile)).toBe(false)
    // the same agent again: its own raw read is now the cache entry
    expect(handleHookEvent(pre('Read', { file_path: bigFile }, worker), deps())).toBeDefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'cached', agent_class: 'editing' })
    // and the main conversation still has its own entry
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeDefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'cached', agent_class: 'main' })
  })

  it('relecture entière après un rappel → brut, apprise, pénalisée, et plus jamais de rappel pour ce fichier', () => {
    putTsOnProbation()
    handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeDefined()   // reminder
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeUndefined() // insisted
    expect(events.at(-1)).toMatchObject({ event: 'hook_reread', properties: { kind: 'after-cache', ext: '.ts' } })
    expect(loadPolicy().ext['cache:.ts']).toMatchObject({ compressions: 1, reReads: 1 })
    expect(loadSessionReads(sessionId).raw![bigFile].missed).toBe(true)
    const live = readActiveLiveSessions().find(s => s.sessionId === sessionId)!
    expect(live.reReads).toBe(1)
    expect(isSkipped(bigFile)).toBe(false) // the skip list is for outlines; the cache only gives up for this session
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'raw', cache_miss: 'missed' })
  })

  it('offset/limit passe toujours ; policy.reReadCache=false désactive le rappel', () => {
    putTsOnProbation()
    handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    expect(handleHookEvent(pre('Read', { file_path: bigFile, offset: 5, limit: 10 }), deps())).toBeUndefined()
    saveConfig({ telemetry: false, contextGuard: { enabled: true }, policy: { reReadCache: false } })
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'raw', reason: 'probation' })
  })

  it('la relecture d’un fichier déjà outliné (servie brute) alimente aussi le cache', () => {
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeDefined()   // outline
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeUndefined() // re-read → raw, skip-listed
    expect(loadSessionReads(sessionId).raw![bigFile]).toBeDefined()
    // skip-listed for good: no reminder either — the file proved it needs its content
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'raw', reason: 'skip-list' })
  })
})

describe('agent class', () => {
  it('Explore obtient un outline dès 800 tokens économisés, la conversation principale non', () => {
    const medium = path.join(dir, 'src', 'medium.ts')
    fs.writeFileSync(medium, mediumTs(20))
    expect(handleHookEvent(pre('Read', { file_path: medium }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'raw', reason: 'saves-only', agent_class: 'main', subagent: false })

    const out = handleHookEvent(pre('Read', { file_path: medium }, { agent_type: 'Explore', agent_id: 'agent-2' }), deps())
    expect(out).toBeDefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'outline', agent_class: 'readonly', subagent: true })
    expect(loadPolicy().ext['ro:.ts'].compressions).toBe(1)
    expect(loadPolicy().ext['.ts']).toBeUndefined()

    // an editing subagent keeps the main threshold
    expect(handleHookEvent(pre('Read', { file_path: medium }, { agent_type: 'general-purpose', agent_id: 'agent-3' }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'raw', reason: 'saves-only', agent_class: 'editing' })
  })

  it('policy.readonlyAgentsAggressive=false remet Explore au seuil normal', () => {
    saveConfig({ telemetry: false, contextGuard: { enabled: true }, policy: { readonlyAgentsAggressive: false } })
    const medium = path.join(dir, 'src', 'medium.ts')
    fs.writeFileSync(medium, mediumTs(20))
    expect(handleHookEvent(pre('Read', { file_path: medium }, { agent_type: 'Explore', agent_id: 'agent-4' }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'raw', reason: 'saves-only', agent_class: 'readonly' })
  })
})

describe('reads state per agent', () => {
  it('un sous-agent qui lit un fichier outliné par la conversation principale n’est pas une relecture', () => {
    expect(handleHookEvent(pre('Read', { file_path: bigFile }), deps())).toBeDefined()
    const out = handleHookEvent(pre('Read', { file_path: bigFile }, { agent_type: 'general-purpose', agent_id: 'agent-9' }), deps())
    expect(out).toBeDefined() // its own outline: its context never had one
    expect(events.map(e => e.event)).toEqual(['hook_read', 'hook_read'])
    expect(loadPolicy().ext['.ts']).toMatchObject({ compressions: 2, reReads: 0 })
    expect(isSkipped(bigFile)).toBe(false)
    const reads = loadSessionReads(sessionId)
    expect(reads.files[bigFile]).toBe(1)
    expect(reads.files[`@agent-9:${bigFile}`]).toBe(1)
  })

  it('un Edit du sous-agent sur son fichier outliné est appris pour la classe de l’agent', () => {
    const explore = { agent_type: 'Explore', agent_id: 'agent-10' }
    expect(handleHookEvent(pre('Read', { file_path: bigFile }, explore), deps())).toBeDefined()
    handleHookEvent({ ...pre('Read', {}, explore), hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: bigFile, old_string: 'a', new_string: 'b' }, tool_response: { ok: true } }, deps())
    expect(loadPolicy().ext['ro:.ts']).toMatchObject({ compressions: 1, editsAfter: 1 })
    expect(loadPolicy().ext['.ts']).toBeUndefined()
    expect(loadSessionReads(sessionId).edited![bigFile]).toBeTruthy() // edits are session-wide
  })
})

describe('PreToolUse PowerShell', () => {
  it('Get-Content d’un gros fichier → outline, -TotalCount → suite ciblée', () => {
    const ps = (command: string) => ({ ...pre('Bash', { command }), tool_name: 'PowerShell' })
    const out = handleHookEvent(ps(`Get-Content ${bigFile}`), deps())
    expect(out).toBeDefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'outline', source: 'Get-Content' })
    expect(handleHookEvent(ps(`Get-Content ${bigFile} -TotalCount 30`), deps())).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ event: 'hook_reread', properties: { kind: 'range' } })
  })
})

describe('audit 1.0.0-rc.1 — robustesse', () => {
  it('des hooks parallèles ne se perdent pas leurs écritures (fusion à l’écriture)', async () => {
    const { readsFileFor, saveSessionReads } = await import('../../src/cli/hook.js')
    const raw = (f: string) => ({ mtimeMs: 1, size: 1, hash: 'x', at: 'now', offset: 0, agent: null, hits: 0 })
    // Hook A loads an empty state. Meanwhile six parallel hooks save one raw
    // entry each. A plain load-modify-save from A would then leave A's entry alone.
    const others = Array.from({ length: 6 }, (_, i) => path.join(dir, 'src', `p${i}.ts`))
    fs.writeFileSync(readsFileFor(sessionId), JSON.stringify({ files: { [others[0]]: 1 }, raw: Object.fromEntries(others.map(f => [f, raw(f)])) }))
    const late = path.join(dir, 'src', 'late.ts')
    saveSessionReads(sessionId, { files: { [late]: 1 }, edited: { [late]: 'now' }, raw: { [late]: raw(late) } })

    const after = loadSessionReads(sessionId)
    expect(Object.keys(after.raw ?? {}).sort()).toEqual([...others, late].sort())
    expect(after.files).toEqual({ [others[0]]: 1, [late]: 1 })
    expect(after.edited).toEqual({ [late]: 'now' })
  })

  it('un contenu que Claude Code aurait tronqué n’entre pas dans le cache (Read > 2000 lignes, cat > 30 Ko)', () => {
    putTsOnProbation()
    const long = path.join(dir, 'src', 'long.ts')
    fs.writeFileSync(long, Array.from({ length: 2_500 }, (_, i) => `export const v${i} = ${i}`).join('\n'))
    expect(handleHookEvent(pre('Read', { file_path: long }), deps())).toBeUndefined()
    expect(loadSessionReads(sessionId).raw?.[long]).toBeUndefined()

    const wide = path.join(dir, 'src', 'wide.ts')
    fs.writeFileSync(wide, Array.from({ length: 400 }, (_, i) => `export const w${i} = '${'x'.repeat(100)}'`).join('\n'))  // ≈ 46 KB, 400 lines
    expect(fs.statSync(wide).size).toBeGreaterThan(30_000)
    expect(handleHookEvent(pre('Bash', { command: `cat ${wide}` }), deps())).toBeUndefined()
    expect(loadSessionReads(sessionId).raw?.[wide]).toBeUndefined()      // shell output would be spilled to a file
    expect(handleHookEvent(pre('Read', { file_path: wide }), deps())).toBeUndefined()
    expect(loadSessionReads(sessionId).raw?.[wide]).toBeDefined()        // Read returns all 400 lines
  })

  it('un résumé de compaction n’est pas « le prompt de l’utilisateur »', () => {
    fs.writeFileSync(transcript, transcriptLines(40_000, 'refactor the parser') + JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation… files: big.ts, hook.ts' } }) + '\n')
    const out = handleHookEvent(pre('Read', { file_path: bigFile }), deps())
    expect(out).toBeDefined()   // outlined: big.ts named only by the summary
    expect(events[0].properties).toMatchObject({ decision: 'outline' })
  })

  it('un fichier trop gros, un FIFO ou un tool-results de Claude Code passent bruts sans être lus', () => {
    const spill = path.join(dir, 'tool-results', 'toolu_01.txt')
    fs.mkdirSync(path.dirname(spill)); fs.writeFileSync(spill, 'line\n'.repeat(500))
    expect(handleHookEvent(pre('Read', { file_path: spill }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'raw', reason: 'tool-results' })

    const huge = path.join(dir, 'src', 'huge.log')
    const fd = fs.openSync(huge, 'w'); fs.ftruncateSync(fd, 5 * 1024 * 1024); fs.closeSync(fd)
    expect(handleHookEvent(pre('Read', { file_path: huge }), deps())).toBeUndefined()
    expect(events.at(-1)!.properties).toMatchObject({ decision: 'raw', reason: 'ineligible: too-large' })
    expect(handleHookEvent(pre('Read', { file_path: dir }), deps())).toBeUndefined()   // a directory: not a file
  })

  it('l’outline d’un fichier de plus de 2000 lignes annonce la vraie longueur', () => {
    const long = path.join(dir, 'src', 'long.ts')
    fs.writeFileSync(long, mediumTs(400))   // 400 handlers × 6 lines ≈ 2400 lines
    const total = fs.readFileSync(long, 'utf-8').split('\n').length
    expect(total).toBeGreaterThan(2000)
    const out = handleHookEvent(pre('Read', { file_path: long }), deps())
    const reason = (out!.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason
    expect(reason).toContain(`${total} lines (first 2000 outlined)`)
    expect(reason).toContain(`Lines 2001–${total} are not in this outline`)
  })

  it('SessionEnd purge les fichiers live de plus de 7 jours', async () => {
    const { pruneLiveState } = await import('../../src/cli/hook.js')
    fs.mkdirSync(LIVE_DIR, { recursive: true })
    const old = path.join(LIVE_DIR, `reads-${sessionId}-old.json`), fresh = path.join(LIVE_DIR, `guard-${sessionId}-fresh.json`)
    fs.writeFileSync(old, '{}'); fs.writeFileSync(fresh, '{}')
    const t = Date.now() / 1000 - 8 * 86_400
    fs.utimesSync(old, t, t)
    expect(pruneLiveState(new Date())).toBe(1)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })
})
