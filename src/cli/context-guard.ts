/**
 * Context guard — the lever that actually moves the bill.
 *
 * Measured on this machine's transcripts (2026-07 → 2026-09): 82% of the spend
 * was cache reads of the conversation prefix, at an average context of
 * 250–530k tokens per turn, on sessions that ran up to the 1M window before
 * auto-compaction kicked in. Replayed with compaction at 200k, the same work
 * would have cost 46% less; at 150k, 54% less. Read compression, by
 * comparison, moves about 1%.
 *
 * The guard reads the live context size from the transcript tail and, as the
 * session crosses each band, tells the user (a `systemMessage`) and the model
 * (an `additionalContext`) once. It never blocks anything. Claude Code's own
 * `autoCompactWindow` setting is the durable fix; the guard is the nudge that
 * makes the cost visible while it is being paid.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolvePricing } from '../pricing/index.js'
import { lastMainTurnUsage } from './transcript-usage.js'
import { writeFileAtomic } from './fs-utils.js'

const GLOBAL_DIR = process.env.CORK_AI_HOME ?? path.join(os.homedir(), '.cork-ai')
const LIVE_DIR = path.join(GLOBAL_DIR, 'live')

export const DEFAULT_BANDS = [150_000, 300_000, 500_000, 750_000]

export interface ContextGuardConfig {
  /** Default true once hooks are installed; `cork-ai context guard off` disables. */
  enabled?: boolean
  /** Context sizes (tokens) at which a notice fires, once each per session. */
  bands?: number[]
  /** Also nudge the model, not only the user. Default true. */
  nudgeModel?: boolean
  /** PostToolUse events between two evaluations (they fire on every edit). */
  everyNthToolUse?: number
}

interface GuardState {
  notified: number[]
  toolUses: number
}

function stateFile(sessionId: string): string {
  const safe = sessionId.replace(/[^\w.-]/g, '_').slice(0, 80)
  return path.join(LIVE_DIR, `guard-${safe}.json`)
}

function loadState(sessionId: string): GuardState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf-8')) as GuardState
    if (parsed && Array.isArray(parsed.notified)) return { notified: parsed.notified, toolUses: parsed.toolUses ?? 0 }
  } catch { /* fresh session */ }
  return { notified: [], toolUses: 0 }
}

function saveState(sessionId: string, state: GuardState): void {
  try {
    fs.mkdirSync(LIVE_DIR, { recursive: true })
    writeFileAtomic(stateFile(sessionId), JSON.stringify(state))
  } catch { /* non-critical */ }
}

export interface GuardNotice {
  band: number
  contextTokens: number
  model: string
  /** USD billed in cache reads by every further turn at this context size. */
  perTurnUSD: number
  /** The same turn with the context compacted to ~25k tokens. */
  perTurnCompactedUSD: number
  systemMessage: string
  additionalContext: string
}

function fmtK(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`
}

export function buildNotice(band: number, contextTokens: number, model: string): GuardNotice {
  const p = resolvePricing(model)
  const perTurnUSD = (contextTokens / 1_000_000) * p.cacheRead
  const perTurnCompactedUSD = (25_000 / 1_000_000) * p.cacheRead
  const systemMessage =
    `cork-ai: context is ${fmtK(contextTokens)} tokens — every tool call now re-reads it for ~$${perTurnUSD.toFixed(3)} ` +
    `(${model}). /compact would bring that to ~$${perTurnCompactedUSD.toFixed(3)}; ` +
    `\`/autocompact 200k\` makes Claude Code do it automatically. Run \`cork-ai context\` for the full picture.`
  const additionalContext =
    `[cork-ai context guard] The conversation context is ${fmtK(contextTokens)} tokens; each further tool call costs the user ` +
    `~$${perTurnUSD.toFixed(3)} in cache reads. Keep working, but: batch independent commands into one call, read only the ` +
    `line ranges you need (sed -n / offset+limit), avoid re-reading files already in context, and at the next natural ` +
    `stopping point tell the user that running /compact (or setting /autocompact 200k) would cut the per-call cost to ` +
    `~$${perTurnCompactedUSD.toFixed(3)}.`
  return { band, contextTokens, model, perTurnUSD, perTurnCompactedUSD, systemMessage, additionalContext }
}

export interface GuardInput {
  sessionId: string
  transcriptPath?: string
  event: 'UserPromptSubmit' | 'PostToolUse' | 'Stop' | 'SessionStart'
  config?: ContextGuardConfig
  /** Injected for tests. */
  contextProbe?: (transcriptPath: string) => { contextTokens: number; model: string } | undefined
}

/**
 * Evaluates the guard for one hook event. Returns the notice to emit, or
 * undefined when nothing new crossed a band (the common case, ~1 ms).
 */
export function evaluateGuard(input: GuardInput): GuardNotice | undefined {
  const cfg = input.config ?? {}
  if (cfg.enabled === false || !input.sessionId || !input.transcriptPath) return undefined
  const bands = (cfg.bands ?? DEFAULT_BANDS).slice().sort((a, b) => a - b)

  const state = loadState(input.sessionId)
  if (input.event === 'PostToolUse') {
    state.toolUses += 1
    const every = Math.max(1, cfg.everyNthToolUse ?? 5)
    if (state.toolUses % every !== 0) {
      saveState(input.sessionId, state)
      return undefined
    }
  }

  const probe = input.contextProbe
    ? input.contextProbe(input.transcriptPath)
    : (() => {
        const turn = lastMainTurnUsage(input.transcriptPath)
        return turn ? { contextTokens: turn.contextTokens, model: turn.model } : undefined
      })()
  if (!probe) {
    saveState(input.sessionId, state)
    return undefined
  }

  // Highest band reached that has not been announced yet. Bands below the
  // current context that were skipped (a session resumed at 600k) fold into
  // the highest one: one notice, not three.
  const reached = bands.filter(b => probe.contextTokens >= b)
  const pending = reached.filter(b => !state.notified.includes(b))
  if (pending.length === 0) {
    saveState(input.sessionId, state)
    return undefined
  }
  const band = pending[pending.length - 1]
  state.notified = [...new Set([...state.notified, ...pending])]
  saveState(input.sessionId, state)

  return buildNotice(band, probe.contextTokens, probe.model)
}

/** Hook stdout for a notice, shaped for the event that produced it. */
export function guardHookOutput(notice: GuardNotice, event: GuardInput['event'], nudgeModel = true): Record<string, unknown> {
  const out: Record<string, unknown> = { systemMessage: notice.systemMessage }
  if (nudgeModel && event !== 'SessionStart') {
    out.hookSpecificOutput = { hookEventName: event, additionalContext: notice.additionalContext }
  }
  return out
}
