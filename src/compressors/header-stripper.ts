/**
 * Header Stripper — removes repetitive headers from user messages.
 * Estimated gain: 5–10% of input tokens.
 *
 * Claude Code injects a header into each user message containing CWD, open files,
 * timestamps, env vars. This module detects and deduplicates these blocks.
 */

import { countTokens } from '../core/tokenizer.js'
import type { CompressResult, ContentBlock, HeaderStripperOptions, Message, TextBlock } from '../types/index.js'

const DEFAULT_OPTIONS: HeaderStripperOptions = {
  aggressiveness: 0.6,
}

// Detection patterns for Claude Code headers
const HEADER_PATTERNS = [
  /^<environment[\s>]/m,
  /^<files[\s>]/m,
  /^CWD:\s/m,
  /^OS:\s/m,
  /^Platform:\s/m,
  /^Working directory:\s/mi,
  /^Current working directory:\s/mi,
  /^<system-reminder>/m,
  /^\[Timestamp:/m,
  /^Date:\s\d/m,
]

/**
 * Detects whether a text contains a Claude Code header.
 */
function hasHeader(text: string): boolean {
  return HEADER_PATTERNS.some(p => p.test(text))
}

/**
 * Extracts key=value fields from a header.
 */
function parseHeaderFields(text: string): Map<string, string> {
  const fields = new Map<string, string>()

  // CWD / OS / Platform
  const simplePatterns: [RegExp, string][] = [
    [/CWD:\s*(.+)/m, 'CWD'],
    [/OS:\s*(.+)/m, 'OS'],
    [/Platform:\s*(.+)/m, 'Platform'],
    [/Working directory:\s*(.+)/mi, 'CWD'],
    [/Current working directory:\s*(.+)/mi, 'CWD'],
  ]
  for (const [pattern, key] of simplePatterns) {
    const m = text.match(pattern)
    if (m) fields.set(key, m[1].trim())
  }

  // Blocs XML-like
  const xmlBlockPattern = /<(\w+)([^>]*)>([\s\S]*?)<\/\1>/g
  let match: RegExpExecArray | null
  while ((match = xmlBlockPattern.exec(text)) !== null) {
    fields.set(match[1], match[3].trim().slice(0, 200))
  }

  // Open files
  const filesMatch = text.match(/(?:open(?:ed)? files?|fichiers? ouverts?):\s*(.+)/im)
  if (filesMatch) fields.set('files', filesMatch[1].trim())

  return fields
}

/**
 * Computes the diff between two sets of header fields.
 */
function computeHeaderDiff(
  prev: Map<string, string>,
  curr: Map<string, string>,
): { changed: Map<string, string>; unchanged: string[] } {
  const changed = new Map<string, string>()
  const unchanged: string[] = []

  for (const [key, value] of curr) {
    const prevValue = prev.get(key)
    if (prevValue === value) {
      unchanged.push(key)
    } else {
      changed.set(key, value)
    }
  }

  return { changed, unchanged }
}

/**
 * Extracts the header part and the body part of a message.
 */
function splitHeaderFromContent(text: string): { headerPart: string; bodyPart: string } {
  // Strategy: the header is at the beginning of the message before the first substantial content
  // Find the end of metadata blocks
  const lines = text.split('\n')
  let headerEndLine = 0

  // Detect XML header blocks
  let inXmlBlock = false
  let xmlBlockDepth = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (/<(environment|files|system-reminder|metadata)[^>]*>/.test(line)) {
      inXmlBlock = true
      xmlBlockDepth++
    }
    if (inXmlBlock && /<\/(environment|files|system-reminder|metadata)>/.test(line)) {
      xmlBlockDepth--
      if (xmlBlockDepth === 0) {
        inXmlBlock = false
        headerEndLine = i + 1
      }
    }

    // Simple metadata lines (CWD:, OS:, etc.)
    if (!inXmlBlock && /^(CWD|OS|Platform|Date|Working directory):\s/i.test(line)) {
      headerEndLine = i + 1
    }
  }

  if (headerEndLine === 0) {
    return { headerPart: '', bodyPart: text }
  }

  return {
    headerPart: lines.slice(0, headerEndLine).join('\n'),
    bodyPart: lines.slice(headerEndLine).join('\n').trimStart(),
  }
}

/**
 * Removes repetitive headers from user messages.
 * Keeps the first header in full, replaces subsequent ones with a diff.
 */
export function stripHeaders(
  messages: Message[],
  options?: Partial<HeaderStripperOptions>,
): CompressResult {
  const _opts: HeaderStripperOptions = { ...DEFAULT_OPTIONS, ...options }
  void _opts // reserved for future options
  let savedTokens = 0
  let lastHeaderFields: Map<string, string> | null = null
  let firstHeaderSeen = false

  const compressed = messages.map(msg => {
    if (msg.role !== 'user') return msg

    // Process text content
    const processText = (text: string): string => {
      if (!hasHeader(text)) return text

      const { headerPart, bodyPart } = splitHeaderFromContent(text)
      if (!headerPart) return text

      const currentFields = parseHeaderFields(headerPart)

      if (!firstHeaderSeen) {
        // First header: keep in full
        firstHeaderSeen = true
        lastHeaderFields = currentFields
        return text
      }

      // Subsequent headers: replace with a diff
      const originalTokenCount = countTokens(headerPart)

      let replacement: string
      if (!lastHeaderFields || lastHeaderFields.size === 0) {
        replacement = '[env: header present]'
      } else {
        const { changed, unchanged } = computeHeaderDiff(lastHeaderFields, currentFields)

        if (changed.size === 0) {
          replacement = '[env: identical to previous message]'
        } else {
          const changedParts: string[] = []
          for (const [key, value] of changed) {
            changedParts.push(`${key}=${value}`)
          }
          const unchangedSummary = unchanged.length > 0
            ? `, ${unchanged.length} field(s) unchanged`
            : ''
          replacement = `[env: ${changedParts.join(', ')}${unchangedSummary}]`
        }
      }

      lastHeaderFields = currentFields
      savedTokens += Math.max(0, originalTokenCount - countTokens(replacement))

      return `${replacement}\n${bodyPart}`
    }

    if (typeof msg.content === 'string') {
      return { ...msg, content: processText(msg.content) }
    }

    const newContent: ContentBlock[] = msg.content.map(block => {
      if (block.type !== 'text') return block
      const newText = processText(block.text)
      return newText !== block.text ? { ...block, text: newText } as TextBlock : block
    })

    return { ...msg, content: newContent }
  })

  return { messages: compressed, savedTokens }
}
