/**
 * Suite 1 — Cohérence des stats (sans API)
 *
 * Vérifie que toutes les formules internes sont mathématiquement correctes :
 * savedTokens, savingsPercent, estimatedCostSaved, session accumulation, byModule.
 */

import { describe, it, expect } from 'vitest'
import { CtxForge, BudgetManager, countMessageTokens } from '../src/index.js'
import type { Message } from '../src/types/index.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ENV_HEADER = `<environment>
CWD: /home/user/my-project
OS: Linux
Platform: WSL2
Open files: src/index.ts, src/utils.ts, src/auth.ts
Version: node v20.11.0
</environment>`

const CODE_BLOCK = `import { readFileSync } from 'fs'
import path from 'path'
import { createHash } from 'crypto'

export interface Config {
  database: { host: string; port: number; name: string; poolSize: number }
  api: { baseUrl: string; timeout: number; retries: number }
  features: { darkMode: boolean; betaFeatures: boolean }
}

export const CONFIG: Config = {
  database: { host: 'localhost', port: 5432, name: 'mydb', poolSize: 10 },
  api: { baseUrl: 'https://api.example.com', timeout: 5000, retries: 3 },
  features: { darkMode: true, betaFeatures: false },
}

export function loadConfig(filePath?: string): Config {
  if (!filePath) return CONFIG
  const raw = readFileSync(filePath, 'utf-8')
  return JSON.parse(raw) as Config
}

export function hashConfig(cfg: Config): string {
  return createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 8)
}`

const BASH_OUTPUT = [
  '$ npm test',
  '',
  '> my-project@1.0.0 test',
  '> vitest run',
  '',
  ...Array.from({ length: 30 }, (_, i) =>
    i === 12
      ? 'FAIL tests/auth.test.ts'
      : i === 13
        ? '  ● AuthService › validateToken › should reject expired tokens'
        : `  Line ${i + 1}: test output...`
  ),
  '',
  'Tests: 1 failed, 14 passed',
].join('\n')

/** Session qui déclenche une compression niveau 'all' avec maxContextTokens=1500 */
function makeCompressibleSession(): Message[] {
  return [
    { role: 'user', content: `${ENV_HEADER}\n\nPeux-tu analyser le module config.ts ?` },
    { role: 'assistant', content: `Voici mon analyse :\n\n\`\`\`typescript\n${CODE_BLOCK}\n\`\`\`` },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 't1',
        content: CODE_BLOCK.repeat(3),
      }],
    },
    { role: 'assistant', content: 'Le code est bien structuré.' },
    { role: 'user', content: `${ENV_HEADER}\n\nMaintenant vérifie les tests.` },
    { role: 'assistant', content: 'Je lance les tests.' },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 't2',
        content: BASH_OUTPUT,
      }],
    },
    { role: 'assistant', content: 'Un test est en échec : `AuthService › validateToken`.' },
    { role: 'user', content: `${ENV_HEADER}\n\nFixe le test.` },
    { role: 'assistant', content: `Voilà la correction :\n\n\`\`\`typescript\n${CODE_BLOCK}\n\`\`\`` },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 't3',
        content: CODE_BLOCK.repeat(2),
      }],
    },
    { role: 'assistant', content: 'Tests corrigés.' },
  ]
}

/** Session très petite qui NE déclenche PAS la compression (budget 200K) */
function makeSmallSession(): Message[] {
  return [
    { role: 'user', content: 'Bonjour, peux-tu m\'aider ?' },
    { role: 'assistant', content: 'Bien sûr ! Que puis-je faire pour toi ?' },
    { role: 'user', content: 'Merci.' },
  ]
}

// ─── Groupe 1 : Invariants mathématiques ─────────────────────────────────────

