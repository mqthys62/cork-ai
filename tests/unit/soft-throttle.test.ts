/**
 * Soft-throttle : quand les headers rate-limit montrent un quota presque
 * épuisé, la requête suivante est retardée (jamais dégradée).
 */
import { describe, expect, it } from 'vitest'
import { wrapClient } from '../../src/core/interceptor.js'
import type { Message } from '../../src/types/index.js'

const messages: Message[] = [{ role: 'user', content: 'bonjour' }]

function clientWithQuota(remaining: number, limit: number) {
  const data = {
    id: 'msg', type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model: 'claude-opus-4-8',
    usage: { input_tokens: 10, output_tokens: 5 },
  }
  return {
    messages: {
      create: () => {
        const p = Promise.resolve(data) as Promise<typeof data> & { withResponse?: unknown }
        p.withResponse = async () => ({
          data,
          response: {
            headers: new Map([
              ['anthropic-ratelimit-input-tokens-limit', String(limit)],
              ['anthropic-ratelimit-input-tokens-remaining', String(remaining)],
              ['anthropic-ratelimit-input-tokens-reset', new Date(Date.now() + 60_000).toISOString()],
            ]),
          },
        })
        return p
      },
    },
  }
}

describe('softThrottle', () => {
  it('retarde la requête quand le quota passe sous le seuil', async () => {
    const client = clientWithQuota(1_000, 100_000)  // 1% restant
    const wrapped = wrapClient(client as never, {
      softThrottle: { enabled: true, thresholdPct: 0.1, maxDelayMs: 120 },
    })
    // 1re requête : pas encore de headers observés → pas de délai
    await wrapped.messages.create({ messages, model: 'claude-opus-4-8', max_tokens: 100 })
    // 2e requête : quota connu à 1% → délai ~maxDelayMs
    const t0 = Date.now()
    await wrapped.messages.create({ messages, model: 'claude-opus-4-8', max_tokens: 100 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100)
  })

  it('ne retarde pas quand le quota est confortable', async () => {
    const client = clientWithQuota(90_000, 100_000)  // 90% restant
    const wrapped = wrapClient(client as never, {
      softThrottle: { enabled: true, thresholdPct: 0.1, maxDelayMs: 500 },
    })
    await wrapped.messages.create({ messages, model: 'claude-opus-4-8', max_tokens: 100 })
    const t0 = Date.now()
    await wrapped.messages.create({ messages, model: 'claude-opus-4-8', max_tokens: 100 })
    expect(Date.now() - t0).toBeLessThan(100)
  })

  it('désactivé par défaut', async () => {
    const client = clientWithQuota(0, 100_000)
    const wrapped = wrapClient(client as never)
    await wrapped.messages.create({ messages, model: 'claude-opus-4-8', max_tokens: 100 })
    const t0 = Date.now()
    await wrapped.messages.create({ messages, model: 'claude-opus-4-8', max_tokens: 100 })
    expect(Date.now() - t0).toBeLessThan(100)
  })
})
