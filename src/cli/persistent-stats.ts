/**
 * Persistent stats — saves savings to ~/.cork-ai/stats.json.
 * Allows `cork-ai gain` and `cork-ai report` to display global stats.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

const GLOBAL_DIR = path.join(os.homedir(), '.cork-ai')
const STATS_FILE = path.join(GLOBAL_DIR, 'stats.json')

export interface ModelUsage {
  requests: number
  originalTokens: number
  savedTokens: number
  costSaved: number
  lastUsedAt: string
}

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
    byModel?: Record<string, ModelUsage>
  }
  sessions: SessionRecord[]
}

export interface SessionRecord {
  sessionId: string
  projectPath?: string
  startedAt: string
  endedAt: string
  requests: number
  originalTokens: number
  compressedTokens: number
  savedTokens: number
  savingsPercent: number
  estimatedCostSaved: number
  byModule: Record<string, number>
  byModel?: Record<string, ModelUsage>
}

export interface ProjectStats {
  projectPath: string
  projectName: string
  sessionCount: number
  totalRequests: number
  totalOriginalTokens: number
  totalSavedTokens: number
  totalCostSaved: number
  avgSavingsPercent: number
  lastSessionAt: string
}

export interface PeriodBucket {
  label: string        // "2026-05-26", "2026-W21", "2026-05"
  sessionCount: number
  totalOriginalTokens: number
  totalSavedTokens: number
  totalCostSaved: number
  avgSavingsPercent: number
}

export interface ModelStats {
  model: string
  requests: number
  requestShare: number       // 0-100, share of all requests
  originalTokens: number
  savedTokens: number
  costSaved: number
  lastUsedAt: string
}

export interface ForecastStats {
  basedOnDays: number
  avgDailyTokensSaved: number
  avgDailyCostSaved: number
  projectedAnnualTokensSaved: number
  projectedAnnualCostSaved: number
  projectedMonthlyTokensSaved: number
  projectedMonthlyCostSaved: number
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

// ─── Write (completed sessions) ────────────────────────────────────────────────────────────

function mergeByModel(
  target: Record<string, ModelUsage> | undefined,
  source: Record<string, ModelUsage> | undefined,
): Record<string, ModelUsage> {
  const merged: Record<string, ModelUsage> = { ...(target ?? {}) }
  for (const [model, usage] of Object.entries(source ?? {})) {
    const existing = merged[model]
    if (existing) {
      existing.requests += usage.requests
      existing.originalTokens += usage.originalTokens
      existing.savedTokens += usage.savedTokens
      existing.costSaved += usage.costSaved
      if (usage.lastUsedAt > existing.lastUsedAt) existing.lastUsedAt = usage.lastUsedAt
    } else {
      merged[model] = { ...usage }
    }
  }
  return merged
}

export function recordSession(session: Omit<SessionRecord, 'sessionId'>): void {
  const stats = loadStats()
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const record: SessionRecord = { sessionId, ...session }

  stats.sessions.push(record)
  if (stats.sessions.length > 500) {
    stats.sessions = stats.sessions.slice(-500)
  }

  stats.allTime.totalRequests += session.requests
  stats.allTime.totalOriginalTokens += session.originalTokens
  stats.allTime.totalCompressedTokens += session.compressedTokens
  stats.allTime.totalSavedTokens += session.savedTokens
  stats.allTime.estimatedCostSaved += session.estimatedCostSaved
  stats.allTime.byModel = mergeByModel(stats.allTime.byModel, session.byModel)

  saveStats(stats)
}

export function readGlobalStats(): GlobalStats | null {
  try { return loadStats() } catch { return null }
}

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
      byModel: {},
    },
    sessions: [],
  }
  fs.writeFileSync(STATS_FILE, JSON.stringify(fresh, null, 2), 'utf-8')
}

// ─── Live session (aggregates all hook calls for a session) ──────────────────

export interface LiveSession {
  sessionId: string
  projectPath: string
  startedAt: string
  lastActivityAt: string
  requests: number
  originalTokens: number
  compressedTokens: number
  savedTokens: number
  estimatedCostSaved: number
  byModule: Record<string, number>
  byModel?: Record<string, ModelUsage>
}

export const LIVE_SESSION_FILE = path.join(GLOBAL_DIR, 'live-session.json')
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000  // 2h of inactivity = new session

export function readLiveSession(): LiveSession | null {
  try {
    const data = JSON.parse(fs.readFileSync(LIVE_SESSION_FILE, 'utf-8')) as LiveSession
    const elapsed = Date.now() - new Date(data.lastActivityAt).getTime()
    return elapsed <= SESSION_TIMEOUT_MS ? data : null
  } catch {
    return null
  }
}

function flushLiveSessionToHistory(live: LiveSession): void {
  const stats = loadStats()
  const savingsPercent = live.originalTokens > 0
    ? (live.savedTokens / live.originalTokens) * 100 : 0

  stats.sessions.push({
    sessionId: live.sessionId,
    projectPath: live.projectPath,
    startedAt: live.startedAt,
    endedAt: live.lastActivityAt,
    requests: live.requests,
    originalTokens: live.originalTokens,
    compressedTokens: live.compressedTokens,
    savedTokens: live.savedTokens,
    savingsPercent,
    estimatedCostSaved: live.estimatedCostSaved,
    byModule: live.byModule,
    byModel: live.byModel,
  })
  if (stats.sessions.length > 500) stats.sessions = stats.sessions.slice(-500)

  stats.allTime.totalRequests += live.requests
  stats.allTime.totalOriginalTokens += live.originalTokens
  stats.allTime.totalCompressedTokens += live.compressedTokens
  stats.allTime.totalSavedTokens += live.savedTokens
  stats.allTime.estimatedCostSaved += live.estimatedCostSaved
  stats.allTime.byModel = mergeByModel(stats.allTime.byModel, live.byModel)

  saveStats(stats)
}

export function accumulateInSession(event: {
  projectPath: string
  originalTokens: number
  compressedTokens: number
  savedTokens: number
  estimatedCostSaved: number
  byModule: Record<string, number>
  model?: string
}): void {
  ensureDir()

  const now = new Date().toISOString()
  const eventByModel: Record<string, ModelUsage> | undefined = event.model
    ? {
        [event.model]: {
          requests: 1,
          originalTokens: event.originalTokens,
          savedTokens: event.savedTokens,
          costSaved: event.estimatedCostSaved,
          lastUsedAt: now,
        },
      }
    : undefined

  let live: LiveSession | null = null
  try {
    const existing = JSON.parse(fs.readFileSync(LIVE_SESSION_FILE, 'utf-8')) as LiveSession
    const elapsed = Date.now() - new Date(existing.lastActivityAt).getTime()
    if (elapsed <= SESSION_TIMEOUT_MS && existing.projectPath === event.projectPath) {
      live = existing
    } else {
      // Expired session or different project: flush before creating a new one
      flushLiveSessionToHistory(existing)
    }
  } catch { /* no existing live session */ }

  if (live) {
    live.lastActivityAt = now
    live.requests++
    live.originalTokens += event.originalTokens
    live.compressedTokens += event.compressedTokens
    live.savedTokens += event.savedTokens
    live.estimatedCostSaved += event.estimatedCostSaved
    for (const [mod, saved] of Object.entries(event.byModule)) {
      live.byModule[mod] = (live.byModule[mod] ?? 0) + saved
    }
    live.byModel = mergeByModel(live.byModel, eventByModel)
  } else {
    live = {
      sessionId: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      projectPath: event.projectPath,
      startedAt: now,
      lastActivityAt: now,
      requests: 1,
      originalTokens: event.originalTokens,
      compressedTokens: event.compressedTokens,
      savedTokens: event.savedTokens,
      estimatedCostSaved: event.estimatedCostSaved,
      byModule: { ...event.byModule },
      byModel: eventByModel,
    }
  }

  fs.writeFileSync(LIVE_SESSION_FILE, JSON.stringify(live, null, 2), 'utf-8')
}

