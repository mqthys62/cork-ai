/**
 * What cork-ai has saved, valued honestly, and the anonymous snapshot of it
 * that telemetry sends once a day when the user has opted in.
 *
 * The savings maths used to live in the CLI entry point; it moved here so the
 * SessionEnd hook (through a detached child) and `cork-ai telemetry preview`
 * can build the same figures `gain --all` prints.
 */

import fs from 'fs'
import { readGlobalStats, readActiveLiveSessions, type SessionRecord, type ModelUsage } from './persistent-stats.js'
import { inputPriceForModel, costOfAvoidedTokens } from '../pricing/index.js'
import { sessionAmplification, sessionReReadTurns, scanAllTranscripts, contextReport } from './transcript-usage.js'
import { loadConfig, updateConfig, isTelemetryEnabled, installId, CORK_HOME } from './config.js'
import { loadClaudeSettings, installedCorkHooks } from './claude-settings.js'
import { readHeartbeat } from './heartbeat.js'
import { contextBucket, costBucket, modelFamily, capturePayload, postCapture, type TelemetryEvent } from './telemetry.js'
import { DEFAULT_BANDS } from './context-guard.js'
import { VERSION } from './version.js'

/**
 * USD already deducted from the displayed savings by re-reads.
 *
 * `estimatedCostSaved` is stored net: every re-read subtracted
 * `rawTokens × inputPrice(model)` at the time it happened. Only the token
 * volume survives in the stats file, so the penalty is reconstructed per
 * session at that session's own model price — sessions are effectively
 * single-model, which keeps this faithful to what was originally deducted.
 */
export interface LifetimeSavings {
  /** What cork-ai reported before: every saved token valued once at 1× input. */
  firstPass: number
  /** Cache write + one cache read per subsequent turn, per the transcripts. */
  lifetime: number
  /** Re-read cost, valued on the same lifetime basis (raw tokens re-injected). */
  penalty: number
  /** Real cost of the assistant turns that issued a re-read: the extra API round trip each one is. */
  extraTurnPenalty: number
  /** Re-read turns found in the transcripts. */
  extraTurns: number
  /** Sessions whose transcript was found, over sessions considered. */
  measured: number
  total: number
  /** Median amplification across measured sessions — the headline multiplier. */
  medianAmplification: number
  compactions: number
}

/**
 * Values saved tokens over their life in context rather than on first send.
 *
 * The hook cannot do this at write time: when it fires, the session is still
 * running and the number of turns that will re-read the context is unknowable.
 * The transcript knows after the fact, and `SessionRecord.sessionId` is the
 * transcript's filename, so the two join with no stored schema change.
 *
 * Sessions with no transcript fall back to the first-pass value and are
 * excluded from `measured` so partial coverage stays visible.
 */
export function lifetimeSavings(
  sessions: Array<{ sessionId: string; byModel?: Record<string, ModelUsage>; reReadTokensServed?: number }>,
): LifetimeSavings {
  const out: LifetimeSavings = {
    firstPass: 0,
    lifetime: 0,
    penalty: 0,
    extraTurnPenalty: 0,
    extraTurns: 0,
    measured: 0,
    total: 0,
    medianAmplification: 0,
    compactions: 0,
  }
  // cork-ai flushes a SessionRecord per activity window, so one Claude Code
  // session can produce several records. Amplification and compaction counts
  // are properties of the transcript, so they are gathered once per session id
  // — counting a 1000-turn session nine times would drag the median with it.
  const ampBySession = new Map<string, number>()
  const cache = new Map<string, ReturnType<typeof sessionAmplification>>()
  const seenSessions = new Set<string>()

  for (const session of sessions) {
    const models = Object.entries(session.byModel ?? {})
    if (models.length === 0) continue
    seenSessions.add(session.sessionId)

    let amp = cache.get(session.sessionId)
    if (!amp) {
      amp = sessionAmplification(session.sessionId)
      cache.set(session.sessionId, amp)
      if (amp.found && amp.cacheWriteTokens > 0) {
        out.compactions += amp.compactions
        ampBySession.set(session.sessionId, amp.amplification)
      }
      // The turn that re-reads a compressed file exists only because of the
      // compression: bill it at its real, transcript-recorded cost. The
      // token-based penalty below never saw this — it counted the raw file
      // being re-sent, not the whole context being re-read once more.
      const turns = sessionReReadTurns(session.sessionId)
      if (turns.found) {
        out.extraTurnPenalty += turns.extraTurnCostUSD
        out.extraTurns += turns.reReads
      }
    }
    // No transcript → amplification 0, which collapses costOfAvoidedTokens()
    // to the cache-write tier: close to the old 1× figure, never inflated.
    const factor = amp.found ? amp.amplification : 0

    let saved = 0
    let weightedPrice = 0
    let totalTokens = 0
    for (const [, usage] of models) totalTokens += usage.savedTokens

    for (const [model, usage] of models) {
      out.firstPass += (usage.savedTokens / 1_000_000) * inputPriceForModel(model)
      saved += costOfAvoidedTokens(usage.savedTokens, model, factor)
      if (totalTokens > 0) {
        weightedPrice += inputPriceForModel(model) * (usage.savedTokens / totalTokens)
      }
    }
    out.lifetime += saved

    // Symmetric treatment: a re-read puts raw content back into the context and
    // is re-billed every subsequent turn exactly like anything else. Valuing it
    // at 1× while savings run at the lifetime rate would bias the net in
    // cork-ai's favour.
    const reRead = session.reReadTokensServed ?? 0
    if (reRead > 0 && weightedPrice > 0) {
      const model = models.sort((a, b) => b[1].savedTokens - a[1].savedTokens)[0][0]
      out.penalty += costOfAvoidedTokens(reRead, model, factor)
    }
  }

  out.measured = ampBySession.size
  out.total = seenSessions.size

  const sorted = [...ampBySession.values()].sort((a, b) => a - b)
  if (sorted.length > 0) {
    const mid = Math.floor(sorted.length / 2)
    out.medianAmplification =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  }
  return out
}