describe('Suite 1 — Invariants mathématiques', () => {
  it('savedTokens + compressedTokens === originalTokens (identité exacte)', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(makeCompressibleSession())
    const { request } = stats
    expect(request.savedTokens + request.compressedTokens).toBe(request.originalTokens)
  })

  it('savedTokens est toujours >= 0', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(makeCompressibleSession())
    expect(stats.request.savedTokens).toBeGreaterThanOrEqual(0)
  })

  it('compressedTokens <= originalTokens (jamais de tokens "ajoutés")', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(makeCompressibleSession())
    expect(stats.request.compressedTokens).toBeLessThanOrEqual(stats.request.originalTokens)
  })

  it('savingsPercent correspond à la formule arrondie', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(makeCompressibleSession())
    const { request } = stats
    const expected = Math.round((request.savedTokens / request.originalTokens) * 1000) / 10
    expect(request.savingsPercent).toBeCloseTo(expected, 1)
  })

  it('savingsPercent est entre 0 et 100', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(makeCompressibleSession())
    expect(stats.request.savingsPercent).toBeGreaterThanOrEqual(0)
    expect(stats.request.savingsPercent).toBeLessThanOrEqual(100)
  })

  it('estimatedCostSaved correspond à la formule (pricing input par défaut = $3/1M)', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(makeCompressibleSession())
    const { request } = stats
    // Default pricing: $3.0 / 1M tokens input
    const expected = Math.round((request.savedTokens / 1_000_000) * 3.0 * 1000) / 1000
    expect(request.estimatedCostSaved).toBeCloseTo(expected, 3)
  })

  it('estimatedCostSaved respecte le pricing personnalisé', () => {
    const forge = new CtxForge({
      maxContextTokens: 1500,
      pricing: { input: 15.0 }, // Opus
    })
    const { stats } = forge.compress(makeCompressibleSession())
    const { request } = stats
    const expected = Math.round((request.savedTokens / 1_000_000) * 15.0 * 1000) / 1000
    expect(request.estimatedCostSaved).toBeCloseTo(expected, 3)
  })

  it('countMessageTokens(messages compressés) === stats.request.compressedTokens', () => {
    const session = makeCompressibleSession()
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { messages: compressed, stats } = forge.compress(session)
    const actualCompressedTokens = countMessageTokens(compressed)
    expect(stats.request.compressedTokens).toBe(actualCompressedTokens)
  })

  it('countMessageTokens(messages originaux) === stats.request.originalTokens', () => {
    const session = makeCompressibleSession()
    const originalTokens = countMessageTokens(session)
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(session)
    expect(stats.request.originalTokens).toBe(originalTokens)
  })
})

// ─── Groupe 2 : Accumulation de session ───────────────────────────────────────

describe('Suite 1 — Accumulation de session', () => {
  it('session.requestCount s\'incrémente à chaque compress()', () => {
    const forge = new CtxForge({ maxContextTokens: 1500 })
    forge.compress(makeCompressibleSession())
    forge.compress(makeCompressibleSession())
    forge.compress(makeCompressibleSession())
    const stats = forge.getStats()!
    expect(stats.session.requestCount).toBe(3)
  })

  it('session.totalProcessed === somme des originalTokens de chaque requête', () => {
    const forge = new CtxForge({ maxContextTokens: 1500 })
    const session = makeCompressibleSession()
    const originalTokens = countMessageTokens(session)

    forge.compress(session)
    forge.compress(session)

    const stats = forge.getStats()!
    expect(stats.session.totalProcessed).toBe(originalTokens * 2)
  })

  it('session.totalSaved === somme des savedTokens de chaque requête', () => {
    const forge = new CtxForge({ maxContextTokens: 1500 })

    let totalExpected = 0
    const r1 = forge.compress(makeCompressibleSession())
    totalExpected += r1.stats.request.savedTokens
    const r2 = forge.compress(makeCompressibleSession())
    totalExpected += r2.stats.request.savedTokens

    const stats = forge.getStats()!
    expect(stats.session.totalSaved).toBe(totalExpected)
  })

  it('session.estimatedCostSaved est positif après des compressions', () => {
    const forge = new CtxForge({ maxContextTokens: 1500 })
    forge.compress(makeCompressibleSession())
    forge.compress(makeCompressibleSession())
    const stats = forge.getStats()!
    expect(stats.session.estimatedCostSaved).toBeGreaterThan(0)
  })
})

