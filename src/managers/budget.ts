/**
 * Budget Manager — orchestration adaptative de la compression selon le budget tokens.
 * Paliers : passthrough < 40%, L1 40–65%, L1+L2 65–80%, tout > 80%.
 *
 * C'est le module central qui décide quoi activer selon la pression budgétaire.
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
 * Détermine le niveau de compression selon le ratio tokens/budget.
 */
function getCompressionLevel(tokenCount: number, maxTokens: number): CompressionLevel {
  const ratio = tokenCount / maxTokens
  if (ratio < 0.40) return 'none'
  if (ratio < 0.65) return 'level1'
  if (ratio < 0.80) return 'level2'
  return 'all'
}

/**
 * Calcule le seuil heatmap ajusté selon la pression budgétaire.
 * Monotone : plus la pression est forte, plus le seuil baisse (moins de messages
 * compressés par le heatmap — on délègue davantage aux autres modules).
 * Valeurs abaissées pour ne pas écraser les messages avec code blocks (floor=0.30).
 */
function adaptiveHeatmapThreshold(ratio: number): number {
  if (ratio < 0.65) return 0.40 // level1 — heatmap ne tourne pas ici (safety)
  if (ratio < 0.80) return 0.25 // level2 — légèrement moins agressif (était 0.30)
  return 0.15                   // all — délègue à semantic dedup + summarizer (était 0.20)
}

/**
 * Compresse les messages selon le budget disponible.
 * @param messages - Historique de conversation
 * @param options - Options globales cork-ai
 * @returns Messages compressés + tokens économisés par module
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

  // Vérifier la limite stricte avant même de compresser
  if (budget.hardLimit && ratio > 1.0) {
    throw new Error(
      `[cork-ai] Le contexte dépasse le budget maximum : ${originalTokens} tokens > ${budget.maxTokens} tokens. ` +
      `Réduisez le nombre de messages ou augmentez maxContextTokens.`
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

  // Niveau 1 : Tool results + Headers (toujours en premier — plus gros gain)
  if (level === 'level1' || level === 'level2' || level === 'all') {
    apply('toolResultCompressor', msgs =>
      compressToolResults(msgs, { aggressiveness })
    )
    apply('headerStripper', msgs =>
      stripHeaders(msgs, { aggressiveness })
    )
  }

  // Niveau 2 : Code dedup + Heatmap
  if (level === 'level2' || level === 'all') {
    apply('codeDedup', msgs =>
      deduplicateCode(msgs, { aggressiveness })
    )

    const heatThreshold = adaptiveHeatmapThreshold(ratio)
    apply('heatmap', msgs =>
      compressWithHeatmap(msgs, heatThreshold, { windowSize: 5, threshold: heatThreshold })
    )
  }

  // Niveau 3 : Semantic dedup + Selective summarizer
  if (level === 'all') {
    apply('semanticDedup', msgs =>
      deduplicateSemantic(msgs, { similarityThreshold: 0.82 })
    )
    apply('selectiveSummarizer', msgs =>
      selectiveSummarize(msgs, { aggressiveness, minTokensToSummarize: 100 })
    )
  }

  // Vérifier la limite stricte après compression
  if (budget.hardLimit) {
    const finalTokens = countMessageTokens(current)
    if (finalTokens > budget.maxTokens) {
      throw new Error(
        `[cork-ai] Même après compression, le contexte dépasse le budget : ` +
        `${finalTokens} tokens > ${budget.maxTokens} tokens.`
      )
    }
  }

  return { messages: current, savedTokens: totalSaved, byModule }
}

/**
 * Classe publique pour l'usage avancé.
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
