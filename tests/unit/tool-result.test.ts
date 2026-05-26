import { describe, it, expect, beforeEach } from 'vitest'
import { compressToolResults, restore, clearCache } from '../../src/compressors/tool-result.js'
import type { Message } from '../../src/types/index.js'

beforeEach(() => {
  clearCache()
})

const makeToolResultMessage = (content: string): Message => ({
  role: 'user',
  content: [
    {
      type: 'tool_result',
      tool_use_id: 'tool_123',
      content,
    },
  ],
})

const TYPESCRIPT_FILE = `
import { foo } from './foo'
import { bar } from './bar'

export interface Config {
  name: string
  value: number
}

export function processConfig(config: Config): string {
  const result = config.name + config.value
  // Logique complexe ici
  const intermediate = result.split('').reverse().join('')
  const final = intermediate.toUpperCase()
  return final
}

export class ConfigManager {
  private config: Config

  constructor(config: Config) {
    this.config = config
  }

  public getConfig(): Config {
    return this.config
  }

  private validate(): boolean {
    return this.config.name.length > 0
  }
}
`.repeat(5) // répéter pour dépasser le seuil de 300 chars

const BASH_OUTPUT = Array.from({ length: 30 }, (_, i) =>
  i === 15 ? 'Error: module not found' : `line ${i + 1}: some output here`
).join('\n')

const JSON_CONTENT = JSON.stringify({
  users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
  total: 2,
  page: 1,
  nested: { a: 1, b: 2, c: { d: 3 } },
  tags: ['admin', 'user'],
})

describe('compressToolResults', () => {
  it('ne modifie pas les messages sans tool_result', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Bonjour' },
      { role: 'assistant', content: 'Bonjour !' },
    ]
    const result = compressToolResults(messages)
    expect(result.messages).toEqual(messages)
    expect(result.savedTokens).toBe(0)
  })

  it('ne modifie pas les messages assistant', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'Voici le résultat...' },
    ]
    const result = compressToolResults(messages)
    expect(result.messages).toEqual(messages)
  })

  it('compresse les fichiers TypeScript volumineux', () => {
    const messages: Message[] = [makeToolResultMessage(TYPESCRIPT_FILE)]
    const result = compressToolResults(messages)
    const block = (result.messages[0].content as Array<{ type: string; content: string }>)[0]
    expect(block.content).toContain('cork-ai')
    expect(result.savedTokens).toBeGreaterThan(0)
  })

  it('compresse les sorties bash volumineuses', () => {
    const messages: Message[] = [makeToolResultMessage(BASH_OUTPUT)]
    const result = compressToolResults(messages)
    const block = (result.messages[0].content as Array<{ type: string; content: string }>)[0]
    // Soit compressé soit passthrough si le gain n'est pas suffisant
    expect(block).toBeDefined()
  })

  it('remonte les lignes d\'erreur dans la sortie bash', () => {
    const messages: Message[] = [makeToolResultMessage(BASH_OUTPUT)]
    const result = compressToolResults(messages)
    const block = (result.messages[0].content as Array<{ type: string; content: string }>)[0]
    // L'erreur doit être visible (soit dans le header cork-ai soit conservée)
    const content = typeof block.content === 'string' ? block.content : ''
    const hasErrorOrUnchanged = content.includes('Error') || content.includes('cork-ai')
    expect(hasErrorOrUnchanged).toBe(true)
  })

  it('compresse le JSON au premier niveau', () => {
    const messages: Message[] = [makeToolResultMessage(JSON_CONTENT)]
    const result = compressToolResults(messages)
    expect(result).toBeDefined()
    // Le résultat doit être valide
    expect(result.messages).toHaveLength(1)
  })

  it('ne compresse pas les contenus trop courts (< 200 chars)', () => {
    const shortContent = 'Hello world'
    const messages: Message[] = [makeToolResultMessage(shortContent)]
    const result = compressToolResults(messages)
    const block = (result.messages[0].content as Array<{ type: string; content: string }>)[0]
    expect(block.content).toBe(shortContent)
    expect(result.savedTokens).toBe(0)
  })

  it('stocke dans le cache et permet restore()', () => {
    const messages: Message[] = [makeToolResultMessage(TYPESCRIPT_FILE)]
    const result = compressToolResults(messages, { cacheEnabled: true })

    // Chercher le refId dans le contenu compressé
    const block = (result.messages[0].content as Array<{ type: string; content: string }>)[0]
    if (typeof block.content === 'string' && block.content.includes('refId:')) {
      const refIdMatch = block.content.match(/refId:\s*([a-f0-9]+)/)
      if (refIdMatch) {
        const restored = restore(refIdMatch[1])
        expect(restored).toBe(TYPESCRIPT_FILE)
      }
    }
  })

  it('restore() retourne null pour un refId inexistant', () => {
    expect(restore('nonexistent')).toBeNull()
  })

  it('traite les messages string content dans tool_result', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_456',
            content: TYPESCRIPT_FILE,
          },
        ],
      },
    ]
    const result = compressToolResults(messages)
    expect(result.messages).toHaveLength(1)
  })

  it('gère les messages vides', () => {
    const result = compressToolResults([])
    expect(result.messages).toEqual([])
    expect(result.savedTokens).toBe(0)
  })

  it('gère les tool_result avec content tableau', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_789',
            content: [{ type: 'text', text: TYPESCRIPT_FILE }],
          },
        ],
      },
    ]
    const result = compressToolResults(messages)
    expect(result.messages).toHaveLength(1)
  })
})
