/**
 * cork-ai — Optimisation chirurgicale du contexte pour Claude Code.
 * Réduit de 60–75% le coût en tokens sur les sessions longues.
 *
 * Deux modes d'utilisation :
 * 1. wrapClient() — middleware transparent sur le SDK Anthropic
 * 2. CtxForge — compression manuelle à la demande
 */

import { runPipeline } from './core/pipeline.js'
import { StatsTracker } from './stats/tracker.js'
import { restore as restoreToolResult } from './compressors/tool-result.js'
import type { CorkAIOptions, FullStats, Message } from './types/index.js'

// ─── Point d'entrée public ────────────────────────────────────────────────────

export { wrapClient } from './core/interceptor.js'
export type { WrappedClient } from './core/interceptor.js'

// ─── CtxForge — compression manuelle ─────────────────────────────────────────

/**
 * Interface manuelle pour compression à la demande.
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
   * Compresse un historique de conversation.
   * @param messages - Messages à compresser
   * @returns Messages compressés + stats complètes
   */
  compress(messages: Message[]): { messages: Message[]; stats: FullStats } {
    const result = runPipeline(messages, this.opts, this.tracker)
    this.lastStats = result.stats
    return { messages: result.messages, stats: result.stats }
  }

  /**
   * Retourne les stats de la dernière compression.
   */
  getStats(): FullStats | null {
    return this.lastStats
  }

  /**
   * Restaure le contenu original d'un bloc compressé.
   */
  restore(refId: string): string | null {
    return restoreToolResult(refId)
  }

  /**
   * Remet la session à zéro.
   */
  reset(): void {
    this.tracker.reset()
    this.lastStats = null
  }
}

// ─── Stats persistantes (cork-ai gain) ───────────────────────────────────────

export { recordSession, readGlobalStats, resetGlobalStats } from './cli/persistent-stats.js'
export type { GlobalStats, SessionRecord } from './cli/persistent-stats.js'

// ─── Exports des modules individuels (usage avancé) ──────────────────────────

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

// ─── Types publics ────────────────────────────────────────────────────────────

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
