/**
 * Heatmap Manager — relevance scoring of conversation history.
 * Estimated gain: 15–25% of input tokens.
 *
 * Scores each message on 4 dimensions: recency, lexical relevance,
 * content type, and recent references. Messages below the threshold
 * are summarized to one line (never deleted).
 */

import { countTokens } from '../core/tokenizer.js'
import { hasToolBlocks } from '../core/validate.js'
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

// Messages containing code blocks are API contracts or
// read results — removing them loses critical information
// (signatures, configs, stack traces). Floor score to protect them.
const CODE_BLOCK_SCORE_FLOOR = 0.30

// High permanent value content patterns
const HIGH_VALUE_PATTERNS = [
  // Decisions
  /\b(j'ai décidé|on va utiliser|la décision|on a choisi|il est décidé|on garde|c'est décidé)\b/i,
  /\b(decided|we'll use|decision|chosen|the rule is|keeping|final choice)\b/i,
  // Resolved errors
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
 * Extracts text content from a message.
 */
function extractText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

/**
 * Tokenizes text into significant terms (lightweight version).
 */
function quickTokenize(text: string): Set<string> {
  const terms = text.toLowerCase().split(/\W+/).filter(t => t.length > 3)
  return new Set(terms)
}

/**
 * Scores a message on multiple dimensions (0–1 per dimension).
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

  // Dimension 1: Recency (higher score for recent messages)
  const recencyScore = msgIdx / Math.max(1, totalMessages - 1)
  if (recencyScore > 0.7) reasons.push('recent')

  // Dimension 2: Lexical relevance (overlap with the last N messages)
  const msgTerms = quickTokenize(text)
  let overlap = 0
  for (const term of msgTerms) {
    if (recentTerms.has(term)) overlap++
  }
  const relevanceScore = msgTerms.size > 0 ? Math.min(1, overlap / Math.sqrt(msgTerms.size)) : 0
  if (relevanceScore > 0.3) reasons.push('lexically relevant')

  // Dimension 3: Content type (permanent bonus for decisions/configs/errors)
  let contentScore = 0
  if (HIGH_VALUE_PATTERNS.some(p => p.test(text))) {
    contentScore = 0.8
    reasons.push('high-value content')
  } else if (MEDIUM_VALUE_PATTERNS.some(p => p.test(text))) {
    contentScore = 0.4
    reasons.push('medium-value content')
  }

  // Dimension 4: Recently referenced
  const referenceScore = recentlyReferenced.has(msgIdx) ? 0.7 : 0
  if (referenceScore > 0) reasons.push('recently referenced')

  // Combined score (weighted)
  let score =
    recencyScore * 0.35 +
    relevanceScore * 0.30 +
    contentScore * 0.25 +
    referenceScore * 0.10

  // Floor for messages containing code blocks: function signatures,
  // interfaces and configs are critical contracts for code quality
  // — never summarize them regardless of their recency score.
  const hasCodeBlock = /```[\s\S]{10,}```/.test(text)
  if (hasCodeBlock) {
    score = Math.max(score, CODE_BLOCK_SCORE_FLOOR)
    reasons.push('contains a code block')
  }

  return {
    messageIndex: msgIdx,
    score: Math.round(score * 100) / 100,
    reason: reasons.length > 0 ? reasons.join(', ') : 'low relevance',
  }
}

/**
 * Builds the term index from the last N messages.
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
 * Detects references to message numbers in the text.
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
 * Scores all messages in the conversation history.
 */
export function scoreMessages(
  messages: Message[],
  options?: Partial<HeatmapOptions>,
): HeatmapScore[] {
  const opts: HeatmapOptions = { ...DEFAULT_OPTIONS, ...options }

  // Build the index of recently referenced messages
  const recentlyReferenced = new Set<number>()
  const windowStart = Math.max(0, messages.length - opts.windowSize)
  for (let i = windowStart; i < messages.length; i++) {
    const text = extractText(messages[i])
    for (const ref of detectReferences(text)) {
      recentlyReferenced.add(ref)
    }
  }

  // Terms from recent messages for relevance scoring
  const recentTerms = buildRecentTerms(messages, opts.windowSize, messages.length - 1)

  return messages.map((msg, idx) =>
    scoreMessage(msg, idx, messages.length, recentTerms, recentlyReferenced, opts)
  )
}

/**
 * Creates a one-line summary for a low-relevance message.
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
 * Compresses history by summarizing low-relevance messages.
 * @param messages - Full conversation history
 * @param threshold - Score threshold (defaults from options)
 * @param options - Heatmap options
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

  // Never compress the last N messages (recent window)
  const keepRecent = opts.windowSize
  const compressUntil = Math.max(0, messages.length - keepRecent)

  const compressed = messages.map((msg, idx) => {
    if (idx >= compressUntil) return msg
    // Never summarize messages carrying tool_use/tool_result blocks:
    // replacing them with a text block orphans the paired block in the
    // adjacent message and the API rejects the request (400).
    if (hasToolBlocks(msg)) return msg
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
