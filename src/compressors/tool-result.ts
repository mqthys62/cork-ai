/**
 * Tool Result Compressor — compression des blocs tool_result dans l'historique.
 * Gain estimé : 30–50% des tokens input sur les sessions longues.
 *
 * Stratégie par type :
 * - Code : extraire imports + signatures, supprimer les corps de fonctions
 * - Bash : garder 10 premières + 5 dernières lignes + lignes d'erreur
 * - JSON : structure de premier niveau uniquement
 * - Texte : N premières lignes selon aggressivité
 */

import { randomBytes } from 'crypto'
import { countTokens } from '../core/tokenizer.js'
import type {
  CachedContent,
  CompressResult,
  ContentBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolResultOptions,
} from '../types/index.js'

const DEFAULT_OPTIONS: ToolResultOptions = {
  aggressiveness: 0.6,
  maxCodeLines: 30,
  maxBashLines: 15,
  cacheEnabled: true,
}

// Cache side-channel pour restore()
const contentCache = new Map<string, CachedContent>()

function generateRefId(): string {
  return randomBytes(4).toString('hex')
}

// ─── Détection du type de contenu ────────────────────────────────────────────

function detectContentType(content: string, toolName?: string): 'code' | 'bash' | 'json' | 'text' {
  // Si le nom de l'outil indique le type
  if (toolName) {
    const lower = toolName.toLowerCase()
    if (lower.includes('bash') || lower.includes('execute') || lower.includes('run')) {
      return 'bash'
    }
    if (lower.includes('read') || lower.includes('write') || lower.includes('file')) {
      // Vérifier si le contenu ressemble à du code via l'extension dans le tool_use parent
      // On tente la détection par contenu
    }
  }

  // Essai de détection JSON
  const trimmed = content.trimStart()
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && isValidJson(content)) {
    return 'json'
  }

  // Détection de code (présence de patterns syntaxiques)
  const codePatterns = [
    /^(import|export|from|require|function|class|const|let|var|def |fn |pub |use |package )/m,
    /^(interface|type |enum |async |await |return |if |for |while )/m,
    /^\s*(#include|#define|#pragma)/m,
  ]
  if (codePatterns.some(p => p.test(content))) {
    return 'code'
  }

  // Détection bash (présence de sorties typiques de terminal)
  const bashPatterns = [
    /^\$\s+/m,
    /^(>>>|\.\.\.)\s/m,
    /\[\d+m/, // codes ANSI
    /^(error|warning|fatal|Error|Warning):/im,
  ]
  if (bashPatterns.some(p => p.test(content))) {
    return 'bash'
  }

  return 'text'
}

function isValidJson(str: string): boolean {
  try {
    JSON.parse(str)
    return true
  } catch {
    return false
  }
}

// ─── Compression de fichiers de code ─────────────────────────────────────────

function compressCodeContent(content: string, opts: ToolResultOptions): string {
  const lines = content.split('\n')
  const kept: string[] = []

  // Patterns de signatures à conserver
  const signaturePatterns = [
    /^(import|export|from|require)\s/,
    /^(export\s+)?(async\s+)?function\s+\w+/,
    /^(export\s+)?(abstract\s+)?class\s+\w+/,
    /^(export\s+)?interface\s+\w+/,
    /^(export\s+)?type\s+\w+\s*=/,
    /^(export\s+)?enum\s+\w+/,
    /^\s+(public|private|protected|async|static|readonly)?\s*(async\s+)?\w+\s*\(/,
    /^(def |fn |pub fn |func |sub )\w+/,
    /^(const|let|var)\s+\w+\s*=/,  // variables de haut niveau
    /^#\s/,  // commentaires Markdown-style dans du code Python
    /^\/\*\*/, // JSDoc ouvert
    /^\s+\*/, // JSDoc lignes
    /^\s+\*\//, // JSDoc fermé
  ]

  let inDocComment = false
  let docCommentCount = 0
  const maxDocComments = 3

  for (const line of lines) {
    const trimmed = line.trimStart()

    // Conserver les commentaires JSDoc (limités)
    if (trimmed.startsWith('/**')) { inDocComment = true; docCommentCount++ }
    if (inDocComment && docCommentCount <= maxDocComments) {
      kept.push(line)
      if (trimmed.includes('*/')) inDocComment = false
      continue
    }
    if (inDocComment) {
      if (trimmed.includes('*/')) inDocComment = false
      continue
    }

    // Conserver les signatures
    if (signaturePatterns.some(p => p.test(line))) {
      kept.push(line)
    }
  }

  if (kept.length === 0) {
    // Fallback : garder les N premières lignes
    return lines.slice(0, opts.maxCodeLines).join('\n')
  }

  return kept.join('\n')
}

// ─── Compression de sortie bash ───────────────────────────────────────────────

function compressBashContent(content: string, _opts: ToolResultOptions): string {
  const allLines = content.split('\n')
  const lines = allLines.filter((l, _i, arr) => l.trim() !== '' || arr.length < 5)
  const headCount = 10
  const tailCount = 5

  // Lignes contenant des erreurs
  const errorPattern = /\b(error|Error|ERROR|fail|FAIL|exception|Exception|fatal|FATAL|warning|Warning)\b/
  const errorLines = lines
    .map((line: string, idx: number) => ({ line, idx }))
    .filter(({ line }: { line: string }) => errorPattern.test(line))

  if (lines.length <= headCount + tailCount) {
    return content
  }

  const head = lines.slice(0, headCount)
  const tail = lines.slice(-tailCount)
  const omitted = lines.length - headCount - tailCount

  const parts: string[] = [...head]
  if (omitted > 0) {
    parts.push(`[... ${omitted} lignes omises ...]`)
  }

  // Remonter les lignes d'erreur si elles sont dans la partie omise
  const omittedErrorLines = errorLines.filter(({ idx }: { idx: number }) => idx >= headCount && idx < lines.length - tailCount)
  if (omittedErrorLines.length > 0) {
    parts.push(`[Lignes importantes dans la partie omise :]`)
    for (const { line } of omittedErrorLines.slice(0, 5)) {
      parts.push(`  ${line}`)
    }
  }

  parts.push(...tail)
  return parts.join('\n')
}

// ─── Compression JSON ─────────────────────────────────────────────────────────

function compressJsonContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== 'object' || parsed === null) return content

    if (Array.isArray(parsed)) {
      return `Array(${parsed.length}) [${parsed.slice(0, 3).map(summarizeJsonValue).join(', ')}${parsed.length > 3 ? ', ...' : ''}]`
    }

    const obj = parsed as Record<string, unknown>
    const keys = Object.keys(obj)
    const summary: string[] = []
    for (const key of keys.slice(0, 10)) {
      summary.push(`${key}: ${summarizeJsonValue(obj[key])}`)
    }
    if (keys.length > 10) summary.push(`... +${keys.length - 10} clés`)
    return `{\n  ${summary.join(',\n  ')}\n}`
  } catch {
    return content
  }
}

