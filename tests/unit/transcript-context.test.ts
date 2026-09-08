import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  contextReport,
  lastMainTurnUsage,
  listTranscriptFiles,
  scanAllTranscripts,
  sessionContextProfile,
  sessionReReadTurns,
} from '../../src/cli/transcript-usage.js'

let root: string
let project: string
const previousProjectsDir = process.env.CLAUDE_PROJECTS_DIR

function turn(opts: { id: string; cacheRead: number; write?: number; output?: number; model?: string; sidechain?: boolean; content?: unknown[]; ts?: string }): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: opts.sidechain ?? false,
    timestamp: opts.ts ?? '2026-09-01T10:00:00.000Z',
    message: {
      id: opts.id,
      model: opts.model ?? 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: opts.output ?? 100, cache_read_input_tokens: opts.cacheRead, cache_creation_input_tokens: opts.write ?? 1_000 },
      content: opts.content ?? [{ type: 'text', text: 'ok' }],
    },
  })
}

function toolResult(toolUseId: string, text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-projects-'))
  project = path.join(root, '-home-me-projects-app')
  fs.mkdirSync(project)
  process.env.CLAUDE_PROJECTS_DIR = root
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  if (previousProjectsDir === undefined) delete process.env.CLAUDE_PROJECTS_DIR
  else process.env.CLAUDE_PROJECTS_DIR = previousProjectsDir
})

describe('listTranscriptFiles / scanAllTranscripts', () => {
  it('trouve les sous-agents dans <session>/subagents/**.jsonl et les marque sidechain', () => {
    fs.writeFileSync(path.join(project, 'sess-1.jsonl'), turn({ id: 'm1', cacheRead: 1_000 }))
    const sub = path.join(project, 'sess-1', 'subagents', 'workflows', 'wf-1')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'agent-a.jsonl'), turn({ id: 'm2', cacheRead: 2_000, sidechain: true }))

    const files = listTranscriptFiles()
    expect(files).toHaveLength(2)
    expect(files.find(f => f.sidechain)?.sessionId).toBe('sess-1')
    expect(files.find(f => !f.sidechain)?.sessionId).toBe('sess-1')

    const usage = scanAllTranscripts()
    expect(usage.messages).toBe(2)
    expect(usage.sidechainMessages).toBe(1)
    expect(usage.cacheReadTokens).toBe(3_000)
  })

  it('respecte le filtre since', () => {
    const file = path.join(project, 'old.jsonl')
    fs.writeFileSync(file, turn({ id: 'm1', cacheRead: 1 }))
    const past = new Date(Date.now() - 10 * 86_400_000)
    fs.utimesSync(file, past, past)
    expect(listTranscriptFiles(new Date(Date.now() - 86_400_000))).toHaveLength(0)
    expect(listTranscriptFiles()).toHaveLength(1)
  })
})

describe('lastMainTurnUsage', () => {
  it('renvoie le dernier tour du thread principal et la taille du contexte', () => {
    const file = path.join(project, 's.jsonl')
    fs.writeFileSync(file, [
      turn({ id: 'a', cacheRead: 50_000 }),
      turn({ id: 'b', cacheRead: 80_000, write: 500 }),
      turn({ id: 'c', cacheRead: 999_999, sidechain: true }),
      '{"type":"user","message":{"role":"user","content":"hi"}}',
    ].join('\n'))
    const t = lastMainTurnUsage(file)
    expect(t?.model).toBe('claude-opus-5')
    expect(t?.contextTokens).toBe(80_510)
  })
  it('undefined sans transcript', () => {
    expect(lastMainTurnUsage(undefined)).toBeUndefined()
    expect(lastMainTurnUsage('/nope.jsonl')).toBeUndefined()
  })
})

