import { describe, expect, it } from 'vitest'
import { hasToolBlocks, validateToolPairing } from '../../src/core/validate.js'
import type { Message } from '../../src/types/index.js'

const toolUseMsg = (id: string): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/tmp/a.ts' } }],
})

const toolResultMsg = (id: string): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'contenu du fichier' }],
})

describe('validateToolPairing', () => {
  it('valide une conversation texte simple', () => {
    const messages: Message[] = [
      { role: 'user', content: 'salut' },
      { role: 'assistant', content: 'bonjour' },
    ]
    expect(validateToolPairing(messages)).toBe(true)
  })

  it('valide une paire tool_use/tool_result correcte', () => {
    expect(validateToolPairing([
      { role: 'user', content: 'lis le fichier' },
      toolUseMsg('tu_1'),
      toolResultMsg('tu_1'),
      { role: 'assistant', content: 'voilà' },
    ])).toBe(true)
  })

  it('rejette un tool_result orphelin (tool_use résumé en texte)', () => {
    expect(validateToolPairing([
      { role: 'user', content: 'lis le fichier' },
      { role: 'assistant', content: '[msg#2 résumé]' },  // le tool_use a été écrasé
      toolResultMsg('tu_1'),
    ])).toBe(false)
  })

  it('rejette un tool_use sans tool_result dans le message suivant', () => {
    expect(validateToolPairing([
      toolUseMsg('tu_1'),
      { role: 'user', content: 'autre chose' },
    ])).toBe(false)
  })

  it('accepte un tool_use en fin de conversation (résultat à venir)', () => {
    expect(validateToolPairing([
      { role: 'user', content: 'lis' },
      toolUseMsg('tu_1'),
    ])).toBe(true)
  })
})

describe('hasToolBlocks', () => {
  it('détecte les blocs tool_use et tool_result', () => {
    expect(hasToolBlocks(toolUseMsg('x'))).toBe(true)
    expect(hasToolBlocks(toolResultMsg('x'))).toBe(true)
    expect(hasToolBlocks({ role: 'user', content: 'texte' })).toBe(false)
    expect(hasToolBlocks({ role: 'user', content: [{ type: 'text', text: 'txt' }] })).toBe(false)
  })
})
