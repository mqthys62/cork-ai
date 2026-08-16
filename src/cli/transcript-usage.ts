/**
 * Transcript usage — real spend, read back from Claude Code's own transcripts.
 *
 * Everything else in cork-ai's stats is an *estimate of what was avoided*: the
 * hook only ever sees the Read tool outputs it compresses, never the request
 * that Claude Code actually sends. That leaves the headline question — "what
 * did this session really cost?" — unanswerable from our own bookkeeping.
 *
 * Claude Code does record it. Every assistant turn in
 * `~/.claude/projects/<slug>/<session-id>.jsonl` carries the API's `usage`
 * object verbatim, including the 5-minute/1-hour cache-write split. Summing it
 * gives ground truth for the whole session — system prompt, history, every
 * tool result, output tokens, subagents — not just the slice cork-ai touched.
 *
 * Two traps, both load-bearing:
 *
 *   1. Assistant turns are written to the transcript several times as the
 *      message streams in (2–5 lines per message, same `usage` each time).
 *      Deduplicating on `message.id` is mandatory — summing raw lines
 *      overstates spend by roughly 2.5×.
 *   2. Subagent turns are marked `isSidechain: true`. They are real spend and
 *      are counted, but they are tracked separately so the split stays visible.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { costOfUsage, type ApiUsage } from '../pricing/index.js'

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

export interface TranscriptUsage {
  /** Unique assistant messages counted (post-deduplication). */
  messages: number
  /** Of those, how many came from subagent sidechains. */
  sidechainMessages: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Real USD spend at list prices, per the model that served each message. */
  costUSD: number
  /** Per-model breakdown, keyed by the model id the transcript reports. */
  byModel: Record<string, { messages: number; costUSD: number; promptTokens: number; outputTokens: number }>
}

function emptyUsage(): TranscriptUsage {
  return {
    messages: 0,
    sidechainMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUSD: 0,
    byModel: {},
  }
}

interface TranscriptLine {
  type?: string
  isSidechain?: boolean
  message?: { id?: string; model?: string; usage?: ApiUsage }
}

/**
 * Accumulates one transcript file into `acc`.
 *
 * `seenMessageIds` is threaded through by the caller so that deduplication
 * spans files: resumed sessions replay earlier turns into the new transcript,
 * which would otherwise be double-counted across the directory scan.
 */
function accumulateFile(file: string, acc: TranscriptUsage, seenMessageIds: Set<string>): void {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    return // unreadable/deleted mid-scan — skip, a partial total beats a crash
  }

  for (const line of raw.split('\n')) {
    if (!line || !line.includes('"assistant"')) continue

    let entry: TranscriptLine
    try {
      entry = JSON.parse(line) as TranscriptLine
    } catch {
      continue // truncated tail line while Claude Code is mid-write
    }

    if (entry.type !== 'assistant') continue
    const usage = entry.message?.usage
    const id = entry.message?.id
    if (!usage || !id) continue
    if (seenMessageIds.has(id)) continue
    seenMessageIds.add(id)

    const model = entry.message?.model
    // Synthetic entries ("<synthetic>") carry no billable model.
    if (!model || !/^claude/i.test(model)) continue

    const cost = costOfUsage(usage, model)
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cacheWrite = usage.cache_creation_input_tokens ?? 0
    const promptTokens = usage.input_tokens + cacheRead + cacheWrite

    acc.messages += 1
    if (entry.isSidechain) acc.sidechainMessages += 1
    acc.inputTokens += usage.input_tokens
    acc.outputTokens += usage.output_tokens
    acc.cacheReadTokens += cacheRead
    acc.cacheWriteTokens += cacheWrite
    acc.costUSD += cost

    const bucket = (acc.byModel[model] ??= {
      messages: 0,
      costUSD: 0,
      promptTokens: 0,
      outputTokens: 0,
    })
    bucket.messages += 1
    bucket.costUSD += cost
    bucket.promptTokens += promptTokens
    bucket.outputTokens += usage.output_tokens
  }
}

/** Real usage for a single transcript file. */
export function scanTranscript(transcriptPath: string): TranscriptUsage {
  const acc = emptyUsage()
  accumulateFile(transcriptPath, acc, new Set())
  return acc
}

/**
 * Real usage across every Claude Code transcript on this machine.
 *
 * @param since - Ignore transcripts last modified before this date. Use the
 *   stats file's `createdAt` so the real-spend figure covers the same window
 *   as cork-ai's own savings numbers rather than the machine's whole history.
 */
export function scanAllTranscripts(since?: Date): TranscriptUsage {
  const acc = emptyUsage()
  const seen = new Set<string>()

  let projects: string[]
  try {
    projects = fs.readdirSync(PROJECTS_DIR)
  } catch {
    return acc // no Claude Code transcripts on this machine
  }

  const cutoff = since?.getTime()

  for (const project of projects) {
    const dir = path.join(PROJECTS_DIR, project)
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const file = path.join(dir, entry)
      if (cutoff !== undefined) {
        try {
          if (fs.statSync(file).mtimeMs < cutoff) continue
        } catch {
          continue
        }
      }
      accumulateFile(file, acc, seen)
    }
  }

  return acc
}
