/**
 * cork-ai — Surgical context optimization for Claude Code.
 * Reduces token cost by 60–75% on long sessions.
 *
 * Two usage modes:
 * 1. wrapClient() — transparent middleware on the Anthropic SDK
 * 2. CtxForge — on-demand manual compression
 */

import { runPipeline } from './core/pipeline.js'
import { StatsTracker } from './stats/tracker.js'
import { restore as restoreToolResult } from './compressors/tool-result.js'
import type { CorkAIOptions, FullStats, Message } from './types/index.js'

// ─── Public entry point ───────────────────────────────────────────────────────

export { wrapClient } from './core/interceptor.js'
export type { WrappedClient } from './core/interceptor.js'

// ─── CtxForge — manual compression ─────────────────────────────────────────

/**
 * Manual interface for on-demand compression.
 * @example
 * const forge = new CtxForge({ maxContextTokens: 150000 })
 * const { messages, stats } = forge.compress(conversationHistory)
 */
export class CtxForge {
  private opts: CorkAIOptions
  private tracker: StatsTracker
  private lastStats: FullStats | null = null

  constructor(options: CorkAIOptions = {}) {
    this.opts = options
    this.tracker = new StatsTracker(options.pricing)
  }

  /**
   * Compresses a conversation history.
   * @param messages - Messages to compress
   * @returns Compressed messages + full stats
   */
  compress(messages: Message[]): { messages: Message[]; stats: FullStats } {
    const result = runPipeline(messages, this.opts, this.tracker)
    this.lastStats = result.stats
    return { messages: result.messages, stats: result.stats }
  }

  /**
   * Returns stats from the last compression.
   */
  getStats(): FullStats | null {
    return this.lastStats
  }

  /**
   * Restores the original content of a compressed block.
   */
  restore(refId: string): string | null {
    return restoreToolResult(refId)
  }

  /**
   * Resets the session.
   */
  reset(): void {
    this.tracker.reset()
    this.lastStats = null
  }
}

// ─── Stats persistantes (cork-ai gain) ───────────────────────────────────────

export { recordSession, readGlobalStats, resetGlobalStats } from './cli/persistent-stats.js'
export type { GlobalStats, SessionRecord } from './cli/persistent-stats.js'

// ─── Individual module exports (advanced use) ───────────────────────────────

export { compressToolResults, restore, clearCache } from './compressors/tool-result.js'
export { stripHeaders } from './compressors/header-stripper.js'
export { deduplicateCode } from './compressors/code-dedup.js'
export { deduplicateSemantic } from './compressors/semantic-dedup.js'
export { HeatmapManager, compressWithHeatmap, scoreMessages } from './managers/heatmap.js'
export { DynamicSystemPrompt } from './managers/system-prompt.js'
export { BudgetManager, compressWithBudget } from './managers/budget.js'
export { SelectiveSummarizer, selectiveSummarize } from './managers/selective-summarizer.js'
export { SessionCache, saveSession, loadSession } from './managers/session-cache.js'
export { StatsTracker } from './stats/tracker.js'
export { countTokens, countMessageTokens, isTiktokenAvailable } from './core/tokenizer.js'
export { runPipeline } from './core/pipeline.js'

// ─── Public types ─────────────────────────────────────────────────────────────

export type {
  Message,
  MessageRole,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  CorkAIOptions,
  PricingConfig,
  BudgetConfig,
  FullStats,
  RequestStats,
  SessionStats,
  ModuleStats,
  ModuleName,
  CompressResult,
  HeatmapScore,
  ToolResultOptions,
  CodeDedupOptions,
  HeaderStripperOptions,
  HeatmapOptions,
  SemanticDedupOptions,
  CachedContent,
} from './types/index.js'
