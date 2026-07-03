/**
 * Validation — structural invariants the Anthropic API enforces.
 *
 * The API rejects (400 invalid_request_error) any request where a
 * `tool_result` block references a `tool_use` id that no longer exists in the
 * immediately preceding assistant message. Compression modules that rewrite
 * whole messages can break this pairing — the pipeline validates its output
 * and falls back to the original messages if the invariant is violated.
 */

import type { ContentBlock, Message } from '../types/index.js'

function blocksOf(msg: Message): ContentBlock[] {
  return typeof msg.content === 'string' ? [] : msg.content
}

/**
 * Checks the tool_use / tool_result pairing invariant:
 *  - every tool_result references a tool_use id present in the immediately
 *    preceding assistant message;
 *  - every tool_use in an assistant message is answered by a tool_result in
 *    the immediately following user message.
 */
export function validateToolPairing(messages: Message[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const blocks = blocksOf(msg)

    if (msg.role === 'user') {
      const results = blocks.filter(b => b.type === 'tool_result')
      if (results.length > 0) {
        const prev = i > 0 ? messages[i - 1] : null
        const prevIds = new Set(
          prev && prev.role === 'assistant'
            ? blocksOf(prev).filter(b => b.type === 'tool_use').map(b => (b as { id: string }).id)
            : [],
        )
        for (const r of results) {
          if (!prevIds.has((r as { tool_use_id: string }).tool_use_id)) return false
        }
      }
    }

    if (msg.role === 'assistant') {
      const uses = blocks.filter(b => b.type === 'tool_use')
      if (uses.length > 0) {
        // A trailing assistant tool_use with no following message is legal
        // mid-loop (the caller appends results next) — only check when a
        // following message exists.
        const next = i + 1 < messages.length ? messages[i + 1] : null
        if (next) {
          const nextIds = new Set(
            next.role === 'user'
              ? blocksOf(next).filter(b => b.type === 'tool_result').map(b => (b as { tool_use_id: string }).tool_use_id)
              : [],
          )
          for (const u of uses) {
            if (!nextIds.has((u as { id: string }).id)) return false
          }
        }
      }
    }
  }
  return true
}

/** True if the message contains any tool_use or tool_result block. */
export function hasToolBlocks(msg: Message): boolean {
  if (typeof msg.content === 'string') return false
  return msg.content.some(b => b.type === 'tool_use' || b.type === 'tool_result')
}