export function reReadPenalty(stats: { sessions: SessionRecord[] } | null | undefined): number {
  if (!stats) return 0
  let total = 0
  for (const session of stats.sessions) {
    const served = session.reReadTokensServed ?? 0
    if (served <= 0) continue
    const model = Object.entries(session.byModel ?? {})
      .sort((a, b) => b[1].requests - a[1].requests)[0]?.[0]
    total += (served / 1_000_000) * inputPriceForModel(model)
  }
  return total
}

// ─── Telemetry snapshot ───────────────────────────────────────────────────────

/** At most one snapshot per day per install, whatever triggers it. */
export const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000

export type SnapshotReason = 'session_end' | 'gain' | 'install' | 'telemetry_on' | 'preview'

const usd = (n: number): number => Math.round(n * 10_000) / 10_000
const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 100) : 0)

/**
 * The anonymous aggregate of everything cork-ai has measured on this machine.
 *
 * Exact figures are sent for what cork-ai itself produced (tokens kept out of
 * context, what they were worth, re-reads) — an aggregate over weeks of work
 * cannot identify a file or a project. What the user spends stays a bucket:
 * a bill is personal, a saving is a product metric.
 */
export function buildSavingsSnapshot(reason: SnapshotReason, now: Date = new Date()): TelemetryEvent {
  const stats = readGlobalStats()
  const live = readActiveLiveSessions()
  const records: Array<{ sessionId: string; byModel?: Record<string, ModelUsage>; reReadTokensServed?: number }> = [...(stats?.sessions ?? []), ...live]

  const requests = (stats?.allTime.totalRequests ?? 0) + live.reduce((s, l) => s + (l.requests ?? 0), 0)
  const rawTokens = (stats?.allTime.totalOriginalTokens ?? 0) + live.reduce((s, l) => s + (l.originalTokens ?? 0), 0)
  const savedTokens = (stats?.allTime.totalSavedTokens ?? 0) + live.reduce((s, l) => s + (l.savedTokens ?? 0), 0)
  const reReads = (stats?.allTime.reReads ?? 0) + live.reduce((s, l) => s + (l.reReads ?? 0), 0)
  const reReadTokens = (stats?.allTime.reReadTokensServed ?? 0) + live.reduce((s, l) => s + (l.reReadTokensServed ?? 0), 0)
  const editFailures = (stats?.allTime.editFailuresAfterCompression ?? 0) + live.reduce((s, l) => s + (l.editFailuresAfterCompression ?? 0), 0)
  const sessions = (stats?.sessions.length ?? 0) + live.length

  const life = lifetimeSavings(records)
  const penalty = life.measured > 0 ? life.penalty : reReadPenalty(stats)
  const net = life.measured > 0 ? life.lifetime - penalty - life.extraTurnPenalty : (stats?.allTime.estimatedCostSaved ?? 0)

  const byModel = new Map<string, number>()
  for (const [model, u] of Object.entries(stats?.allTime.byModel ?? {})) byModel.set(modelFamily(model), (byModel.get(modelFamily(model)) ?? 0) + u.savedTokens)
  const topModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'

  const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const spend = scanAllTranscripts(since30)
  const ctx = contextReport({ since: since30, ceilings: [200_000] })

  const cfg = loadConfig()
  const settings = loadClaudeSettings()
  const hooks = installedCorkHooks(settings).filter(h => h.present).length
  const guard = cfg.contextGuard?.enabled !== false
  const heartbeat = readHeartbeat()
  const trackingDays = stats?.createdAt ? Math.max(0, Math.round((now.getTime() - new Date(stats.createdAt).getTime()) / 86_400_000)) : 0

  return {
    event: 'savings_snapshot',
    properties: {
      reason,
      tracking_days: trackingDays,
      sessions,
      requests,
      read_raw_tokens: rawTokens,
      saved_tokens: savedTokens,
      saved_pct: pct(savedTokens, rawTokens),
      rereads: reReads,
      reread_tokens: reReadTokens,
      reread_rate_pct: pct(reReads, requests),
      edit_failures: editFailures,
      saved_usd_first_pass: usd(life.firstPass || (stats?.allTime.estimatedCostSaved ?? 0)),
      saved_usd_lifetime: usd(life.lifetime),
      reread_penalty_usd: usd(penalty),
      extra_turn_penalty_usd: usd(life.extraTurnPenalty),
      net_usd: usd(net),
      measured_sessions: life.measured,
      amplification: Math.round(life.medianAmplification * 10) / 10,
      compactions: life.compactions,
      top_model: topModel,
      models: byModel.size,
      // Last 30 days of transcripts — the context-governance picture.
      spend_30d: costBucket(spend.costUSD),
      turns_30d: ctx.turns,
      sessions_30d: ctx.sessions.length,
      context_avg_30d: ctx.avgContextTokens,
      context_avg_30d_bucket: contextBucket(ctx.avgContextTokens),
      cache_read_share_pct_30d: pct(ctx.cacheReadCostUSD, ctx.costUSD),
      saving_at_200k_pct_30d: ctx.costUSD > 0 ? Math.round(((ctx.costUSD - (ctx.cappedCostUSD[200_000] ?? ctx.costUSD)) / ctx.costUSD) * 100) : 0,
      // Setup.
      autocompact_window: settings.autoCompactWindow ?? null,
      context_guard: guard,
      guard_bands: (cfg.contextGuard?.bands ?? DEFAULT_BANDS).length,
      hooks_installed: hooks,
      claude_version: heartbeat?.claudeVersion,
    },
    set: {
      version: VERSION,
      os: process.platform,
      arch: process.arch,
      claude_version: heartbeat?.claudeVersion ?? null,
      autocompact_window: settings.autoCompactWindow ?? null,
      context_guard: guard,
      hooks_installed: hooks,
      telemetry: true,
      lifetime_sessions: sessions,
      lifetime_saved_tokens: savedTokens,
      lifetime_net_usd: usd(net),
      amplification: Math.round(life.medianAmplification * 10) / 10,
      top_model: topModel,
      context_avg_30d: ctx.avgContextTokens,
      saving_at_200k_pct_30d: ctx.costUSD > 0 ? Math.round(((ctx.costUSD - (ctx.cappedCostUSD[200_000] ?? ctx.costUSD)) / ctx.costUSD) * 100) : 0,
      last_snapshot_at: now.toISOString(),
    },
    setOnce: {
      first_seen: now.toISOString(),
      first_version: VERSION,
    },
  }
}

