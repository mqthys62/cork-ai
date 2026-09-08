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
 *                              `sed -i` / redirections → file marked as being edited
 *   PostToolUse Edit/Write     failed-edit detection, edited-file tracking, context guard
 *   UserPromptSubmit, Stop     context guard
 *   SessionEnd                 session digest (local file + telemetry)
 */

import fs from 'fs'
import path from 'path'
import { estimateTokensFast } from '../core/tokenizer.js'
import { inputPriceForModel } from '../pricing/index.js'
import { parseBashEdit, parseBashRead } from './bash-read.js'
import { CORK_HOME, loadConfig, updateConfig } from './config.js'
import { evaluateGuard, guardHookOutput } from './context-guard.js'
import { eligibility } from './file-eligibility.js'
import { noteSessionSeen, readSessionsSeen, writeHeartbeat } from './heartbeat.js'
import { outline } from './outline.js'
import { LIVE_DIR, accumulateInSession, readActiveLiveSessions } from './persistent-stats.js'
import { gate, recordCompression, recordEditAfter, recordRangeRead, recordReRead } from './policy.js'
import { isSkipped, markSkipped } from './skip-list.js'
import { contextBucket, costBucket, modelFamily, sendTelemetry, sendSnapshotDetached, tokenBucket, type TelemetryEvent } from './telemetry.js'
import { snapshotDue, type SnapshotReason } from './savings.js'
import { lastMainTurnUsage, lastUserPromptFromTranscript, sessionContextProfile } from './transcript-usage.js'

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
}

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

function saveSessionReads(sessionId: string, reads: SessionReads): void {
  try {
    fs.mkdirSync(LIVE_DIR, { recursive: true })
    fs.writeFileSync(readsFileFor(sessionId), JSON.stringify(reads), 'utf-8')
  } catch { /* non-critical */ }
}

function markEdited(sessionId: string, filePath: string, now: Date): void {
  if (!sessionId || !filePath) return
  const reads = loadSessionReads(sessionId)
  reads.edited ??= {}
  reads.edited[filePath] = now.toISOString()
  // A file served compressed and then edited: the model needed the real
  // content after all. Learn it for the extension.
  if (reads.files[filePath]) recordEditAfter(filePath)
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
// compression harm. Failure detection is best-effort (Claude Code's known
// Edit errors); if the payload shape differs, this is a silent no-op.
const EDIT_FAILURE_MARKERS =
  /String to replace not found|matches of the string to replace|has not been read yet|"is_error"\s*:\s*true/i

function handlePostToolUseEdit(event: Record<string, unknown>, now: Date): void {
  const toolName = (event.tool_name as string) ?? ''
  if (toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write') return
  const toolInput = (event.tool_input as Record<string, unknown>) ?? {}
  const filePath = toolInput.file_path as string
  const sessionId = (event.session_id as string) || ''
  if (!filePath || !sessionId) return

  const wasCompressed = Boolean(loadSessionReads(sessionId).files[filePath])
  markEdited(sessionId, filePath, now)
  if (!wasCompressed) return

  let respText = ''
  try { respText = JSON.stringify(event.tool_response ?? '') } catch { return }
  if (!EDIT_FAILURE_MARKERS.test(respText)) return

  // Whitelist for good: a failed Edit is the strongest possible evidence that
  // the outline was not enough for this file.
  const reads = loadSessionReads(sessionId)
  reads.files[filePath] = (reads.files[filePath] ?? 0) + 1
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
  } catch { /* non-critical */ }
}

// ─── Read handling (Read tool and Bash equivalents share one path) ───────────

interface ReadContext {
  event: Record<string, unknown>
  filePath: string
  /** 'Read' or the shell command word ('cat', …). */
  source: string
  deps: Required<HookDeps>
}

function accountReRead(ctx: ReadContext, sessionId: string, rawTokens: number, detectedModel: string | undefined, ext: string): void {
  markSkipped(ctx.filePath, 're-read')
  recordReRead(ctx.filePath)
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
  } catch { /* non-critical */ }
  ctx.deps.telemetry({ event: 'hook_reread', properties: { kind: 'full', ext, source: ctx.source, tokens: tokenBucket(rawTokens), model: modelFamily(detectedModel) } })
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
  if (reads.files[filePath] !== 1) return
  reads.files[filePath] = 2
  saveSessionReads(sessionId, reads)
  recordRangeRead(filePath)
  deps.telemetry({ event: 'hook_reread', properties: { kind: 'range', ext: path.extname(filePath).toLowerCase() || 'none' } })
}

