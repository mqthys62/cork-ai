import { describe, it, expect } from 'vitest'
import { deduplicateSemantic } from '../../src/compressors/semantic-dedup.js'
import type { Message } from '../../src/types/index.js'

const PARAGRAPH_A = `
Les hooks React permettent d'utiliser l'état et d'autres fonctionnalités de React
dans les composants fonctionnels. useState retourne une paire de valeurs :
la valeur courante et une fonction pour la mettre à jour.
`.trim()

const PARAGRAPH_B = `
En utilisant les hooks React comme useState, on peut gérer l'état dans les
composants fonctionnels React. La valeur courante et la fonction de mise à jour
sont retournées par useState sous forme de paire.
`.trim()

const CODE_BLOCK_A = `\`\`\`typescript
const [count, setCount] = useState(0)
function increment() {
  setCount(prev => prev + 1)
}
\`\`\``

describe('deduplicateSemantic', () => {
  it('ne modifie pas un historique sans duplication sémantique', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Parle-moi de React' },
      { role: 'assistant', content: 'React est une bibliothèque JavaScript pour les interfaces.' },
      { role: 'user', content: 'Et les hooks ?' },
      { role: 'assistant', content: 'Les hooks permettent d\'utiliser l\'état dans les composants fonctionnels.' },
    ]
    const result = deduplicateSemantic(messages)
    expect(result.messages).toHaveLength(4)
  })

  it('retourne les messages sans erreur même sans similarité', () => {
    const messages: Message[] = [
      { role: 'user', content: PARAGRAPH_A },
      { role: 'assistant', content: 'Le JavaScript est différent de Python.' },
    ]
    const result = deduplicateSemantic(messages)
    expect(result.messages).toHaveLength(2)
  })

  it('ne supprime jamais la première occurrence', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Explique useState' },
      { role: 'assistant', content: PARAGRAPH_A },
    ]
    const result = deduplicateSemantic(messages)
    // La première occurrence doit être préservée
    const content = result.messages[1].content as string
    expect(content).toContain('hooks')
  })

  it('gère les blocs de code similaires', () => {
    const messages: Message[] = [
      { role: 'assistant', content: CODE_BLOCK_A },
      { role: 'user', content: 'OK, et ensuite ?' },
      { role: 'assistant', content: `Rappel du code:\n${CODE_BLOCK_A}` },
    ]
    const result = deduplicateSemantic(messages, { similarityThreshold: 0.7 })
    expect(result.messages).toHaveLength(3)
  })

  it('gère les messages vides', () => {
    const result = deduplicateSemantic([])
    expect(result.messages).toEqual([])
    expect(result.savedTokens).toBe(0)
  })

  it('gère les messages avec ContentBlock', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: PARAGRAPH_A }],
      },
      { role: 'user', content: 'Merci' },
    ]
    const result = deduplicateSemantic(messages)
    expect(result.messages).toHaveLength(2)
  })

  it('respecte le seuil de similarité', () => {
    const messages: Message[] = [
      { role: 'user', content: PARAGRAPH_A },
      { role: 'assistant', content: 'Réponse courte.' },
      { role: 'user', content: PARAGRAPH_B },
    ]
    // Seuil très bas → plus de chance de déduplication
    const resultLow = deduplicateSemantic(messages, { similarityThreshold: 0.1 })
    // Seuil très haut → moins de chance
    const resultHigh = deduplicateSemantic(messages, { similarityThreshold: 0.99 })

    // Les deux doivent retourner 3 messages
    expect(resultLow.messages).toHaveLength(3)
    expect(resultHigh.messages).toHaveLength(3)
  })
})
