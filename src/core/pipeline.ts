/**
 * Pipeline — main orchestrator for cork-ai.
 * Composes modules according to options and available budget.
 * Modules have no knowledge of each other — everything goes through the pipeline.
 */

import { compressWithBudget } from '../managers/budget.js'
import { countMessageTokens } from './tokenizer.js'
import { StatsTracker } from '../stats/tracker.js'
import type {
  CorkAIOptions,
  CompressResult,
  FullStats,
  Message,
} from '../types/index.js'

export interface PipelineResult extends CompressResult {
  stats: FullStats
}

/**
 * Internal logger, silent by default.
 */
function createLogger(debug = false) {
  return {
    log: (...args: unknown[]) => { if (debug) console.log('[cork-ai]', ...args) },
    warn: (...args: unknown[]) => { if (debug) console.warn('[cork-ai:warn]', ...args) },
  }
}

/**
 * Runs the compression pipeline on a set of messages.
 * @param messages - Conversation history to compress
 * @param options - Global options
 * @param tracker - Shared StatsTracker (optional, creates a new one if absent)
 * @returns Compressed messages + full stats
 */
export function runPipeline(
  messages: Message[],
  options: CorkAIOptions = {},
  tracker?: StatsTracker,
): PipelineResult {
  const logger = createLogger(options.debug)
  const stats = tracker ?? new StatsTracker(options.pricing)

  logger.log(`Starting pipeline on ${messages.length} messages`)

  const originalTokens = countMessageTokens(messages)
  logger.log(`Initial tokens: ${originalTokens}`)

  // Compress via Budget Manager (orchestrates all modules)
  const result = compressWithBudget(messages, {
    ...options,
    budget: {
      maxTokens: options.maxContextTokens ?? 150_000,
      hardLimit: options.budget?.hardLimit ?? false,
      ...options.budget,
    },
  })

  // Record stats per module
  for (const [name, saved] of Object.entries(result.byModule)) {
    stats.recordModule(name, saved)
  }

  const compressedTokens = countMessageTokens(result.messages)
  logger.log(`Tokens after compression: ${compressedTokens} (saved: ${originalTokens - compressedTokens})`)

  const fullStats = stats.getFullStats(originalTokens, compressedTokens)

  // Call onStats callback if configured
  if (options.onStats) {
    try {
      options.onStats(fullStats)
    } catch (e) {
      logger.warn('Error in onStats callback:', e)
    }
  }

  return {
    messages: result.messages,
    savedTokens: result.savedTokens,
    stats: fullStats,
  }
}