// ─── Groupe 3 : Attribution par module (byModule) ─────────────────────────────

describe('Suite 1 — Attribution par module', () => {
  it('tous les byModule.saved sont >= 0 (jamais négatif)', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(makeCompressibleSession())
    for (const [name, mod] of Object.entries(stats.byModule)) {
      expect(mod.saved, `${name}.saved`).toBeGreaterThanOrEqual(0)
    }
  })

  it('au moins un module a saved > 0 quand la compression s\'active', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(makeCompressibleSession())
    const totalBySumModule = Object.values(stats.byModule).reduce((s, m) => s + m.saved, 0)
    expect(totalBySumModule).toBeGreaterThan(0)
  })

  it('byModule.runs === 1 après une seule compression', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(makeCompressibleSession())
    for (const [name, mod] of Object.entries(stats.byModule)) {
      expect(mod.runs, `${name}.runs après 1 call`).toBe(1)
    }
  })

  it('byModule.runs s\'incrémente après plusieurs compressions', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    forge.compress(makeCompressibleSession())
    forge.compress(makeCompressibleSession())
    const stats = forge.getStats()!
    for (const [name, mod] of Object.entries(stats.byModule)) {
      expect(mod.runs, `${name}.runs après 2 calls`).toBe(2)
    }
  })

  it('quand le budget est large (pas de compression), byModule est vide', () => {
    const forge = new CtxForge({ maxContextTokens: 200_000, aggressiveness: 0.6 })
    const { stats } = forge.compress(makeSmallSession())
    // Ratio << 40% → level 'none' → aucun module ne tourne
    expect(Object.keys(stats.byModule)).toHaveLength(0)
    expect(stats.request.savedTokens).toBe(0)
  })
})

// ─── Groupe 4 : reset() ───────────────────────────────────────────────────────

describe('Suite 1 — reset()', () => {
  it('reset() efface getStats()', () => {
    const forge = new CtxForge({ maxContextTokens: 1500 })
    forge.compress(makeCompressibleSession())
    expect(forge.getStats()).not.toBeNull()
    forge.reset()
    expect(forge.getStats()).toBeNull()
  })

  it('après reset(), session.requestCount repart à 1 au prochain compress()', () => {
    const forge = new CtxForge({ maxContextTokens: 1500 })
    forge.compress(makeCompressibleSession())
    forge.compress(makeCompressibleSession())
    forge.reset()
    forge.compress(makeCompressibleSession())
    const stats = forge.getStats()!
    expect(stats.session.requestCount).toBe(1)
  })

  it('après reset(), session.totalSaved repart de zéro', () => {
    const forge = new CtxForge({ maxContextTokens: 1500 })
    forge.compress(makeCompressibleSession())
    forge.reset()
    const { stats } = forge.compress(makeCompressibleSession())
    // totalSaved = savedTokens de cette seule requête
    expect(stats.session.totalSaved).toBe(stats.request.savedTokens)
  })
})

// ─── Groupe 5 : Cas limites ───────────────────────────────────────────────────

