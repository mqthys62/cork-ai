import { describe, it, expect } from 'vitest'
import { stripHeaders } from '../../src/compressors/header-stripper.js'
import type { Message } from '../../src/types/index.js'

const makeUserMessage = (text: string): Message => ({
  role: 'user',
  content: text,
})

const HEADER_TEMPLATE = (cwd: string, files: string) => `
<environment>
CWD: ${cwd}
OS: Linux
Platform: WSL2
</environment>
<files>
Open files: ${files}
</files>

Comment faire X ?
`.trim()

describe('stripHeaders', () => {
  it('ne modifie pas les messages sans header', () => {
    const messages: Message[] = [
      makeUserMessage('Bonjour, comment ça va ?'),
    ]
    const result = stripHeaders(messages)
    expect(result.messages).toEqual(messages)
    expect(result.savedTokens).toBe(0)
  })

  it('conserve le premier header intégralement', () => {
    const header = HEADER_TEMPLATE('/home/user/project', 'index.ts')
    const messages: Message[] = [makeUserMessage(header)]
    const result = stripHeaders(messages)
    expect(result.messages[0].content).toBe(header)
    expect(result.savedTokens).toBe(0)
  })

  it('remplace les headers identiques par un résumé court', () => {
    const header = HEADER_TEMPLATE('/home/user/project', 'index.ts')
    const messages: Message[] = [
      makeUserMessage(header),
      makeUserMessage(header),
    ]
    const result = stripHeaders(messages)
    const secondContent = result.messages[1].content as string
    expect(secondContent).toContain('[env:')
    expect(result.savedTokens).toBeGreaterThan(0)
  })

  it('indique les changements de CWD', () => {
    const header1 = HEADER_TEMPLATE('/home/user/project-a', 'index.ts')
    const header2 = HEADER_TEMPLATE('/home/user/project-b', 'index.ts')
    const messages: Message[] = [
      makeUserMessage(header1),
      makeUserMessage(header2),
    ]
    const result = stripHeaders(messages)
    const secondContent = result.messages[1].content as string
    // Doit indiquer un changement
    expect(secondContent).toContain('[env:')
  })

  it('ne touche pas aux messages assistant', () => {
    const header = HEADER_TEMPLATE('/home/user/project', 'index.ts')
    const messages: Message[] = [
      makeUserMessage(header),
      { role: 'assistant', content: 'Je vais t\'aider.' },
      makeUserMessage(header),
    ]
    const result = stripHeaders(messages)
    expect(result.messages[1].content).toBe('Je vais t\'aider.')
  })

  it('traite les messages avec ContentBlock', () => {
    const header = HEADER_TEMPLATE('/home/user/project', 'index.ts')
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: header }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: header }],
      },
    ]
    const result = stripHeaders(messages)
    expect(result.messages).toHaveLength(2)
  })

  it('gère les messages vides', () => {
    const result = stripHeaders([])
    expect(result.messages).toEqual([])
    expect(result.savedTokens).toBe(0)
  })

  it('gère une session avec plusieurs messages successifs', () => {
    const header = HEADER_TEMPLATE('/home/user/project', 'index.ts')
    const messages: Message[] = Array.from({ length: 6 }, (_, i) => {
      if (i % 2 === 0) return makeUserMessage(header + ` Question ${i}`)
      return { role: 'assistant', content: `Réponse ${i}` } as Message
    })
    const result = stripHeaders(messages)
    // Les headers 2, 4, 6 doivent être remplacés
    expect(result.savedTokens).toBeGreaterThan(0)
  })
})
