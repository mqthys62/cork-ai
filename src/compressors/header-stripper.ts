/**
 * Header Stripper — suppression des headers répétitifs dans les messages user.
 * Gain estimé : 5–10% des tokens input.
 *
 * Claude Code injecte dans chaque message user un header contenant CWD, fichiers
 * ouverts, timestamp, variables d'env. Ce module détecte et déduplique ces blocs.
 */

import { countTokens } from '../core/tokenizer.js'
import type { CompressResult, ContentBlock, HeaderStripperOptions, Message, TextBlock } from '../types/index.js'

const DEFAULT_OPTIONS: HeaderStripperOptions = {
  aggressiveness: 0.6,
}

// Patterns de détection des headers Claude Code
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
 * Détecte si un texte contient un header Claude Code.
 */
function hasHeader(text: string): boolean {
  return HEADER_PATTERNS.some(p => p.test(text))
}

/**
 * Extrait les champs clé=valeur d'un header.
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

  // Fichiers ouverts
  const filesMatch = text.match(/(?:open(?:ed)? files?|fichiers? ouverts?):\s*(.+)/im)
  if (filesMatch) fields.set('files', filesMatch[1].trim())

  return fields
}

/**
 * Calcule le diff entre deux ensembles de champs de header.
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
 * Extrait la partie header et la partie contenu réel d'un message.
 */
function splitHeaderFromContent(text: string): { headerPart: string; bodyPart: string } {
  // Stratégie : le header est au début du message avant le premier contenu substantiel
  // Chercher la fin des blocs de metadata
  const lines = text.split('\n')
  let headerEndLine = 0

  // Détecter les blocs XML de header
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

    // Lignes de metadata simples (CWD:, OS:, etc.)
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
 * Supprime les headers répétitifs des messages user.
 * Conserve le premier header intégralement, remplace les suivants par un diff.
 */
export function stripHeaders(
  messages: Message[],
  options?: Partial<HeaderStripperOptions>,
): CompressResult {
  const _opts: HeaderStripperOptions = { ...DEFAULT_OPTIONS, ...options }
  void _opts // utilisé implicitement pour les options futures
  let savedTokens = 0
  let lastHeaderFields: Map<string, string> | null = null
  let firstHeaderSeen = false

  const compressed = messages.map(msg => {
    if (msg.role !== 'user') return msg

    // Traiter le contenu textuel
    const processText = (text: string): string => {
      if (!hasHeader(text)) return text

      const { headerPart, bodyPart } = splitHeaderFromContent(text)
      if (!headerPart) return text

      const currentFields = parseHeaderFields(headerPart)

      if (!firstHeaderSeen) {
        // Premier header : conserver intégralement
        firstHeaderSeen = true
        lastHeaderFields = currentFields
        return text
      }

      // Headers suivants : remplacer par un diff
      const originalTokenCount = countTokens(headerPart)

      let replacement: string
      if (!lastHeaderFields || lastHeaderFields.size === 0) {
        replacement = '[env: header présent]'
      } else {
        const { changed, unchanged } = computeHeaderDiff(lastHeaderFields, currentFields)

        if (changed.size === 0) {
          replacement = '[env: identique au message précédent]'
        } else {
          const changedParts: string[] = []
          for (const [key, value] of changed) {
            changedParts.push(`${key}=${value}`)
          }
          const unchangedSummary = unchanged.length > 0
            ? `, ${unchanged.length} champ(s) inchangé(s)`
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
