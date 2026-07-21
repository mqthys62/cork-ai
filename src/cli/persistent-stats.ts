/**
 * Persistent stats — saves savings to ~/.cork-ai/stats.json.
 * Allows `cork-ai gain` and `cork-ai report` to display global stats.
 *
 * Two kinds of numbers, never mixed:
 *   - estimated*: computed from local token counts before sending
 *   - measured:   ground truth from the API's response.usage (wrapClient path)
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { MeasuredUsageStats } from '../types/index.js'

// CORK_AI_HOME overrides the data directory (tests isolate through it —
// without it, every `npm test` run would clobber the user's real stats).
const GLOBAL_DIR = process.env.CORK_AI_HOME ?? path.join(os.homedir(), '.cork-ai')
const STATS_FILE = path.join(GLOBAL_DIR, 'stats.json')
const LIVE_DIR = path.join(GLOBAL_DIR, 'live')

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
    /** Ground truth accumulated from wrapClient sessions (response.usage) */
    measured?: MeasuredUsageStats
    /** Re-reads of files already compressed by the hook (compression harm signal) */
    reReads?: number
    /** Raw tokens served on those re-reads (induced cost, already deducted from savings) */
    reReadTokensServed?: number
    /** Edits that failed on a file only seen compressed (old_string missing from signatures) */
    editFailuresAfterCompression?: number
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
  measured?: MeasuredUsageStats
  reReads?: number
  reReadTokensServed?: number
  editFailuresAfterCompression?: number
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

function mergeMeasured(
  target: MeasuredUsageStats | undefined,
  source: MeasuredUsageStats | undefined,
): MeasuredUsageStats | undefined {
  if (!source) return target
  if (!target) return { ...source }
  return {
    requests: target.requests + source.requests,
    inputTokens: target.inputTokens + source.inputTokens,
    outputTokens: target.outputTokens + source.outputTokens,
    cacheCreationInputTokens: target.cacheCreationInputTokens + source.cacheCreationInputTokens,
    cacheReadInputTokens: target.cacheReadInputTokens + source.cacheReadInputTokens,
    costUSD: target.costUSD + source.costUSD,
  }
}

function applySessionToAllTime(stats: GlobalStats, session: SessionRecord): void {
  stats.allTime.totalRequests += session.requests
  stats.allTime.totalOriginalTokens += session.originalTokens
  stats.allTime.totalCompressedTokens += session.compressedTokens
  stats.allTime.totalSavedTokens += session.savedTokens
  stats.allTime.estimatedCostSaved += session.estimatedCostSaved
  stats.allTime.byModel = mergeByModel(stats.allTime.byModel, session.byModel)
  stats.allTime.measured = mergeMeasured(stats.allTime.measured, session.measured)
  if (session.reReads) stats.allTime.reReads = (stats.allTime.reReads ?? 0) + session.reReads
  if (session.reReadTokensServed) {
    stats.allTime.reReadTokensServed = (stats.allTime.reReadTokensServed ?? 0) + session.reReadTokensServed
  }
  if (session.editFailuresAfterCompression) {
    stats.allTime.editFailuresAfterCompression =
      (stats.allTime.editFailuresAfterCompression ?? 0) + session.editFailuresAfterCompression
  }
}

export function recordSession(session: Omit<SessionRecord, 'sessionId'>): void {
  const stats = loadStats()
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const record: SessionRecord = { sessionId, ...session }

  stats.sessions.push(record)
  if (stats.sessions.length > 500) {
    stats.sessions = stats.sessions.slice(-500)
  }

  applySessionToAllTime(stats, record)
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

// ─── Live sessions (one file per Claude Code session_id) ─────────────────────

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
  reReads?: number
  reReadTokensServed?: number
  editFailuresAfterCompression?: number
}

/** Legacy single-file location (pre-session_id versions) — still flushed/read. */
export const LIVE_SESSION_FILE = path.join(GLOBAL_DIR, 'live-session.json')
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000  // 2h of inactivity = session over

function liveFileFor(sessionId: string): string {
  // session_id is a UUID from Claude Code — sanitize defensively anyway
  const safe = sessionId.replace(/[^\w.-]/g, '_').slice(0, 80)
  return path.join(LIVE_DIR, `${safe}.json`)
}

function isExpired(live: LiveSession): boolean {
  return Date.now() - new Date(live.lastActivityAt).getTime() > SESSION_TIMEOUT_MS
}

function readLiveFile(file: string): LiveSession | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as LiveSession
  } catch {
    return null
  }
}

/** All live session files (legacy single file included), expired or not. */
function listLiveFiles(): string[] {
  const files: string[] = []
  try {
    for (const entry of fs.readdirSync(LIVE_DIR)) {
      // "reads-<sessionId>.json" tracks re-reads (see index.ts SessionReads) —
      // a different shape, not a LiveSession; skip it here.
      if (entry.endsWith('.json') && !entry.startsWith('reads-')) files.push(path.join(LIVE_DIR, entry))
    }
  } catch { /* no live dir yet */ }
  if (fs.existsSync(LIVE_SESSION_FILE)) files.push(LIVE_SESSION_FILE)
  return files
}

