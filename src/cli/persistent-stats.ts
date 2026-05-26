/**
 * Persistent stats — sauvegarde les économies dans ~/.cork-ai/stats.json.
 * Permet à `cork-ai gain` d'afficher les stats globales entre sessions.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

const GLOBAL_DIR = path.join(os.homedir(), '.cork-ai')
const STATS_FILE = path.join(GLOBAL_DIR, 'stats.json')

export interface GlobalStats {
  version: string
  createdAt: string
  updatedAt: string
  allTime: {
    totalRequests: number
    totalOriginalTokens: number
    totalCompressedTokens: number
    totalSavedTokens: number
    estimatedCostSaved: number
  }
  sessions: SessionRecord[]
}

export interface SessionRecord {
  sessionId: string
  startedAt: string
  endedAt: string
  requests: number
  originalTokens: number
  compressedTokens: number
  savedTokens: number
  savingsPercent: number
  estimatedCostSaved: number
  byModule: Record<string, number>
}

function ensureDir(): void {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true })
}

function loadStats(): GlobalStats {
  try {
    const data = fs.readFileSync(STATS_FILE, 'utf-8')
    return JSON.parse(data) as GlobalStats
  } catch {
    return {
      version: '1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      allTime: {
        totalRequests: 0,
        totalOriginalTokens: 0,
        totalCompressedTokens: 0,
        totalSavedTokens: 0,
        estimatedCostSaved: 0,
      },
      sessions: [],
    }
  }
}

function saveStats(stats: GlobalStats): void {
  ensureDir()
  stats.updatedAt = new Date().toISOString()
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8')
}

/**
 * Enregistre une session terminée dans les stats globales.
 */
export function recordSession(session: Omit<SessionRecord, 'sessionId'>): void {
  const stats = loadStats()
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const record: SessionRecord = { sessionId, ...session }

  stats.sessions.push(record)
  // Garder les 100 dernières sessions
  if (stats.sessions.length > 100) {
    stats.sessions = stats.sessions.slice(-100)
  }

  stats.allTime.totalRequests += session.requests
  stats.allTime.totalOriginalTokens += session.originalTokens
  stats.allTime.totalCompressedTokens += session.compressedTokens
  stats.allTime.totalSavedTokens += session.savedTokens
  stats.allTime.estimatedCostSaved += session.estimatedCostSaved

  saveStats(stats)
}

/**
 * Lit les stats globales depuis le fichier persistant.
 */
export function readGlobalStats(): GlobalStats | null {
  try {
    return loadStats()
  } catch {
    return null
  }
}

/**
 * Remet les stats à zéro.
 */
export function resetGlobalStats(): void {
  ensureDir()
  const fresh: GlobalStats = {
    version: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    allTime: {
      totalRequests: 0,
      totalOriginalTokens: 0,
      totalCompressedTokens: 0,
      totalSavedTokens: 0,
      estimatedCostSaved: 0,
    },
    sessions: [],
  }
  fs.writeFileSync(STATS_FILE, JSON.stringify(fresh, null, 2), 'utf-8')
}

export { GLOBAL_DIR, STATS_FILE }
