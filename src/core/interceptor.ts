/**
 * Interceptor — transparent middleware over the Anthropic SDK.
 * wrapClient() returns a client with an interface identical to the original.
 * All messages.create() calls are automatically optimized.
 *
 * Measurement layer: after every request the interceptor records the API's
 * own `response.usage` (ground truth — input/output/cache tiers) and the
 * `anthropic-ratelimit-*` response headers. Estimates demonstrate value;
 * measurements are what you bill against.
 */

import { runPipeline } from './pipeline.js'
import { ConversationRegistry } from './prefix-stable.js'
import {
  countMessageTokens,
  countRequestChars,
  countRequestTokens,
  getCalibrationFactor,
  recordPassiveSample,
  setActiveModel,
} from './tokenizer.js'
import { StatsTracker } from '../stats/tracker.js'
import { recordSession } from '../cli/persistent-stats.js'
import type {
  CorkAIOptions,
  FullStats,
  MeasuredUsageStats,
  Message,
  RateLimitStatus,
} from '../types/index.js'

// Minimal type compatible with the Anthropic SDK (avoids a direct dep)
interface AnthropicCreateParams {
  messages: Message[]
  system?: string
  model: string
  max_tokens: number
  [key: string]: unknown
}

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface AnthropicMessageResponse {
  id: string
  type: string
  role: string
  content: unknown[]
  model: string
  usage: AnthropicUsage
  [key: string]: unknown
}

interface AnthropicMessagesAPI {
  create(params: AnthropicCreateParams): Promise<AnthropicMessageResponse>
  stream?(params: AnthropicCreateParams): unknown
}

interface AnthropicClient {
  messages: AnthropicMessagesAPI
  [key: string]: unknown
}

/**
 * Wrapped client — identical interface to the Anthropic SDK with cork-ai methods added.
 */
export interface WrappedClient extends AnthropicClient {
  /** Returns stats from the last request + session */
  getStats(): FullStats | null
  /** Saves the current session to ~/.cork-ai/stats.json and resets */
  resetStats(): void
  /** Saves the session without resetting it (for end-of-process use) */
  saveSession(): void
  /** Last observed anthropic-ratelimit-* headers (null before the first response) */
  getRateLimitStatus(): RateLimitStatus | null
  /** Ground-truth usage accumulated from response.usage (null before the first response) */
  getMeasuredUsage(): MeasuredUsageStats | null
}

// ─── Rate-limit header parsing ────────────────────────────────────────────────

type HeaderSource = { get(name: string): string | null | undefined } | Record<string, unknown>

function headerValue(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get(n: string): string | null | undefined }).get(name)
    return v ?? undefined
  }
  const rec = headers as Record<string, unknown>
  const v = rec[name] ?? rec[name.toLowerCase()]
  return typeof v === 'string' ? v : undefined
}

