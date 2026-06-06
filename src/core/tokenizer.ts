/**
 * Tokenizer — comptage de tokens cl100k_base.
 * Utilise tiktoken si disponible, sinon fallback pur JS (chars/4).
 * Estimated gain: foundation for all compression modules.
 */

import type { Message } from '../types/index.js'

type TiktokenEncoder = {
  encode(text: string): Uint32Array
  free(): void
}

let encoder: TiktokenEncoder | null = null
let tiktokenAvailable: boolean | null = null

async function loadTiktoken(): Promise<boolean> {
  if (tiktokenAvailable !== null) return tiktokenAvailable
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('tiktoken') as any
    encoder = mod.get_encoding('cl100k_base')
    tiktokenAvailable = true
  } catch {
    tiktokenAvailable = false
  }
  return tiktokenAvailable
}

// Initialisation synchrone pour l'usage sans await
function tryLoadTiktokenSync(): boolean {
  if (tiktokenAvailable !== null) return tiktokenAvailable
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = require('tiktoken') as any
    encoder = mod.get_encoding('cl100k_base')
    tiktokenAvailable = true
  } catch {
    tiktokenAvailable = false
  }
  return tiktokenAvailable
}

/**
 * Pure JS fallback: approximation based on character length.
 * Accuracy ~±15% relative to cl100k_base.
 */
function countTokensFallback(text: string): number {
  if (!text) return 0
  // Approximation: ~4 chars per token for English/code, ~3 for CJK/French
  // On utilise 3.5 comme moyenne
  return Math.ceil(text.length / 3.5)
}

/**
 * Compte le nombre de tokens dans un texte.
 * Utilise cl100k_base (tiktoken) ou fallback JS.
 */
export function countTokens(text: string): number {
  if (!text) return 0
  const available = tryLoadTiktokenSync()
  if (available && encoder) {
    return encoder.encode(text).length
  }
  return countTokensFallback(text)
}

/**
 * Compte les tokens d'un tableau de messages (format Anthropic).
 * Inclut le overhead des tokens de structure (~4 par message).
 */
export function countMessageTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += 4 // overhead de structure par message
    if (typeof msg.content === 'string') {
      total += countTokens(msg.content)
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') {
          total += countTokens(block.text)
        } else if (block.type === 'tool_use') {
          total += countTokens(block.name)
          total += countTokens(JSON.stringify(block.input))
        } else if (block.type === 'tool_result') {
          if (typeof block.content === 'string') {
            total += countTokens(block.content)
          } else if (Array.isArray(block.content)) {
            for (const c of block.content) {
              if (c.type === 'text') total += countTokens(c.text)
            }
          }
        }
      }
    }
  }
  return total
}

/**
 * Checks whether tiktoken is available in the environment.
 */
export async function isTiktokenAvailable(): Promise<boolean> {
  return loadTiktoken()
}

/**
 * Tokenizer singleton — reuses the initialized encoder.
 */
export const TokenizerSingleton = {
  countTokens,
  countMessageTokens,
  isTiktokenAvailable,
}