describe('Suite 1 — Cas limites', () => {
  it('tableau vide → pas de crash, savedTokens = 0', () => {
    const forge = new CtxForge({ maxContextTokens: 1500 })
    const { stats } = forge.compress([])
    expect(stats.request.savedTokens).toBe(0)
    expect(stats.request.originalTokens).toBe(0)
    expect(stats.request.savingsPercent).toBe(0) // pas de NaN
  })

  it('message unique → pas de crash, stats valides', () => {
    const forge = new CtxForge({ maxContextTokens: 1500 })
    const { stats } = forge.compress([{ role: 'user', content: 'Hello world' }])
    expect(stats.request.originalTokens).toBeGreaterThan(0)
    expect(stats.request.savingsPercent).toBeGreaterThanOrEqual(0)
    expect(isNaN(stats.request.savingsPercent)).toBe(false)
  })

  it('aggressiveness=0 → compression minimale, pas de crash', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0 })
    const { stats } = forge.compress(makeCompressibleSession())
    expect(stats.request.savedTokens).toBeGreaterThanOrEqual(0)
    expect(isNaN(stats.request.savingsPercent)).toBe(false)
  })

  it('aggressiveness=1.0 → compression maximale, stats cohérentes', () => {
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 1.0 })
    const { stats } = forge.compress(makeCompressibleSession())
    expect(stats.request.savedTokens + stats.request.compressedTokens).toBe(stats.request.originalTokens)
  })

  it('hardLimit=false → ne throw pas même si le contexte dépasse le budget', () => {
    const forge = new CtxForge({
      maxContextTokens: 100, // ridiculement petit
      budget: { hardLimit: false },
    })
    expect(() => forge.compress(makeCompressibleSession())).not.toThrow()
  })

  it('hardLimit=true → throw si le contexte dépasse le budget après compression', () => {
    const forge = new CtxForge({
      maxContextTokens: 100, // trop petit même après compression
      budget: { hardLimit: true },
    })
    expect(() => forge.compress(makeCompressibleSession())).toThrow(/dépasse le budget/)
  })
})

// ─── Groupe 6 : Compression réelle vérifiable ────────────────────────────────

describe('Suite 1 — Compression réelle vérifiable', () => {
  it('tool_result compressor réduit les tokens sur de gros blocs', () => {
    // On vérifie que savedTokens > 0 quand les tool_results sont larges
    const session = makeCompressibleSession()
    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(session)
    // Avec des CODE_BLOCK × 3 dans les tool_results, toolResultCompressor doit agir
    expect(stats.request.savedTokens).toBeGreaterThan(0)
  })

  it('header stripper élimine les headers dupliqués', () => {
    // Session avec 3 messages user contenant le même ENV_HEADER
    const session: Message[] = [
      { role: 'user', content: `${ENV_HEADER}\n\nQuestion 1` },
      { role: 'assistant', content: 'Réponse 1' },
      { role: 'user', content: `${ENV_HEADER}\n\nQuestion 2` },
      { role: 'assistant', content: 'Réponse 2' },
      { role: 'user', content: `${ENV_HEADER}\n\nQuestion 3` },
      { role: 'assistant', content: 'Réponse 3' },
    ].concat(makeCompressibleSession()) // assez de tokens pour déclencher la compression

    const forge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats } = forge.compress(session)
    const headerSaved = stats.byModule['headerStripper']?.saved ?? 0
    expect(headerSaved).toBeGreaterThan(0)
  })

  it('la réduction annoncée est proportionnelle au contenu comprimé', () => {
    // Deux sessions : une avec tool_results énormes, une sans
    const heavySession = makeCompressibleSession()
    const lightSession = makeSmallSession()

    const heavyForge = new CtxForge({ maxContextTokens: 1500, aggressiveness: 0.6 })
    const { stats: heavyStats } = heavyForge.compress(heavySession)

    const lightForge = new CtxForge({ maxContextTokens: 200_000, aggressiveness: 0.6 })
    const { stats: lightStats } = lightForge.compress(lightSession)

    // La session lourde avec petit budget doit avoir plus de savings
    expect(heavyStats.request.savingsPercent).toBeGreaterThan(lightStats.request.savingsPercent)
  })

  it('BudgetManager — level "none" quand ratio < 40% (budget.maxTokens)', () => {
    // BudgetManager utilise options.budget.maxTokens, pas maxContextTokens
    const manager = new BudgetManager({ budget: { maxTokens: 200_000 } })
    const result = manager.compress(makeSmallSession())
    expect(result.savedTokens).toBe(0)
    expect(Object.keys(result.byModule)).toHaveLength(0)
  })

  it('BudgetManager — compression active quand ratio > 40% (budget.maxTokens petit)', () => {
    const manager = new BudgetManager({ budget: { maxTokens: 1500 } })
    const result = manager.compress(makeCompressibleSession())
    // Avec un petit budget, au moins un module doit s'activer
    expect(Object.keys(result.byModule).length).toBeGreaterThan(0)
  })
})
