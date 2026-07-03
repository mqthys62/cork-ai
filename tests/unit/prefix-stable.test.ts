import { describe, expect, it } from 'vitest'
import { ConversationCompressor, ConversationRegistry, hashMessage } from '../../src/core/prefix-stable.js'
import type { Message } from '../../src/types/index.js'

function msg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: text }
}

/** Conversation volumineuse pour dépasser le seuil de compression (40% du budget). */
function bigConversation(n: number): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < n; i++) {
    messages.push(msg(
      i % 2 === 0 ? 'user' : 'assistant',
      `Message numéro ${i} avec beaucoup de contenu répété pour peser lourd. `.repeat(40),
    ))
  }
  return messages
}

describe('ConversationCompressor', () => {
  it('produit un préfixe byte-identique entre deux appels consécutifs', () => {
    const compressor = new ConversationCompressor()
    const opts = { maxContextTokens: 10_000 }
    const history = bigConversation(20)

    const r1 = compressor.compress(history, opts)
    const frontier1 = compressor.frontier

    // La conversation grandit : deux nouveaux messages
    const grown = [...history, msg('user', 'nouvelle question'), msg('assistant', 'nouvelle réponse')]
    const r2 = compressor.compress(grown, opts)

    // Tout le préfixe gelé au 1er appel doit être STRICTEMENT identique au 2e
    for (let i = 0; i < frontier1; i++) {
      expect(JSON.stringify(r2.messages[i])).toBe(JSON.stringify(r1.messages[i]))
    }
  })

  it('la frontière est monotone (ne recule jamais)', () => {
    const compressor = new ConversationCompressor()
    const opts = { maxContextTokens: 10_000 }
    let history = bigConversation(12)

    compressor.compress(history, opts)
    const f1 = compressor.frontier
    history = [...history, msg('user', 'q'), msg('assistant', 'r')]
    compressor.compress(history, opts)
    const f2 = compressor.frontier
    expect(f2).toBeGreaterThanOrEqual(f1)
  })

  it('les messages de la fenêtre récente restent bruts', () => {
    const compressor = new ConversationCompressor(5)
    const history = bigConversation(20)
    const r = compressor.compress(history, { maxContextTokens: 10_000 })
    for (let i = history.length - 5; i < history.length; i++) {
      expect(r.messages[i]).toBe(history[i])
    }
  })

  it('sépare newlySaved (1er passage) et frozenSaved (passages suivants)', () => {
    const compressor = new ConversationCompressor()
    const opts = { maxContextTokens: 10_000 }
    const history = bigConversation(20)

    const r1 = compressor.compress(history, opts)
    // 1er appel : tout est nouveau
    expect(r1.frozenSavedTokens).toBe(0)

    const grown = [...history, msg('user', 'q'), msg('assistant', 'r')]
    const r2 = compressor.compress(grown, opts)
    // 2e appel : les économies du 1er passage sont désormais "frozen"
    expect(r2.frozenSavedTokens).toBe(r1.newlySavedTokens)
  })

  it('détecte la mutation de l\'historique gelé et reset l\'état', () => {
    const compressor = new ConversationCompressor()
    const opts = { maxContextTokens: 10_000 }
    const history = bigConversation(20)
    compressor.compress(history, opts)

    const mutated = [...history]
    mutated[0] = msg('user', 'contenu réécrit par l\'appelant')
    const r = compressor.compress(mutated, opts)
    expect(r.prefixReset).toBe(true)
  })

  it('recompresse une seule fois quand le niveau de budget augmente', () => {
    const compressor = new ConversationCompressor()
    // Budget très large : niveau none, les messages sont gelés bruts
    const small = bigConversation(12)
    const r1 = compressor.compress(small, { maxContextTokens: 10_000_000 })
    expect(r1.levelUpgrade).toBe(false)

    // La conversation grossit jusqu'à franchir un niveau → recompression unique
    const grown = bigConversation(40)
    for (let i = 0; i < 12; i++) grown[i] = small[i]
    const r2 = compressor.compress(grown, { maxContextTokens: 20_000 })
    expect(r2.levelUpgrade).toBe(true)

    // Appel suivant au même niveau : plus de reset
    const grown2 = [...grown, msg('user', 'q'), msg('assistant', 'r')]
    const r3 = compressor.compress(grown2, { maxContextTokens: 20_000 })
    expect(r3.levelUpgrade).toBe(false)
    expect(r3.prefixReset).toBe(false)
  })
})

describe('ConversationRegistry', () => {
  it('route la même conversation vers le même compresseur', () => {
    const registry = new ConversationRegistry()
    const history = bigConversation(10)
    const c1 = registry.for(history)
    const c2 = registry.for([...history, msg('user', 'suite')])
    expect(c1).toBe(c2)
  })

  it('sépare deux conversations différentes', () => {
    const registry = new ConversationRegistry()
    const a = registry.for([msg('user', 'conversation A')])
    const b = registry.for([msg('user', 'conversation B')])
    expect(a).not.toBe(b)
  })

  it('évince les conversations les plus anciennes au-delà de la capacité', () => {
    const registry = new ConversationRegistry(2)
    const a = registry.for([msg('user', 'A')])
    registry.for([msg('user', 'B')])
    registry.for([msg('user', 'C')])  // évince A
    const a2 = registry.for([msg('user', 'A')])
    expect(a2).not.toBe(a)
  })
})

describe('hashMessage', () => {
  it('est stable et sensible au contenu', () => {
    const m = msg('user', 'bonjour')
    expect(hashMessage(m)).toBe(hashMessage({ role: 'user', content: 'bonjour' }))
    expect(hashMessage(m)).not.toBe(hashMessage(msg('user', 'bonsoir')))
  })
})
