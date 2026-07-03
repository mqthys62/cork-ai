/**
 * Prefix-stable compression — preserves the Anthropic prompt cache.
 *
 * The problem with re-running compression over the whole history on every
 * request: scoring is adaptive (thresholds move with budget pressure, windows
 * are relative to conversation length), so old messages get rewritten between
 * requests. Prompt caching is a byte-exact prefix match — one changed byte at
 * position N invalidates every cached token after N. A 100K-token history
 * served at cache-read price (0.1×) that gets "compressed" to 80K with a
 * broken cache costs 80K × 1× — up to 8× MORE than doing nothing.
 *
 * The fix is a monotonic compression frontier:
 *   - messages that leave the recent window cross the frontier and receive
 *     their final compressed form ONCE — frozen byte-identical afterwards;
 *   - messages before the frontier are never touched again;
 *   - messages after the frontier stay raw (they're cheap: they change anyway).
 *
 * One documented exception: when budget pressure crosses a compression level
 * (none → level1 → level2 → all), the frozen prefix is recompressed once at
 * the new level. That's at most 3 cache invalidations over a conversation's
 * lifetime, instead of one per request.
 */

import { createHash } from 'crypto'
import { compressWithBudget } from '../managers/budget.js'
import { countMessageTokens } from './tokenizer.js'
import { validateToolPairing } from './validate.js'
import type { CorkAIOptions, Message } from '../types/index.js'

const DEFAULT_KEEP_RECENT = 5

type Level = 'none' | 'level1' | 'level2' | 'all'
const LEVEL_ORDER: Record<Level, number> = { none: 0, level1: 1, level2: 2, all: 3 }

function levelFor(tokenCount: number, maxTokens: number): Level {
  const ratio = tokenCount / maxTokens
  if (ratio < 0.40) return 'none'
  if (ratio < 0.65) return 'level1'
  if (ratio < 0.80) return 'level2'
  return 'all'
}

/** Stable hash of a message's original content (conversation identity + mutation detection). */
export function hashMessage(msg: Message): string {
  return createHash('sha1')
    .update(JSON.stringify({ role: msg.role, content: msg.content }))
    .digest('hex')
}

interface FrozenSlot {
  /** Hash of the ORIGINAL message at this index (mutation detection) */
  originalHash: string
  /** Frozen output form — byte-identical on every subsequent request */
  message: Message
  /** Tokens saved on this message vs its original */
  savedTokens: number
}

export interface PrefixStableResult {
  messages: Message[]
  /** Total tokens saved this request (frozen + newly frozen) */
  savedTokens: number
  /** Saved on messages frozen during THIS request (would have been billed at input rate) */
  newlySavedTokens: number
  /** Saved on previously-frozen messages (would have been billed at cache-read rate) */
  frozenSavedTokens: number
  /** Per-module attribution for the newly compressed slice */
  byModule: Record<string, number>
  /** True when the caller mutated already-frozen history and state was reset */
  prefixReset: boolean
  /** True when a budget-level increase forced a one-time recompression */
  levelUpgrade: boolean
}

/**
 * Per-conversation stateful compressor. Create one instance per conversation
 * and call compress() with the full history on every request.
 */
export class ConversationCompressor {
  private slots: FrozenSlot[] = []
  private level: Level = 'none'
  private readonly keepRecent: number

  constructor(keepRecent: number = DEFAULT_KEEP_RECENT) {
    this.keepRecent = keepRecent
  }

  /** Number of messages currently frozen (exposed for tests/debugging). */
  get frontier(): number {
    return this.slots.length
  }