/** Flushes every expired live session into history and deletes its file. */
function flushExpiredLiveSessions(): void {
  for (const file of listLiveFiles()) {
    const live = readLiveFile(file)
    if (!live) { try { fs.unlinkSync(file) } catch { /* already gone */ } ; continue }
    if (isExpired(live)) {
      flushLiveSessionToHistory(live)
      try { fs.unlinkSync(file) } catch { /* already gone */ }
    }
  }
}

/** All currently-active live sessions, most recent activity first. */
export function readActiveLiveSessions(): LiveSession[] {
  const actives: LiveSession[] = []
  for (const file of listLiveFiles()) {
    const live = readLiveFile(file)
    if (live && !isExpired(live)) actives.push(live)
  }
  return actives.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
}

/** Most recently active live session (display convenience), or null. */
export function readLiveSession(): LiveSession | null {
  return readActiveLiveSessions()[0] ?? null
}

function flushLiveSessionToHistory(live: LiveSession): void {
  const stats = loadStats()
  const savingsPercent = live.originalTokens > 0
    ? (live.savedTokens / live.originalTokens) * 100 : 0

  const record: SessionRecord = {
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
    reReads: live.reReads,
    reReadTokensServed: live.reReadTokensServed,
    editFailuresAfterCompression: live.editFailuresAfterCompression,
  }
  stats.sessions.push(record)
  if (stats.sessions.length > 500) stats.sessions = stats.sessions.slice(-500)

  applySessionToAllTime(stats, record)
  saveStats(stats)
}

export interface SessionEvent {
  projectPath: string
  originalTokens: number
  compressedTokens: number
  savedTokens: number
  estimatedCostSaved: number
  byModule: Record<string, number>
  model?: string
  /** Claude Code session_id — one live file per session, no cross-flushing */
  sessionId?: string
  /** This event is a re-read of an already-compressed file (served raw) */
  reRead?: boolean
  /** Raw tokens served on the re-read (induced cost) */
  reReadTokensServed?: number
  /** This event is an Edit failure on a file only seen compressed */
  editFailure?: boolean
}

export function accumulateInSession(event: SessionEvent): void {
  ensureDir()
  fs.mkdirSync(LIVE_DIR, { recursive: true })

  // Opportunistic cleanup: flush sessions that ended (no hook fires at session end)
  flushExpiredLiveSessions()

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

  const file = event.sessionId ? liveFileFor(event.sessionId) : LIVE_SESSION_FILE
  let live = readLiveFile(file)

  // Same file but expired (long-idle session) or, on the legacy single-file
  // path, a different project: flush and start fresh.
  if (live && (isExpired(live) || (!event.sessionId && live.projectPath !== event.projectPath))) {
    flushLiveSessionToHistory(live)
    live = null
  }

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
    if (event.reRead) {
      live.reReads = (live.reReads ?? 0) + 1
      live.reReadTokensServed = (live.reReadTokensServed ?? 0) + (event.reReadTokensServed ?? 0)
    }
    if (event.editFailure) {
      live.editFailuresAfterCompression = (live.editFailuresAfterCompression ?? 0) + 1
    }
  } else {
    live = {
      sessionId: event.sessionId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
      ...(event.reRead
        ? { reReads: 1, reReadTokensServed: event.reReadTokensServed ?? 0 }
        : {}),
      ...(event.editFailure ? { editFailuresAfterCompression: 1 } : {}),
    }
  }

  fs.writeFileSync(file, JSON.stringify(live, null, 2), 'utf-8')
}

export function clearLiveSession(): void {
  for (const file of listLiveFiles()) {
    try { fs.unlinkSync(file) } catch { /* no session to clear */ }
  }
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
        avgSavingsPercent: 0, // computed below, token-weighted
        lastSessionAt: s.startedAt,
      })
    } else {
      existing.sessionCount++
      existing.totalRequests += s.requests
      existing.totalOriginalTokens += s.originalTokens
      existing.totalSavedTokens += s.savedTokens
      existing.totalCostSaved += s.estimatedCostSaved
      if (s.startedAt > existing.lastSessionAt) existing.lastSessionAt = s.startedAt
    }
  }

  // Token-weighted savings: Σsaved / Σoriginal — a 200-token session must not
  // weigh as much as a 2M-token one (the old per-session arithmetic mean did).
  for (const p of map.values()) {
    p.avgSavingsPercent = p.totalOriginalTokens > 0
      ? (p.totalSavedTokens / p.totalOriginalTokens) * 100
      : 0
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
        avgSavingsPercent: 0, // computed below, token-weighted
      })
    } else {
      existing.sessionCount++
      existing.totalOriginalTokens += s.originalTokens
      existing.totalSavedTokens += s.savedTokens
      existing.totalCostSaved += s.estimatedCostSaved
    }
  }

  for (const b of map.values()) {
    b.avgSavingsPercent = b.totalOriginalTokens > 0
      ? (b.totalSavedTokens / b.totalOriginalTokens) * 100
      : 0
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
  let recent = stats.sessions.filter(s => new Date(s.startedAt) >= cutoff)

  // The current day is incomplete — including it deflates the daily average
  // (e.g. at 9am today only counts a third of a day's savings but a full day
  // in the span). Exclude it whenever older data exists.
  const today = new Date().toISOString().slice(0, 10)
  const beforeToday = recent.filter(s => s.startedAt.slice(0, 10) < today)
  if (beforeToday.length > 0) recent = beforeToday

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

export { GLOBAL_DIR, STATS_FILE, LIVE_DIR }
