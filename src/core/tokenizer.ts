/**
 * Tokenizer — token counting with per-model calibration.
 *
 * Base encoder: tiktoken cl100k_base when available (fast, deterministic) —
 * but cl100k_base is OpenAI's tokenizer and systematically undercounts Claude
 * tokens (~15-20% on prose, more on code/French, and Claude tokenizers differ
 * across model generations). A per-model calibration factor corrects this.
 *
 * Calibration factors live in ~/.cork-ai/calibration.json and are measured
 * against the real `POST /v1/messages/count_tokens` endpoint via
 * `cork-ai calibrate` (exact, model-specific, free).
 *
 * Two counting paths, both calibrated and consistent:
 *   - countTokens(text)        — tiktoken-based (library pipeline)
 *   - estimateTokensFast(text) — chars-based (CLI hook: no WASM load latency)
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Message } from '../types/index.js'

type TiktokenEncoder = {
  encode(text: string): Uint32Array
  free(): void
}

let encoder: TiktokenEncoder | null = null
let tiktokenAvailable: boolean | null = null

async function loadTiktoken(): Promise<boolean> {
  if (tiktokenAvailable !== null) return tiktokenAvailable
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('tiktoken') as any
    encoder = mod.get_encoding('cl100k_base')
    tiktokenAvailable = true
  } catch {
    tiktokenAvailable = false
  }
  return tiktokenAvailable
}

// Initialisation synchrone pour l'usage sans await
function tryLoadTiktokenSync(): boolean {
  if (tiktokenAvailable !== null) return tiktokenAvailable
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = require('tiktoken') as any
    encoder = mod.get_encoding('cl100k_base')
    tiktokenAvailable = true
  } catch {
    tiktokenAvailable = false
  }
  return tiktokenAvailable
}

// ─── Per-model calibration ────────────────────────────────────────────────────

export interface CalibrationFactor {
  /** Multiplier applied to tiktoken cl100k_base counts (real / tiktoken) */
  tiktokenFactor: number
  /** Characters per token for the fast chars-based path (real measurement) */
  charsPerToken: number
  /** When this factor was measured */
  sampledAt?: string
}

/**
 * Passive calibration accumulator: on every wrapClient response we know both
 * our local estimate and the API's real prompt token count — their ratio,
 * accumulated over enough samples, corrects the estimator without any manual
 * `cork-ai calibrate` run.
 */
export interface PassiveSample {
  /** Σ locally-estimated tokens, with calibration factor divided back out */
  sumRawEstimate: number
  /** Σ characters of the same requests (drives the chars-based fast path) */
  sumChars: number
  /** Σ real prompt tokens billed by the API (input + cache read + cache write) */
  sumMeasured: number
  samples: number
  updatedAt: string
}

/** Passive factors need a few observations before they beat the defaults. */
const PASSIVE_MIN_SAMPLES = 3

interface CalibrationFile {
  version: number
  updatedAt: string
  factors: Record<string, CalibrationFactor>
  /** Auto-accumulated by the interceptor, keyed by model family */
  passive?: Record<string, PassiveSample>
}

export const CALIBRATION_FILE = path.join(
  process.env.CORK_AI_HOME ?? path.join(os.homedir(), '.cork-ai'),
  'calibration.json',
)

/** Uncalibrated defaults — corrected by `cork-ai calibrate`. */
const DEFAULT_FACTOR: CalibrationFactor = { tiktokenFactor: 1.0, charsPerToken: 3.5 }

let calibration: CalibrationFile | null = null
let calibrationLoaded = false
let activeModel: string | undefined

function loadCalibration(): CalibrationFile | null {
  if (calibrationLoaded) return calibration
  calibrationLoaded = true
  try {
    calibration = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf-8')) as CalibrationFile
  } catch {
    calibration = null
  }
  return calibration
}

/**
 * Normalizes a model ID into a calibration family.
 * Families group models sharing (approximately) the same tokenizer.
 */
export function modelFamily(modelId?: string): string {
  if (!modelId) return 'unknown'
  if (/fable|mythos/i.test(modelId)) return 'fable'
  if (/haiku/i.test(modelId)) return 'haiku'
  if (/sonnet-5/i.test(modelId)) return 'sonnet-5'
  if (/sonnet/i.test(modelId)) return 'sonnet'
  if (/opus-4-[7-9]/i.test(modelId)) return 'opus-new'
  if (/opus/i.test(modelId)) return 'opus'
  return 'unknown'
}

