/**
 * Stats Tracker — tracks savings per module and per session.
 *
 * Two layers of numbers, kept separate on purpose:
 *   - estimated: computed from local token counts (pre-send compression)
 *   - measured:  ground truth from the API's `response.usage` (wrapClient path)
 *
 * Pricing comes from the shared src/pricing module (per-model, four billing
 * tiers). A custom PricingConfig passed by the caller overrides auto-detection.
 */

import {
  costOfUsage,
  resolvePricing,
  type ApiUsage,
} from '../pricing/index.js'
import type {
  FullStats,
  MeasuredUsageStats,
  ModuleStats,
  PricingConfig,
  RequestStats,
  SessionStats,
} from '../types/index.js'

export class StatsTracker {
  private customPricing: Partial<PricingConfig> | undefined
  private model: string | undefined
  private sessionTotalSaved = 0
  private sessionTotalProcessed = 0
  private sessionRequestCount = 0
  private sessionCostSaved = 0
  private measured: MeasuredUsageStats | null = null
  private moduleAccumulators: Map<string, ModuleStats> = new Map()

  constructor(pricing?: Partial<PricingConfig>) {
    this.customPricing = pricing
  }

  /** Sets the model used for pricing (auto-detected from request params). */
  setModel(modelId?: string): void {
    if (modelId) this.model = modelId
  }

  getModel(): string | undefined {
    return this.model
  }

  /** USD per million input tokens currently in effect. */
  private inputPrice(): number {
    if (this.customPricing?.input !== undefined) return this.customPricing.input
    return resolvePricing(this.model).input
  }

  /** USD per million cache-read tokens currently in effect. */
  private cacheReadPrice(): number {
    // Anthropic bills cache reads at 0.1× the input price on every model.
    if (this.customPricing?.input !== undefined) return this.customPricing.input * 0.1
    return resolvePricing(this.model).cacheRead
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
   *
   * When the newly/frozen breakdown is provided (prefix-stable mode), the
   * cost estimate is cache-aware: newly-compressed tokens would have been
   * billed at input rate, previously-frozen tokens at cache-read rate (0.1×).
   * Without the breakdown, everything is valued at input rate (legacy
   * behavior — an overestimate whenever the caller's history was cached).
   */
  getRequestStats(
    originalTokens: number,
    compressedTokens: number,
    breakdown?: { newlySavedTokens: number; frozenSavedTokens: number },
  ): RequestStats {
    const savedTokens = Math.max(0, originalTokens - compressedTokens)
    const savingsPercent = originalTokens > 0
      ? Math.round((savedTokens / originalTokens) * 1000) / 10
      : 0

    let estimatedCostSaved: number
    if (breakdown) {
      estimatedCostSaved =
        (breakdown.newlySavedTokens / 1_000_000) * this.inputPrice() +
        (breakdown.frozenSavedTokens / 1_000_000) * this.cacheReadPrice()
    } else {
      estimatedCostSaved = (savedTokens / 1_000_000) * this.inputPrice()
    }

    this.sessionTotalSaved += savedTokens
    this.sessionTotalProcessed += originalTokens
    this.sessionRequestCount += 1
    this.sessionCostSaved += estimatedCostSaved

    return {
      originalTokens,
      compressedTokens,
      savedTokens,
      savingsPercent,
      estimatedCostSaved: Math.round(estimatedCostSaved * 100000) / 100000,
      ...(breakdown
        ? {
            newlySavedTokens: breakdown.newlySavedTokens,
            frozenSavedTokens: breakdown.frozenSavedTokens,
          }
        : {}),
    }
  }

  /**
   * Records ground-truth usage from the API response (`response.usage`).
   * Cost is computed across the four billing tiers at the response model's price.
   */
  recordMeasuredUsage(usage: ApiUsage, modelId?: string): void {
    if (modelId) this.model = modelId
    if (!this.measured) {
      this.measured = {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUSD: 0,
      }
    }
    this.measured.requests += 1
    this.measured.inputTokens += usage.input_tokens ?? 0
    this.measured.outputTokens += usage.output_tokens ?? 0
    this.measured.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
    this.measured.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
    this.measured.costUSD += costOfUsage(usage, modelId ?? this.model)
  }

  /** Last recorded measured usage totals (null if never measured). */
  getMeasuredUsage(): MeasuredUsageStats | null {
    return this.measured ? { ...this.measured } : null
  }

  /**
   * Returns cumulative stats for the current session.
   */
  getSessionStats(): SessionStats {
    return {
      totalSaved: this.sessionTotalSaved,
      totalProcessed: this.sessionTotalProcessed,
      estimatedCostSaved: Math.round(this.sessionCostSaved * 100000) / 100000,
      requestCount: this.sessionRequestCount,
      ...(this.measured ? { measured: { ...this.measured } } : {}),
    }
  }

  /**
   * Returns full stats (request + session + per module).
   */
  getFullStats(
    originalTokens: number,
    compressedTokens: number,
    breakdown?: { newlySavedTokens: number; frozenSavedTokens: number },
  ): FullStats {
    const request = this.getRequestStats(originalTokens, compressedTokens, breakdown)
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
    this.measured = null
    this.moduleAccumulators.clear()
  }

  /** Returns the pricing configuration currently in effect (input/output). */
  getPricing(): PricingConfig {
    const resolved = resolvePricing(this.model)
    return {
      input: this.customPricing?.input ?? resolved.input,
      output: this.customPricing?.output ?? resolved.output,
    }
  }
}
