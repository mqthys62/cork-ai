/**
 * Heatmap Manager — scoring de pertinence de l'historique.
 * Gain estimé : 15–25% des tokens input.
 *
 * Score chaque message sur 4 dimensions : récence, pertinence lexicale,
 * type de contenu, et références récentes. Les messages sous le seuil
 * sont résumés à une ligne (jamais supprimés).
 */

import { countTokens } from '../core/tokenizer.js'
import type {
  CompressResult,
  ContentBlock,
  HeatmapOptions,
  HeatmapScore,
  Message,
  TextBlock,
} from '../types/index.js'

const DEFAULT_OPTIONS: HeatmapOptions = {
  windowSize: 5,
  threshold: 0.3,
}

// Patterns de contenu à haute valeur permanente
const HIGH_VALUE_PATTERNS = [
  // Décisions
  /\b(j'ai décidé|on va utiliser|la décision|on a choisi|il est décidé|on garde|c'est décidé)\b/i,
  /\b(decided|we'll use|decision|chosen|the rule is|keeping|final choice)\b/i,
  // Erreurs résolues
  /\b(le problème était|la solution|fixed by|solved|root cause|was caused by)\b/i,
  /\b(le bug venait de|corrigé en|la cause était)\b/i,
  // Configurations
  /\b(configuration|config|settings|\.env|API_KEY|TOKEN|SECRET)\b/i,
  // Architecture
  /\b(architecture|structure|design pattern|on utilise|interface|abstract)\b/i,
]

const MEDIUM_VALUE_PATTERNS = [
  /\b(error|Error|exception|Exception|FAIL|warning)\b/,
  /\b(important|critical|attention|note|warning|caveat)\b/i,
  /\b(TODO|FIXME|HACK|NOTE|BUG)\b/,
]

/**
 * Extrait le contenu textuel d'un message.
 */
function extractText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

/**
 * Tokenise un texte en termes significatifs (version légère).
 */
function quickTokenize(text: string): Set<string> {
  const terms = text.toLowerCase().split(/\W+/).filter(t => t.length > 3)
  return new Set(terms)
}

/**
 * Score un message sur plusieurs dimensions (0–1 par dimension).
 */
function scoreMessage(
  msg: Message,
  msgIdx: number,
  totalMessages: number,
  recentTerms: Set<string>,
  recentlyReferenced: Set<number>,
  _opts: HeatmapOptions,
): HeatmapScore {
  const text = extractText(msg)
  const reasons: string[] = []

  // Dimension 1 : Récence (score plus élevé pour les messages récents)
  const recencyScore = msgIdx / Math.max(1, totalMessages - 1)
  if (recencyScore > 0.7) reasons.push('récent')

  // Dimension 2 : Pertinence lexicale (overlap avec les N derniers messages)
  const msgTerms = quickTokenize(text)
  let overlap = 0
  for (const term of msgTerms) {
    if (recentTerms.has(term)) overlap++
  }
  const relevanceScore = msgTerms.size > 0 ? Math.min(1, overlap / Math.sqrt(msgTerms.size)) : 0
  if (relevanceScore > 0.3) reasons.push('pertinent lexicalement')

  // Dimension 3 : Type de contenu (bonus permanent pour décisions/configs/erreurs)
  let contentScore = 0
  if (HIGH_VALUE_PATTERNS.some(p => p.test(text))) {
    contentScore = 0.8
    reasons.push('contenu haute valeur')
  } else if (MEDIUM_VALUE_PATTERNS.some(p => p.test(text))) {
    contentScore = 0.4
    reasons.push('contenu moyenne valeur')
  }

  // Dimension 4 : Référencé récemment
  const referenceScore = recentlyReferenced.has(msgIdx) ? 0.7 : 0
  if (referenceScore > 0) reasons.push('référencé récemment')

  // Score combiné (pondéré)
  const score =
    recencyScore * 0.35 +
    relevanceScore * 0.30 +
    contentScore * 0.25 +
    referenceScore * 0.10

  return {
    messageIndex: msgIdx,
    score: Math.round(score * 100) / 100,
    reason: reasons.length > 0 ? reasons.join(', ') : 'faible pertinence',
  }
}

/**
 * Construit l'index des termes des N derniers messages.
 */
function buildRecentTerms(messages: Message[], windowSize: number, currentIdx: number): Set<string> {
  const terms = new Set<string>()
  const start = Math.max(0, currentIdx - windowSize)
  for (let i = start; i < Math.min(currentIdx + 1, messages.length); i++) {
    const text = extractText(messages[i])
    for (const term of quickTokenize(text)) {
      terms.add(term)
    }
  }
  return terms
}

/**
 * Détecte les références à des numéros de messages dans le texte.
 */
function detectReferences(text: string): number[] {
  const refs: number[] = []
  const pattern = /message\s*#(\d+)|msg\s*#(\d+)|\(#(\d+)\)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const num = parseInt(match[1] || match[2] || match[3], 10)
    if (!isNaN(num)) refs.push(num - 1) // 0-indexed
  }
  return refs
}

