/**
 * The hook — everything Claude Code calls us for, as one pure function.
 *
 * `handleHookEvent(event)` takes the JSON payload Claude Code writes on stdin
 * and returns the JSON to print on stdout (or nothing). No `process.exit`, no
 * `console.log`: the CLI entry point does the I/O, tests call this directly.
 *
 * Events handled:
 *   PreToolUse  Read           whole-file reads → numbered outline when the EV gate says so
 *   PreToolUse  Bash           `cat file` & co → same path; `sed -n` & co → follow-up tracking;
 *               PowerShell     `sed -i` / redirections → file marked as being edited;
 *                              `Get-Content` / `gc` / `type` under the PowerShell tool
 *   PostToolUse Edit/Write     edited-file tracking, context guard
 *   PostToolUseFailure Edit…   failed-edit detection (whitelist the file for good)
 *   UserPromptSubmit, Stop     context guard
 *   SessionEnd                 session digest (local file + telemetry)
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { estimateTokensFast } from '../core/tokenizer.js'
import { inputPriceForModel, resolvePricing } from '../pricing/index.js'
import { parseBashEdit, parseBashRead } from './bash-read.js'
import { loadConfig, updateConfig } from './config.js'
import { writeDigest, type SessionDigest } from './digests.js'
import { evaluateGuard, guardHookOutput } from './context-guard.js'
import { eligibility, CODE_EXTS, TEXT_EXTS, BINARY_EXTS } from './file-eligibility.js'
import { noteSessionSeen, readSessionsSeen, writeHeartbeat } from './heartbeat.js'
import { outline } from './outline.js'
import { LIVE_DIR, accumulateInSession, readActiveLiveSessions } from './persistent-stats.js'
import { agentClassOf, gate, recordCompression, recordEditAfter, recordProbationRead, recordRangeRead, recordReRead, type AgentClass, type PolicyScope } from './policy.js'
import { isSkipped, markSkipped } from './skip-list.js'
import { contextBucket, costBucket, modelFamily, sendTelemetry, sendSnapshotDetached, tokenBucket, type TelemetryEvent } from './telemetry.js'
import { snapshotDue, type SnapshotReason } from './savings.js'
import { agentTranscriptPath, lastMainTurnUsage, lastUserPromptFromTranscript, sessionContextProfile, transcriptSince } from './transcript-usage.js'
import { writeFileAtomic, debugLog } from './fs-utils.js'

export type HookOutput = Record<string, unknown> | undefined

export interface HookDeps {
  /** Telemetry sink; defaults to the real one (which is a no-op unless opted in). */
  telemetry?: (e: TelemetryEvent) => void
  /** Daily savings snapshot trigger; defaults to a detached `cork-ai __send-snapshot`. */
  snapshot?: (reason: SnapshotReason) => void
  now?: () => Date
}

// ─── Per-session read tracking (re-read = compression harmed the model) ──────

export interface SessionReads {
  /** filePath → 1 served compressed, 2 followed up (range read or re-read) */
  files: Record<string, number>
  /** filePath → ISO time of the last edit seen this session */
  edited?: Record<string, string>
  /** filePath → the last time the whole file was served raw (re-read cache). */
  raw?: Record<string, RawRead>
}

/**
 * A whole file the model received raw, and everything needed to know later
 * whether it still has that exact content in context: the file's fingerprint
 * (changed on disk?), the transcript offset (compacted since?), the agent
 * (same context?).
 */
export interface RawRead {
  mtimeMs: number
  size: number
  /** Short content hash — mtime and size can both survive a `git checkout`. */
  hash: string
  at: string
  /** Transcript size when the read was served; `transcriptSince` scans from here. */
  offset: number
  /** Subagent id, null for the main conversation. Contexts are separate. */
  agent: string | null
  /** Reminders served instead of the content since this raw read. */
  hits: number
  /** The model re-read the whole file after a reminder: never remind again this session. */
  missed?: boolean
}

/**
 * Key of a file in `SessionReads.files` / `.raw`. Subagents share the session
 * id but not the context: what the main conversation was served says nothing
 * about what an Explore agent has. Edits stay session-wide (`edited`): a
 * change on disk is a change for everyone.
 */
