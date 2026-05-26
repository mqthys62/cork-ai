/**
 * Pipeline — orchestrateur principal de cork-ai.
 * Compose les modules selon les options et le budget disponible.
 * Les modules ne se connaissent pas entre eux — tout passe par le pipeline.
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
 * Logger interne silencieux par défaut.
 */
function createLogger(debug = false) {
  return {
    log: (...args: unknown[]) => { if (debug) console.log('[cork-ai]', ...args) },
    warn: (...args: unknown[]) => { if (debug) console.warn('[cork-ai:warn]', ...args) },
  }
}

/**
 * Exécute le pipeline de compression sur un ensemble de messages.
 * @param messages - Historique de conversation à compresser
 * @param options - Options globales
 * @param tracker - StatsTracker partagé (optionnel, crée un nouveau si absent)
 * @returns Messages compressés + stats complètes
 */
export function runPipeline(
  messages: Message[],
  options: CorkAIOptions = {},
  tracker?: StatsTracker,
): PipelineResult {
  const logger = createLogger(options.debug)
  const stats = tracker ?? new StatsTracker(options.pricing)

  logger.log(`Démarrage pipeline sur ${messages.length} messages`)

  const originalTokens = countMessageTokens(messages)
  logger.log(`Tokens initiaux : ${originalTokens}`)

  // Compression via le Budget Manager (orchestre tous les modules)
  const result = compressWithBudget(messages, {
    ...options,
    budget: {
      maxTokens: options.maxContextTokens ?? 150_000,
      hardLimit: options.budget?.hardLimit ?? false,
      ...options.budget,
    },
  })

  // Enregistrer les stats par module
  for (const [name, saved] of Object.entries(result.byModule)) {
    stats.recordModule(name, saved)
  }

  const compressedTokens = countMessageTokens(result.messages)
  logger.log(`Tokens après compression : ${compressedTokens} (économisé : ${originalTokens - compressedTokens})`)

  const fullStats = stats.getFullStats(originalTokens, compressedTokens)

  // Appeler le callback onStats si configuré
  if (options.onStats) {
    try {
      options.onStats(fullStats)
    } catch (e) {
      logger.warn('Erreur dans le callback onStats :', e)
    }
  }

  return {
    messages: result.messages,
    savedTokens: result.savedTokens,
    stats: fullStats,
  }
}
