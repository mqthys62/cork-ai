/**
 * Compression policy — should this read be compressed at all?
 *
 * Measured on real transcripts (2026-07 → 2026-09): 72–81% of compressed
 * reads were followed by a full re-read, 42% of them immediately. A re-read
 * costs an extra API turn, and an agent turn re-reads the *whole* context from
 * cache — at 400k tokens on Opus 5 that is ~$0.20, more than a 2,000-token
 * compression can ever save. Compressing everything above 400 tokens was a
 * net loss.
 *
 * Two mechanisms replace the fixed threshold:
 *
 *   1. An expected-value gate: compress only when the tokens kept out of
 *      context, valued over the rest of the session, outweigh the probability-
 *      weighted cost of a re-read (the wasted compressed view, plus one extra
 *      turn over the current context).
 *   2. A per-extension re-read rate learned from this machine's own history,
 *      so an extension that keeps backfiring (`.tsx`: 92%) is served raw, with
 *      an occasional probe so it can earn its way back.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolvePricing } from '../pricing/index.js'

const GLOBAL_DIR = process.env.CORK_AI_HOME ?? path.join(os.homedir(), '.cork-ai')
export const POLICY_FILE = path.join(GLOBAL_DIR, 'policy.json')

export interface ExtStats {
  compressions: number
  /** Full re-reads after an outline: the compression failed (feeds P(re-read)). */
  reReads: number
  /** Targeted follow-ups (sed -n, offset/limit) after an outline: the outline worked as intended. Informational. */
  rangeReads?: number
  editsAfter: number
  lastAt: string
}

export interface PolicyState {
  version: 1
  ext: Record<string, ExtStats>
}

/** Prior belief before any local evidence: a coin flip, weighted like 4 observations. */
const PRIOR_RE_READ = 0.5
const PRIOR_WEIGHT = 4
/** Above this measured re-read rate an extension is put on probation. */
export const PROBATION_RATE = 0.35
/** Observations needed before probation can apply. */
export const PROBATION_MIN_SAMPLES = 10
/** On probation, one read in N is still compressed so the estimate can recover. */
export const PROBE_EVERY = 10
/** Cache reads per token written when no session measurement is available. */
export const DEFAULT_AMPLIFICATION = 50
/** Output tokens of the assistant turn that issues a re-read. */
const RE_READ_OUTPUT_TOKENS = 300
/** Compressed reads must save at least this many tokens to be worth the risk at all. */
export const MIN_SAVED_TOKENS = 1_500

export function loadPolicy(): PolicyState {
  try {
    const parsed = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf-8')) as PolicyState
    if (parsed && typeof parsed.ext === 'object') return parsed
  } catch { /* first run */ }
  return { version: 1, ext: {} }
}

export function savePolicy(state: PolicyState): void {
  try {
    fs.mkdirSync(GLOBAL_DIR, { recursive: true })
    fs.writeFileSync(POLICY_FILE, JSON.stringify(state), 'utf-8')
  } catch { /* non-critical: the hook must never fail a read */ }
}

export function normalizeExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return ext || path.basename(filePath).toLowerCase()
}

function bump(ext: string, field: 'compressions' | 'reReads' | 'rangeReads' | 'editsAfter'): void {
  const state = loadPolicy()
  const entry = state.ext[ext] ?? { compressions: 0, reReads: 0, editsAfter: 0, lastAt: '' }
  entry[field] = (entry[field] ?? 0) + 1
  entry.lastAt = new Date().toISOString()
  state.ext[ext] = entry
  savePolicy(state)
}

export function recordCompression(filePath: string): void { bump(normalizeExt(filePath), 'compressions') }
export function recordReRead(filePath: string): void { bump(normalizeExt(filePath), 'reReads') }
export function recordRangeRead(filePath: string): void { bump(normalizeExt(filePath), 'rangeReads') }
export function recordEditAfter(filePath: string): void { bump(normalizeExt(filePath), 'editsAfter') }

/**
 * Probability that a compressed read of this extension gets re-read, blending
 * the prior with what this machine has seen (a Beta posterior mean).
 */
