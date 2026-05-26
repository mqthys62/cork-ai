/**
 * Stats Tracker — suivi des économies par module et par session.
 * Nécessaire pour démontrer la valeur de la lib et guider la compression adaptative.
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
   * Enregistre les tokens économisés par un module pour la requête courante.
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
   * Calcule les stats de la requête courante et met à jour la session.
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
   * Retourne les stats cumulées de la session courante.
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
   * Retourne les stats complètes (requête + session + par module).
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
   * Remet la session à zéro (à appeler en début de nouvelle session).
   */
  reset(): void {
    this.sessionTotalSaved = 0
    this.sessionTotalProcessed = 0
    this.sessionRequestCount = 0
    this.sessionCostSaved = 0
    this.moduleAccumulators.clear()
  }

  /** Retourne la configuration de pricing courante. */
  getPricing(): PricingConfig {
    return { ...this.pricing }
  }
}
