import { describe, it, expect, vi } from 'vitest'
import { runPipeline } from '../../src/core/pipeline.js'
import type { Message, FullStats } from '../../src/types/index.js'

const makeMessages = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message ${i} avec du contenu de test pour le pipeline`,
  }))

describe('runPipeline', () => {
  it('retourne les messages et les stats', () => {
    const messages = makeMessages(4)
    const result = runPipeline(messages)
    expect(result.messages).toBeDefined()
    expect(result.stats).toBeDefined()
    expect(result.stats.request).toBeDefined()
    expect(result.stats.session).toBeDefined()
    expect(result.stats.byModule).toBeDefined()
  })

  it('préserve le nombre de messages', () => {
    const messages = makeMessages(6)
    const result = runPipeline(messages)
    expect(result.messages).toHaveLength(6)
  })

  it('appelle le callback onStats si configuré', () => {
    const onStats = vi.fn()
    const messages = makeMessages(4)
    runPipeline(messages, { onStats })
    expect(onStats).toHaveBeenCalledOnce()
    expect(onStats).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.any(Object),
      session: expect.any(Object),
      byModule: expect.any(Object),
    }))
  })

  it('les stats contiennent les bonnes métriques', () => {
    const messages = makeMessages(4)
    const result = runPipeline(messages, { maxContextTokens: 150_000 })
    expect(result.stats.request.originalTokens).toBeGreaterThan(0)
    expect(result.stats.request.compressedTokens).toBeGreaterThanOrEqual(0)
    expect(result.stats.session.requestCount).toBe(1)
  })

  it('fonctionne avec des options vides', () => {
    const messages = makeMessages(2)
    expect(() => runPipeline(messages, {})).not.toThrow()
  })

  it('fonctionne avec un tableau vide', () => {
    const result = runPipeline([])
    expect(result.messages).toEqual([])
    expect(result.stats.request.originalTokens).toBe(0)
  })

  it('le callback onStats ne bloque pas en cas d\'erreur', () => {
    const onStats = vi.fn().mockImplementation(() => { throw new Error('callback error') })
    const messages = makeMessages(2)
    expect(() => runPipeline(messages, { onStats })).not.toThrow()
  })

  it('le mode debug n\'affecte pas les résultats', () => {
    const messages = makeMessages(4)
    const resultNormal = runPipeline(messages)
    const resultDebug = runPipeline(messages, { debug: true })
    expect(resultNormal.messages.length).toBe(resultDebug.messages.length)
  })
})
