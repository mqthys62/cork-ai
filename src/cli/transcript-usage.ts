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
import { costOfUsage, resolvePricing, type ApiUsage } from '../pricing/index.js'

// ─── Durable per-session cache ──────────────────────────────────────────────
//
// Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default),
// so a report that only reads live transcripts forgets the past a month at a
// time. Every scan records what it computed per file; a later scan adds back
// the files that have since disappeared. Live files always win over the cache,
// and the cross-file deduplication of the live scan is unchanged.

const CORK_HOME = process.env.CORK_AI_HOME ?? path.join(os.homedir(), '.cork-ai')
export const SPEND_CACHE_FILE = path.join(CORK_HOME, 'spend-cache.json')

interface CachedFile {
  sessionId: string
  project: string
  sidechain: boolean
  /** ISO time of the file's last modification when it was scanned. */
  endedAt: string
  usage: TranscriptUsage
  /** Main-thread files only; ceilings as computed at scan time. */
  context?: ContextProfile
}

interface SpendCache {
  version: 1
  files: Record<string, CachedFile>
}

function loadSpendCache(): SpendCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(SPEND_CACHE_FILE, 'utf-8')) as SpendCache
    if (parsed && parsed.files && typeof parsed.files === 'object') return parsed
  } catch { /* first run */ }
  return { version: 1, files: {} }
}

function saveSpendCache(cache: SpendCache): void {
  try {
    fs.mkdirSync(CORK_HOME, { recursive: true })
    fs.writeFileSync(SPEND_CACHE_FILE, JSON.stringify(cache), 'utf-8')
  } catch { /* best effort */ }
}

function mergeUsage(acc: TranscriptUsage, add: TranscriptUsage): void {
  acc.messages += add.messages
  acc.sidechainMessages += add.sidechainMessages
  acc.inputTokens += add.inputTokens
  acc.outputTokens += add.outputTokens
  acc.cacheReadTokens += add.cacheReadTokens
  acc.cacheWriteTokens += add.cacheWriteTokens
  acc.costUSD += add.costUSD
  for (const [model, m] of Object.entries(add.byModel)) {
    const bucket = (acc.byModel[model] ??= { messages: 0, costUSD: 0, promptTokens: 0, outputTokens: 0 })
    bucket.messages += m.messages
    bucket.costUSD += m.costUSD
    bucket.promptTokens += m.promptTokens
    bucket.outputTokens += m.outputTokens
  }
}

/**
 * Root of Claude Code's transcripts.
 *
 * Resolved per call, not once at import: CLAUDE_PROJECTS_DIR lets tests point
 * at a fixture directory instead of the developer's real conversation history,
 * and a module-level constant would be frozen before a test could set it.
 * Claude Code itself does not read this variable.
 */
function projectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects')
}

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

export interface SessionAmplification {
  /** Assistant turns on the main thread (subagent sidechains excluded). */
  turns: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Cache reads per token written — how many times context gets re-billed. */
  amplification: number
  /** Context segments; > 1 means the conversation was compacted mid-session. */
  compactions: number
  /** false when no transcript exists for this session id. */
  found: boolean
}

function emptyAmplification(): SessionAmplification {
  return {
    turns: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    amplification: 0,
    compactions: 0,
    found: false,
  }
}

