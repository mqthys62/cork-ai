import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AMPLIFICATION,
  MIN_SAVED_TOKENS,
  POLICY_FILE,
  PROBATION_MIN_SAMPLES,
  agentClassOf,
  gate,
  policyKey,
  loadPolicy,
  policySummary,
  recordCompression,
  recordEditAfter,
  recordRangeRead,
  recordReRead,
  reReadProbability,
  type PolicyState,
} from '../../src/cli/policy.js'

beforeEach(() => {
  fs.mkdirSync(path.dirname(POLICY_FILE), { recursive: true })
  try { fs.unlinkSync(POLICY_FILE) } catch { /* none */ }
})
afterEach(() => {
  try { fs.unlinkSync(POLICY_FILE) } catch { /* none */ }
})

describe('apprentissage par extension', () => {
  it('part d’un prior de 0.5 et converge vers le taux observé', () => {
    expect(reReadProbability('.ts', { version: 1, ext: {} })).toBe(0.5)
    for (let i = 0; i < 20; i++) recordCompression('/p/a.ts')
    for (let i = 0; i < 2; i++) recordReRead('/p/a.ts')
    const p = reReadProbability('.ts')
    expect(p).toBeCloseTo((0.5 * 4 + 2) / (4 + 20), 5)
    expect(p).toBeLessThan(0.2)
  })

  it('une lecture ciblée après un outline ne pèse pas sur P(relecture)', () => {
    for (let i = 0; i < 10; i++) { recordCompression('/p/a.go'); recordRangeRead('/p/a.go') }
    expect(reReadProbability('.go')).toBeCloseTo((0.5 * 4) / (4 + 10), 5)
    expect(policySummary()[0]).toMatchObject({ ext: '.go', rangeReads: 10, reReadRate: 0, probation: false })
  })

  it('compte les éditions après compression et résume par extension', () => {
    recordCompression('/p/a.tsx'); recordCompression('/p/b.tsx'); recordReRead('/p/a.tsx'); recordEditAfter('/p/a.tsx')
    const s = policySummary()
    expect(s[0]).toMatchObject({ ext: '.tsx', compressions: 2, editsAfter: 1 })
    expect(s[0].reReadRate).toBeCloseTo(0.5)
    expect(loadPolicy().ext['.tsx'].lastAt).toBeTruthy()
  })
})

describe('gate — valeur attendue', () => {
  const base = { filePath: '/p/x.ts', originalTokens: 6_000, compressedTokens: 800, model: 'claude-opus-5' }

  it('refuse une économie trop petite quoi qu’il arrive', () => {
    const d = gate({ ...base, originalTokens: 2_000, compressedTokens: 2_000 - MIN_SAVED_TOKENS + 1, contextTokens: 0 })
    expect(d.compress).toBe(false)
    expect(d.reason).toContain('saves only')
  })

  it('compresse un gros fichier sur un petit contexte, refuse le même fichier sur un contexte énorme', () => {
    const small = gate({ ...base, contextTokens: 50_000 })
    const huge = gate({ ...base, contextTokens: 900_000 })
    expect(small.compress).toBe(true)
    expect(small.expectedValueUSD).toBeGreaterThan(0)
    expect(huge.compress).toBe(false)
    expect(huge.expectedValueUSD).toBeLessThan(0)
    expect(huge.reason).toContain('expected value')
  })

  it('la formule : gain = saved × amp × cacheRead ; perte = p × (compressed × amp × cacheRead + ctx × cacheRead + 300 × output)', () => {
    const state: PolicyState = { version: 1, ext: {} } // p = 0.5
    const d = gate({ ...base, contextTokens: 200_000, amplification: 50, state })
    const cacheRead = 0.5, output = 25
    const gain = (5_200 / 1e6) * 50 * cacheRead
    const loss = 0.5 * ((800 / 1e6) * 50 * cacheRead + (200_000 / 1e6) * cacheRead + (300 / 1e6) * output)
    expect(d.expectedValueUSD).toBeCloseTo(gain - loss, 6)
  })

  it('une extension qui re-lit trop passe en probation, sondée 1 fois sur 10', () => {
    for (let i = 0; i < PROBATION_MIN_SAMPLES; i++) recordCompression('/p/a.tsx')
    for (let i = 0; i < 8; i++) recordReRead('/p/a.tsx')
    const d = gate({ ...base, filePath: '/p/b.tsx', contextTokens: 10_000 })
    expect(d.probation).toBe(true)
    expect(d.compress).toBe(true) // 10 % 10 === 0 → probe
    expect(d.reason).toBe('probation probe')
    recordCompression('/p/a.tsx')
    const next = gate({ ...base, filePath: '/p/b.tsx', contextTokens: 10_000 })
    expect(next.compress).toBe(false)
    expect(next.reason).toContain('probation')
  })

  it('le prix du modèle entre dans le calcul (Opus 5 vs Sonnet 5 à contexte égal)', () => {
    const opus = gate({ ...base, model: 'claude-opus-5', contextTokens: 500_000 })
    const sonnet = gate({ ...base, model: 'claude-sonnet-5', contextTokens: 500_000 })
    expect(opus.expectedValueUSD).not.toBeCloseTo(sonnet.expectedValueUSD, 4)
    expect(Math.abs(sonnet.expectedValueUSD)).toBeLessThan(Math.abs(opus.expectedValueUSD))
  })

  it('l’amplification par défaut vaut 50', () => {
    expect(DEFAULT_AMPLIFICATION).toBe(50)
  })
})