export function readsKey(filePath: string, event: Record<string, unknown>): string {
  const agent = typeof event.agent_id === 'string' ? event.agent_id : ''
  return agent ? `@${agent}:${filePath}` : filePath
}

function fingerprint(filePath: string, buf: Buffer): Pick<RawRead, 'mtimeMs' | 'size' | 'hash'> {
  let mtimeMs = 0
  try { mtimeMs = fs.statSync(filePath).mtimeMs } catch { /* fingerprint on content only */ }
  return { mtimeMs, size: buf.length, hash: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) }
}

function transcriptSize(transcriptPath: string | undefined): number {
  if (!transcriptPath) return -1
  try { return fs.statSync(transcriptPath).size } catch { return -1 }
}

/** Tokens of the reminder itself, for the accounting (the real text is ~60). */
const CACHE_REMINDER_TOKENS = 80
/** Claude Code's `Read` returns this many lines by default; the outline works on the same slice. */
const READ_DEFAULT_LINES = 2_000
/** Above this, Claude Code spills a Bash tool's output to a file and shows a preview: the model did not get the content. */
const SHELL_OUTPUT_SPILL_BYTES = 30_000
/**
 * Files above this are never outlined nor hashed: reading and hashing a 100 MB
 * log costs 360 ms and 300 MB of memory for an outline of its first 2000
 * lines. They pass raw — Claude Code truncates them itself.
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024

export function readsFileFor(sessionId: string): string {
  const safe = sessionId.replace(/[^\w.-]/g, '_').slice(0, 80)
  return path.join(LIVE_DIR, `reads-${safe}.json`)
}

export function loadSessionReads(sessionId: string): SessionReads {
  try {
    const parsed = JSON.parse(fs.readFileSync(readsFileFor(sessionId), 'utf-8')) as SessionReads
    return parsed && typeof parsed.files === 'object' ? parsed : { files: {} }
  } catch {
    return { files: {} }
  }
}

/**
 * Merge-on-write. Claude Code runs the hooks of parallel tool calls at the
 * same time, and parallel subagents share the session file: a plain
 * load-modify-save loses whatever the other hook wrote in between (six
 * concurrent reads left one entry). The atomic rename only prevents torn
 * files, so the state on disk is re-read right before saving and this hook's
 * entries are laid over it — nothing is ever deleted from these maps, so a
 * union is the right merge, with this process winning on the keys it touched.
 */
export function saveSessionReads(sessionId: string, reads: SessionReads): void {
  try {
    fs.mkdirSync(LIVE_DIR, { recursive: true })
    const disk = loadSessionReads(sessionId)
    const merged: SessionReads = { files: { ...disk.files, ...reads.files } }
    if (disk.edited || reads.edited) merged.edited = { ...disk.edited, ...reads.edited }
    if (disk.raw || reads.raw) merged.raw = { ...disk.raw, ...reads.raw }
    writeFileAtomic(readsFileFor(sessionId), JSON.stringify(merged))
  } catch (err) { debugLog('hook.saveSessionReads', err) }
}

function markEdited(sessionId: string, filePath: string, now: Date, event: Record<string, unknown>): void {
  if (!sessionId || !filePath) return
  const reads = loadSessionReads(sessionId)
  reads.edited ??= {}
  reads.edited[filePath] = now.toISOString()
  // A file served compressed and then edited: the model needed the real
  // content after all. Learn it for the extension.
  if (reads.files[readsKey(filePath, event)]) recordEditAfter(filePath, { agentClass: agentClassOf(event) })
  saveSessionReads(sessionId, reads)
}

// ─── Hook output ─────────────────────────────────────────────────────────────

/**
 * Deny the tool call and hand the compressed view back as the reason. Claude
 * Code shows `permissionDecisionReason` to the model in place of the tool
 * result. The legacy top-level `decision: "block"` is kept for older versions;
 * when both are present `hookSpecificOutput` takes precedence.
 */
export function denyWith(reason: string): HookOutput {
  return {
    decision: 'block',
    reason,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }
}