describe('sessionContextProfile / contextReport', () => {
  it('mesure le contexte moyen et rejoue la session sous un plafond', () => {
    const file = path.join(project, 'big.jsonl')
    const lines: string[] = []
    // context climbs 20k per turn up to 500k: 25 turns
    for (let i = 1; i <= 25; i++) lines.push(turn({ id: `t${i}`, cacheRead: i * 20_000, write: 20_000, output: 100 }))
    lines.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))
    fs.writeFileSync(file, lines.join('\n'))

    const p = sessionContextProfile(file, [200_000])!
    expect(p.turns).toBe(25)
    expect(p.compactions).toBe(1)
    expect(p.maxContextTokens).toBe(500_010 + 20_000)
    expect(p.avgContextTokens).toBeGreaterThan(250_000)
    expect(p.cacheReadCostUSD).toBeCloseTo((25 * 26 / 2) * 20_000 / 1e6 * 0.5, 4)
    // capped replay must cost less than the real thing, but not be free
    expect(p.cappedCostUSD[200_000]).toBeLessThan(p.costUSD)
    expect(p.cappedCostUSD[200_000]).toBeGreaterThan(p.costUSD * 0.3)

    const r = contextReport({ ceilings: [200_000], minTurns: 20 })
    expect(r.sessions).toHaveLength(1)
    expect(r.turns).toBe(25)
    expect(r.cappedCostUSD[200_000]).toBeCloseTo(p.cappedCostUSD[200_000], 6)
  })

  it('ignore les sessions trop courtes', () => {
    fs.writeFileSync(path.join(project, 'short.jsonl'), turn({ id: 'x', cacheRead: 1 }))
    expect(contextReport({ minTurns: 20 }).sessions).toHaveLength(0)
  })
})

describe('sessionReReadTurns', () => {
  it('facture le tour qui re-lit un fichier servi compressé, et ignore les re-lectures après compaction', () => {
    const file = path.join(project, 'rr.jsonl')
    const read = (id: string, fp: string) => [{ type: 'tool_use', id, name: 'Read', input: { file_path: fp } }]
    const bash = (id: string, cmd: string) => [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }]
    fs.writeFileSync(file, [
      turn({ id: 'a1', cacheRead: 100_000, content: read('tu1', '/p/src/app.ts') }),
      toolResult('tu1', '[cork-ai] app.ts — 300 lines → outline (12 entries)\n...'),
      turn({ id: 'a2', cacheRead: 200_000, output: 300, content: bash('tu2', 'sed -n \'1,300p\' /p/src/app.ts') }),   // the re-read turn
      toolResult('tu2', 'export const x = 1'),
      turn({ id: 'a3', cacheRead: 200_000, content: read('tu3', '/p/src/app.ts') }),                                    // already counted once
      toolResult('tu3', 'raw'),
      turn({ id: 'a4', cacheRead: 200_000, content: read('tu4', '/p/legacy.ts') }),
      toolResult('tu4', '// legacy.ts — 100 lines → signatures extracted (60% compression)'),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
      turn({ id: 'a5', cacheRead: 30_000, content: read('tu5', '/p/legacy.ts') }),                                      // after compaction: not billed
    ].join('\n'))

    const r = sessionReReadTurns('rr')
    expect(r.found).toBe(true)
    expect(r.compressions).toBe(2)
    expect(r.reReads).toBe(1)
    // turn a2: 10 input + 300 output + 200k cache read + 1k cache write on Opus 5
    const expected = 10 / 1e6 * 5 + 300 / 1e6 * 25 + 200_000 / 1e6 * 0.5 + 1_000 / 1e6 * 6.25
    expect(r.extraTurnCostUSD).toBeCloseTo(expected, 6)
  })

  it('found=false sans transcript', () => {
    expect(sessionReReadTurns('missing').found).toBe(false)
  })
})

describe('cache durable des dépenses (spend-cache.json)', () => {
  it('un transcript purgé par Claude Code reste compté', async () => {
    const { SPEND_CACHE_FILE } = await import('../../src/cli/transcript-usage.js')
    try { fs.unlinkSync(SPEND_CACHE_FILE) } catch { /* none */ }
    const file = path.join(project, 'purged.jsonl')
    const lines: string[] = []
    for (let i = 1; i <= 25; i++) lines.push(turn({ id: `p${i}`, cacheRead: 10_000 }))
    fs.writeFileSync(file, lines.join('\n'))

    const first = scanAllTranscripts()
    const ctxFirst = contextReport({ ceilings: [150_000, 200_000, 300_000], minTurns: 20 })
    expect(first.messages).toBe(25)
    expect(ctxFirst.sessions).toHaveLength(1)

    fs.unlinkSync(file)
    const second = scanAllTranscripts()
    expect(second.messages).toBe(25)
    expect(second.costUSD).toBeCloseTo(first.costUSD, 8)
    const ctxSecond = contextReport({ ceilings: [200_000], minTurns: 20 })
    expect(ctxSecond.sessions).toHaveLength(1)
    expect(ctxSecond.sessions[0].sessionId).toBe('purged')

    // a `since` after the purged file's last activity excludes it
    expect(scanAllTranscripts(new Date(Date.now() + 86_400_000)).messages).toBe(0)
    try { fs.unlinkSync(SPEND_CACHE_FILE) } catch { /* none */ }
  })
})