export function clearLiveSession(): void {
  try { fs.unlinkSync(LIVE_SESSION_FILE) } catch { /* no session to clear */ }
}

// ─── Aggregations ─────────────────────────────────────────────────────────────

export function getStatsByProject(stats: GlobalStats): ProjectStats[] {
  const map = new Map<string, ProjectStats>()

  for (const s of stats.sessions) {
    const p = s.projectPath || 'unknown'
    const name = p === 'unknown' ? 'Unknown project' : path.basename(p)
    const existing = map.get(p)

    if (!existing) {
      map.set(p, {
        projectPath: p,
        projectName: name,
        sessionCount: 1,
        totalRequests: s.requests,
        totalOriginalTokens: s.originalTokens,
        totalSavedTokens: s.savedTokens,
        totalCostSaved: s.estimatedCostSaved,
        avgSavingsPercent: s.savingsPercent,
        lastSessionAt: s.startedAt,
      })
    } else {
      existing.sessionCount++
      existing.totalRequests += s.requests
      existing.totalOriginalTokens += s.originalTokens
      existing.totalSavedTokens += s.savedTokens
      existing.totalCostSaved += s.estimatedCostSaved
      existing.avgSavingsPercent =
        (existing.avgSavingsPercent * (existing.sessionCount - 1) + s.savingsPercent) /
        existing.sessionCount
      if (s.startedAt > existing.lastSessionAt) existing.lastSessionAt = s.startedAt
    }
  }

  return Array.from(map.values()).sort((a, b) => b.totalSavedTokens - a.totalSavedTokens)
}

