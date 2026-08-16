import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// persistent-stats reads CORK_AI_HOME once, at module load. Test files run in
// parallel and would otherwise fight over the shared home vitest.config.ts
// sets, so this suite points the variable at a private directory and imports
// the module afterwards, through vi.resetModules().
let HOME: string
let STATS_FILE: string
let previousHome: string | undefined
let readGlobalStats: typeof import('../../src/cli/persistent-stats.js')['readGlobalStats']
let STATS_VERSION: string

async function loadModule(): Promise<void> {
  vi.resetModules()
  const mod = await import('../../src/cli/persistent-stats.js')
  readGlobalStats = mod.readGlobalStats
  STATS_VERSION = mod.STATS_VERSION
}

/**
 * A v1 file as written by v0.4.1 and earlier: Opus 5 savings priced at the
 * legacy $15/M Opus rule instead of $5/M.
 */
function writeV1Stats(): void {
  fs.mkdirSync(HOME, { recursive: true })
  const opusModelUsage = {
    requests: 10,
    originalTokens: 1_200_000,
    savedTokens: 1_000_000,
    costSaved: 15, // 1M × $15/M — the bug
    lastUsedAt: new Date().toISOString(),
  }
  fs.writeFileSync(
    STATS_FILE,
    JSON.stringify({
      version: '1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      allTime: {
        totalRequests: 10,
        totalOriginalTokens: 1_200_000,
        totalCompressedTokens: 200_000,
        totalSavedTokens: 1_000_000,
        estimatedCostSaved: 15,
        byModel: { 'claude-opus-5': { ...opusModelUsage } },
      },
      sessions: [
        {
          sessionId: 'sess-1',
          projectPath: '/tmp/p',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          requests: 10,
          originalTokens: 1_200_000,
          compressedTokens: 200_000,
          savedTokens: 1_000_000,
          savingsPercent: 83.3,
          estimatedCostSaved: 15,
          byModule: {},
          byModel: { 'claude-opus-5': { ...opusModelUsage } },
        },
      ],
    }),
    'utf-8',
  )
}

beforeEach(async () => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-migration-'))
  STATS_FILE = path.join(HOME, 'stats.json')
  previousHome = process.env.CORK_AI_HOME
  process.env.CORK_AI_HOME = HOME
  writeV1Stats()
  await loadModule()
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.CORK_AI_HOME
  else process.env.CORK_AI_HOME = previousHome
  fs.rmSync(HOME, { recursive: true, force: true })
})

describe('migration stats v1 → v2 (reprise du tarif Opus 5)', () => {
  it('repricifie Opus 5 à $5/M au lieu du tarif legacy $15/M', () => {
    const stats = readGlobalStats()!
    expect(stats.version).toBe(STATS_VERSION)
    expect(stats.allTime.byModel!['claude-opus-5'].costSaved).toBeCloseTo(5)
    expect(stats.allTime.estimatedCostSaved).toBeCloseTo(5)
    expect(stats.sessions[0].estimatedCostSaved).toBeCloseTo(5)
  })

  it('ne touche à aucun compteur de tokens', () => {
    const stats = readGlobalStats()!
    expect(stats.allTime.totalSavedTokens).toBe(1_000_000)
    expect(stats.allTime.totalOriginalTokens).toBe(1_200_000)
    expect(stats.allTime.byModel!['claude-opus-5'].savedTokens).toBe(1_000_000)
  })

  it('écrit une sauvegarde de la version précédente', () => {
    readGlobalStats()
    const backup = `${STATS_FILE}.v1.bak`
    expect(fs.existsSync(backup)).toBe(true)
    expect(JSON.parse(fs.readFileSync(backup, 'utf-8')).version).toBe('1')
  })

  it('persiste la migration — la deuxième lecture ne remigre pas', () => {
    readGlobalStats()
    const onDisk = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'))
    expect(onDisk.version).toBe(STATS_VERSION)
    // Une remigration repartirait de $5 et ne changerait plus rien, mais la
    // sauvegarde .v2.bak trahirait un second passage.
    readGlobalStats()
    expect(fs.existsSync(`${STATS_FILE}.v2.bak`)).toBe(false)
  })

  it('déduit la pénalité de re-read au prix corrigé', () => {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'))
    raw.allTime.reReadTokensServed = 200_000
    raw.sessions[0].reReadTokensServed = 200_000
    fs.writeFileSync(STATS_FILE, JSON.stringify(raw), 'utf-8')

    const stats = readGlobalStats()!
    // 1M × $5/M brut − 200k × $5/M de pénalité = $4
    expect(stats.allTime.estimatedCostSaved).toBeCloseTo(4)
  })
})
