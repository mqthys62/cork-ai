/**
 * Assistant Code Deduplicator — removes code duplicates from conversation history.
 * Estimated gain: 10–20% of input tokens.
 *
 * Two strategies:
 * 1. Code written to a file via Write/create_file → replaced with a file reference
 * 2. Identical code blocks in the conversation → subsequent occurrences are replaced
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

// Names of tools that write code to files
const WRITE_TOOL_NAMES = new Set([
  'Write', 'write', 'create_file', 'write_file',
  'str_replace_editor', 'text_editor', 'edit_file',
  'bash', 'Bash', // sometimes used to write via echo/cat
])

interface FileWrite {
  filePath: string
  contentHash: string
  messageIndex: number
  blockIndex: number
}

/**
 * Normalizes code for hashing (trim, line ending normalization).
 */
function normalizeCode(code: string): string {
  return code
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

/**
 * Computes a short SHA1 hash (8 chars) of the normalized code.
 */
function hashCode(code: string): string {
  return createHash('sha1').update(normalizeCode(code)).digest('hex').slice(0, 8)
}

/**
 * Extracts code blocks from a markdown text.
 * Returns an array of { code, lang, startIndex, endIndex }.
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
 * Extracts the file path and content from a Write-type tool_use block.
 */
function extractWriteToolInfo(block: ToolUseBlock): { filePath: string; content: string } | null {
  const input = block.input

  // Different formats depending on the tool
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
 * Deduplicates code in assistant messages.
 * @param messages - Conversation history
 * @param options - Compression options
 */
export function deduplicateCode(
  messages: Message[],
  options?: Partial<CodeDedupOptions>,
): CompressResult {
  const _opts: CodeDedupOptions = { ...DEFAULT_OPTIONS, ...options }
  void _opts // reserved for future options
  let savedTokens = 0

  // Phase 1: build hash → file map from Write tool_use blocks
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

  // Phase 2: index of code blocks already seen in the conversation
  const seenCodeBlocks = new Map<string, { messageIndex: number; blockRef: string }>()

  // Phase 3: replace duplicates in assistant messages
  const compressed = messages.map((msg, msgIdx) => {
    if (msg.role !== 'assistant') return msg

    const processText = (text: string): string => {
      const codeBlocks = extractCodeBlocks(text)
      if (codeBlocks.length === 0) return text

      // Process in reverse order to avoid index shifting
      let result = text
      const sortedBlocks = [...codeBlocks].sort((a, b) => b.start - a.start)

      for (const block of sortedBlocks) {
        const hash = hashCode(block.code)
        const originalTokens = countTokens(result.slice(block.start, block.end))

        // Case 1: code matches a written file
        const fileWrite = fileWrites.get(hash)
        if (fileWrite && fileWrite.messageIndex <= msgIdx) {
          const replacement = `[code written to \`${fileWrite.filePath}\` — omitted to save tokens]`
          savedTokens += Math.max(0, originalTokens - countTokens(replacement))
          result = result.slice(0, block.start) + replacement + result.slice(block.end)
          continue
        }

        // Case 2: code was already seen in the conversation
        const seen = seenCodeBlocks.get(hash)
        if (seen && seen.messageIndex < msgIdx) {
          const replacement = `[duplicate code from ${seen.blockRef} — omitted to save tokens]`
          savedTokens += Math.max(0, originalTokens - countTokens(replacement))
          result = result.slice(0, block.start) + replacement + result.slice(block.end)
          continue
        }

        // First occurrence: register it
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
