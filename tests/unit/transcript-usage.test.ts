import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanTranscript } from '../../src/cli/transcript-usage.js'
import { costOfUsage } from '../../src/pricing/index.js'

let dir: string
let file: string

function line(entry: unknown): string {
  return JSON.stringify(entry)
}

function assistantTurn(opts: {
  id: string
  model?: string
  sidechain?: boolean
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
}): string {
  const write5m = opts.cacheWrite5m ?? 0
  const write1h = opts.cacheWrite1h ?? 0
  return line({
    type: 'assistant',
    isSidechain: opts.sidechain ?? false,
    message: {
      id: opts.id,
      model: opts.model ?? 'claude-opus-5',
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: write5m + write1h,
        cache_creation: {
          ephemeral_5m_input_tokens: write5m,
          ephemeral_1h_input_tokens: write1h,
        },
      },
    },
  })
}

function write(lines: string[]): void {
  fs.writeFileSync(file, lines.join('\n'), 'utf-8')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-transcript-'))
  file = path.join(dir, 'session.jsonl')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('scanTranscript', () => {
  it('déduplique les tours assistant répétés par message.id', () => {
    // Claude Code écrit 2 à 5 lignes par message assistant pendant le stream,
    // avec le même usage — sans dédup le coût est multiplié d'autant.
    write([
      assistantTurn({ id: 'msg_1', output: 100 }),
      assistantTurn({ id: 'msg_1', output: 100 }),
      assistantTurn({ id: 'msg_1', output: 100 }),
      assistantTurn({ id: 'msg_2', output: 50 }),
    ])

    const usage = scanTranscript(file)
    expect(usage.messages).toBe(2)
    expect(usage.outputTokens).toBe(150)
  })

  it('compte les tours de sous-agents mais les expose séparément', () => {
    write([
      assistantTurn({ id: 'msg_1', output: 100 }),
      assistantTurn({ id: 'msg_2', output: 40, sidechain: true }),
    ])

    const usage = scanTranscript(file)
    expect(usage.messages).toBe(2)
    expect(usage.sidechainMessages).toBe(1)
    expect(usage.outputTokens).toBe(140)
  })

  it('ignore les entrées synthétiques sans modèle Claude', () => {
    write([
      assistantTurn({ id: 'msg_1', output: 100 }),
      assistantTurn({ id: 'msg_2', output: 999, model: '<synthetic>' }),
    ])

    const usage = scanTranscript(file)
    expect(usage.messages).toBe(1)
    expect(usage.outputTokens).toBe(100)
  })

  it('survit à une ligne tronquée en fin de fichier', () => {
    write([
      assistantTurn({ id: 'msg_1', output: 100 }),
      '{"type":"assistant","message":{"id":"msg_2","mod',
    ])

    const usage = scanTranscript(file)
    expect(usage.messages).toBe(1)
  })

  it('ventile le coût par modèle', () => {
    write([
      assistantTurn({ id: 'msg_1', model: 'claude-opus-5', output: 1_000_000 }),
      assistantTurn({ id: 'msg_2', model: 'claude-haiku-4-5', output: 1_000_000 }),
    ])

    const usage = scanTranscript(file)
    expect(usage.byModel['claude-opus-5'].costUSD).toBeCloseTo(25)
    expect(usage.byModel['claude-haiku-4-5'].costUSD).toBeCloseTo(5)
    expect(usage.costUSD).toBeCloseTo(30)
  })

  it('retourne un total vide sur un fichier absent', () => {
    const usage = scanTranscript(path.join(dir, 'nope.jsonl'))
    expect(usage.messages).toBe(0)
    expect(usage.costUSD).toBe(0)
  })
})

describe('costOfUsage — split TTL du cache', () => {
  it('facture les écritures 1h à 2× et les 5m à 1.25×', () => {
    const cost = costOfUsage(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000,
        },
      },
      'claude-opus-5', // $5/M input → 5m = $6.25/M, 1h = $10/M
    )
    expect(cost).toBeCloseTo(6.25 + 10)
  })

  it('retombe sur le tarif 5m quand le split est absent', () => {
    const cost = costOfUsage(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 2_000_000,
      },
      'claude-opus-5',
    )
    expect(cost).toBeCloseTo(12.5)
  })
})
