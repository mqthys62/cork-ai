import { describe, it, expect, vi } from 'vitest'
import { wrapClient } from '../../src/core/interceptor.js'
import type { Message } from '../../src/types/index.js'

const SESSION: Message[] = [
  { role: 'user', content: 'Bonjour' },
  { role: 'assistant', content: 'Bonjour !' },
]

function makeMockClient(streamSupported = false) {
  const mockCreate = vi.fn().mockResolvedValue({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Réponse test' }],
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 10, output_tokens: 5 },
  })

  const messages: Record<string, unknown> = { create: mockCreate }

  if (streamSupported) {
    messages['stream'] = vi.fn().mockReturnValue({ /* stream mock */ })
  }

  return { messages, mockCreate }
}

describe('wrapClient', () => {
  it('retourne un client wrappé', () => {
    const { messages } = makeMockClient()
    const wrapped = wrapClient({ messages } as any)
    expect(wrapped).toBeDefined()
    expect(wrapped.getStats).toBeDefined()
    expect(wrapped.resetStats).toBeDefined()
  })

  it('messages.create() est intercepté', async () => {
    const { messages, mockCreate } = makeMockClient()
    const wrapped = wrapClient({ messages } as any)

    await wrapped.messages.create({
      messages: SESSION,
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
    })

    expect(mockCreate).toHaveBeenCalledOnce()
  })

  it('getStats() retourne null avant le premier appel', () => {
    const { messages } = makeMockClient()
    const wrapped = wrapClient({ messages } as any)
    expect(wrapped.getStats()).toBeNull()
  })

  it('getStats() retourne les stats après un appel', async () => {
    const { messages } = makeMockClient()
    const wrapped = wrapClient({ messages } as any)

    await wrapped.messages.create({
      messages: SESSION,
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
    })

    const stats = wrapped.getStats()
    expect(stats).not.toBeNull()
    expect(stats?.request.originalTokens).toBeGreaterThan(0)
  })

  it('resetStats() remet à zéro', async () => {
    const { messages } = makeMockClient()
    const wrapped = wrapClient({ messages } as any)

    await wrapped.messages.create({
      messages: SESSION,
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
    })

    wrapped.resetStats()
    expect(wrapped.getStats()).toBeNull()
  })

  it('les messages compressés sont passés à l\'API', async () => {
    const { messages, mockCreate } = makeMockClient()
    const wrapped = wrapClient({ messages } as any, { maxContextTokens: 150_000 })

    await wrapped.messages.create({
      messages: SESSION,
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
    })

    // L'appel original doit avoir reçu des messages (peut être compressés ou non)
    const calledWith = mockCreate.mock.calls[0][0]
    expect(calledWith.messages).toBeDefined()
    expect(Array.isArray(calledWith.messages)).toBe(true)
  })

  it('appelle onStats callback après chaque requête', async () => {
    const onStats = vi.fn()
    const { messages } = makeMockClient()
    const wrapped = wrapClient({ messages } as any, { onStats })

    await wrapped.messages.create({
      messages: SESSION,
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
    })

    expect(onStats).toHaveBeenCalledOnce()
  })

  it('wrapper stream() si disponible', async () => {
    const { messages } = makeMockClient(true)
    const wrapped = wrapClient({ messages } as any)
    expect(wrapped.messages.stream).toBeDefined()
  })

  it('plusieurs appels accumulent les stats de session', async () => {
    const { messages } = makeMockClient()
    const wrapped = wrapClient({ messages } as any)

    await wrapped.messages.create({ messages: SESSION, model: 'claude-sonnet-4-6', max_tokens: 1024 })
    await wrapped.messages.create({ messages: SESSION, model: 'claude-sonnet-4-6', max_tokens: 1024 })

    const stats = wrapped.getStats()
    expect(stats?.session.requestCount).toBe(2)
  })
})
