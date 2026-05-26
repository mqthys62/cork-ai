import { describe, it, expect } from 'vitest'
import { CtxForge } from '../../src/index.js'
import type { Message } from '../../src/types/index.js'

const makeMessages = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message ${i} de test`,
  }))

describe('CtxForge', () => {
  it('peut être instancié sans options', () => {
    const forge = new CtxForge()
    expect(forge).toBeDefined()
  })

  it('peut être instancié avec des options', () => {
    const forge = new CtxForge({ maxContextTokens: 100_000, aggressiveness: 0.8 })
    expect(forge).toBeDefined()
  })

  describe('compress()', () => {
    it('retourne des messages et des stats', () => {
      const forge = new CtxForge()
      const messages = makeMessages(4)
      const result = forge.compress(messages)
      expect(result.messages).toBeDefined()
      expect(result.stats).toBeDefined()
    })

    it('préserve le nombre de messages', () => {
      const forge = new CtxForge()
      const messages = makeMessages(6)
      const result = forge.compress(messages)
      expect(result.messages).toHaveLength(6)
    })

    it('les stats incluent request, session et byModule', () => {
      const forge = new CtxForge()
      const messages = makeMessages(4)
      const { stats } = forge.compress(messages)
      expect(stats.request).toBeDefined()
      expect(stats.session).toBeDefined()
      expect(stats.byModule).toBeDefined()
    })

    it('accumule les stats sur plusieurs appels', () => {
      const forge = new CtxForge()
      const messages = makeMessages(4)
      forge.compress(messages)
      forge.compress(messages)
      const stats = forge.getStats()
      expect(stats?.session.requestCount).toBe(2)
    })
  })

  describe('getStats()', () => {
    it('retourne null avant le premier compress()', () => {
      const forge = new CtxForge()
      expect(forge.getStats()).toBeNull()
    })

    it('retourne les stats après compress()', () => {
      const forge = new CtxForge()
      forge.compress(makeMessages(2))
      expect(forge.getStats()).not.toBeNull()
    })
  })

  describe('restore()', () => {
    it('retourne null pour un refId inexistant', () => {
      const forge = new CtxForge()
      expect(forge.restore('nonexistent')).toBeNull()
    })
  })

  describe('reset()', () => {
    it('remet les stats à zéro', () => {
      const forge = new CtxForge()
      forge.compress(makeMessages(4))
      forge.reset()
      expect(forge.getStats()).toBeNull()
    })
  })
})