  compress(messages: Message[], options: CorkAIOptions = {}): PrefixStableResult {
    const maxTokens = options.maxContextTokens ?? options.budget?.maxTokens ?? 150_000
    let prefixReset = false
    let levelUpgrade = false

    // 1. Mutation check: the frozen prefix must still match the caller's
    //    original messages. If not (edited/truncated history), reset state.
    if (this.slots.length > messages.length) {
      this.slots = []
      this.level = 'none'
      prefixReset = true
    } else {
      for (let i = 0; i < this.slots.length; i++) {
        if (hashMessage(messages[i]) !== this.slots[i].originalHash) {
          this.slots = []
          this.level = 'none'
          prefixReset = true
          break
        }
      }
    }

    // 2. Level upgrade: if budget pressure crossed a compression level,
    //    recompress the whole prefix once at the new level.
    const currentLevel = levelFor(countMessageTokens(messages), maxTokens)
    if (LEVEL_ORDER[currentLevel] > LEVEL_ORDER[this.level]) {
      if (this.slots.length > 0) levelUpgrade = true
      this.slots = []
      this.level = currentLevel
    }

    // 3. Advance the frontier: messages leaving the recent window get frozen.
    const targetFrontier = Math.max(this.slots.length, messages.length - this.keepRecent)

    if (targetFrontier > this.slots.length) {
      // Run the regular budget pipeline over [frozen prefix + raw remainder]
      // so scoring sees realistic context, then accept its output ONLY for
      // the segment being frozen. Everything before stays frozen, everything
      // after stays raw.
      const workingInput: Message[] = [
        ...this.slots.map(s => s.message),
        ...messages.slice(this.slots.length),
      ]
      const run = compressWithBudget(workingInput, options)

      // Fail-safe: never freeze forms that break tool pairing.
      const candidate = run.messages
      const pairingOk =
        validateToolPairing([
          ...this.slots.map(s => s.message),
          ...candidate.slice(this.slots.length, targetFrontier),
          ...messages.slice(targetFrontier),
        ]) || !validateToolPairing(messages)

      for (let i = this.slots.length; i < targetFrontier; i++) {
        const original = messages[i]
        const frozenForm = pairingOk ? candidate[i] : original
        const savedTokens = Math.max(
          0,
          countMessageTokens([original]) - countMessageTokens([frozenForm]),
        )
        this.slots.push({
          originalHash: hashMessage(original),
          message: frozenForm,
          savedTokens,
        })
      }
    }

    // 4. Assemble output: frozen prefix + raw tail.
    const out: Message[] = [
      ...this.slots.map(s => s.message),
      ...messages.slice(this.slots.length),
    ]

    return this.buildResult(out, prefixReset, levelUpgrade)
  }

  private previousFrontier = 0

  private buildResult(
    out: Message[],
    prefixReset: boolean,
    levelUpgrade: boolean,
  ): PrefixStableResult {
    // Split savings between "newly frozen this request" and "already frozen".
    // After a reset/upgrade everything frozen this call counts as new.
    const boundary = prefixReset || levelUpgrade ? 0 : this.previousFrontier
    let newlySavedTokens = 0
    let frozenSavedTokens = 0
    const byModule: Record<string, number> = {}

    for (let i = 0; i < this.slots.length; i++) {
      if (i >= boundary) newlySavedTokens += this.slots[i].savedTokens
      else frozenSavedTokens += this.slots[i].savedTokens
    }
    if (newlySavedTokens > 0) {
      byModule['prefixStable'] = newlySavedTokens
    }
    this.previousFrontier = this.slots.length

    return {
      messages: out,
      savedTokens: newlySavedTokens + frozenSavedTokens,
      newlySavedTokens,
      frozenSavedTokens,
      byModule,
      prefixReset,
      levelUpgrade,
    }
  }
}

/**
 * LRU registry of per-conversation compressors, keyed by the hash of the
 * first message (a stable identity for a conversation whose history only
 * grows). Used by wrapClient to route each request to its conversation state.
 */
export class ConversationRegistry {
  private map = new Map<string, ConversationCompressor>()
  private readonly maxSize: number

  constructor(maxSize = 50) {
    this.maxSize = maxSize
  }

  for(messages: Message[], keepRecent?: number): ConversationCompressor {
    const key = messages.length > 0 ? hashMessage(messages[0]) : '<empty>'
    let compressor = this.map.get(key)
    if (compressor) {
      // LRU refresh
      this.map.delete(key)
      this.map.set(key, compressor)
      return compressor
    }
    compressor = new ConversationCompressor(keepRecent)
    this.map.set(key, compressor)
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    return compressor
  }
}
