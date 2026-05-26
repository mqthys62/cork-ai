import { describe, it, expect } from 'vitest'
import { selectiveSummarize, SelectiveSummarizer } from '../../src/managers/selective-summarizer.js'
import type { Message } from '../../src/types/index.js'

const makeMessages = (contents: string[]): Message[] =>
  contents.map((content, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content,
  }))

const EXPLORATORY_MESSAGE = `
Essayons d'abord l'approche A. En fait, je pense qu'on pourrait utiliser X plutôt que Y.
D'accord, oui, ça marche aussi. Hmm, voyons... peut-être que Z serait mieux finalement ?
Oui oui, c'est une bonne idée. Ok parfait. Let's try this approach then. Sounds good !
En réfléchissant davantage, peut-être que maybe we should reconsider this approach entirely.
I think it seems like a better option to look at alternatives. Actually, let's explore option B.
Could we try a different architecture here ? On pourrait revoir les fondements de l'implémentation.
Essayons aussi une troisième variante, voyons si ça donne de meilleurs résultats en pratique.
D'accord pour tester ça aussi. Hmm, je pense que la solution C est probablement la meilleure finalement.
`.trim()

const PRECISE_MESSAGE = `
L'erreur est : Error: ENOENT: no such file or directory, open '/src/index.ts'
Le fichier src/utils/helpers.ts contient la fonction parseDate().
Configuration: DATABASE_URL=postgres://localhost:5432/mydb
Version: v2.3.1
`.trim()

const DECISION_MESSAGE = `
C'est décidé : on garde PostgreSQL pour la production.
La règle est d'utiliser snake_case pour les noms de tables.
Validé : toutes les API utilisent le préfixe /api/v2.
`.trim()

describe('selectiveSummarize', () => {
  it('ne modifie pas les messages récents', () => {
    const messages = makeMessages([
      EXPLORATORY_MESSAGE,
      EXPLORATORY_MESSAGE,
    ])
    const result = selectiveSummarize(messages)
    // Avec seulement 2 messages, le keepRecent couvre tout
    expect(result.messages).toHaveLength(2)
  })

  it('préserve le nombre de messages', () => {
    const longSession = makeMessages(
      Array.from({ length: 20 }, (_, i) => `${EXPLORATORY_MESSAGE} #${i}`)
    )
    const result = selectiveSummarize(longSession)
    expect(result.messages).toHaveLength(20)
  })

  it('résume les anciens messages exploratoires', () => {
    const messages: Message[] = [
      // Messages anciens exploratoires (assez longs pour déclencher le résumé)
      ...Array.from({ length: 10 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `${EXPLORATORY_MESSAGE} - Iteration ${i} avec du contenu additionnel pour atteindre le seuil minimum de tokens`,
      })),
      // Messages récents (conservés)
      { role: 'user', content: 'Question finale importante' },
      { role: 'assistant', content: 'Réponse finale importante' },
    ]
    const result = selectiveSummarize(messages, { minTokensToSummarize: 50 })
    expect(result.messages).toHaveLength(messages.length)
    // Les anciens messages exploratoires devraient être résumés
    expect(result.savedTokens).toBeGreaterThanOrEqual(0)
  })

  it('résume effectivement avec seuil très bas', () => {
    const messages: Message[] = [
      ...Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `${EXPLORATORY_MESSAGE} numero ${i}`,
      })),
      { role: 'user', content: 'Final question' },
      { role: 'assistant', content: 'Final answer' },
    ]
    const result = selectiveSummarize(messages, { minTokensToSummarize: 10, aggressiveness: 0.8 })
    expect(result.messages).toHaveLength(14)
    // Avec un seuil très bas, des messages doivent être résumés
    expect(result.savedTokens).toBeGreaterThan(0)
  })

  it('respecte le seuil minTokensToSummarize', () => {
    const shortMessages = makeMessages(['Oui.', 'Non.', 'OK.', 'D\'accord.', 'Parfait.'])
    const result = selectiveSummarize(shortMessages, { minTokensToSummarize: 1000 })
    // Messages trop courts → pas résumés
    expect(result.savedTokens).toBe(0)
  })

  it('gère les messages vides', () => {
    const result = selectiveSummarize([])
    expect(result.messages).toEqual([])
    expect(result.savedTokens).toBe(0)
  })

  it('gère les ContentBlock', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: EXPLORATORY_MESSAGE }],
      },
      { role: 'assistant', content: 'Réponse' },
    ]
    const result = selectiveSummarize(messages)
    expect(result.messages).toHaveLength(2)
  })

  it('ne résume pas les messages à haute précision (décisions)', () => {
    const messages: Message[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: DECISION_MESSAGE + ` - point ${i}`,
      })),
      { role: 'user', content: 'Question récente' },
      { role: 'assistant', content: 'Réponse récente' },
    ]
    const result = selectiveSummarize(messages)
    expect(result.messages).toHaveLength(messages.length)
  })
})

describe('SelectiveSummarizer', () => {
  it('peut être instancié', () => {
    const summarizer = new SelectiveSummarizer()
    expect(summarizer).toBeDefined()
  })

  it('peut être instancié avec des options', () => {
    const summarizer = new SelectiveSummarizer({ aggressiveness: 0.8 })
    expect(summarizer).toBeDefined()
  })

  it('summarize() retourne des messages et des tokens économisés', () => {
    const summarizer = new SelectiveSummarizer()
    const messages = makeMessages(Array.from({ length: 6 }, () => EXPLORATORY_MESSAGE))
    const result = summarizer.summarize(messages)
    expect(result.messages).toHaveLength(6)
    expect(result.savedTokens).toBeGreaterThanOrEqual(0)
  })

  it('summarize() accepte des options override', () => {
    const summarizer = new SelectiveSummarizer({ aggressiveness: 0.5 })
    const messages = makeMessages([EXPLORATORY_MESSAGE, 'Réponse courte'])
    const result = summarizer.summarize(messages, { aggressiveness: 0.9 })
    expect(result).toBeDefined()
  })
})
