/**
 * Interceptor — middleware transparent sur le SDK Anthropic.
 * wrapClient() returns a client with an interface identical to the original.
 * All messages.create() calls are automatically optimized.
 */

import { runPipeline } from './pipeline.js'
import { StatsTracker } from '../stats/tracker.js'
import { recordSession } from '../cli/persistent-stats.js'
import type { CorkAIOptions, FullStats, Message } from '../types/index.js'

// Minimal type compatible with the Anthropic SDK (avoids a direct dep)
interface AnthropicCreateParams {
  messages: Message[]
  system?: string
  model: string
  max_tokens: number
  [key: string]: unknown
}

interface AnthropicMessageResponse {
  id: string
  type: string
  role: string
  content: unknown[]
  model: string
  usage: { input_tokens: number; output_tokens: number }
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
}

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
  let lastStats: FullStats | null = null

  const originalCreate = client.messages.create.bind(client.messages)

  const wrappedMessages: AnthropicMessagesAPI = {
    ...client.messages,
    create: async (params: AnthropicCreateParams): Promise<AnthropicMessageResponse> => {
      // Compresser les messages avant l'envoi
      const result = runPipeline(params.messages, options, tracker)
      lastStats = result.stats

      // Substitute compressed messages
      const optimizedParams: AnthropicCreateParams = {
        ...params,
        messages: result.messages,
      }

      return originalCreate(optimizedParams)
    },
  }

  // Si le client supporte stream, wrapper aussi
  if (client.messages.stream) {
    const originalStream = client.messages.stream.bind(client.messages)
    wrappedMessages.stream = (params: AnthropicCreateParams) => {
      const result = runPipeline(params.messages, options, tracker)
      lastStats = result.stats
      return originalStream({ ...params, messages: result.messages })
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
    })
  }

  // Auto-save when the Node.js process exits
  const exitHandler = () => { try { persistCurrentSession() } catch { /* silent */ } }
  process.once('exit', exitHandler)
  process.once('SIGINT', () => { exitHandler(); process.exit(0) })
  process.once('SIGTERM', () => { exitHandler(); process.exit(0) })

  wrapped.getStats = () => lastStats

  wrapped.saveSession = () => {
    persistCurrentSession()
  }

  wrapped.resetStats = () => {
    persistCurrentSession()
    tracker.reset()
    lastStats = null
  }

  return wrapped
}