describe('scopes (1.0): cache and agent class', () => {
  it('agentClassOf : principal, lecture seule, édition', () => {
    expect(agentClassOf({})).toBe('main')
    expect(agentClassOf({ agent_type: 'Explore', agent_id: 'x' })).toBe('readonly')
    expect(agentClassOf({ agent_type: 'plan' })).toBe('readonly')
    expect(agentClassOf({ agent_type: 'general-purpose', agent_id: 'x' })).toBe('editing')
    expect(agentClassOf({ agent_id: 'fork-1' })).toBe('editing')          // a fork: unknown type → editing
    expect(agentClassOf({ agent_type: 'my-custom-reviewer' })).toBe('editing')
  })

  it('policyKey : .ts / ro:.ts / cache:.ts', () => {
    expect(policyKey('/p/a.ts')).toBe('.ts')
    expect(policyKey('/p/a.ts', { agentClass: 'editing' })).toBe('.ts')
    expect(policyKey('/p/a.ts', { agentClass: 'readonly' })).toBe('ro:.ts')
    expect(policyKey('/p/a.ts', { mode: 'cache', agentClass: 'readonly' })).toBe('cache:.ts')
  })

  it('la porte est plus basse (800) en lecture seule et pour le cache, et le cache part d’un a priori plus bas', () => {
    const base = { filePath: '/p/a.ts', originalTokens: 2_000, compressedTokens: 900, contextTokens: 40_000, model: 'claude-opus-5', state: { version: 1 as const, ext: {} } }
    expect(gate(base).compress).toBe(false)
    expect(gate(base).reason).toContain('< 1500')
    expect(gate({ ...base, scope: { agentClass: 'readonly' } }).compress).toBe(true)
    expect(gate({ ...base, scope: { agentClass: 'editing' } }).compress).toBe(false)
    const cache = gate({ ...base, compressedTokens: 80, scope: { mode: 'cache' } })
    expect(cache.compress).toBe(true)
    expect(cache.reReadProbability).toBeCloseTo(0.3, 5)
    expect(gate(base).reReadProbability).toBeCloseTo(0.5, 5)
  })

  it('les statistiques se cumulent sous la bonne clé', () => {
    recordCompression('/p/a.ts', { agentClass: 'readonly' })
    recordCompression('/p/a.ts', { mode: 'cache' })
    recordReRead('/p/a.ts', { mode: 'cache' })
    recordCompression('/p/a.ts')
    const s = loadPolicy().ext
    expect(s['ro:.ts']).toMatchObject({ compressions: 1, reReads: 0 })
    expect(s['cache:.ts']).toMatchObject({ compressions: 1, reReads: 1 })
    expect(s['.ts']).toMatchObject({ compressions: 1 })
  })
})
