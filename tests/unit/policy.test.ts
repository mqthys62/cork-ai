import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AMPLIFICATION,
  MIN_SAVED_TOKENS,
  POLICY_FILE,
  POOLED_PRIOR_MAX,
  POOLED_PRIOR_MIN_SAMPLES,
  PRIOR_WEIGHT,
  PROBATION_MIN_SAMPLES,
  PROBE_EVERY,
  agentClassOf,
  gate,
  policyKey,
  loadPolicy,
  policySummary,
  recordCompression,
  recordEditAfter,
  recordProbationRead,
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
    expect(p).toBeCloseTo((0.5 * PRIOR_WEIGHT + 2) / (PRIOR_WEIGHT + 20), 5)
    expect(p).toBeLessThan(0.2)
  })

  it('une lecture ciblée après un outline ne pèse pas sur P(relecture)', () => {
    for (let i = 0; i < 10; i++) { recordCompression('/p/a.go'); recordRangeRead('/p/a.go') }
    expect(reReadProbability('.go')).toBeCloseTo((0.5 * PRIOR_WEIGHT) / (PRIOR_WEIGHT + 10), 5)
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

describe('prior empirique pour une extension jamais vue', () => {
  it('reste sur le prior fixe tant que la machine a trop peu de preuves', () => {
    for (let i = 0; i < POOLED_PRIOR_MIN_SAMPLES - 1; i++) recordCompression('/p/a.md')
    expect(reReadProbability('.rs')).toBe(0.5)
  })

  it('hérite du taux mesuré sur les autres extensions du même scope', () => {
    // 20 compressions, 0 relecture ailleurs : la machine sait que les outlines
    // marchent ici, une extension neuve ne doit pas repartir d’une pièce jetée.
    for (let i = 0; i < 20; i++) recordCompression('/p/a.md')
    expect(reReadProbability('.rs')).toBeCloseTo(0.3, 5)
  })

  it('plafonne le prior pour qu’une extension neuve garde son premier essai', () => {
    for (let i = 0; i < 20; i++) { recordCompression('/p/a.md'); recordReRead('/p/a.md') }
    expect(reReadProbability('.rs')).toBeCloseTo(POOLED_PRIOR_MAX, 5)
    // Au plafond, une extension neuve n’est pas en probation : 0 échantillon.
    expect(policySummary().find(e => e.ext === '.rs')).toBeUndefined()
  })

  it('ne mélange pas les scopes', () => {
    for (let i = 0; i < 20; i++) { recordCompression('/p/a.md'); recordReRead('/p/a.md') }
    // Le scope cache n’a aucune preuve à lui : il garde son propre prior.
    expect(reReadProbability('cache:.rs')).toBe(0.3)
  })

  it('n’utilise pas sa propre histoire comme prior', () => {
    for (let i = 0; i < 20; i++) { recordCompression('/p/a.md'); recordReRead('/p/a.md') }
    // .md se juge sur ses 20 observations, pas sur le pool (qui l’exclut).
    expect(reReadProbability('.md')).toBeCloseTo((0.5 * PRIOR_WEIGHT + 20) / (PRIOR_WEIGHT + 20), 5)
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

  it('une extension qui re-lit trop passe en probation, sondée 1 fois sur 10 des lectures gérées', () => {
    for (let i = 0; i < PROBATION_MIN_SAMPLES + 3; i++) recordCompression('/p/a.tsx')   // 13 : pas un multiple de 10
    for (let i = 0; i < 9; i++) recordReRead('/p/a.tsx')
    const read = () => { const d = gate({ ...base, filePath: '/p/b.tsx', contextTokens: 10_000 }); if (d.probation) recordProbationRead('/p/b.tsx'); return d }
    const first = read()
    expect(first.probation).toBe(true)
    expect(first.compress).toBe(true)          // probationReads 0 → probe
    expect(first.reason).toBe('probation probe')
    for (let i = 0; i < PROBE_EVERY - 1; i++) {
      const d = read()
      expect(d.compress).toBe(false)
      expect(d.reason).toContain('probation')
    }
    expect(read().reason).toBe('probation probe')   // 10e lecture gérée → nouvelle sonde
  })

  it('la probation se lève quand les sondes ne sont plus relues', () => {
    for (let i = 0; i < PROBATION_MIN_SAMPLES; i++) { recordCompression('/p/a.tsx'); recordReRead('/p/a.tsx') }
    expect(gate({ ...base, filePath: '/p/b.tsx', contextTokens: 10_000 }).probation).toBe(true)
    for (let i = 0; i < 40; i++) recordCompression('/p/a.tsx')   // 40 sondes, aucune relecture → p ≈ (2+10)/(4+50) = 0.22
    const d = gate({ ...base, filePath: '/p/b.tsx', contextTokens: 10_000 })
    expect(d.probation).toBe(false)
    expect(d.compress).toBe(true)
    expect(d.reason).toContain('expected value')
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

describe('concurrent counter writes', () => {
  // Regression: bump() used a plain load-modify-save on a file that every
  // parallel hook shares. Six processes × 50 increments persisted 93 of 300
  // (69% lost), which starved probation of the observations it needs.
  it('loses no increment when several processes bump at once', async () => {
    const workers = 6
    const each = 50
    await Promise.all(
      Array.from({ length: workers }, () =>
        new Promise<void>(resolve => {
          // Same process, but interleaved: each tick yields between the read
          // and the write, which is exactly the window the bug lived in.
          let n = 0
          const step = () => {
            if (n++ >= each) return resolve()
            recordCompression('/x/a.ts')
            setImmediate(step)
          }
          step()
        }),
      ),
    )
    expect(loadPolicy().ext['.ts'].compressions).toBe(workers * each)
  })
})

describe('gate refuses what it cannot justify', () => {
  const base = {
    filePath: '/x/a.ts',
    originalTokens: 20_000,
    compressedTokens: 500,
    contextTokens: 100_000,
    model: 'claude-opus-5',
    amplification: 150,
  }

  // Regression: `ev <= 0` is false for NaN, so a non-finite input sailed
  // through as "compress".
  it('refuses when the expected value is not computable', () => {
    const d = gate({ ...base, originalTokens: NaN })
    expect(d.compress).toBe(false)
    expect(d.reason).toMatch(/not computable/)
  })

  // Regression: an outline with no entries is deletion, not compression —
  // the model must re-read to learn anything, so it only buys an extra turn.
  it('refuses an outline with no structural entries', () => {
    const d = gate({ ...base, outlineEntries: 0, outlineLines: 163 })
    expect(d.compress).toBe(false)
    expect(d.reason).toMatch(/no entries/)
  })

  it('refuses an outline too sparse to navigate', () => {
    const d = gate({ ...base, outlineEntries: 1, outlineLines: 4_221 })
    expect(d.compress).toBe(false)
    expect(d.reason).toMatch(/too sparse/)
  })

  it('still compresses when the outline has real structure', () => {
    const d = gate({ ...base, outlineEntries: 19, outlineLines: 189 })
    expect(d.compress).toBe(true)
  })

  // Short files legitimately have few entries.
  it('does not judge density on a short file', () => {
    const d = gate({ ...base, outlineEntries: 1, outlineLines: 45 })
    expect(d.compress).toBe(true)
  })
})
