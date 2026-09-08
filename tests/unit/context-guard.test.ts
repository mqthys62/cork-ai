import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BANDS, buildNotice, evaluateGuard, guardHookOutput } from '../../src/cli/context-guard.js'

const HOME = process.env.CORK_AI_HOME!
let sessionId: string

beforeEach(() => {
  sessionId = `guard-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
})
afterEach(() => {
  try { fs.rmSync(path.join(HOME, 'live', `guard-${sessionId}.json`), { force: true }) } catch { /* none */ }
})

const probeAt = (contextTokens: number, model = 'claude-opus-5') => () => ({ contextTokens, model })

describe('evaluateGuard', () => {
  it('rien sous la première bande', () => {
    expect(evaluateGuard({ sessionId, transcriptPath: '/t.jsonl', event: 'UserPromptSubmit', contextProbe: probeAt(120_000) })).toBeUndefined()
  })

  it('une notice par bande et par session, la plus haute atteinte', () => {
    const first = evaluateGuard({ sessionId, transcriptPath: '/t.jsonl', event: 'UserPromptSubmit', contextProbe: probeAt(160_000) })
    expect(first?.band).toBe(150_000)
    // same band again: silence
    expect(evaluateGuard({ sessionId, transcriptPath: '/t.jsonl', event: 'Stop', contextProbe: probeAt(200_000) })).toBeUndefined()
    // jump straight past two bands: one notice, for the highest
    const jump = evaluateGuard({ sessionId, transcriptPath: '/t.jsonl', event: 'UserPromptSubmit', contextProbe: probeAt(520_000) })
    expect(jump?.band).toBe(500_000)
    expect(evaluateGuard({ sessionId, transcriptPath: '/t.jsonl', event: 'UserPromptSubmit', contextProbe: probeAt(600_000) })).toBeUndefined()
    const top = evaluateGuard({ sessionId, transcriptPath: '/t.jsonl', event: 'UserPromptSubmit', contextProbe: probeAt(800_000) })
    expect(top?.band).toBe(750_000)
  })

  it('PostToolUse n’évalue qu’un événement sur N', () => {
    let probes = 0
    const probe = () => { probes++; return { contextTokens: 400_000, model: 'claude-opus-5' } }
    for (let i = 0; i < 4; i++) {
      expect(evaluateGuard({ sessionId, transcriptPath: '/t.jsonl', event: 'PostToolUse', contextProbe: probe, config: { everyNthToolUse: 5 } })).toBeUndefined()
    }
    expect(probes).toBe(0)
    const fifth = evaluateGuard({ sessionId, transcriptPath: '/t.jsonl', event: 'PostToolUse', contextProbe: probe, config: { everyNthToolUse: 5 } })
    expect(probes).toBe(1)
    expect(fifth?.band).toBe(300_000)
  })

  it('désactivé par la config, ou sans transcript', () => {
    expect(evaluateGuard({ sessionId, transcriptPath: '/t.jsonl', event: 'Stop', contextProbe: probeAt(900_000), config: { enabled: false } })).toBeUndefined()
    expect(evaluateGuard({ sessionId, transcriptPath: undefined, event: 'Stop', contextProbe: probeAt(900_000) })).toBeUndefined()
  })

  it('bandes personnalisées', () => {
    const n = evaluateGuard({ sessionId, transcriptPath: '/t.jsonl', event: 'Stop', contextProbe: probeAt(90_000), config: { bands: [80_000] } })
    expect(n?.band).toBe(80_000)
  })

  it('lit le contexte dans un vrai transcript quand aucune sonde n’est injectée', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-guard-'))
    const file = path.join(dir, 's.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'assistant', message: { id: 'a', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 310_000, cache_creation_input_tokens: 2_000 } } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'b', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 5_000 } } }),
    ].join('\n'))
    const n = evaluateGuard({ sessionId, transcriptPath: file, event: 'UserPromptSubmit' })
    expect(n?.band).toBe(300_000)
    expect(n?.contextTokens).toBe(312_010)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('buildNotice / guardHookOutput', () => {
  it('chiffre le coût par appel au tarif cache-read du modèle', () => {
    const n = buildNotice(300_000, 400_000, 'claude-opus-5')
    expect(n.perTurnUSD).toBeCloseTo(0.2)
    expect(n.perTurnCompactedUSD).toBeCloseTo(0.0125)
    expect(n.systemMessage).toContain('400k tokens')
    expect(n.systemMessage).toContain('$0.200')
    expect(n.additionalContext).toContain('/compact')
    const fable = buildNotice(300_000, 400_000, 'claude-fable-5-1')
    expect(fable.perTurnUSD).toBeCloseTo(0.1)
  })

  it('la sortie hook porte systemMessage et additionalContext pour l’événement', () => {
    const n = buildNotice(150_000, 160_000, 'claude-sonnet-5')
    const out = guardHookOutput(n, 'UserPromptSubmit')
    expect(out.systemMessage).toBe(n.systemMessage)
    expect(out.hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: n.additionalContext })
    expect(guardHookOutput(n, 'Stop', false).hookSpecificOutput).toBeUndefined()
  })

  it('bandes par défaut', () => {
    expect(DEFAULT_BANDS).toEqual([150_000, 300_000, 500_000, 750_000])
  })
})