function handleRead(ctx: ReadContext): HookOutput {
  const { event, filePath, deps } = ctx
  const ext = path.extname(filePath).toLowerCase() || 'none'
  const isSubagent = typeof event.agent_type === 'string' || typeof event.agent_id === 'string'
  const skipped = (reason: string, extra: Record<string, string | number | undefined> = {}) => {
    deps.telemetry({ event: 'hook_read', properties: { decision: 'raw', reason, ext, source: ctx.source, subagent: isSubagent, ...extra } })
    return undefined
  }

  // Never compress the file the user is explicitly asking about — the model
  // almost certainly needs its real content.
  const userPrompt = lastUserPromptFromTranscript(event.transcript_path as string | undefined)
  if (userPrompt && userPrompt.toLowerCase().includes(path.basename(filePath).toLowerCase())) return skipped('user-mentioned')

  // A file that already proved it needs its real content is served raw for good.
  if (isSkipped(filePath)) return skipped('skip-list')

  const sessionId = (event.session_id as string) || ''
  const reads = sessionId ? loadSessionReads(sessionId) : null

  // A file the model is editing in this session is served raw: every measured
  // edit flow (59% of compressed files, 97% of .tsx) ended in a full re-read.
  if (reads?.edited?.[filePath]) return skipped('editing')

  // Bytes, not a utf-8 string: `readFileSync(png, 'utf-8')` returns mojibake
  // that passes every downstream check.
  let buf: Buffer
  try { buf = fs.readFileSync(filePath) } catch { return undefined }

  const verdict = eligibility(filePath, buf)
  if (!verdict.compress) return skipped(`ineligible: ${verdict.reason.split(' ')[0]}`)

  const content = buf.toString('utf-8')
  const slice = content.split('\n').slice(0, 2000).join('\n')
  const originalTokens = estimateTokensFast(slice)

  const cfg = loadConfig()
  const turn = lastMainTurnUsage(event.transcript_path as string | undefined)
  const detectedModel = turn?.model || (event.model as string) || cfg.detectedModel

  // Re-read of a file we already compressed this session: serve it raw,
  // whitelist it, and account the induced cost against our savings.
  if (reads && reads.files[filePath]) {
    reads.files[filePath] += 1
    saveSessionReads(sessionId, reads)
    accountReRead(ctx, sessionId, originalTokens, detectedModel, ext)
    return undefined
  }

  const view = outline(slice, filePath, verdict.kind)
  const compressedTokens = estimateTokensFast(view.text)
  if (compressedTokens >= originalTokens * 0.85) return skipped('not-compressible', { tokens: tokenBucket(originalTokens) })

  // The expected-value gate: worth the re-read risk, given the live context
  // size and what this extension has done before?
  const decision = gate({
    filePath, originalTokens, compressedTokens,
    contextTokens: turn?.contextTokens ?? 0,
    model: detectedModel,
    amplification: cfg.measuredAmplification,
  })
  if (!decision.compress) {
    return skipped(decision.probation ? 'probation' : decision.reason.split(' ').slice(0, 2).join('-'), {
      tokens: tokenBucket(originalTokens), context: contextBucket(turn?.contextTokens ?? 0), model: modelFamily(detectedModel),
      p_reread: Math.round(decision.reReadProbability * 100),
    })
  }

  const saved = originalTokens - compressedTokens
  if (reads && sessionId) {
    reads.files[filePath] = 1
    saveSessionReads(sessionId, reads)
  }
  recordCompression(filePath)

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
  } catch { /* non-critical */ }

  deps.telemetry({
    event: 'hook_read',
    properties: {
      decision: 'outline', ext, source: ctx.source, kind: verdict.kind, subagent: isSubagent,
      tokens: tokenBucket(originalTokens), saved_pct: Math.round((saved / originalTokens) * 100),
      context: contextBucket(turn?.contextTokens ?? 0), model: modelFamily(detectedModel),
      p_reread: Math.round(decision.reReadProbability * 100), probe: decision.reason === 'probation probe',
    },
  })
  return denyWith(view.text)
}

function handleBash(event: Record<string, unknown>, deps: Required<HookDeps>): HookOutput {
  const command = ((event.tool_input as Record<string, unknown>)?.command as string) ?? ''
  const cwd = (event.cwd as string) || process.cwd()
  const sessionId = (event.session_id as string) || ''

  const edit = parseBashEdit(command, cwd)
  if (edit) { markEdited(sessionId, edit.file, deps.now()); return undefined }

  const read = parseBashRead(command, cwd)
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

export const DIGEST_DIR = path.join(CORK_HOME, 'digests')

export interface SessionDigest {
  sessionId: string
  endedAt: string
  reason?: string
  model?: string
  permissionMode?: string
  turns: number
  avgContextTokens: number
  maxContextTokens: number
  costUSD: number
  /** What the same session would have cost with auto-compaction at 200k. */
  cappedCost200kUSD: number
  compactions: number
  /** Outlines served / full re-reads / edit failures, from the live session record. */
  compressions: number
  reReads: number
  editFailures: number
  savedTokens: number
  guardBands: number[]
}

function handleSessionEnd(event: Record<string, unknown>, deps: Required<HookDeps>): void {
  const sessionId = (event.session_id as string) || ''
  const transcriptPath = event.transcript_path as string | undefined
  if (!sessionId || !transcriptPath) return
  const profile = sessionContextProfile(transcriptPath, [200_000])
  if (!profile) return

  const live = readActiveLiveSessions().find(s => s.sessionId === sessionId)
  let guardBands: number[] = []
  try {
    const safe = sessionId.replace(/[^\w.-]/g, '_').slice(0, 80)
    guardBands = (JSON.parse(fs.readFileSync(path.join(LIVE_DIR, `guard-${safe}.json`), 'utf-8')) as { notified?: number[] }).notified ?? []
  } catch { /* no guard state */ }

  const digest: SessionDigest = {
    sessionId,
    endedAt: deps.now().toISOString(),
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
  try {
    fs.mkdirSync(DIGEST_DIR, { recursive: true })
    fs.writeFileSync(path.join(DIGEST_DIR, `${sessionId.replace(/[^\w.-]/g, '_').slice(0, 80)}.json`), JSON.stringify(digest, null, 2), 'utf-8')
  } catch { /* non-critical */ }

  const startedAt = readSessionsSeen()[sessionId]
  deps.telemetry({
    event: 'session_digest',
    properties: {
      model: modelFamily(profile.model),
      permission_mode: digest.permissionMode,
      duration_min: startedAt ? Math.max(0, Math.round((deps.now().getTime() - new Date(startedAt).getTime()) / 60_000)) : undefined,
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

  if (toolName === 'Bash') return handleBash(event, deps)
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