// ─── PostToolUse on Edit / Write ─────────────────────────────────────────────

// An Edit that fails on a file we only ever served compressed means the
// model's old_string came from the outline, not the real file — direct
// compression harm. Claude Code reports tool failures on `PostToolUseFailure`
// (`error` field); `PostToolUse` fires on success only, so the markers below
// on its `tool_response` are a fallback for older payload shapes.
const EDIT_FAILURE_MARKERS =
  /String to replace not found|matches of the string to replace|has not been read yet|"is_error"\s*:\s*true/i

function handlePostToolUseEdit(event: Record<string, unknown>, now: Date, failed = false): void {
  const toolName = (event.tool_name as string) ?? ''
  if (toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write') return
  const toolInput = (event.tool_input as Record<string, unknown>) ?? {}
  const filePath = toolInput.file_path as string
  const sessionId = (event.session_id as string) || ''
  if (!filePath || !sessionId) return

  const key = readsKey(filePath, event)
  const wasCompressed = Boolean(loadSessionReads(sessionId).files[key])
  // A failed edit changed nothing on disk: the re-read cache stays valid.
  if (!failed) markEdited(sessionId, filePath, now, event)
  if (!wasCompressed) return

  if (!failed) {
    let respText = ''
    try { respText = JSON.stringify(event.tool_response ?? '') } catch { return }
    if (!EDIT_FAILURE_MARKERS.test(respText)) return
  }

  // Whitelist for good: a failed Edit is the strongest possible evidence that
  // the outline was not enough for this file.
  const reads = loadSessionReads(sessionId)
  reads.files[key] = (reads.files[key] ?? 0) + 1
  saveSessionReads(sessionId, reads)
  markSkipped(filePath, 'edit-failure')
  try {
    accumulateInSession({
      projectPath: (event.cwd as string) || process.cwd(),
      originalTokens: 0, compressedTokens: 0, savedTokens: 0, estimatedCostSaved: 0, byModule: {},
      model: loadConfig().detectedModel,
      sessionId,
      editFailure: true,
    })
  } catch (err) { debugLog('hook.editFailure.accumulate', err) }
}

// ─── Read handling (Read tool and Bash equivalents share one path) ───────────

interface ReadContext {
  event: Record<string, unknown>
  filePath: string
  /** 'Read' or the shell command word ('cat', …). */
  source: string
  deps: Required<HookDeps>
}

/**
 * The re-read cache: the file was served raw earlier in this session and the
 * model still has it — same bytes on disk, no compaction since, same context.
 * Returns why it does not apply otherwise (telemetry `cache_miss`).
 */
function cacheStatus(entry: RawRead | undefined, fp: ReturnType<typeof fingerprint>, transcriptPath: string | undefined, agent: string | null, own = false): { hit: true; turnsAgo: number } | { hit: false; miss?: string } {
  if (!entry) return { hit: false }
  if (entry.missed) return { hit: false, miss: 'missed' }
  if (entry.agent !== agent) return { hit: false, miss: 'other-agent' }
  if (entry.hash !== fp.hash || entry.size !== fp.size) return { hit: false, miss: 'changed' }
  const since = transcriptSince(transcriptPath, entry.offset, own)
  if (!since) return { hit: false, miss: 'unknown' }
  if (since.compacted) return { hit: false, miss: 'compacted' }
  return { hit: true, turnsAgo: since.turns }
}

function cacheReminder(filePath: string, lines: number, turnsAgo: number): string {
  const when = turnsAgo === 0 ? 'this turn' : turnsAgo === 1 ? '1 turn ago' : `${turnsAgo} turns ago`
  return [
    `[cork-ai] ${path.basename(filePath)} — already read ${when}, unchanged since (${lines} lines, L1–L${lines}): the full content is still in your context above.`,
    `[cork-ai] To view a region again: Read with offset=<line> limit=<n>, or \`sed -n '<a>,<b>p' ${filePath}\`.`,
    `[cork-ai] Re-reading the whole file once more serves it raw.`,
  ].join('\n')
}

function accountReRead(ctx: ReadContext, sessionId: string, rawTokens: number, detectedModel: string | undefined, ext: string, scope: PolicyScope): void {
  markSkipped(ctx.filePath, 're-read')
  recordReRead(ctx.filePath, scope)
  try {
    accumulateInSession({
      projectPath: (ctx.event.cwd as string) || process.cwd(),
      originalTokens: 0, compressedTokens: 0, savedTokens: 0,
      // The second read only exists because the first one was compressed —
      // its full raw cost is induced by us. Deduct it.
      estimatedCostSaved: -(rawTokens / 1_000_000) * inputPriceForModel(detectedModel),
      byModule: {},
      model: detectedModel,
      sessionId,
      reRead: true,
      reReadTokensServed: rawTokens,
    })
  } catch (err) { debugLog('hook.reRead.accumulate', err) }
  ctx.deps.telemetry({ event: 'hook_reread', properties: { kind: 'full', ext, source: ctx.source, tokens: tokenBucket(rawTokens), model: modelFamily(detectedModel), agent_class: scope.agentClass } })
}

/**
 * A targeted read (sed -n, head, tail, Read with offset/limit) of a file that
 * was served compressed this session: the outline pointed the model at a
 * region and it read just that. The intended follow-up — recorded, but it
 * does not count against the extension; only a full re-read does.
 */
function noteRangeRead(event: Record<string, unknown>, filePath: string, deps: Required<HookDeps>): void {
  const sessionId = (event.session_id as string) || ''
  if (!sessionId) return
  const reads = loadSessionReads(sessionId)
  const key = readsKey(filePath, event)
  if (reads.files[key] !== 1) return
  reads.files[key] = 2
  saveSessionReads(sessionId, reads)
  recordRangeRead(filePath, { agentClass: agentClassOf(event) })
  deps.telemetry({ event: 'hook_reread', properties: { kind: 'range', ext: telemetryExt(filePath), agent_class: agentClassOf(event) } })
}

/**
 * The extension as sent to telemetry: a known one, `none`, or `other`. Never a
 * fragment of the file name (`notes.acme-internal` is not an extension).
 */
export function telemetryExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (!ext) return 'none'
  return CODE_EXTS.has(ext) || TEXT_EXTS.has(ext) || BINARY_EXTS.has(ext) ? ext : 'other'
}

