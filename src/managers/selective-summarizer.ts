/**
 * Selective Summarizer — résumé intelligent préservant les informations critiques.
 * Gain estimé : 20–30% des tokens sur l'historique ancien.
 *
 * Classifie chaque message en deux catégories :
 * - Peut être résumé : explorations, discussions, confirmations
 * - Doit rester verbatim : noms de fichiers, stack traces, décisions, configs
 */

import { countTokens } from '../core/tokenizer.js'
import type {
  CompressResult,
  ContentBlock,
  Message,
  TextBlock,
} from '../types/index.js'

interface SummarizerOptions {
  aggressiveness: number
  /** Nombre minimum de tokens pour résumer un message */
  minTokensToSummarize: number
}

const DEFAULT_OPTIONS: SummarizerOptions = {
  aggressiveness: 0.6,
  minTokensToSummarize: 100,
}

// Patterns indiquant du contenu résumable (exploration, discussion)
const SUMMARIZABLE_PATTERNS = [
  /\b(essayons|let's try|voyons|perhaps|maybe|could we|on pourrait)\b/gi,
  /\b(d'accord|ok|bien|parfait|good|great|sounds good|lgtm)\b/gi,
  /\b(en fait|actually|hmm|je pense|i think|it seems)\b/gi,
]

/**
 * Extrait le texte d'un message.
 */
function extractText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

/**
 * Extrait les éléments verbatim d'un texte (chemins, erreurs, décisions).
 */
function extractVerbatimElements(text: string): string[] {
  const elements: Set<string> = new Set()

  // Chemins de fichiers
  const filePathPattern = /(\/[\w\-./]+\.\w{1,6}|[\w\-.]+\/[\w\-./]+\.\w{1,6})/g
  let m: RegExpExecArray | null
  while ((m = filePathPattern.exec(text)) !== null) {
    elements.add(m[1])
  }

  // Messages d'erreur
  const errorPattern = /(?:Error|Exception|FAIL|error):\s*(.+)/g
  while ((m = errorPattern.exec(text)) !== null) {
    elements.add(m[0].slice(0, 120))
  }

  // Décisions
  const decisionPattern = /(?:on garde|c'est décidé|la règle est|validé|decided|final).*$/gim
  while ((m = decisionPattern.exec(text)) !== null) {
    elements.add(m[0].trim().slice(0, 150))
  }

  // Variables de config
  const configPattern = /[A-Z_]{3,}=\S+/g
  while ((m = configPattern.exec(text)) !== null) {
    elements.add(m[0])
  }

  // Numéros de version et références précises
  const versionPattern = /v\d+\.\d+(?:\.\d+)?/g
  while ((m = versionPattern.exec(text)) !== null) {
    elements.add(m[0])
  }

  return Array.from(elements).slice(0, 10) // limiter le verbatim
}

/**
 * Détermine si un message est principalement exploratoire/résumable.
 */
function isSummarizableMessage(text: string): boolean {
  const summarizableCount = SUMMARIZABLE_PATTERNS.filter(p => {
    p.lastIndex = 0
    return p.test(text)
  }).length

  // Si plusieurs patterns d'exploration trouvés → résumable
  return summarizableCount >= 2
}

/**
 * Crée un résumé compact d'un message en préservant les éléments verbatim.
 */
function createSummary(msg: Message, msgIdx: number, _aggressiveness: number): Message {
  const text = extractText(msg)

  // Extraire les éléments verbatim critiques
  const verbatim = extractVerbatimElements(text)

  // Créer le résumé en prose
  const words = text.split(/\s+/).filter(w => w.length > 0)
  const summaryWordCount = Math.max(15, Math.floor(words.length * 0.15))
  const proseSummary = words.slice(0, summaryWordCount).join(' ').slice(0, 200)

  let summary = `[msg#${msgIdx + 1} résumé: ${proseSummary}${text.length > 200 ? '...' : ''}]`

  if (verbatim.length > 0) {
    summary += `\n[verbatim: ${verbatim.join(' | ')}]`
  }

  const newContent: ContentBlock[] = [{ type: 'text', text: summary } as TextBlock]
  return { ...msg, content: newContent }
}

/**
 * Résume sélectivement l'historique en préservant les informations critiques.
 */
export function selectiveSummarize(
  messages: Message[],
  options?: Partial<SummarizerOptions>,
): CompressResult {
  const opts: SummarizerOptions = { ...DEFAULT_OPTIONS, ...options }
  let savedTokens = 0

  // Garder les N derniers messages intacts (fenêtre récente)
  const keepRecent = Math.max(3, Math.floor(messages.length * 0.3))
  const summarizeUntil = Math.max(0, messages.length - keepRecent)

  const compressed = messages.map((msg, idx) => {
    if (idx >= summarizeUntil) return msg

    const text = extractText(msg)
    const tokenCount = countTokens(text)

    // Ne résumer que les messages substantiels
    if (tokenCount < opts.minTokensToSummarize) return msg

    // Ne résumer que les messages exploratoires
    if (!isSummarizableMessage(text)) return msg

    const summarized = createSummary(msg, idx, opts.aggressiveness)
    const newTokens = countTokens(extractText(summarized))
    savedTokens += Math.max(0, tokenCount - newTokens)
    return summarized
  })

  return { messages: compressed, savedTokens }
}

/**
 * Classe publique pour l'usage avancé.
 */
export class SelectiveSummarizer {
  private opts: SummarizerOptions

  constructor(options?: Partial<SummarizerOptions>) {
    this.opts = { ...DEFAULT_OPTIONS, ...options }
  }

  summarize(messages: Message[], options?: Partial<SummarizerOptions>): CompressResult {
    return selectiveSummarize(messages, { ...this.opts, ...options })
  }
}
