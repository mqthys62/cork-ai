import { describe, it, expect } from 'vitest'
import { compressWithBudget, BudgetManager } from '../../src/managers/budget.js'
import type { Message } from '../../src/types/index.js'

const makeMessages = (n: number, content = 'Message de test avec du contenu substantiel pour compter les tokens'): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `${content} #${i}`,
  }))

describe('compressWithBudget', () => {
  it('mode passthrough quand le contexte est sous 40% du budget', () => {
    const messages = makeMessages(2)
    const result = compressWithBudget(messages, { maxContextTokens: 1_000_000 })
    expect(result.savedTokens).toBe(0)
    expect(result.byModule).toEqual({})
  })

  it('retourne les messages originaux en mode passthrough', () => {
    const messages = makeMessages(2)
    const result = compressWithBudget(messages, { maxContextTokens: 1_000_000 })
    expect(result.messages).toEqual(messages)
  })

  it('applique la compression niveau 1 entre 40% et 65%', () => {
    // Créer beaucoup de messages pour dépasser 40% d'un petit budget
    const messages = makeMessages(50)
    const result = compressWithBudget(messages, {
      maxContextTokens: 500, // budget très petit pour forcer la compression
    })
    expect(result).toBeDefined()
    expect(result.messages).toHaveLength(messages.length)
  })

  it('throw en hardLimit quand le contexte dépasse 100% du budget', () => {
    const messages = makeMessages(100)
    expect(() => compressWithBudget(messages, {
      maxContextTokens: 10,
      budget: { maxTokens: 10, hardLimit: true },
    })).toThrow('[cork-ai]')
  })

  it('ne throw pas sans hardLimit même si dépassement', () => {
    const messages = makeMessages(100)
    expect(() => compressWithBudget(messages, {
      maxContextTokens: 10,
      budget: { maxTokens: 10, hardLimit: false },
    })).not.toThrow()
  })

  it('respecte les modules désactivés', () => {
    const messages = makeMessages(50)
    const result = compressWithBudget(messages, {
      maxContextTokens: 500,
      disabledModules: ['toolResultCompressor', 'headerStripper', 'codeDedup', 'heatmap', 'semanticDedup', 'selectiveSummarizer'],
    })
    // Tous les modules désactivés → pas de compression par module
    expect(Object.keys(result.byModule)).toHaveLength(0)
  })

  it('gère les messages vides', () => {
    const result = compressWithBudget([], { maxContextTokens: 150_000 })
    expect(result.messages).toEqual([])
    expect(result.savedTokens).toBe(0)
  })

  it('expose les économies par module', () => {
    const messages = makeMessages(100)
    const result = compressWithBudget(messages, {
      maxContextTokens: 500,
    })
    // byModule doit être un objet (peut être vide ou non selon l'activation)
    expect(typeof result.byModule).toBe('object')
  })
})

describe('BudgetManager', () => {
  it('peut être instancié', () => {
    const bm = new BudgetManager({ maxContextTokens: 150_000 })
    expect(bm).toBeDefined()
  })

  it('getLevel retourne none pour un petit contexte', () => {
    const bm = new BudgetManager({ maxContextTokens: 1_000_000 })
    const messages = makeMessages(2)
    expect(bm.getLevel(messages)).toBe('none')
  })

  it('compress() fonctionne', () => {
    const bm = new BudgetManager({ maxContextTokens: 150_000 })
    const messages = makeMessages(5)
    const result = bm.compress(messages)
    expect(result.messages).toHaveLength(5)
  })
})