function handleRead(ctx: ReadContext): HookOutput {
  const { event, filePath, deps } = ctx
  const ext = telemetryExt(filePath)
  const agentClass: AgentClass = agentClassOf(event)
  const isSubagent = agentClass !== 'main'
  const agent = typeof event.agent_id === 'string' ? event.agent_id : null
  // A subagent's payload carries the main transcript; its own context (size,
  // compactions, task prompt) is in its sidechain file when Claude Code keeps one.
  const mainTranscript = event.transcript_path as string | undefined
  const ownTranscript = agentTranscriptPath(mainTranscript, agent)
  const transcriptPath = ownTranscript ?? mainTranscript
  const own = ownTranscript !== undefined
  const sessionId = (event.session_id as string) || ''
  const reads = sessionId ? loadSessionReads(sessionId) : null
  const key = readsKey(filePath, event)
  const cfg = loadConfig()
  // Read-only subagents can be handled more aggressively (lower threshold, no
  // "being edited" rule): their context is discarded and they never edit.
  const aggressive = agentClass === 'readonly' && cfg.policy?.readonlyAgentsAggressive !== false
  const scope: PolicyScope = { agentClass: aggressive ? 'readonly' : agentClass === 'main' ? 'main' : 'editing' }

  // Whatever leaves this function raw and whole is now in the model's context:
  // remember it so the next identical read can be a reminder (re-read cache).
  // Only when the model really received the whole file: `Read` stops at 2000
  // lines and a Bash output above ~30 KB is spilled to a file with a preview,
  // and a reminder saying "still in your context" would then be a lie.
  let fp: ReturnType<typeof fingerprint> | undefined
  let deliveredWhole = false
  const servedRaw = () => {
    if (!fp || !reads || !sessionId || !deliveredWhole) return
    reads.raw ??= {}
    const prev = reads.raw[key]
    reads.raw[key] = { ...fp, at: deps.now().toISOString(), offset: transcriptSize(transcriptPath), agent, hits: 0, ...(prev?.missed ? { missed: true } : {}) }
    saveSessionReads(sessionId, reads)
  }
  const skipped = (reason: string, extra: Record<string, string | number | undefined> = {}) => {
    servedRaw()
    deps.telemetry({ event: 'hook_read', properties: { decision: 'raw', reason, ext, source: ctx.source, subagent: isSubagent, agent_class: agentClass, ...extra } })
    return undefined
  }

  // Never compress the file the user is explicitly asking about — the model
  // almost certainly needs its real content.
  const userPrompt = lastUserPromptFromTranscript(transcriptPath, own)
  if (userPrompt && userPrompt.toLowerCase().includes(path.basename(filePath).toLowerCase())) return skipped('user-mentioned')

  // A file that already proved it needs its real content is served raw for good.
  if (isSkipped(filePath)) return skipped('skip-list')

  // Claude Code's own spill files (`…/tool-results/toolu_*.txt`): the model
  // opens them precisely to see the full output it was just shown a preview
  // of. A 12-line text outline of that guarantees a re-read.
  if (/[\\/]tool-results[\\/]/.test(filePath)) return skipped('tool-results')

  // A file the model is editing in this session is served raw: every measured
  // edit flow (59% of compressed files, 97% of .tsx) ended in a full re-read.
  if (!aggressive && reads?.edited?.[filePath]) return skipped('editing')

  // Size and kind first: a FIFO or a device would block or never end, and a
  // huge file is not worth reading at all.
  let size = 0
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile()) return undefined
    size = st.size
  } catch { return undefined }
  if (size > MAX_FILE_BYTES) return skipped('ineligible: too-large', { tokens: '>15k' })

  // Bytes, not a utf-8 string: `readFileSync(png, 'utf-8')` returns mojibake
  // that passes every downstream check.
  let buf: Buffer
  try { buf = fs.readFileSync(filePath) } catch { return undefined }
  fp = fingerprint(filePath, buf)

  const verdict = eligibility(filePath, buf)
  if (!verdict.compress) return skipped(`ineligible: ${verdict.reason.split(' ')[0]}`)

  const content = buf.toString('utf-8')
  const allLines = content.split('\n')
  const totalLines = allLines.length
  const slice = allLines.slice(0, READ_DEFAULT_LINES).join('\n')
  const originalTokens = estimateTokensFast(slice)
  deliveredWhole = totalLines <= READ_DEFAULT_LINES && (ctx.source === 'Read' || buf.length <= SHELL_OUTPUT_SPILL_BYTES)

  const turn = lastMainTurnUsage(transcriptPath, undefined, own)
  const detectedModel = turn?.model || (event.model as string) || cfg.detectedModel
  const contextTokens = turn?.contextTokens ?? 0

  // Re-read of a file we already compressed this session: serve it raw,
  // whitelist it, and account the induced cost against our savings.
  if (reads && reads.files[key]) {
    reads.files[key] += 1
    saveSessionReads(sessionId, reads)
    accountReRead(ctx, sessionId, originalTokens, detectedModel, ext, scope)
    servedRaw()
    return undefined
  }

  // The re-read cache: the whole file went raw into this very context earlier
  // and nothing changed since — a reminder instead of the content.
  const cached = reads?.raw?.[key]
  const cache = cfg.policy?.reReadCache === false ? { hit: false as const } : cacheStatus(cached, fp, transcriptPath, agent, own)
  if (cached && cached.hits > 0 && !cached.missed && cache.hit) {
    // A whole read right after a reminder: the reminder was not enough. Serve
    // raw, learn it, charge the extra turn, stop reminding for this file.
    cached.missed = true
    saveSessionReads(sessionId, reads!)
    recordReRead(filePath, { mode: 'cache' })
    try {
      accumulateInSession({
        projectPath: (event.cwd as string) || process.cwd(),
        originalTokens: 0, compressedTokens: 0, savedTokens: 0,
        // The induced cost is the extra turn: one cache read of the whole context plus its output.
        estimatedCostSaved: -((contextTokens / 1_000_000) * resolvePricing(detectedModel).cacheRead + (300 / 1_000_000) * resolvePricing(detectedModel).output),
        byModule: {}, model: detectedModel, sessionId, reRead: true, reReadTokensServed: originalTokens,
      })
    } catch (err) { debugLog('hook.afterCache.accumulate', err) }
    deps.telemetry({ event: 'hook_reread', properties: { kind: 'after-cache', ext, source: ctx.source, tokens: tokenBucket(originalTokens), model: modelFamily(detectedModel), agent_class: agentClass } })
    servedRaw()
    return undefined
  }
  if (cache.hit && reads && cached) {
    const lines = content.split('\n').length
    const decision = gate({
      filePath, originalTokens, compressedTokens: CACHE_REMINDER_TOKENS,
      contextTokens, model: detectedModel, amplification: cfg.measuredAmplification,
      scope: { mode: 'cache' },
    })
    if (decision.probation) recordProbationRead(filePath, { mode: 'cache' })
    if (decision.compress) {
      cached.hits += 1
      saveSessionReads(sessionId, reads)
      recordCompression(filePath, { mode: 'cache' })
      const saved = originalTokens - CACHE_REMINDER_TOKENS
      try {
        accumulateInSession({
          projectPath: (event.cwd as string) || process.cwd(),
          originalTokens, compressedTokens: CACHE_REMINDER_TOKENS, savedTokens: saved,
          estimatedCostSaved: (saved / 1_000_000) * inputPriceForModel(detectedModel),
          byModule: { hookReadCache: saved }, model: detectedModel, sessionId,
        })
      } catch (err) { debugLog('hook.cacheHit.accumulate', err) }
      deps.telemetry({
        event: 'hook_read',
        properties: {
          decision: 'cached', ext, source: ctx.source, kind: verdict.kind, subagent: isSubagent, agent_class: agentClass,
          tokens: tokenBucket(originalTokens), saved_pct: Math.round((saved / originalTokens) * 100),
          context: contextBucket(contextTokens), model: modelFamily(detectedModel),
          p_reread: Math.round(decision.reReadProbability * 100), turns_ago: cache.turnsAgo,
        },
      })
      return denyWith(cacheReminder(filePath, lines, cache.turnsAgo))
    }
  }
  const cacheMiss = cached && !cache.hit ? cache.miss : undefined

  const view = outline(slice, filePath, verdict.kind, totalLines)
  const compressedTokens = estimateTokensFast(view.text)
  if (compressedTokens >= originalTokens * 0.85) return skipped('not-compressible', { tokens: tokenBucket(originalTokens), cache_miss: cacheMiss })

  // The expected-value gate: worth the re-read risk, given the live context
  // size and what this extension has done before?
  const decision = gate({
    filePath, originalTokens, compressedTokens,
    contextTokens,
    model: detectedModel,
    amplification: cfg.measuredAmplification,
    scope,
  })
  if (decision.probation) recordProbationRead(filePath, scope)
  if (!decision.compress) {
    return skipped(decision.probation ? 'probation' : decision.reason.split(' ').slice(0, 2).join('-'), {
      tokens: tokenBucket(originalTokens), context: contextBucket(contextTokens), model: modelFamily(detectedModel),
      p_reread: Math.round(decision.reReadProbability * 100), cache_miss: cacheMiss,
    })
  }

  const saved = originalTokens - compressedTokens
  if (reads && sessionId) {
    reads.files[key] = 1
    saveSessionReads(sessionId, reads)
  }
  recordCompression(filePath, scope)

  try {
    if (detectedModel && cfg.detectedModel !== detectedModel) updateConfig({ detectedModel })
    accumulateInSession({
      projectPath: (event.cwd as string) || process.cwd(),
      originalTokens, compressedTokens, savedTokens: saved,
      estimatedCostSaved: (saved / 1_000_000) * inputPriceForModel(detectedModel),
      byModule: { [ctx.source === 'Read' ? 'hookReadCompressor' : 'hookBashReadCompressor']: saved },
      model: detectedModel,
      sessionId: sessionId || undefined,
    })
  } catch (err) { debugLog('hook.outline.accumulate', err) }

  deps.telemetry({
    event: 'hook_read',
    properties: {
      decision: 'outline', ext, source: ctx.source, kind: verdict.kind, subagent: isSubagent, agent_class: agentClass,
      tokens: tokenBucket(originalTokens), saved_pct: Math.round((saved / originalTokens) * 100),
      context: contextBucket(contextTokens), model: modelFamily(detectedModel),
      p_reread: Math.round(decision.reReadProbability * 100), probe: decision.reason === 'probation probe', cache_miss: cacheMiss,
    },
  })
  return denyWith(view.text)
}