function parseRateLimitHeaders(headers: HeaderSource): RateLimitStatus | null {
  const num = (name: string): number | undefined => {
    const v = headerValue(headers, name)
    if (v === undefined) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const str = (name: string): string | undefined => headerValue(headers, name)

  const status: RateLimitStatus = {
    requestsLimit: num('anthropic-ratelimit-requests-limit'),
    requestsRemaining: num('anthropic-ratelimit-requests-remaining'),
    requestsReset: str('anthropic-ratelimit-requests-reset'),
    inputTokensLimit: num('anthropic-ratelimit-input-tokens-limit'),
    inputTokensRemaining: num('anthropic-ratelimit-input-tokens-remaining'),
    inputTokensReset: str('anthropic-ratelimit-input-tokens-reset'),
    outputTokensLimit: num('anthropic-ratelimit-output-tokens-limit'),
    outputTokensRemaining: num('anthropic-ratelimit-output-tokens-remaining'),
    outputTokensReset: str('anthropic-ratelimit-output-tokens-reset'),
    tokensLimit: num('anthropic-ratelimit-tokens-limit'),
    tokensRemaining: num('anthropic-ratelimit-tokens-remaining'),
    tokensReset: str('anthropic-ratelimit-tokens-reset'),
    observedAt: new Date().toISOString(),
  }

  const hasAny = Object.entries(status).some(
    ([k, v]) => k !== 'observedAt' && v !== undefined,
  )
  return hasAny ? status : null
}

/** Worst remaining/limit ratio across all tracked quotas (1 = full, 0 = exhausted). */
function worstQuotaRatio(status: RateLimitStatus): number {
  const pairs: Array<[number | undefined, number | undefined]> = [
    [status.requestsRemaining, status.requestsLimit],
    [status.inputTokensRemaining, status.inputTokensLimit],
    [status.outputTokensRemaining, status.outputTokensLimit],
    [status.tokensRemaining, status.tokensLimit],
  ]
  let worst = 1
  for (const [remaining, limit] of pairs) {
    if (remaining !== undefined && limit !== undefined && limit > 0) {
      worst = Math.min(worst, remaining / limit)
    }
  }
  return worst
}

/** Earliest reset timestamp among tracked quotas, if any. */
function earliestReset(status: RateLimitStatus): number | null {
  const candidates = [status.requestsReset, status.inputTokensReset, status.outputTokensReset, status.tokensReset]
    .filter((s): s is string => typeof s === 'string')
    .map(s => new Date(s).getTime())
    .filter(t => Number.isFinite(t))
  return candidates.length > 0 ? Math.min(...candidates) : null
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Wraps an Anthropic client to automatically optimize every request.
 * @param client - Instance Anthropic SDK
 * @param options - Options cork-ai
 * @returns Wrapped client with the Anthropic interface + .getStats()
 */
export function wrapClient<T extends AnthropicClient>(
  client: T,
  options: CorkAIOptions = {},
): WrappedClient & Omit<T, keyof WrappedClient> {
  const tracker = new StatsTracker(options.pricing)
  const registry = new ConversationRegistry()
  const prefixStable = options.prefixStable !== false
  let lastStats: FullStats | null = null
  let rateLimit: RateLimitStatus | null = null
  let lastCacheRead = -1

  const debugWarn = (...args: unknown[]) => {
    if (options.debug) console.warn('[cork-ai:warn]', ...args)
  }

  const originalCreate = client.messages.create.bind(client.messages)

  /** Runs compression and stats; shared by create() and stream(). */
  const compressParams = (params: AnthropicCreateParams): AnthropicCreateParams => {
    setActiveModel(params.model)
    tracker.setModel(params.model)

    if (prefixStable) {
      const originalTokens = countMessageTokens(params.messages)
      const result = registry.for(params.messages).compress(params.messages, options)
      const compressedTokens = countMessageTokens(result.messages)
      for (const [name, saved] of Object.entries(result.byModule)) {
        tracker.recordModule(name, saved)
      }
      lastStats = tracker.getFullStats(originalTokens, compressedTokens, {
        newlySavedTokens: result.newlySavedTokens,
        frozenSavedTokens: result.frozenSavedTokens,
      })
      if (result.prefixReset) {
        debugWarn('Conversation history mutated before the frozen frontier — compression state reset (prompt cache will miss once).')
      }
      if (options.onStats && lastStats) {
        try { options.onStats(lastStats) } catch { /* user callback */ }
      }
      return { ...params, messages: result.messages }
    }

    const result = runPipeline(params.messages, options, tracker)
    lastStats = result.stats
    return { ...params, messages: result.messages }
  }

  /** Soft throttle: delay the request when quota is nearly exhausted. */
  const maybeThrottle = async (): Promise<void> => {
    const throttle = options.softThrottle
    if (!throttle?.enabled || !rateLimit) return
    const threshold = throttle.thresholdPct ?? 0.1
    const maxDelayMs = throttle.maxDelayMs ?? 5_000
    const ratio = worstQuotaRatio(rateLimit)
    if (ratio >= threshold) return
    const reset = earliestReset(rateLimit)
    const untilReset = reset !== null ? Math.max(0, reset - Date.now()) : maxDelayMs
    const delay = Math.min(maxDelayMs, untilReset)
    if (delay > 0) {
      debugWarn(`Rate-limit quota at ${(ratio * 100).toFixed(1)}% — soft-throttling ${delay}ms`)
      await sleep(delay)
    }
  }

  /** Records ground truth from the response (usage, cache-break detection, passive calibration). */
  const recordResponse = (
    response: AnthropicMessageResponse | undefined,
    sentParams: AnthropicCreateParams,
  ): void => {
    const usage = response?.usage
    if (!usage || typeof usage.input_tokens !== 'number') return
    tracker.recordMeasuredUsage(usage, response?.model)

    const cacheRead = usage.cache_read_input_tokens ?? 0
    if (lastCacheRead > 2_000 && cacheRead < lastCacheRead * 0.5) {
      debugWarn(
        `Prompt cache regression: cache_read_input_tokens dropped from ${lastCacheRead} to ${cacheRead}. ` +
        `Something rewrote the prompt prefix (compression instability, edited history, or a changed system/tools block).`,
      )
    }
    lastCacheRead = cacheRead

    // Passive calibration: we know exactly what we sent (local estimate) and
    // what the API billed for it (input + cache tiers = the full prompt).
    // Their ratio, accumulated, corrects the estimator per model family.
    const measuredPrompt =
      usage.input_tokens + cacheRead + (usage.cache_creation_input_tokens ?? 0)
    if (measuredPrompt > 1_000) {
      try {
        const model = response?.model ?? sentParams.model
        const calibrated = countRequestTokens({
          messages: sentParams.messages,
          system: sentParams.system,
          tools: sentParams.tools as unknown[] | undefined,
        })
        const factor = getCalibrationFactor(model).tiktokenFactor
        recordPassiveSample(model, {
          rawEstimatedTokens: factor > 0 ? calibrated / factor : calibrated,
          chars: countRequestChars({
            messages: sentParams.messages,
            system: sentParams.system,
            tools: sentParams.tools as unknown[] | undefined,
          }),
          measuredTokens: measuredPrompt,
        })
      } catch { /* calibration is best-effort */ }
    }
  }

  const wrappedMessages: AnthropicMessagesAPI = {
    ...client.messages,
    create: async (params: AnthropicCreateParams): Promise<AnthropicMessageResponse> => {
      const optimizedParams = compressParams(params)
      await maybeThrottle()

      const pending = originalCreate(optimizedParams)

      // The SDK's APIPromise exposes withResponse() — use it to read the
      // anthropic-ratelimit-* headers without changing the return value.
      const withResponse = (pending as unknown as {
        withResponse?: () => Promise<{ data: AnthropicMessageResponse; response: { headers: HeaderSource } }>
      }).withResponse
      if (typeof withResponse === 'function') {
        const { data, response } = await withResponse.call(pending)
        const parsed = parseRateLimitHeaders(response.headers)
        if (parsed) rateLimit = parsed
        recordResponse(data, optimizedParams)
        return data
      }

      const response = await pending
      recordResponse(response, optimizedParams)
      return response
    },
  }

  // Si le client supporte stream, wrapper aussi
  if (client.messages.stream) {
    const originalStream = client.messages.stream.bind(client.messages)
    wrappedMessages.stream = (params: AnthropicCreateParams) => {
      const optimizedParams = compressParams(params)
      return originalStream(optimizedParams)
    }
  }

  const wrapped = Object.create(client) as WrappedClient & Omit<T, keyof WrappedClient>

  Object.defineProperty(wrapped, 'messages', {
    get: () => wrappedMessages,
    enumerable: true,
  })

  const sessionStart = new Date().toISOString()

  const persistCurrentSession = () => {
    const session = tracker.getSessionStats()
    if (session.requestCount === 0) return
    recordSession({
      projectPath: process.cwd(),
      startedAt: sessionStart,
      endedAt: new Date().toISOString(),
      requests: session.requestCount,
      originalTokens: session.totalProcessed,
      compressedTokens: session.totalProcessed - session.totalSaved,
      savedTokens: session.totalSaved,
      savingsPercent: session.totalProcessed > 0
        ? Math.round((session.totalSaved / session.totalProcessed) * 1000) / 10
        : 0,
      estimatedCostSaved: session.estimatedCostSaved,
      byModule: lastStats
        ? Object.fromEntries(Object.entries(lastStats.byModule).map(([k, v]) => [k, v.saved]))
        : {},
      measured: tracker.getMeasuredUsage() ?? undefined,
    })
  }

  // Auto-save when the Node.js process exits
  const exitHandler = () => { try { persistCurrentSession() } catch { /* silent */ } }
  process.once('exit', exitHandler)
  process.once('SIGINT', () => { exitHandler(); process.exit(0) })
  process.once('SIGTERM', () => { exitHandler(); process.exit(0) })

  // The request part is a snapshot from compression time; the session part is
  // rebuilt live so measured usage recorded after the response is included.
  wrapped.getStats = () =>
    lastStats ? { ...lastStats, session: tracker.getSessionStats() } : null

  wrapped.saveSession = () => {
    persistCurrentSession()
  }

  wrapped.resetStats = () => {
    persistCurrentSession()
    tracker.reset()
    lastStats = null
  }

  wrapped.getRateLimitStatus = () => (rateLimit ? { ...rateLimit } : null)

  wrapped.getMeasuredUsage = () => tracker.getMeasuredUsage()

  return wrapped
}