/**
 * Score tous les messages de l'historique.
 */
export function scoreMessages(
  messages: Message[],
  options?: Partial<HeatmapOptions>,
): HeatmapScore[] {
  const opts: HeatmapOptions = { ...DEFAULT_OPTIONS, ...options }

  // Construire l'index des messages récemment référencés
  const recentlyReferenced = new Set<number>()
  const windowStart = Math.max(0, messages.length - opts.windowSize)
  for (let i = windowStart; i < messages.length; i++) {
    const text = extractText(messages[i])
    for (const ref of detectReferences(text)) {
      recentlyReferenced.add(ref)
    }
  }

  // Termes des derniers messages pour la pertinence
  const recentTerms = buildRecentTerms(messages, opts.windowSize, messages.length - 1)

  return messages.map((msg, idx) =>
    scoreMessage(msg, idx, messages.length, recentTerms, recentlyReferenced, opts)
  )
}

/**
 * Crée un résumé d'une ligne pour un message peu pertinent.
 */
function summarizeMessage(msg: Message, msgIdx: number, score: HeatmapScore): Message {
  const text = extractText(msg)
  const preview = text.slice(0, 80).replace(/\n/g, ' ').trim()
  const ellipsis = text.length > 80 ? '...' : ''
  const summary = `[msg#${msgIdx + 1} (score:${score.score}): ${preview}${ellipsis}]`

  if (typeof msg.content === 'string') {
    return { ...msg, content: summary }
  }

  const newContent: ContentBlock[] = [{ type: 'text', text: summary } as TextBlock]
  return { ...msg, content: newContent }
}

/**
 * Compresse l'historique en résumant les messages peu pertinents.
 * @param messages - Historique complet
 * @param threshold - Seuil de score (défaut depuis options)
 * @param options - Options du heatmap
 */
export function compressWithHeatmap(
  messages: Message[],
  threshold?: number,
  options?: Partial<HeatmapOptions>,
): CompressResult {
  const opts: HeatmapOptions = { ...DEFAULT_OPTIONS, ...options }
  const effectiveThreshold = threshold ?? opts.threshold
  let savedTokens = 0

  const scores = scoreMessages(messages, opts)

  // Ne jamais comprimer les N derniers messages (fenêtre récente)
  const keepRecent = opts.windowSize
  const compressUntil = Math.max(0, messages.length - keepRecent)

  const compressed = messages.map((msg, idx) => {
    if (idx >= compressUntil) return msg
    const score = scores[idx]
    if (score.score >= effectiveThreshold) return msg

    const originalTokens = countTokens(extractText(msg))
    const summarized = summarizeMessage(msg, idx, score)
    const newTokens = countTokens(extractText(summarized))
    savedTokens += Math.max(0, originalTokens - newTokens)
    return summarized
  })

  return { messages: compressed, savedTokens }
}

/**
 * Alias pour l'interface publique.
 */
export class HeatmapManager {
  private opts: HeatmapOptions

  constructor(options?: Partial<HeatmapOptions>) {
    this.opts = { ...DEFAULT_OPTIONS, ...options }
  }

  score(messages: Message[]): HeatmapScore[] {
    return scoreMessages(messages, this.opts)
  }

  compress(messages: Message[], threshold?: number): CompressResult {
    return compressWithHeatmap(messages, threshold, this.opts)
  }
}
