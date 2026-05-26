/**
 * Assistant Code Deduplicator — suppression des doublons de code dans l'historique.
 * Gain estimé : 10–20% des tokens input.
 *
 * Deux stratégies :
 * 1. Code écrit dans un fichier via Write/create_file → remplacé par une référence au fichier
 * 2. Blocs de code identiques dans la conversation → les occurrences suivantes sont remplacées
 */

import { createHash } from 'crypto'
import { countTokens } from '../core/tokenizer.js'
import type {
  CodeDedupOptions,
  CompressResult,
  ContentBlock,
  Message,
  TextBlock,
  ToolUseBlock,
} from '../types/index.js'

const DEFAULT_OPTIONS: CodeDedupOptions = {
  aggressiveness: 0.6,
}

// Noms d'outils qui écrivent du code dans des fichiers
const WRITE_TOOL_NAMES = new Set([
  'Write', 'write', 'create_file', 'write_file',
  'str_replace_editor', 'text_editor', 'edit_file',
  'bash', 'Bash', // parfois utilisé pour écrire via echo/cat
])

interface FileWrite {
  filePath: string
  contentHash: string
  messageIndex: number
  blockIndex: number
}

/**
 * Normalise le code pour le hash (trim, normalisation des fins de lignes).
 */
function normalizeCode(code: string): string {
  return code
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

/**
 * Calcule le hash SHA1 court (8 chars) du code normalisé.
 */
function hashCode(code: string): string {
  return createHash('sha1').update(normalizeCode(code)).digest('hex').slice(0, 8)
}

/**
 * Extrait les blocs de code d'un texte markdown.
 * Retourne un tableau de { code, lang, startIndex, endIndex }.
 */
function extractCodeBlocks(text: string): Array<{ code: string; lang: string; start: number; end: number }> {
  const blocks: Array<{ code: string; lang: string; start: number; end: number }> = []
  const pattern = /```(\w*)\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    blocks.push({
      code: match[2],
      lang: match[1],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return blocks
}

/**
 * Extrait le chemin de fichier et le contenu depuis un tool_use de type Write.
 */
function extractWriteToolInfo(block: ToolUseBlock): { filePath: string; content: string } | null {
  const input = block.input

  // Différents formats selon l'outil
  const filePath = (
    (typeof input['path'] === 'string' && input['path']) ||
    (typeof input['file_path'] === 'string' && input['file_path']) ||
    (typeof input['filename'] === 'string' && input['filename']) ||
    ''
  )

  const content = (
    (typeof input['content'] === 'string' && input['content']) ||
    (typeof input['new_str'] === 'string' && input['new_str']) ||
    (typeof input['text'] === 'string' && input['text']) ||
    ''
  )

  if (!filePath || !content) return null
  return { filePath, content }
}

/**
 * Déduplique le code dans les messages assistant.
 * @param messages - Historique de conversation
 * @param options - Options de compression
 */
export function deduplicateCode(
  messages: Message[],
  options?: Partial<CodeDedupOptions>,
): CompressResult {
  const _opts: CodeDedupOptions = { ...DEFAULT_OPTIONS, ...options }
  void _opts // utilisé implicitement pour les options futures
  let savedTokens = 0

  // Phase 1 : construire la map hash → fichier depuis les tool_use Write
  const fileWrites = new Map<string, FileWrite>()

  messages.forEach((msg, msgIdx) => {
    if (typeof msg.content === 'string') return
    msg.content.forEach((block, blockIdx) => {
      if (block.type !== 'tool_use') return
      if (!WRITE_TOOL_NAMES.has(block.name)) return
      const info = extractWriteToolInfo(block)
      if (!info) return
      const hash = hashCode(info.content)
      fileWrites.set(hash, {
        filePath: info.filePath,
        contentHash: hash,
        messageIndex: msgIdx,
        blockIndex: blockIdx,
      })
    })
  })

  // Phase 2 : index des blocs de code déjà vus dans la conversation
  const seenCodeBlocks = new Map<string, { messageIndex: number; blockRef: string }>()

  // Phase 3 : remplacer les doublons dans les messages assistant
  const compressed = messages.map((msg, msgIdx) => {
    if (msg.role !== 'assistant') return msg

    const processText = (text: string): string => {
      const codeBlocks = extractCodeBlocks(text)
      if (codeBlocks.length === 0) return text

      // Travailler en sens inverse pour ne pas décaler les indices
      let result = text
      const sortedBlocks = [...codeBlocks].sort((a, b) => b.start - a.start)

      for (const block of sortedBlocks) {
        const hash = hashCode(block.code)
        const originalTokens = countTokens(result.slice(block.start, block.end))

        // Cas 1 : le code correspond à un fichier écrit
        const fileWrite = fileWrites.get(hash)
        if (fileWrite && fileWrite.messageIndex <= msgIdx) {
          const replacement = `[code écrit dans \`${fileWrite.filePath}\` — omis pour économiser les tokens]`
          savedTokens += Math.max(0, originalTokens - countTokens(replacement))
          result = result.slice(0, block.start) + replacement + result.slice(block.end)
          continue
        }

        // Cas 2 : le code a déjà été vu dans la conversation
        const seen = seenCodeBlocks.get(hash)
        if (seen && seen.messageIndex < msgIdx) {
          const replacement = `[code identique à ${seen.blockRef} — omis pour économiser les tokens]`
          savedTokens += Math.max(0, originalTokens - countTokens(replacement))
          result = result.slice(0, block.start) + replacement + result.slice(block.end)
          continue
        }

        // Première occurrence : l'enregistrer
        if (!seenCodeBlocks.has(hash)) {
          seenCodeBlocks.set(hash, {
            messageIndex: msgIdx,
            blockRef: `message #${msgIdx + 1}`,
          })
        }
      }

      return result
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