function handleBash(event: Record<string, unknown>, deps: Required<HookDeps>): HookOutput {
  const command = ((event.tool_input as Record<string, unknown>)?.command as string) ?? ''
  const cwd = (event.cwd as string) || process.cwd()
  const sessionId = (event.session_id as string) || ''

  const edit = parseBashEdit(command, cwd)
  if (edit) { markEdited(sessionId, edit.file, deps.now(), event); return undefined }

  const read = parseBashRead(command, cwd, event.tool_name === 'PowerShell' ? 'powershell' : 'bash')
  if (!read) return undefined
  if (read.kind === 'range') { noteRangeRead(event, read.file, deps); return undefined }
  return handleRead({ event, filePath: read.file, source: read.tool, deps })
}

// ─── Context guard ───────────────────────────────────────────────────────────

function runGuard(event: Record<string, unknown>, hookEvent: 'UserPromptSubmit' | 'PostToolUse' | 'Stop' | 'SessionStart', deps: Required<HookDeps>): HookOutput {
  const cfg = loadConfig()
  const notice = evaluateGuard({
    sessionId: (event.session_id as string) || '',
    transcriptPath: event.transcript_path as string | undefined,
    event: hookEvent,
    config: cfg.contextGuard,
  })
  if (!notice) return undefined
  deps.telemetry({ event: 'guard_notice', properties: { band: notice.band, context: contextBucket(notice.contextTokens), model: modelFamily(notice.model), on: hookEvent } })
  return guardHookOutput(notice, hookEvent, cfg.contextGuard?.nudgeModel !== false)
}