/**
 * Sets the active model — all subsequent counts use its calibration factor.
 * Called by the interceptor (from request params) and the CLI hook (from the transcript).
 */
export function setActiveModel(modelId?: string): void {
  if (modelId !== activeModel) {
    activeModel = modelId
    // Counts are model-dependent — drop the memo
    messageTokenCache = new WeakMap()
  }
}

export function getActiveModel(): string | undefined {
  return activeModel
}

function passiveFactor(cal: CalibrationFile, family: string): CalibrationFactor | null {
  const p = cal.passive?.[family]
  if (!p || p.samples < PASSIVE_MIN_SAMPLES || p.sumRawEstimate <= 0 || p.sumMeasured <= 0) {
    return null
  }
  return {
    tiktokenFactor: p.sumMeasured / p.sumRawEstimate,
    charsPerToken: p.sumChars / p.sumMeasured,
    sampledAt: p.updatedAt,
  }
}

function factorFor(modelId?: string): CalibrationFactor {
  const cal = loadCalibration()
  if (!cal) return DEFAULT_FACTOR
  const id = modelId ?? activeModel
  // Explicit factors (manual `cork-ai calibrate`) win over passive ones:
  // count_tokens is exact, the passive ratio is a noisy aggregate.
  if (id && cal.factors[id]) return cal.factors[id]
  const family = modelFamily(id)
  return cal.factors[family] ?? passiveFactor(cal, family) ?? DEFAULT_FACTOR
}

/** Calibration factor currently in effect for a model (exposed for the interceptor). */
export function getCalibrationFactor(modelId?: string): CalibrationFactor {
  return { ...factorFor(modelId) }
}

/**
 * Drops the in-memory calibration cache — the next count re-reads
 * ~/.cork-ai/calibration.json. Call it if the file changed outside this
 * process (manual edit, another `cork-ai calibrate` run).
 */
export function reloadCalibration(): void {
  calibrationLoaded = false
  calibration = null
  messageTokenCache = new WeakMap()
}

/**
 * Feeds one passive calibration observation (called by the interceptor after
 * each measured response). `rawEstimatedTokens` must be the estimate with the
 * calibration factor divided back out, so the stored ratio never feeds back
 * on itself.
 */
export function recordPassiveSample(
  modelId: string | undefined,
  obs: { rawEstimatedTokens: number; chars: number; measuredTokens: number },
): void {
  if (obs.rawEstimatedTokens <= 0 || obs.measuredTokens <= 0) return
  const cal: CalibrationFile = loadCalibration() ?? {
    version: 1,
    updatedAt: new Date().toISOString(),
    factors: {},
  }
  cal.passive ??= {}
  const family = modelFamily(modelId)
  const now = new Date().toISOString()
  const p = cal.passive[family] ?? {
    sumRawEstimate: 0, sumChars: 0, sumMeasured: 0, samples: 0, updatedAt: now,
  }
  p.sumRawEstimate += obs.rawEstimatedTokens
  p.sumChars += obs.chars
  p.sumMeasured += obs.measuredTokens
  p.samples += 1
  p.updatedAt = now
  cal.passive[family] = p
  cal.updatedAt = now
  try {
    fs.mkdirSync(path.dirname(CALIBRATION_FILE), { recursive: true })
    fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(cal, null, 2), 'utf-8')
  } catch { /* non-critical — calibration is an optimization */ }
  calibrationLoaded = false
  calibration = null
  messageTokenCache = new WeakMap()
}

/** Persists a measured calibration factor (used by `cork-ai calibrate`). */
export function saveCalibrationFactor(key: string, factor: CalibrationFactor): void {
  const cal: CalibrationFile = loadCalibration() ?? {
    version: 1,
    updatedAt: new Date().toISOString(),
    factors: {},
  }
  cal.factors[key] = { ...factor, sampledAt: new Date().toISOString() }
  cal.updatedAt = new Date().toISOString()
  fs.mkdirSync(path.dirname(CALIBRATION_FILE), { recursive: true })
  fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(cal, null, 2), 'utf-8')
  // Invalidate in-memory caches so new counts pick the factor up
  calibrationLoaded = false
  calibration = null
  messageTokenCache = new WeakMap()
}

// ─── Counting ─────────────────────────────────────────────────────────────────

/**
 * Fast chars-based estimate, calibrated per model.
 * Used by the CLI hook (no tiktoken WASM load on every Read) — same unit
 * as countTokens() thanks to the shared calibration file.
 */