/** Locates `<sessionId>.jsonl` across every project directory. */
function findTranscript(sessionId: string): string | undefined {
  let projects: string[]
  try {
    projects = fs.readdirSync(projectsDir())
  } catch {
    return undefined
  }
  for (const project of projects) {
    const candidate = path.join(projectsDir(), project, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * How many times this session re-billed each token it put into context.
 *
 * cork-ai's saved-token figures are worth `cacheWrite + amplification ×
 * cacheRead` per token (see `costOfAvoidedTokens()`), and only the transcript
 * knows the multiplier — it depends on how long the session ran after each
 * file was read.
 *
 * Three exclusions matter:
 *   - Sidechain (subagent) turns run their own context and never re-read the
 *     main thread, so counting them would inflate the ratio.
 *   - Duplicate stream lines are deduplicated on `message.id`, as elsewhere.
 *   - Turns after a `compact_boundary` are dropped. Compaction replaces the
 *     raw history with a summary, so tokens cork-ai kept out were not being
 *     re-read past that point either — counting those turns would credit
 *     cork-ai for savings that had already evaporated.
 */
export function sessionAmplification(sessionId: string): SessionAmplification {
  const file = findTranscript(sessionId)
  if (!file) return emptyAmplification()

  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    return emptyAmplification()
  }

  const acc = emptyAmplification()
  acc.found = true
  const seen = new Set<string>()
  let compacted = false

  for (const line of raw.split('\n')) {
    if (!line) continue

    let entry: TranscriptLine & { subtype?: string; isCompactSummary?: boolean }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (entry.subtype === 'compact_boundary' || entry.isCompactSummary) {
      // Count each boundary once — Claude Code writes both a system
      // `compact_boundary` and a user `isCompactSummary` entry per compaction.
      if (entry.subtype === 'compact_boundary') acc.compactions += 1
      compacted = true
      continue
    }
    if (compacted) continue

    if (entry.type !== 'assistant' || entry.isSidechain) continue
    const usage = entry.message?.usage
    const id = entry.message?.id
    if (!usage || !id || seen.has(id)) continue
    seen.add(id)

    acc.turns += 1
    acc.cacheReadTokens += usage.cache_read_input_tokens ?? 0
    acc.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0
  }

  acc.amplification =
    acc.cacheWriteTokens > 0 ? acc.cacheReadTokens / acc.cacheWriteTokens : 0
  return acc
}

export interface TranscriptFile {
  path: string
  /** Main-thread session id (the subagent files of a session share it). */
  sessionId: string
  /** Project slug directory name under ~/.claude/projects. */
  project: string
  /** true for `<session>/subagents/**.jsonl` files (Agent tool, workflows). */
  sidechain: boolean
  mtimeMs: number
}

function walkJsonl(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkJsonl(full, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
}

/**
 * Every transcript file on this machine, main threads and subagents alike.
 *
 * Claude Code writes the main thread to `<project>/<session>.jsonl` and, since
 * mid-2026, each subagent to `<project>/<session>/subagents/agent-<id>.jsonl`
 * (workflows nest one level deeper). The old scanner only looked at depth one,
 * so subagent spend — which can be most of a research-heavy session — was
 * silently missing from "Real spend".
 */
export function listTranscriptFiles(since?: Date): TranscriptFile[] {
  const out: TranscriptFile[] = []
  let projects: string[]
  try {
    projects = fs.readdirSync(projectsDir())
  } catch {
    return out
  }
  const cutoff = since?.getTime()

  for (const project of projects) {
    const dir = path.join(projectsDir(), project)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const file = path.join(dir, entry.name)
        let mtimeMs: number
        try { mtimeMs = fs.statSync(file).mtimeMs } catch { continue }
        if (cutoff !== undefined && mtimeMs < cutoff) continue
        out.push({ path: file, sessionId: entry.name.slice(0, -'.jsonl'.length), project, sidechain: false, mtimeMs })
      } else if (entry.isDirectory()) {
        const nested: string[] = []
        walkJsonl(path.join(dir, entry.name), nested)
        for (const file of nested) {
          let mtimeMs: number
          try { mtimeMs = fs.statSync(file).mtimeMs } catch { continue }
          if (cutoff !== undefined && mtimeMs < cutoff) continue
          out.push({ path: file, sessionId: entry.name, project, sidechain: true, mtimeMs })
        }
      }
    }
  }
  return out
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
  const cache = loadSpendCache()
  const live = new Set<string>()

  for (const file of listTranscriptFiles(since)) {
    live.add(file.path)
    const fileAcc = emptyUsage()
    accumulateFile(file.path, fileAcc, seen)
    mergeUsage(acc, fileAcc)
    const prev = cache.files[file.path]
    cache.files[file.path] = {
      sessionId: file.sessionId,
      project: file.project,
      sidechain: file.sidechain,
      endedAt: new Date(file.mtimeMs).toISOString(),
      usage: fileAcc,
      context: prev?.context,
    }
  }

  // Files Claude Code has deleted since they were last scanned.
  const cutoff = since?.getTime()
  for (const [file, entry] of Object.entries(cache.files)) {
    if (live.has(file) || fs.existsSync(file)) continue
    if (cutoff !== undefined && new Date(entry.endedAt).getTime() < cutoff) continue
    mergeUsage(acc, entry.usage)
  }

  saveSpendCache(cache)
  return acc
}

// ─── Last turn (context size right now) ──────────────────────────────────────

export interface TurnUsage {
  model: string
  usage: ApiUsage
  /** Prompt tokens of that turn = the live context size: input + cache read + cache write. */
  contextTokens: number
  timestamp?: string
}

/**
 * The most recent main-thread assistant turn's usage, read from the tail of the
 * transcript. This is how big the context is *right now*: Claude Code resends
 * the whole conversation on every turn, so the next tool call will be billed
 * roughly `contextTokens` cache-read tokens again.
 */
export function lastMainTurnUsage(transcriptPath: string | undefined, tailBytes = 512 * 1024): TurnUsage | undefined {
  if (!transcriptPath) return undefined
  let lines: string[]
  try {
    const stat = fs.statSync(transcriptPath)
    const start = Math.max(0, stat.size - tailBytes)
    const fd = fs.openSync(transcriptPath, 'r')
    const buf = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    lines = buf.toString('utf-8').split('\n')
  } catch {
    return undefined
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
    let entry: TranscriptLine & { timestamp?: string }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue
    const usage = entry.message?.usage
    const model = entry.message?.model
    if (!usage || !model || !/^claude/i.test(model)) continue
    const contextTokens =
      (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    return { model, usage, contextTokens, timestamp: entry.timestamp }
  }
  return undefined
}

// ─── Context profile (what an oversized context costs) ──────────────────────

export interface ContextProfile {
  sessionId: string
  project: string
  /** Model that served most turns. */
  model: string
  startedAt?: string
  endedAt?: string
  /** Main-thread assistant turns. */
  turns: number
  avgContextTokens: number
  maxContextTokens: number
  costUSD: number
  cacheReadCostUSD: number
  outputCostUSD: number
  compactions: number
  /** What the same turns would have cost with auto-compaction at each ceiling. */
  cappedCostUSD: Record<number, number>
}

/** Tokens left in context right after a compaction (summary + system prompt). */
const COMPACTION_RESIDUAL_TOKENS = 25_000
/** Output tokens of a compaction summary. */
const COMPACTION_OUTPUT_TOKENS = 4_000

/**
 * Cost profile of one main-thread transcript, plus a replay of the same
 * session under a lower auto-compact window.
 *
 * The replay is deliberately simple: context grows by whatever the real turn
 * added, and whenever it crosses the ceiling a compaction is paid (one cache
 * read of the whole context plus a summary) and the context drops to a small
 * residual. Turns are otherwise identical — same output, same model — so the
 * comparison isolates the cost of carrying a large context.
 */
export function sessionContextProfile(file: string, ceilings: number[] = [200_000]): ContextProfile | undefined {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    return undefined
  }

  const seen = new Set<string>()
  const modelTurns = new Map<string, number>()
  let turns = 0
  let ctxSum = 0
  let ctxMax = 0
  let cost = 0
  let cacheReadCost = 0
  let outputCost = 0
  let compactions = 0
  let startedAt: string | undefined
  let endedAt: string | undefined
  let prevCtx = 0
  const capped = new Map<number, { ctx: number; cost: number }>()
  for (const c of ceilings) capped.set(c, { ctx: 0, cost: 0 })

  for (const line of raw.split('\n')) {
    if (!line) continue
    let entry: TranscriptLine & { subtype?: string; timestamp?: string }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.subtype === 'compact_boundary') {
      compactions += 1
      continue
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue
    const usage = entry.message?.usage
    const id = entry.message?.id
    const model = entry.message?.model
    if (!usage || !id || seen.has(id) || !model || !/^claude/i.test(model)) continue
    seen.add(id)

    const p = resolvePricing(model)
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cacheWrite = usage.cache_creation_input_tokens ?? 0
    const ctx = usage.input_tokens + cacheRead + cacheWrite
    const turnCost = costOfUsage(usage, model)

    turns += 1
    ctxSum += ctx
    ctxMax = Math.max(ctxMax, ctx)
    cost += turnCost
    cacheReadCost += (cacheRead / 1_000_000) * p.cacheRead
    outputCost += (usage.output_tokens / 1_000_000) * p.output
    modelTurns.set(model, (modelTurns.get(model) ?? 0) + 1)
    if (entry.timestamp) {
      startedAt ??= entry.timestamp
      endedAt = entry.timestamp
    }

    // Replay under each ceiling. Everything but the cache-read part of the
    // prompt is kept as is: what the turn wrote, what it output, what it added.
    const nonCacheRead = turnCost - (cacheRead / 1_000_000) * p.cacheRead
    const growth = Math.max(0, ctx - prevCtx)
    prevCtx = ctx
    for (const [ceiling, state] of capped) {
      state.ctx += growth
      if (state.ctx > ceiling) {
        state.cost += (state.ctx / 1_000_000) * p.cacheRead + (COMPACTION_OUTPUT_TOKENS / 1_000_000) * p.output
        state.ctx = COMPACTION_RESIDUAL_TOKENS
      }
      state.cost += nonCacheRead + (Math.min(state.ctx, cacheRead) / 1_000_000) * p.cacheRead
    }
  }

  if (turns === 0) return undefined
  const model = [...modelTurns.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const cappedCostUSD: Record<number, number> = {}
  for (const [ceiling, state] of capped) cappedCostUSD[ceiling] = state.cost

  return {
    sessionId: path.basename(file, '.jsonl'),
    project: path.basename(path.dirname(file)),
    model,
    startedAt,
    endedAt,
    turns,
    avgContextTokens: Math.round(ctxSum / turns),
    maxContextTokens: ctxMax,
    costUSD: cost,
    cacheReadCostUSD: cacheReadCost,
    outputCostUSD: outputCost,
    compactions,
    cappedCostUSD,
  }
}

export interface ContextReport {
  sessions: ContextProfile[]
  turns: number
  costUSD: number
  cacheReadCostUSD: number
  /** Turn-weighted average context across sessions. */
  avgContextTokens: number
  cappedCostUSD: Record<number, number>
}

/** Context profiles of every main-thread session with at least `minTurns` turns. */
export function contextReport(opts: { since?: Date; ceilings?: number[]; minTurns?: number } = {}): ContextReport {
  const ceilings = opts.ceilings ?? [150_000, 200_000, 300_000]
  const minTurns = opts.minTurns ?? 20
  const sessions: ContextProfile[] = []
  const cache = loadSpendCache()
  const live = new Set<string>()
  for (const file of listTranscriptFiles(opts.since)) {
    if (file.sidechain) continue
    live.add(file.path)
    const profile = sessionContextProfile(file.path, ceilings)
    if (!profile) continue
    const entry = cache.files[file.path]
    if (entry) entry.context = profile
    if (profile.turns >= minTurns) sessions.push(profile)
  }
  // Purged transcripts: reuse the cached profile when it covers the ceilings asked for.
  const cutoff = opts.since?.getTime()
  for (const [file, entry] of Object.entries(cache.files)) {
    if (entry.sidechain || !entry.context || live.has(file) || fs.existsSync(file)) continue
    if (cutoff !== undefined && new Date(entry.endedAt).getTime() < cutoff) continue
    if (!ceilings.every(c => entry.context!.cappedCostUSD[c] !== undefined)) continue
    if (entry.context.turns >= minTurns) sessions.push(entry.context)
  }
  saveSpendCache(cache)
  sessions.sort((a, b) => b.costUSD - a.costUSD)

  const report: ContextReport = {
    sessions,
    turns: 0,
    costUSD: 0,
    cacheReadCostUSD: 0,
    avgContextTokens: 0,
    cappedCostUSD: {},
  }
  let ctxWeighted = 0
  for (const s of sessions) {
    report.turns += s.turns
    report.costUSD += s.costUSD
    report.cacheReadCostUSD += s.cacheReadCostUSD
    ctxWeighted += s.avgContextTokens * s.turns
    for (const c of ceilings) report.cappedCostUSD[c] = (report.cappedCostUSD[c] ?? 0) + s.cappedCostUSD[c]
  }
  report.avgContextTokens = report.turns > 0 ? Math.round(ctxWeighted / report.turns) : 0
  return report
}

// ─── Re-read turns (what a compression that failed really cost) ─────────────

/** Tool results that carry a cork-ai compressed view, current and historical. */
const COMPRESSED_VIEW_MARKERS = /\[cork-ai\]|signatures extracted|^\/\/ JSON compressed|lines omitted — use Read with offset/m

/** A shell command that reads a file: `cat`, `sed -n`, `head`, `tail`, … */
const SHELL_READ_RE =
  /(?:^|[;&|]\s*)(?:rtk proxy )?(?:cat|nl|less|more|bat|sed -n [^ ]+|head(?: -[nc] ?\d+)?|tail(?: -[nc] ?\d+)?)\s+((?:\/|\.{0,2}\/)?[\w.@~/-]+\.\w+)/

export interface ReReadTurns {
  found: boolean
  /** Compressed views detected in the transcript. */
  compressions: number
  /** Of those, how many were followed by a read of the same file. */
  reReads: number
  /** Real cost of the turns that issued those re-reads (the extra API round trip). */
  extraTurnCostUSD: number
}

/**
 * Finds every cork-ai compressed view in a session and, when the same file was
 * read again afterwards, bills the assistant turn that issued the re-read.
 *
 * That turn only exists because the compressed view was not enough: it
 * re-reads the whole context (cache) and produces output, and none of it was
 * counted by the token-based penalty. This is the ground-truth cost of a
 * compression that backfired.
 */
export function sessionReReadTurns(sessionId: string): ReReadTurns {
  const out: ReReadTurns = { found: false, compressions: 0, reReads: 0, extraTurnCostUSD: 0 }
  const file = findTranscript(sessionId)
  if (!file) return out
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    return out
  }
  out.found = true

  interface ToolUse { name: string; file?: string }
  const toolUses = new Map<string, ToolUse>()
  const compressed = new Map<string, boolean>() // basename → still pending re-read
  const seenTurns = new Set<string>()

  for (const line of raw.split('\n')) {
    if (!line) continue
    let entry: TranscriptLine & { subtype?: string; message?: { id?: string; model?: string; usage?: ApiUsage; content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.subtype === 'compact_boundary') {
      // Past a compaction the compressed view is gone from context anyway.
      compressed.clear()
      continue
    }
    if (entry.isSidechain) continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue

    if (entry.type === 'assistant') {
      const id = entry.message?.id
      let billed = false
      for (const block of content as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
        if (block.type !== 'tool_use' || !block.id || !block.name) continue
        let target: string | undefined
        if (block.name === 'Read') target = block.input?.file_path as string | undefined
        else if (block.name === 'Bash') target = SHELL_READ_RE.exec((block.input?.command as string) ?? '')?.[1]
        toolUses.set(block.id, { name: block.name, file: target })
        if (!target) continue
        const key = path.basename(target)
        if (compressed.get(key) && !billed && id && !seenTurns.has(id) && entry.message?.usage && entry.message.model) {
          out.reReads += 1
          out.extraTurnCostUSD += costOfUsage(entry.message.usage, entry.message.model)
          seenTurns.add(id)
          billed = true
          compressed.set(key, false)
        }
      }
    } else if (entry.type === 'user') {
      for (const block of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        const use = toolUses.get(block.tool_use_id)
        if (!use?.file) continue
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? (block.content as Array<{ text?: string }>).map(c => c.text ?? '').join('')
            : ''
        if (COMPRESSED_VIEW_MARKERS.test(text.slice(0, 400))) {
          out.compressions += 1
          compressed.set(path.basename(use.file), true)
        }
      }
    }
  }
  return out
}