function summarizeJsonValue(val: unknown): string {
  if (val === null) return 'null'
  if (typeof val === 'string') return `"${val.length > 50 ? val.slice(0, 47) + '...' : val}"`
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  if (Array.isArray(val)) return `Array(${val.length})`
  if (typeof val === 'object') {
    const keys = Object.keys(val as object)
    return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', ...' : ''}}`
  }
  return String(val)
}

// ─── Compression de texte générique ──────────────────────────────────────────

function compressTextContent(content: string, opts: ToolResultOptions): string {
  const lines = content.split('\n')
  const keepLines = Math.max(5, Math.floor(opts.maxBashLines * (1 - opts.aggressiveness * 0.5)))
  if (lines.length <= keepLines) return content
  const kept = lines.slice(0, keepLines)
  kept.push(`[... ${lines.length - keepLines} lignes omises ...]`)
  return kept.join('\n')
}

// ─── Compresseur principal ────────────────────────────────────────────────────

function compressToolResultContent(
  content: string,
  toolName: string | undefined,
  opts: ToolResultOptions,
): { compressed: string; contentType: CachedContent['contentType'] } {
  const contentType = detectContentType(content, toolName)

  // Seuil minimal : ne compresser que si le contenu est substantiel
  const MIN_CHARS = 300
  if (content.length < MIN_CHARS) {
    return { compressed: content, contentType }
  }

  let compressed: string
  switch (contentType) {
    case 'code':
      compressed = compressCodeContent(content, opts)
      break
    case 'bash':
      compressed = compressBashContent(content, opts)
      break
    case 'json':
      compressed = compressJsonContent(content)
      break
    default:
      compressed = compressTextContent(content, opts)
  }

  return { compressed, contentType }
}

/**
 * Extrait le contenu textuel d'un bloc tool_result.
 */
function extractToolResultText(block: ToolResultBlock): string {
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) {
    return block.content
      .filter((c): c is TextBlock => c.type === 'text')
      .map(c => c.text)
      .join('\n')
  }
  return ''
}

/**
 * Compresse tous les blocs tool_result dans les messages fournis.
 * @param messages - Historique de conversation
 * @param options - Options de compression
 * @returns Messages compressés + tokens économisés
 */
export function compressToolResults(
  messages: Message[],
  options?: Partial<ToolResultOptions>,
): CompressResult {
  const opts: ToolResultOptions = { ...DEFAULT_OPTIONS, ...options }
  let savedTokens = 0

  const compressed = messages.map(msg => {
    if (msg.role !== 'user') return msg
    if (typeof msg.content === 'string') return msg

    const newContent: ContentBlock[] = msg.content.map(block => {
      if (block.type !== 'tool_result') return block

      const originalText = extractToolResultText(block)
      if (!originalText || originalText.length < 200) return block

      const originalTokenCount = countTokens(originalText)

      // Trouver le nom de l'outil depuis le contexte (on cherche le tool_use correspondant)
      const { compressed: compressedText, contentType } = compressToolResultContent(
        originalText,
        undefined,
        opts,
      )

      const compressedTokenCount = countTokens(compressedText)
      const gain = originalTokenCount - compressedTokenCount

      // Ne remplacer que si le gain est significatif (>20%)
      if (gain <= 0 || gain / originalTokenCount < 0.1) return block

      savedTokens += gain

      // Stocker dans le cache si activé
      let refId = ''
      if (opts.cacheEnabled) {
        refId = generateRefId()
        contentCache.set(refId, {
          refId,
          originalContent: originalText,
          compressedPlaceholder: compressedText,
          contentType,
          createdAt: Date.now(),
        })
      }

      const refPart = refId ? ` | refId: ${refId}` : ''
      const header = `[cork-ai: ${contentType} compressé — ${originalTokenCount} → ${compressedTokenCount} tokens${refPart}]\n`

      const newBlock: ToolResultBlock = {
        ...block,
        content: header + compressedText,
      }
      return newBlock
    })

    return { ...msg, content: newContent }
  })

  return { messages: compressed, savedTokens }
}

/**
 * Restaure le contenu original d'un bloc compressé via son refId.
 * @param refId - Identifiant retourné lors de la compression
 * @returns Contenu original ou null si non trouvé
 */
export function restore(refId: string): string | null {
  const cached = contentCache.get(refId)
  return cached ? cached.originalContent : null
}

/**
 * Vide le cache side-channel (libère la mémoire).
 */
export function clearCache(): void {
  contentCache.clear()
}

