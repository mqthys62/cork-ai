/**
 * Budget Manager — adaptive compression orchestration based on token budget.
 * Levels: passthrough < 40%, L1 40–65%, L1+L2 65–80%, all > 80%.
 *
 * This is the central module that decides what to activate based on budget pressure.
 */

import { compressToolResults } from '../compressors/tool-result.js'
import { deduplicateCode } from '../compressors/code-dedup.js'
import { stripHeaders } from '../compressors/header-stripper.js'
import { deduplicateSemantic } from '../compressors/semantic-dedup.js'
import { compressWithHeatmap } from '../managers/heatmap.js'
import { selectiveSummarize } from '../managers/selective-summarizer.js'
import { countMessageTokens } from '../core/tokenizer.js'
import type {
  BudgetConfig,
  CompressResult,
  CorkAIOptions,
  Message,
  ModuleName,
} from '../types/index.js'

const DEFAULT_BUDGET: BudgetConfig = {
  maxTokens: 150_000,
  hardLimit: false,
}

type CompressionLevel = 'none' | 'level1' | 'level2' | 'all'

/**
 * Determines the compression level based on the token/budget ratio.
 */
function getCompressionLevel(tokenCount: number, maxTokens: number): CompressionLevel {
  const ratio = tokenCount / maxTokens
  if (ratio < 0.40) return 'none'
  if (ratio < 0.65) return 'level1'
  if (ratio < 0.80) return 'level2'
  return 'all'
}

/**
 * Computes the adjusted heatmap threshold based on budget pressure.
 * Monotone: the higher the pressure, the lower the threshold (fewer messages
 * compressed by the heatmap — more delegation to other modules).
 * Lowered values to avoid crushing messages with code blocks (floor=0.30).
 */
function adaptiveHeatmapThreshold(ratio: number): number {
  if (ratio < 0.65) return 0.40 // level1 — heatmap ne tourne pas ici (safety)
  if (ratio < 0.80) return 0.25 // level2 — slightly less aggressive (was 0.30)
  return 0.15                   // all — delegates to semantic dedup + summarizer (was 0.20)
}

/**
 * Compresses messages according to the available budget.
 * @param messages - Conversation history
 * @param options - Global cork-ai options
 * @returns Compressed messages + tokens saved per module
 */
export function compressWithBudget(
  messages: Message[],
  options: CorkAIOptions = {},
): CompressResult & { byModule: Record<string, number> } {
  const budget: BudgetConfig = { ...DEFAULT_BUDGET, ...options.budget }
  const aggressiveness = options.aggressiveness ?? 0.6
  const disabled = new Set<ModuleName>(options.disabledModules ?? [])

  const originalTokens = countMessageTokens(messages)
  const ratio = originalTokens / budget.maxTokens

  // Check the hard limit before compressing
  if (budget.hardLimit && ratio > 1.0) {
    throw new Error(
      `[cork-ai] Context exceeds the maximum budget: ${originalTokens} tokens > ${budget.maxTokens} tokens. ` +
      `Reduce the number of messages or increase maxContextTokens.`
    )
  }

  const level = getCompressionLevel(originalTokens, budget.maxTokens)
  const byModule: Record<string, number> = {}

  if (level === 'none') {
    return { messages, savedTokens: 0, byModule }
  }

  let current = messages
  let totalSaved = 0

  const apply = (name: ModuleName, fn: (msgs: Message[]) => CompressResult) => {
    if (disabled.has(name)) return
    const result = fn(current)
    current = result.messages
    totalSaved += result.savedTokens
    byModule[name] = (byModule[name] ?? 0) + result.savedTokens
  }

  // Level 1: Tool results + Headers (always first — biggest gain)
  if (level === 'level1' || level === 'level2' || level === 'all') {
    apply('toolResultCompressor', msgs =>
      compressToolResults(msgs, { aggressiveness })
    )
    apply('headerStripper', msgs =>
      stripHeaders(msgs, { aggressiveness })
    )
  }

  // Level 2: Code dedup + Heatmap
  if (level === 'level2' || level === 'all') {
    apply('codeDedup', msgs =>
      deduplicateCode(msgs, { aggressiveness })
    )

    const heatThreshold = adaptiveHeatmapThreshold(ratio)
    apply('heatmap', msgs =>
      compressWithHeatmap(msgs, heatThreshold, { windowSize: 5, threshold: heatThreshold })
    )
  }

  // Level 3: Semantic dedup + Selective summarizer
  if (level === 'all') {
    apply('semanticDedup', msgs =>
      deduplicateSemantic(msgs, { similarityThreshold: 0.82 })
    )
    apply('selectiveSummarizer', msgs =>
      selectiveSummarize(msgs, { aggressiveness, minTokensToSummarize: 100 })
    )
  }

  // Check the hard limit after compression
  if (budget.hardLimit) {
    const finalTokens = countMessageTokens(current)
    if (finalTokens > budget.maxTokens) {
      throw new Error(
        `[cork-ai] Even after compression, context still exceeds the budget: ` +
        `${finalTokens} tokens > ${budget.maxTokens} tokens.`
      )
    }
  }

  return { messages: current, savedTokens: totalSaved, byModule }
}

/**
 * Public class for advanced use.
 */
export class BudgetManager {
  private opts: CorkAIOptions

  constructor(options: CorkAIOptions = {}) {
    this.opts = options
  }

  compress(messages: Message[]): CompressResult & { byModule: Record<string, number> } {
    return compressWithBudget(messages, this.opts)
  }

  getLevel(messages: Message[]): CompressionLevel {
    const tokens = countMessageTokens(messages)
    const maxTokens = this.opts.budget?.maxTokens ?? DEFAULT_BUDGET.maxTokens
    return getCompressionLevel(tokens, maxTokens)
  }
}