/** True when telemetry is on and no snapshot went out in the last 24 hours. */
export function snapshotDue(now: Date = new Date(), force = false): boolean {
  if (!isTelemetryEnabled()) return false
  if (force) return true
  const last = loadConfig().lastSnapshotAt
  return !last || now.getTime() - new Date(last).getTime() >= SNAPSHOT_INTERVAL_MS
}

/**
 * Entry point of the detached child (`cork-ai __send-snapshot <reason>`): builds
 * the snapshot — which parses transcripts, so it never runs inside a hook — and
 * posts it. The date guard is re-checked here so two SessionEnds firing at once
 * send at most one snapshot each, never a burst.
 */
export async function runSendSnapshot(reason: string | undefined, force = false): Promise<boolean> {
  if (!snapshotDue(new Date(), force)) return false
  const valid: SnapshotReason[] = ['session_end', 'gain', 'install', 'telemetry_on', 'preview']
  const why = valid.includes(reason as SnapshotReason) ? (reason as SnapshotReason) : 'gain'
  const now = new Date()
  const ok = await postCapture(capturePayload(buildSavingsSnapshot(why, now), installId(), now))
  if (ok) updateConfig({ lastSnapshotAt: now.toISOString() })
  return ok
}

/** Where the snapshot's inputs come from, for `telemetry preview`. */
export function snapshotInputs(): string[] {
  return [
    `${CORK_HOME}/stats.json (cork-ai's own savings record)`,
    `${CORK_HOME}/live/*.json (sessions still running)`,
    `~/.claude/projects/**/*.jsonl (Claude Code transcripts, last 30 days — parsed locally, never sent)`,
    `~/.claude/settings.json (autoCompactWindow, hooks)`,
  ].filter(() => fs.existsSync(CORK_HOME))
}
