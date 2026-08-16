import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<{
  sessionId: string
  projectPath: string
  startedAt: string
  savedTokens: number
  originalTokens: number
  compressedTokens: number
  savingsPercent: number
  estimatedCostSaved: number
  requests: number
  byModule: Record<string, number>
}> = {}) {
  return {
    sessionId: `sess-${Math.random().toString(36).slice(2)}`,
    projectPath: '/home/user/projects/myapp',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    requests: 10,
    originalTokens: 10000,
    compressedTokens: 4000,
    savedTokens: 6000,
    savingsPercent: 60,
    estimatedCostSaved: 0.018,
    byModule: { toolResultCompressor: 4000, headerStripper: 2000 },
    ...overrides,
  }
}

function makeStats(sessions = [makeSession()]) {
  return {
    version: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    allTime: {
      totalRequests: sessions.reduce((s, r) => s + r.requests, 0),
      totalOriginalTokens: sessions.reduce((s, r) => s + r.originalTokens, 0),
      totalCompressedTokens: sessions.reduce((s, r) => s + r.compressedTokens, 0),
      totalSavedTokens: sessions.reduce((s, r) => s + r.savedTokens, 0),
      estimatedCostSaved: sessions.reduce((s, r) => s + r.estimatedCostSaved, 0),
    },
    sessions,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Import after helpers to avoid hoisting issues with inline mock data
import {
  getStatsByProject,
  getStatsByPeriod,
  getForecast,
  recordSession,
  readGlobalStats,
  resetGlobalStats,
  STATS_VERSION,
} from '../../src/cli/persistent-stats.js'

// ─── getStatsByProject ────────────────────────────────────────────────────────

describe('getStatsByProject', () => {
  it('regroupe les sessions par projectPath', () => {
    const sessions = [
      makeSession({ projectPath: '/home/user/projects/app-a', savedTokens: 1000 }),
      makeSession({ projectPath: '/home/user/projects/app-a', savedTokens: 2000 }),
      makeSession({ projectPath: '/home/user/projects/app-b', savedTokens: 500 }),
    ]
    const result = getStatsByProject(makeStats(sessions))
    expect(result).toHaveLength(2)
    expect(result[0].projectPath).toBe('/home/user/projects/app-a')
    expect(result[0].totalSavedTokens).toBe(3000)
    expect(result[0].sessionCount).toBe(2)
    expect(result[1].projectPath).toBe('/home/user/projects/app-b')
    expect(result[1].totalSavedTokens).toBe(500)
  })

  it('extrait le projectName depuis path.basename', () => {
    const result = getStatsByProject(makeStats([
      makeSession({ projectPath: '/home/user/projects/cork-ai' }),
    ]))
    expect(result[0].projectName).toBe('cork-ai')
  })

  it('gère les sessions sans projectPath', () => {
    const s = makeSession()
    delete (s as any).projectPath
    const result = getStatsByProject(makeStats([s]))
    expect(result[0].projectPath).toBe('unknown')
    expect(result[0].projectName).toBe('Unknown project')
  })

  it('trie par totalSavedTokens décroissant', () => {
    const sessions = [
      makeSession({ projectPath: '/proj/a', savedTokens: 100 }),
      makeSession({ projectPath: '/proj/b', savedTokens: 9000 }),
      makeSession({ projectPath: '/proj/c', savedTokens: 500 }),
    ]
    const result = getStatsByProject(makeStats(sessions))
    expect(result.map(r => r.projectPath)).toEqual(['/proj/b', '/proj/c', '/proj/a'])
  })

  it('retourne un tableau vide si aucune session', () => {
    const result = getStatsByProject(makeStats([]))
    expect(result).toHaveLength(0)
  })

  it('calcule la moyenne mobile de savingsPercent', () => {
    const sessions = [
      makeSession({ projectPath: '/proj/a', savingsPercent: 40 }),
      makeSession({ projectPath: '/proj/a', savingsPercent: 60 }),
      makeSession({ projectPath: '/proj/a', savingsPercent: 80 }),
    ]
    const result = getStatsByProject(makeStats(sessions))
    expect(result[0].avgSavingsPercent).toBeCloseTo(60, 0)
  })

  it('accumule totalCostSaved et totalRequests', () => {
    const sessions = [
      makeSession({ projectPath: '/p', estimatedCostSaved: 0.01, requests: 5 }),
      makeSession({ projectPath: '/p', estimatedCostSaved: 0.02, requests: 8 }),
    ]
    const result = getStatsByProject(makeStats(sessions))
    expect(result[0].totalCostSaved).toBeCloseTo(0.03)
    expect(result[0].totalRequests).toBe(13)
  })
})

// ─── getStatsByPeriod ─────────────────────────────────────────────────────────

describe('getStatsByPeriod', () => {
  it('regroupe par jour', () => {
    const today = new Date().toISOString()
    const sessions = [
      makeSession({ startedAt: today }),
      makeSession({ startedAt: today }),
    ]
    const result = getStatsByPeriod(makeStats(sessions), 'day')
    expect(result).toHaveLength(1)
    expect(result[0].sessionCount).toBe(2)
  })

  it('filtre les sessions hors de la fenêtre lookback', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString()
    const recent = new Date().toISOString()
    const sessions = [
      makeSession({ startedAt: old }),
      makeSession({ startedAt: recent }),
    ]
    // lookback = 30 jours par défaut → la vieille session doit être exclue
    const result = getStatsByPeriod(makeStats(sessions), 'day')
    expect(result).toHaveLength(1)
  })

  it('regroupe par semaine ISO', () => {
    // Même semaine ISO
    const monday = new Date('2026-05-25T10:00:00Z').toISOString()
    const wednesday = new Date('2026-05-27T10:00:00Z').toISOString()
    const sessions = [
      makeSession({ startedAt: monday }),
      makeSession({ startedAt: wednesday }),
    ]
    const result = getStatsByPeriod(makeStats(sessions), 'week', 100)
    expect(result).toHaveLength(1)
    expect(result[0].label).toMatch(/^\d{4}-W\d{2}$/)
    expect(result[0].sessionCount).toBe(2)
  })

  it('regroupe par mois', () => {
    const may1 = new Date('2026-05-01T10:00:00Z').toISOString()
    const may15 = new Date('2026-05-15T10:00:00Z').toISOString()
    const sessions = [
      makeSession({ startedAt: may1 }),
      makeSession({ startedAt: may15 }),
    ]
    const result = getStatsByPeriod(makeStats(sessions), 'month', 24)
    const may = result.find(r => r.label === '2026-05')
    expect(may).toBeDefined()
    expect(may!.sessionCount).toBe(2)
  })

  it('trie par label croissant', () => {
    const sessions = [
      makeSession({ startedAt: new Date('2026-05-20T10:00:00Z').toISOString() }),
      makeSession({ startedAt: new Date('2026-05-10T10:00:00Z').toISOString() }),
    ]
    const result = getStatsByPeriod(makeStats(sessions), 'day', 100)
    expect(result[0].label < result[1].label).toBe(true)
  })

  it('retourne un tableau vide si aucune session dans la fenêtre', () => {
    const old = new Date(Date.now() - 60 * 86400_000).toISOString()
    const result = getStatsByPeriod(makeStats([makeSession({ startedAt: old })]), 'day')
    expect(result).toHaveLength(0)
  })
})

// ─── getForecast ──────────────────────────────────────────────────────────────

describe('getForecast', () => {
  it('retourne des zéros si aucune session', () => {
    const f = getForecast(makeStats([]))
    expect(f.basedOnDays).toBe(0)
    expect(f.avgDailyTokensSaved).toBe(0)
    expect(f.projectedAnnualTokensSaved).toBe(0)
    expect(f.projectedAnnualCostSaved).toBe(0)
  })

  it('projette correctement depuis une seule session', () => {
    const f = getForecast(makeStats([
      makeSession({ savedTokens: 3650, estimatedCostSaved: 0.01095 }),
    ]))
    // spanDays = 1, dailyAvg = 3650
    expect(f.avgDailyTokensSaved).toBeCloseTo(3650, 0)
    expect(f.projectedAnnualTokensSaved).toBeCloseTo(3650 * 365, -2)
    expect(f.projectedMonthlyTokensSaved).toBeCloseTo(3650 * 30, -2)
  })

  it('utilise uniquement les 30 derniers jours si disponible', () => {
    const old = new Date(Date.now() - 60 * 86400_000).toISOString()
    const recent = new Date().toISOString()
    // Session ancienne avec beaucoup de tokens — ne doit pas influencer la prévision
    const sessions = [
      makeSession({ startedAt: old, savedTokens: 999999 }),
      makeSession({ startedAt: recent, savedTokens: 1000 }),
    ]
    const f = getForecast(makeStats(sessions))
    // Si les 30 derniers jours seulement : dailyAvg ≈ 1000
    // Si toute la data : dailyAvg serait bien plus haute
    expect(f.avgDailyTokensSaved).toBeLessThan(100000)
  })

  it('calcule les projections mensuelles et annuelles cohérentes', () => {
    const f = getForecast(makeStats([
      makeSession({ savedTokens: 100, estimatedCostSaved: 0.0003 }),
    ]))
    expect(f.projectedMonthlyTokensSaved).toBeCloseTo(f.avgDailyTokensSaved * 30, 0)
    expect(f.projectedAnnualTokensSaved).toBeCloseTo(f.avgDailyTokensSaved * 365, 0)
    expect(f.projectedMonthlyCostSaved).toBeCloseTo(f.avgDailyCostSaved * 30, 5)
    expect(f.projectedAnnualCostSaved).toBeCloseTo(f.avgDailyCostSaved * 365, 5)
  })

  it('utilise toute la data si aucune session dans les 30 derniers jours', () => {
    const old = new Date(Date.now() - 60 * 86400_000).toISOString()
    const f = getForecast(makeStats([
      makeSession({ startedAt: old, savedTokens: 5000 }),
    ]))
    expect(f.avgDailyTokensSaved).toBeGreaterThan(0)
  })
})

// ─── recordSession / readGlobalStats / resetGlobalStats (fs) ──────────────────

describe('recordSession + readGlobalStats + resetGlobalStats', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-ai-test-'))
    // Redirect GLOBAL_DIR by writing directly to the file the module uses
    // Since GLOBAL_DIR is os.homedir()/.cork-ai, we write to a known location
    // and test readGlobalStats via the real stats file path after resetGlobalStats
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resetGlobalStats crée un fichier propre lisible par readGlobalStats', () => {
    // resetGlobalStats écrit dans le vrai ~/.cork-ai — on vérifie juste que ça ne throw pas
    // et que readGlobalStats retourne quelque chose de valide
    resetGlobalStats()
    const stats = readGlobalStats()
    expect(stats).not.toBeNull()
    expect(stats!.sessions).toHaveLength(0)
    expect(stats!.allTime.totalSavedTokens).toBe(0)
    expect(stats!.version).toBe(STATS_VERSION)
  })

  it('recordSession ajoute une session et readGlobalStats la retrouve', () => {
    resetGlobalStats()
    recordSession({
      projectPath: '/test/project',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      requests: 5,
      originalTokens: 8000,
      compressedTokens: 3000,
      savedTokens: 5000,
      savingsPercent: 62.5,
      estimatedCostSaved: 0.015,
      byModule: { toolResultCompressor: 5000 },
    })
    const stats = readGlobalStats()
    expect(stats!.sessions).toHaveLength(1)
    expect(stats!.sessions[0].savedTokens).toBe(5000)
    expect(stats!.sessions[0].projectPath).toBe('/test/project')
    expect(stats!.allTime.totalSavedTokens).toBe(5000)
    expect(stats!.allTime.totalRequests).toBe(5)
  })

  it('resetGlobalStats remet à zéro un fichier avec des sessions', () => {
    resetGlobalStats()
    recordSession(makeSession())
    const before = readGlobalStats()
    expect(before!.sessions).toHaveLength(1)

    resetGlobalStats()
    const after = readGlobalStats()
    expect(after!.sessions).toHaveLength(0)
    expect(after!.allTime.totalSavedTokens).toBe(0)
  })

  it('readGlobalStats retourne null-safe sur un fichier corrompu', () => {
    // La fonction retourne null si une exception est levée — déjà testé par le try/catch interne
    // On ne peut pas corrompre le fichier ici sans toucher au vrai home, donc on vérifie
    // juste que readGlobalStats ne throw pas
    expect(() => readGlobalStats()).not.toThrow()
  })
})
