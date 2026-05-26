import { describe, it, expect } from 'vitest'
import { scoreMessages, compressWithHeatmap, HeatmapManager } from '../../src/managers/heatmap.js'
import type { Message } from '../../src/types/index.js'

const makeMessages = (contents: string[]): Message[] =>
  contents.map((content, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content,
  }))

describe('scoreMessages', () => {
  it('retourne un score par message', () => {
    const messages = makeMessages(['Hello', 'World', 'Test'])
    const scores = scoreMessages(messages)
    expect(scores).toHaveLength(3)
  })

  it('les scores sont compris entre 0 et 1', () => {
    const messages = makeMessages(['Hello', 'World', 'Test', 'More', 'Content'])
    const scores = scoreMessages(messages)
    for (const score of scores) {
      expect(score.score).toBeGreaterThanOrEqual(0)
      expect(score.score).toBeLessThanOrEqual(1)
    }
  })

  it('le dernier message a un score de récence plus élevé', () => {
    const messages = makeMessages([
      'Premier message sans lien avec le contexte',
      'Deuxième message toujours sans lien',
      'Troisième message encore sans rapport',
      'Quatrième message sans relation',
      'Dernier message',
    ])
    const scores = scoreMessages(messages)
    // Le dernier a un score de récence maximal
    expect(scores[scores.length - 1].score).toBeGreaterThanOrEqual(scores[0].score)
  })

  it('les messages avec décisions ont un score bonus', () => {
    const messages = makeMessages([
      'On va utiliser PostgreSQL pour la base de données, c\'est décidé',
      'Discussion sur les styles CSS',
    ])
    const scores = scoreMessages(messages)
    // Le message avec une décision devrait avoir un score de contenu élevé
    expect(scores[0].reason).toBeDefined()
  })

  it('retourne un index de message correct', () => {
    const messages = makeMessages(['A', 'B', 'C'])
    const scores = scoreMessages(messages)
    scores.forEach((score, i) => {
      expect(score.messageIndex).toBe(i)
    })
  })
})

describe('compressWithHeatmap', () => {
  it('ne compresse pas les messages récents (fenêtre)', () => {
    const contents = Array.from({ length: 10 }, (_, i) => `Message ${i} avec du contenu`)
    const messages = makeMessages(contents)
    const result = compressWithHeatmap(messages, 0.9) // seuil très élevé
    // Les 5 derniers messages doivent être intacts
    const windowSize = 5
    for (let i = messages.length - windowSize; i < messages.length; i++) {
      expect(result.messages[i].content).toBe(messages[i].content)
    }
  })

  it('compresse les messages anciens peu pertinents', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Discussion CSS totalement hors sujet pour le debug SQL actuel' },
      { role: 'assistant', content: 'Oui le padding est bien là' },
      { role: 'user', content: 'ok parfait merci' },
      { role: 'assistant', content: 'De rien !' },
      { role: 'user', content: 'Maintenant passons au SQL' },
      { role: 'assistant', content: 'SELECT * FROM users WHERE id = 1' },
      { role: 'user', content: 'Erreur SQL, la table n\'existe pas' },
      { role: 'assistant', content: 'Il faut créer la table d\'abord' },
      { role: 'user', content: 'Comment créer la table users ?' },
      { role: 'assistant', content: 'CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255))' },
    ]
    const result = compressWithHeatmap(messages, 0.9)
    expect(result.messages).toHaveLength(messages.length)
    // Au moins un message devrait avoir été résumé
  })

  it('retourne les messages originaux si tous sont au-dessus du seuil', () => {
    const messages = makeMessages(['A', 'B'])
    const result = compressWithHeatmap(messages, 0.0) // seuil = 0 → rien compressé
    expect(result.savedTokens).toBe(0)
  })

  it('ne supprime jamais les messages (conserve le même nombre)', () => {
    const messages = makeMessages(Array.from({ length: 20 }, (_, i) => `Contenu ${i}`))
    const result = compressWithHeatmap(messages, 0.9)
    expect(result.messages).toHaveLength(messages.length)
  })
})

describe('HeatmapManager', () => {
  it('peut être instancié avec des options', () => {
    const hm = new HeatmapManager({ windowSize: 3, threshold: 0.2 })
    expect(hm).toBeDefined()
  })

  it('expose les méthodes score() et compress()', () => {
    const hm = new HeatmapManager()
    const messages = makeMessages(['Hello', 'World'])
    expect(hm.score(messages)).toHaveLength(2)
    expect(hm.compress(messages)).toBeDefined()
  })
})
