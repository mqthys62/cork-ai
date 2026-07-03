/**
 * Couche de mesure de l'interceptor : usage réel (response.usage),
 * headers rate-limit, et coût mesuré via le module pricing.
 */
import { describe, expect, it } from 'vitest'
import { wrapClient } from '../../src/core/interceptor.js'
import type { Message } from '../../src/types/index.js'

interface FakeUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

function fakeResponse(model: string, usage: FakeUsage) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model,
    usage,
  }
}

function makeClient(model: string, usage: FakeUsage, headers?: Record<string, string>) {
  const client = {
    messages: {
      create: (_params: { messages: Message[] }) => {
        const data = fakeResponse(model, usage)
        const promise = Promise.resolve(data) as Promise<typeof data> & {
          withResponse?: () => Promise<{ data: typeof data; response: { headers: Map<string, string> } }>
        }
        if (headers) {
          promise.withResponse = async () => ({
            data,
            response: { headers: new Map(Object.entries(headers)) },
          })
        }
        return promise
      },
    },
  }
  return client
}

const messages: Message[] = [{ role: 'user', content: 'bonjour' }]

describe('wrapClient — mesure', () => {
  it('accumule response.usage dans getMeasuredUsage()', async () => {
    const client = makeClient('claude-opus-4-8', {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 8000,
    })
    const wrapped = wrapClient(client as never)
    await wrapped.messages.create({ messages, model: 'claude-opus-4-8', max_tokens: 100 })
    await wrapped.messages.create({ messages, model: 'claude-opus-4-8', max_tokens: 100 })

    const measured = wrapped.getMeasuredUsage()
    expect(measured).not.toBeNull()
    expect(measured!.requests).toBe(2)
    expect(measured!.inputTokens).toBe(2000)
    expect(measured!.outputTokens).toBe(1000)
    expect(measured!.cacheReadInputTokens).toBe(16000)
    expect(measured!.cacheCreationInputTokens).toBe(400)
    // Opus 4.8 : 2000×$5 + 1000×$25 + 400×$6.25 + 16000×$0.50 (par MTok)
    const expected =
      (2000 / 1e6) * 5 + (1000 / 1e6) * 25 + (400 / 1e6) * 6.25 + (16000 / 1e6) * 0.5
    expect(measured!.costUSD).toBeCloseTo(expected, 10)
  })

  it('expose les stats mesurées dans la session', async () => {
    const client = makeClient('claude-haiku-4-5', { input_tokens: 100, output_tokens: 50 })
    const wrapped = wrapClient(client as never)
    await wrapped.messages.create({ messages, model: 'claude-haiku-4-5', max_tokens: 100 })
    const stats = wrapped.getStats()
    expect(stats?.session.measured?.requests).toBe(1)
  })

  it('parse les headers anthropic-ratelimit-* via withResponse()', async () => {
    const client = makeClient(
      'claude-opus-4-8',
      { input_tokens: 10, output_tokens: 5 },
      {
        'anthropic-ratelimit-requests-limit': '4000',
        'anthropic-ratelimit-requests-remaining': '3999',
        'anthropic-ratelimit-input-tokens-limit': '400000',
        'anthropic-ratelimit-input-tokens-remaining': '350000',
        'anthropic-ratelimit-input-tokens-reset': '2026-07-03T00:00:30Z',
      },
    )
    const wrapped = wrapClient(client as never)
    await wrapped.messages.create({ messages, model: 'claude-opus-4-8', max_tokens: 100 })

    const rl = wrapped.getRateLimitStatus()
    expect(rl).not.toBeNull()
    expect(rl!.requestsLimit).toBe(4000)
    expect(rl!.requestsRemaining).toBe(3999)
    expect(rl!.inputTokensRemaining).toBe(350000)
    expect(rl!.inputTokensReset).toBe('2026-07-03T00:00:30Z')
  })

  it('retourne null avant la première réponse', () => {
    const client = makeClient('claude-opus-4-8', { input_tokens: 1, output_tokens: 1 })
    const wrapped = wrapClient(client as never)
    expect(wrapped.getRateLimitStatus()).toBeNull()
    expect(wrapped.getMeasuredUsage()).toBeNull()
  })

  it('fonctionne sans withResponse (client sans headers)', async () => {
    const client = makeClient('claude-sonnet-4-6', { input_tokens: 42, output_tokens: 7 })
    const wrapped = wrapClient(client as never)
    const res = await wrapped.messages.create({ messages, model: 'claude-sonnet-4-6', max_tokens: 100 })
    expect(res.usage.input_tokens).toBe(42)
    expect(wrapped.getMeasuredUsage()!.inputTokens).toBe(42)
  })
})