// ─── Session digest (SessionEnd) ─────────────────────────────────────────────

export { DIGEST_DIR, type SessionDigest } from './digests.js'

/** Session state files (`reads-*.json`, `guard-*.json`) older than this are dropped at SessionEnd. */
const LIVE_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The per-session state files were never deleted (19 of them dating back two
 * months on one machine). A `--resume` can bring a session back days later,
 * so they are kept a week, then pruned whenever a session ends.
 */
export function pruneLiveState(now: Date = new Date(), dir: string = LIVE_DIR): number {
  let removed = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^(reads|guard)-.*\.json$/.test(name)) continue
      const file = path.join(dir, name)
      try {
        if (now.getTime() - fs.statSync(file).mtimeMs > LIVE_STATE_MAX_AGE_MS) { fs.unlinkSync(file); removed += 1 }
      } catch (err) { debugLog('hook.pruneLiveState', err) }
    }
  } catch { /* no live dir yet */ }
  return removed
}

function handleSessionEnd(event: Record<string, unknown>, deps: Required<HookDeps>): void {
  const sessionId = (event.session_id as string) || ''
  const transcriptPath = event.transcript_path as string | undefined
  pruneLiveState(deps.now())
  if (!sessionId || !transcriptPath) return
  const profile = sessionContextProfile(transcriptPath, [200_000])
  if (!profile) return

  const live = readActiveLiveSessions().find(s => s.sessionId === sessionId)
  let guardBands: number[] = []
  try {
    const safe = sessionId.replace(/[^\w.-]/g, '_').slice(0, 80)
    guardBands = (JSON.parse(fs.readFileSync(path.join(LIVE_DIR, `guard-${safe}.json`), 'utf-8')) as { notified?: number[] }).notified ?? []
  } catch { /* no guard state */ }

  const startedAt = readSessionsSeen()[sessionId]
  const durationMin = startedAt ? Math.max(0, Math.round((deps.now().getTime() - new Date(startedAt).getTime()) / 60_000)) : undefined
  const digest: SessionDigest = {
    sessionId,
    endedAt: deps.now().toISOString(),
    startedAt,
    durationMin,
    project: typeof event.cwd === 'string' && event.cwd ? path.basename(event.cwd) : undefined,
    reason: event.reason as string | undefined,
    model: profile.model,
    permissionMode: event.permission_mode as string | undefined,
    turns: profile.turns,
    avgContextTokens: profile.avgContextTokens,
    maxContextTokens: profile.maxContextTokens,
    costUSD: profile.costUSD,
    cappedCost200kUSD: profile.cappedCostUSD[200_000],
    compactions: profile.compactions,
    compressions: live?.requests ?? 0,
    reReads: live?.reReads ?? 0,
    editFailures: live?.editFailuresAfterCompression ?? 0,
    savedTokens: live?.savedTokens ?? 0,
    guardBands,
  }
  writeDigest(digest, deps.now())

  deps.telemetry({
    event: 'session_digest',
    properties: {
      model: modelFamily(profile.model),
      permission_mode: digest.permissionMode,
      duration_min: durationMin,
      saved_tokens: digest.savedTokens,
      turns: profile.turns,
      avg_context: contextBucket(profile.avgContextTokens),
      max_context: contextBucket(profile.maxContextTokens),
      cost: costBucket(profile.costUSD),
      saving_at_200k_pct: profile.costUSD > 0 ? Math.round(((profile.costUSD - digest.cappedCost200kUSD) / profile.costUSD) * 100) : 0,
      compactions: profile.compactions,
      compressions: digest.compressions,
      rereads: digest.reReads,
      edit_failures: digest.editFailures,
      guard_bands: guardBands.length,
      reason: digest.reason,
    },
  })
  if (snapshotDue(deps.now())) deps.snapshot('session_end')
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export function handleHookEvent(event: Record<string, unknown>, partialDeps: HookDeps = {}): HookOutput {
  const deps: Required<HookDeps> = {
    telemetry: partialDeps.telemetry ?? sendTelemetry,
    snapshot: partialDeps.snapshot ?? (reason => sendSnapshotDetached(reason)),
    now: partialDeps.now ?? (() => new Date()),
  }
  const toolName = (event.tool_name as string) ?? ''
  const toolInput = (event.tool_input as Record<string, unknown>) ?? {}
  const hookEvent = (event.hook_event_name as string) ?? ''

  writeHeartbeat(event, deps.now())
  const sessionId = (event.session_id as string) || ''
  if (sessionId && noteSessionSeen(sessionId, deps.now()).first) {
    deps.telemetry({
      event: 'session_start',
      properties: { on: hookEvent, permission_mode: event.permission_mode as string | undefined, subagent: Boolean(event.agent_id || event.agent_type) },
    })
  }

  switch (hookEvent) {
    case 'PostToolUse':
      handlePostToolUseEdit(event, deps.now())
      return runGuard(event, 'PostToolUse', deps)
    case 'PostToolUseFailure':
      handlePostToolUseEdit(event, deps.now(), true)
      return undefined
    case 'UserPromptSubmit':
    case 'Stop':
    case 'SessionStart':
      return runGuard(event, hookEvent, deps)
    case 'SessionEnd':
      handleSessionEnd(event, deps)
      return undefined
    case 'PreToolUse':
      break
    default:
      return undefined
  }

  if (toolName === 'Bash' || toolName === 'PowerShell') return handleBash(event, deps)
  if (toolName !== 'Read') return undefined

  const filePath = toolInput.file_path as string
  if (!filePath) return undefined

  // Explicit offset/limit = the model is targeting a precise zone. Never compress those.
  if (toolInput.offset !== undefined || toolInput.limit !== undefined) {
    noteRangeRead(event, filePath, deps)
    return undefined
  }
  return handleRead({ event, filePath, source: 'Read', deps })
}
