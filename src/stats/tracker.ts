/**
 * Stats Tracker — tracks savings per module and per session.
 * Required to demonstrate library value and guide adaptive compression.
 */

import type {
  FullStats,
  ModuleStats,
  PricingConfig,
  RequestStats,
  SessionStats,
} from '../types/index.js'

const DEFAULT_PRICING: PricingConfig = {
  input: 3.0,   // USD / 1M tokens — Sonnet 4
  output: 15.0, // USD / 1M tokens — Sonnet 4
}

export class StatsTracker {
  private pricing: PricingConfig
  private sessionTotalSaved = 0
  private sessionTotalProcessed = 0
  private sessionRequestCount = 0
  private sessionCostSaved = 0
  private moduleAccumulators: Map<string, ModuleStats> = new Map()

  constructor(pricing?: Partial<PricingConfig>) {
    this.pricing = { ...DEFAULT_PRICING, ...pricing }
  }

  /**
   * Records tokens saved by a module for the current request.
   */
  recordModule(name: string, savedTokens: number): void {
    const existing = this.moduleAccumulators.get(name)
    if (existing) {
      existing.saved += savedTokens
      existing.runs += 1
    } else {
      this.moduleAccumulators.set(name, { name, saved: savedTokens, runs: 1 })
    }
  }

  /**
   * Computes stats for the current request and updates the session.
   */
  getRequestStats(originalTokens: number, compressedTokens: number): RequestStats {
    const savedTokens = Math.max(0, originalTokens - compressedTokens)
    const savingsPercent = originalTokens > 0
      ? Math.round((savedTokens / originalTokens) * 1000) / 10
      : 0
    const estimatedCostSaved = (savedTokens / 1_000_000) * this.pricing.input

    this.sessionTotalSaved += savedTokens
    this.sessionTotalProcessed += originalTokens
    this.sessionRequestCount += 1
    this.sessionCostSaved += estimatedCostSaved

    return {
      originalTokens,
      compressedTokens,
      savedTokens,
      savingsPercent,
      estimatedCostSaved: Math.round(estimatedCostSaved * 1000) / 1000,
    }
  }

  /**
   * Returns cumulative stats for the current session.
   */
  getSessionStats(): SessionStats {
    return {
      totalSaved: this.sessionTotalSaved,
      totalProcessed: this.sessionTotalProcessed,
      estimatedCostSaved: Math.round(this.sessionCostSaved * 1000) / 1000,
      requestCount: this.sessionRequestCount,
    }
  }

  /**
   * Returns full stats (request + session + per module).
   */
  getFullStats(originalTokens: number, compressedTokens: number): FullStats {
    const request = this.getRequestStats(originalTokens, compressedTokens)
    const session = this.getSessionStats()
    const byModule: Record<string, { saved: number; runs: number }> = {}
    for (const [name, stats] of this.moduleAccumulators) {
      byModule[name] = { saved: stats.saved, runs: stats.runs }
    }
    return { request, session, byModule }
  }

  /**
   * Resets the session (call at the start of a new session).
   */
  reset(): void {
    this.sessionTotalSaved = 0
    this.sessionTotalProcessed = 0
    this.sessionRequestCount = 0
    this.sessionCostSaved = 0
    this.moduleAccumulators.clear()
  }

  /** Returns the current pricing configuration. */
  getPricing(): PricingConfig {
    return { ...this.pricing }
  }
}