export function reReadProbability(ext: string, state: PolicyState = loadPolicy()): number {
  const e = state.ext[ext]
  const n = e?.compressions ?? 0
  const k = e?.reReads ?? 0
  return (PRIOR_RE_READ * PRIOR_WEIGHT + k) / (PRIOR_WEIGHT + n)
}

export interface GateInput {
  filePath: string
  originalTokens: number
  compressedTokens: number
  /** Live context size (prompt tokens of the last turn), 0 when unknown. */
  contextTokens: number
  model?: string
  /** Cache reads per token for the rest of the session; defaults to a conservative 50. */
  amplification?: number
  state?: PolicyState
}

export interface GateDecision {
  compress: boolean
  reason: string
  /** Expected USD gained (positive) or lost (negative) by compressing. */
  expectedValueUSD: number
  reReadProbability: number
  probation: boolean
}

/**
 * The expected-value gate.
 *
 *   gain  = saved × amp × cacheRead
 *   loss  = p × (compressed × amp × cacheRead + context × cacheRead + 300 × output)
 *
 * `gain` is what the saved tokens would have cost over the rest of the
 * session. `loss` is what a re-read costs: the compressed view is dead weight
 * that stays in context, and the extra turn re-reads the whole context once.
 */
export function gate(input: GateInput): GateDecision {
  const state = input.state ?? loadPolicy()
  const ext = normalizeExt(input.filePath)
  const p = reReadProbability(ext, state)
  const pricing = resolvePricing(input.model)
  const amp = Math.max(1, input.amplification ?? DEFAULT_AMPLIFICATION)
  const saved = input.originalTokens - input.compressedTokens

  const gain = (saved / 1_000_000) * amp * pricing.cacheRead
  const loss =
    p *
    ((input.compressedTokens / 1_000_000) * amp * pricing.cacheRead +
      (input.contextTokens / 1_000_000) * pricing.cacheRead +
      (RE_READ_OUTPUT_TOKENS / 1_000_000) * pricing.output)
  const ev = gain - loss

  const stats = state.ext[ext]
  const samples = stats?.compressions ?? 0
  const onProbation = samples >= PROBATION_MIN_SAMPLES && p > PROBATION_RATE
  const probe = onProbation && samples % PROBE_EVERY === 0

  if (saved < MIN_SAVED_TOKENS) {
    return { compress: false, reason: `saves only ${saved} tokens (< ${MIN_SAVED_TOKENS})`, expectedValueUSD: ev, reReadProbability: p, probation: onProbation }
  }
  if (onProbation && !probe) {
    return { compress: false, reason: `${ext} on probation (re-read rate ${(p * 100).toFixed(0)}% over ${samples} reads)`, expectedValueUSD: ev, reReadProbability: p, probation: true }
  }
  if (ev <= 0) {
    return { compress: false, reason: `expected value ${ev.toFixed(4)} USD ≤ 0 at ${Math.round(input.contextTokens / 1000)}k context`, expectedValueUSD: ev, reReadProbability: p, probation: onProbation }
  }
  return { compress: true, reason: probe ? 'probation probe' : `expected value +${ev.toFixed(4)} USD`, expectedValueUSD: ev, reReadProbability: p, probation: onProbation }
}

/** Per-extension summary for `cork-ai gain` / `doctor`. */
export function policySummary(state: PolicyState = loadPolicy()): Array<{ ext: string; compressions: number; reReadRate: number; rangeReads: number; editsAfter: number; probation: boolean }> {
  return Object.entries(state.ext)
    .map(([ext, e]) => {
      const p = reReadProbability(ext, state)
      return {
        ext,
        compressions: e.compressions,
        reReadRate: e.compressions > 0 ? e.reReads / e.compressions : 0,
        rangeReads: e.rangeReads ?? 0,
        editsAfter: e.editsAfter,
        probation: e.compressions >= PROBATION_MIN_SAMPLES && p > PROBATION_RATE,
      }
    })
    .sort((a, b) => b.compressions - a.compressions)
}
