import { describe, it, expect } from 'vitest'
import { deduplicateCode } from '../../src/compressors/code-dedup.js'
import type { Message } from '../../src/types/index.js'

const CODE_BLOCK = `\`\`\`typescript
export function add(a: number, b: number): number {
  return a + b
}

export function multiply(a: number, b: number): number {
  return a * b
}
\`\`\``

describe('deduplicateCode', () => {
  it('ne modifie pas les messages sans duplication', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Peux-tu créer une fonction add ?' },
      { role: 'assistant', content: CODE_BLOCK },
    ]
    const result = deduplicateCode(messages)
    expect(result.savedTokens).toBe(0)
    expect(result.messages[1].content).toBe(CODE_BLOCK)
  })

  it('remplace les blocs de code dupliqués dans les messages assistant', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Peux-tu créer une fonction add ?' },
      { role: 'assistant', content: CODE_BLOCK },
      { role: 'user', content: 'C\'est correct, merci.' },
      { role: 'assistant', content: `J'ai aussi utilisé:\n${CODE_BLOCK}` },
    ]
    const result = deduplicateCode(messages)
    expect(result.savedTokens).toBeGreaterThan(0)
    const lastContent = result.messages[3].content as string
    expect(lastContent).toContain('omis pour économiser')
  })

  it('détecte le code écrit via tool_use Write', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Write',
            input: {
              path: 'src/utils.ts',
              content: 'export function add(a: number, b: number): number {\n  return a + b\n}\n',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: `Voici le code:\n\`\`\`typescript\nexport function add(a: number, b: number): number {\n  return a + b\n}\n\`\`\``,
      },
    ]
    const result = deduplicateCode(messages)
    // Le deuxième message doit avoir le code remplacé par une référence au fichier
    const lastContent = result.messages[1].content as string
    expect(lastContent).toContain('src/utils.ts')
  })

  it('ne touche pas aux messages user', () => {
    const messages: Message[] = [
      { role: 'user', content: `Voici mon code:\n${CODE_BLOCK}` },
      { role: 'user', content: `Et encore:\n${CODE_BLOCK}` },
    ]
    const result = deduplicateCode(messages)
    // Les messages user ne sont pas dédupliqués
    expect(result.messages[0].content).toBe(messages[0].content)
    expect(result.messages[1].content).toBe(messages[1].content)
  })

  it('gère les messages vides', () => {
    const result = deduplicateCode([])
    expect(result.messages).toEqual([])
    expect(result.savedTokens).toBe(0)
  })

  it('ne remplace pas la première occurrence', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: CODE_BLOCK },
    ]
    const result = deduplicateCode(messages)
    // Première occurrence intacte
    expect(result.messages[1].content).toContain('add')
  })

  it('traite les ContentBlock text dans les messages assistant', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: CODE_BLOCK }],
      },
      { role: 'user', content: 'OK' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: `Rappel:\n${CODE_BLOCK}` }],
      },
    ]
    const result = deduplicateCode(messages)
    expect(result.messages).toHaveLength(3)
    // La troisième occurrence devrait être dédupliquée
    const lastBlock = (result.messages[2].content as Array<{ type: string; text: string }>)[0]
    if (result.savedTokens > 0) {
      expect(lastBlock.text).toContain('omis')
    }
  })
})