export function estimateTokensFast(text: string, modelId?: string): number {
  if (!text) return 0
  return Math.ceil(text.length / factorFor(modelId).charsPerToken)
}

/**
 * Counts tokens in a text: tiktoken × calibration factor, or fast fallback.
 */
export function countTokens(text: string, modelId?: string): number {
  if (!text) return 0
  const available = tryLoadTiktokenSync()
  if (available && encoder) {
    return Math.ceil(encoder.encode(text).length * factorFor(modelId).tiktokenFactor)
  }
  return estimateTokensFast(text, modelId)
}

/** Raw tiktoken count without calibration (used by `cork-ai calibrate`). Null if tiktoken unavailable. */
export function countTokensRaw(text: string): number | null {
  if (!text) return 0
  const available = tryLoadTiktokenSync()
  if (available && encoder) return encoder.encode(text).length
  return null
}

function countSingleMessage(msg: Message): number {
  let total = 4 // structural overhead per message
  if (typeof msg.content === 'string') {
    total += countTokens(msg.content)
  } else {
    for (const block of msg.content) {
      if (block.type === 'text') {
        total += countTokens(block.text)
      } else if (block.type === 'tool_use') {
        total += countTokens(block.name)
        total += countTokens(JSON.stringify(block.input))
      } else if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          total += countTokens(block.content)
        } else if (Array.isArray(block.content)) {
          for (const c of block.content) {
            if (c.type === 'text') total += countTokens(c.text)
          }
        }
      }
    }
  }
  return total
}

// Per-message memo: the pipeline re-counts the whole history on every request
// (O(n²) over a session without it). Message objects are treated as immutable —
// compressors always produce new objects. Invalidated on model/calibration change.
let messageTokenCache = new WeakMap<Message, number>()

/**
 * Counts tokens for an array of messages (Anthropic format).
 * Includes structural overhead (~4 per message). Memoized per message object.
 */
export function countMessageTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue
    let count = messageTokenCache.get(msg)
    if (count === undefined) {
      count = countSingleMessage(msg)
      messageTokenCache.set(msg, count)
    }
    total += count
  }
  return total
}

/**
 * Counts tokens for a full request: messages + system prompt + tool definitions.
 * Tool definitions routinely weigh 5-15K tokens and are ignored by
 * countMessageTokens — use this for context-size decisions.
 */
export function countRequestTokens(params: {
  messages: Message[]
  system?: unknown
  tools?: unknown[]
}): number {
  let total = countMessageTokens(params.messages)
  if (typeof params.system === 'string') {
    total += countTokens(params.system)
  } else if (Array.isArray(params.system)) {
    for (const block of params.system) {
      const text = (block as { text?: unknown })?.text
      if (typeof text === 'string') total += countTokens(text)
    }
  }
  if (Array.isArray(params.tools)) {
    for (const tool of params.tools) {
      total += countTokens(JSON.stringify(tool))
    }
  }
  return total
}

/**
 * Character count for a full request — pairs with countRequestTokens to feed
 * the passive calibration of the chars-based fast path.
 */
export function countRequestChars(params: {
  messages: Message[]
  system?: unknown
  tools?: unknown[]
}): number {
  let total = 0
  for (const msg of params.messages) {
    if (typeof msg.content === 'string') {
      total += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') total += block.text.length
        else if (block.type === 'tool_use') total += block.name.length + JSON.stringify(block.input).length
        else if (block.type === 'tool_result') {
          if (typeof block.content === 'string') total += block.content.length
          else if (Array.isArray(block.content)) {
            for (const c of block.content) {
              if (c.type === 'text') total += c.text.length
            }
          }
        }
      }
    }
  }
  if (typeof params.system === 'string') total += params.system.length
  else if (Array.isArray(params.system)) {
    for (const block of params.system) {
      const text = (block as { text?: unknown })?.text
      if (typeof text === 'string') total += text.length
    }
  }
  if (Array.isArray(params.tools)) {
    for (const tool of params.tools) total += JSON.stringify(tool).length
  }
  return total
}

/**
 * Checks whether tiktoken is available in the environment.
 */
export async function isTiktokenAvailable(): Promise<boolean> {
  return loadTiktoken()
}

/**
 * Tokenizer singleton — reuses the initialized encoder.
 */
export const TokenizerSingleton = {
  countTokens,
  countMessageTokens,
  countRequestTokens,
  estimateTokensFast,
  isTiktokenAvailable,
  setActiveModel,
}