export function getStatsByModel(stats: GlobalStats | null, live?: LiveSession | null): ModelStats[] {
  const merged = mergeByModel(
    mergeByModel(undefined, stats?.allTime.byModel),
    live?.byModel,
  )
  const totalRequests = Object.values(merged).reduce((s, u) => s + u.requests, 0)
  if (totalRequests === 0) return []

  return Object.entries(merged)
    .map(([model, u]) => ({
      model,
      requests: u.requests,
      requestShare: (u.requests / totalRequests) * 100,
      originalTokens: u.originalTokens,
      savedTokens: u.savedTokens,
      costSaved: u.costSaved,
      lastUsedAt: u.lastUsedAt,
    }))
    .sort((a, b) => b.requests - a.requests)
}

function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

function sessionLabel(s: SessionRecord, period: 'day' | 'week' | 'month'): string {
  const d = new Date(s.startedAt)
  if (period === 'day') return d.toISOString().slice(0, 10)
  if (period === 'week') return isoWeek(d)
  return d.toISOString().slice(0, 7)
}

export function getStatsByPeriod(
  stats: GlobalStats,
  period: 'day' | 'week' | 'month',
  lookback = 30,
): PeriodBucket[] {
  const cutoff = new Date()
  if (period === 'day') cutoff.setDate(cutoff.getDate() - lookback)
  else if (period === 'week') cutoff.setDate(cutoff.getDate() - lookback * 7)
  else cutoff.setMonth(cutoff.getMonth() - lookback)

  const map = new Map<string, PeriodBucket>()

  for (const s of stats.sessions) {
    if (new Date(s.startedAt) < cutoff) continue
    const label = sessionLabel(s, period)
    const existing = map.get(label)

    if (!existing) {
      map.set(label, {
        label,
        sessionCount: 1,
        totalOriginalTokens: s.originalTokens,
        totalSavedTokens: s.savedTokens,
        totalCostSaved: s.estimatedCostSaved,
        avgSavingsPercent: s.savingsPercent,
      })
    } else {
      existing.sessionCount++
      existing.totalOriginalTokens += s.originalTokens
      existing.totalSavedTokens += s.savedTokens
      existing.totalCostSaved += s.estimatedCostSaved
      existing.avgSavingsPercent =
        (existing.avgSavingsPercent * (existing.sessionCount - 1) + s.savingsPercent) /
        existing.sessionCount
    }
  }

  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label))
}

export function getForecast(stats: GlobalStats): ForecastStats {
  if (stats.sessions.length === 0) {
    return {
      basedOnDays: 0,
      avgDailyTokensSaved: 0,
      avgDailyCostSaved: 0,
      projectedAnnualTokensSaved: 0,
      projectedAnnualCostSaved: 0,
      projectedMonthlyTokensSaved: 0,
      projectedMonthlyCostSaved: 0,
    }
  }

  // Use last 30 days of data for forecast
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  const recent = stats.sessions.filter(s => new Date(s.startedAt) >= cutoff)
  const sample = recent.length > 0 ? recent : stats.sessions

  const totalSaved = sample.reduce((s, r) => s + r.savedTokens, 0)
  const totalCost = sample.reduce((s, r) => s + r.estimatedCostSaved, 0)

  const oldest = new Date(sample[0].startedAt)
  const newest = new Date(sample[sample.length - 1].startedAt)
  const spanDays = Math.max(1, Math.ceil((newest.getTime() - oldest.getTime()) / 86400000) + 1)

  const avgDailyTokensSaved = totalSaved / spanDays
  const avgDailyCostSaved = totalCost / spanDays

  return {
    basedOnDays: spanDays,
    avgDailyTokensSaved,
    avgDailyCostSaved,
    projectedAnnualTokensSaved: avgDailyTokensSaved * 365,
    projectedAnnualCostSaved: avgDailyCostSaved * 365,
    projectedMonthlyTokensSaved: avgDailyTokensSaved * 30,
    projectedMonthlyCostSaved: avgDailyCostSaved * 30,
  }
}

export { GLOBAL_DIR, STATS_FILE }
