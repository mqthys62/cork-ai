/**
 * Selective Summarizer — intelligent summarization preserving critical information.
 * Estimated gain: 20–30% of tokens on old conversation history.
 *
 * Classifies each message into two categories:
 * - Can be summarized: explorations, discussions, confirmations
 * - Must stay verbatim: file names, stack traces, decisions, configs
 */

import { countTokens } from '../core/tokenizer.js'
import { hasToolBlocks } from '../core/validate.js'
import type {
  CompressResult,
  ContentBlock,
  Message,
  TextBlock,
} from '../types/index.js'

interface SummarizerOptions {
  aggressiveness: number
  /** Minimum number of tokens to summarize a message */
  minTokensToSummarize: number
}

const DEFAULT_OPTIONS: SummarizerOptions = {
  aggressiveness: 0.6,
  minTokensToSummarize: 100,
}

// Patterns indicating summarizable content (exploration, discussion)
const SUMMARIZABLE_PATTERNS = [
  /\b(essayons|let's try|voyons|perhaps|maybe|could we|on pourrait)\b/gi,
  /\b(d'accord|ok|bien|parfait|good|great|sounds good|lgtm)\b/gi,
  /\b(en fait|actually|hmm|je pense|i think|it seems)\b/gi,
]

/**
 * Extracts text from a message.
 */
function extractText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

/**
 * Extracts verbatim elements from text (paths, errors, decisions).
 */
function extractVerbatimElements(text: string): string[] {
  const elements: Set<string> = new Set()

  // File paths
  const filePathPattern = /(\/[\w\-./]+\.\w{1,6}|[\w\-.]+\/[\w\-./]+\.\w{1,6})/g
  let m: RegExpExecArray | null
  while ((m = filePathPattern.exec(text)) !== null) {
    elements.add(m[1])
  }

  // Error messages
  const errorPattern = /(?:Error|Exception|FAIL|error):\s*(.+)/g
  while ((m = errorPattern.exec(text)) !== null) {
    elements.add(m[0].slice(0, 120))
  }

  // Decisions
  const decisionPattern = /(?:on garde|c'est décidé|la règle est|validé|decided|final).*$/gim
  while ((m = decisionPattern.exec(text)) !== null) {
    elements.add(m[0].trim().slice(0, 150))
  }

  // Config variables
  const configPattern = /[A-Z_]{3,}=\S+/g
  while ((m = configPattern.exec(text)) !== null) {
    elements.add(m[0])
  }

  // Version numbers and precise references
  const versionPattern = /v\d+\.\d+(?:\.\d+)?/g
  while ((m = versionPattern.exec(text)) !== null) {
    elements.add(m[0])
  }

  return Array.from(elements).slice(0, 10) // limiter le verbatim
}

/**
 * Determines whether a message is primarily exploratory/summarizable.
 */
function isSummarizableMessage(text: string): boolean {
  const summarizableCount = SUMMARIZABLE_PATTERNS.filter(p => {
    p.lastIndex = 0
    return p.test(text)
  }).length

  // If multiple exploration patterns found → summarizable
  return summarizableCount >= 2
}

/**
 * Creates a compact summary of a message preserving verbatim elements.
 */
function createSummary(msg: Message, msgIdx: number, _aggressiveness: number): Message {
  const text = extractText(msg)

  // Extract critical verbatim elements
  const verbatim = extractVerbatimElements(text)

  // Create prose summary
  const words = text.split(/\s+/).filter(w => w.length > 0)
  const summaryWordCount = Math.max(15, Math.floor(words.length * 0.15))
  const proseSummary = words.slice(0, summaryWordCount).join(' ').slice(0, 200)

  let summary = `[msg#${msgIdx + 1} summary: ${proseSummary}${text.length > 200 ? '...' : ''}]`

  if (verbatim.length > 0) {
    summary += `\n[verbatim: ${verbatim.join(' | ')}]`
  }

  const newContent: ContentBlock[] = [{ type: 'text', text: summary } as TextBlock]
  return { ...msg, content: newContent }
}

/**
 * Selectively summarizes history while preserving critical information.
 */
export function selectiveSummarize(
  messages: Message[],
  options?: Partial<SummarizerOptions>,
): CompressResult {
  const opts: SummarizerOptions = { ...DEFAULT_OPTIONS, ...options }
  let savedTokens = 0

  // Keep the last N messages intact (recent window)
  const keepRecent = Math.max(3, Math.floor(messages.length * 0.3))
  const summarizeUntil = Math.max(0, messages.length - keepRecent)

  const compressed = messages.map((msg, idx) => {
    if (idx >= summarizeUntil) return msg

    // Never replace messages carrying tool_use/tool_result blocks with a
    // text summary — it orphans the paired block (API 400).
    if (hasToolBlocks(msg)) return msg

    const text = extractText(msg)
    const tokenCount = countTokens(text)

    // Only summarize substantial messages
    if (tokenCount < opts.minTokensToSummarize) return msg

    // Only summarize exploratory messages
    if (!isSummarizableMessage(text)) return msg

    const summarized = createSummary(msg, idx, opts.aggressiveness)
    const newTokens = countTokens(extractText(summarized))
    savedTokens += Math.max(0, tokenCount - newTokens)
    return summarized
  })

  return { messages: compressed, savedTokens }
}

/**
 * Public class for advanced use.
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
