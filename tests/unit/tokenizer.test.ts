import { describe, it, expect } from 'vitest'
import { countTokens, countMessageTokens } from '../../src/core/tokenizer.js'
import type { Message } from '../../src/types/index.js'

describe('countTokens', () => {
  it('retourne 0 pour une chaîne vide', () => {
    expect(countTokens('')).toBe(0)
  })

  it('retourne un nombre positif pour du texte', () => {
    expect(countTokens('Hello world')).toBeGreaterThan(0)
  })

  it('retourne plus de tokens pour un texte plus long', () => {
    const short = 'Hello'
    const long = 'Hello world, this is a much longer text with many more words'
    expect(countTokens(long)).toBeGreaterThan(countTokens(short))
  })

  it('gère les caractères spéciaux', () => {
    expect(countTokens('function foo() { return 42; }')).toBeGreaterThan(0)
  })

  it('gère le code source', () => {
    const code = `
import { foo } from './bar'
export function baz(x: number): string {
  return x.toString()
}
    `.trim()
    expect(countTokens(code)).toBeGreaterThan(5)
  })
})

describe('countMessageTokens', () => {
  it('retourne 0 pour un tableau vide', () => {
    expect(countMessageTokens([])).toBe(0)
  })

  it('compte les tokens des messages texte simples', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Bonjour' },
      { role: 'assistant', content: 'Bonjour, comment puis-je vous aider ?' },
    ]
    expect(countMessageTokens(messages)).toBeGreaterThan(5)
  })

  it('compte les tokens des messages avec ContentBlock', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Regarde ce fichier :' },
          {
            type: 'tool_result',
            tool_use_id: 'tool_123',
            content: 'const x = 1;',
          },
        ],
      },
    ]
    expect(countMessageTokens(messages)).toBeGreaterThan(3)
  })

  it('compte les tokens des tool_use blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Read',
            input: { path: '/src/index.ts' },
          },
        ],
      },
    ]
    expect(countMessageTokens(messages)).toBeGreaterThan(0)
  })

  it('accumule les tokens de plusieurs messages', () => {
    const single: Message[] = [{ role: 'user', content: 'Hello world' }]
    const double: Message[] = [
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Hello world' },
    ]
    expect(countMessageTokens(double)).toBeGreaterThan(countMessageTokens(single))
  })
})
