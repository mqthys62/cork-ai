/**
 * Régression : un message assistant composé uniquement de blocs tool_use
 * (texte vide → score heatmap ≈ recency seule) était résumé en TextBlock,
 * orphelinant le tool_result du message suivant → 400 invalid_request_error.
 */
import { describe, expect, it } from 'vitest'
import { compressWithHeatmap } from '../../src/managers/heatmap.js'
import { selectiveSummarize } from '../../src/managers/selective-summarizer.js'
import { runPipeline } from '../../src/core/pipeline.js'
import { validateToolPairing } from '../../src/core/validate.js'
import type { Message } from '../../src/types/index.js'

/** Conversation longue dont les vieux messages portent des paires tool_use/tool_result. */
function conversationWithOldToolPairs(): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < 4; i++) {
    messages.push({ role: 'user', content: `lis le fichier numéro ${i}` })
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `tu_${i}`, name: 'Read', input: { file_path: `/src/f${i}.ts` } }],
    })
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: `contenu du fichier ${i} `.repeat(50) }],
    })
    messages.push({ role: 'assistant', content: `ok, fichier ${i} lu et analysé` })
  }
  // Fenêtre récente en texte pour que les paires anciennes soient candidates
  for (let i = 0; i < 8; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `échange récent ${i}` })
  }
  return messages
}

describe('garde tool_use/tool_result', () => {
  it('heatmap ne résume jamais un message à blocs tool_use (même à seuil extrême)', () => {
    const messages = conversationWithOldToolPairs()
    const result = compressWithHeatmap(messages, 0.99)
    expect(validateToolPairing(result.messages)).toBe(true)
    // Les blocs tool_use des vieux messages sont intacts
    const assistant1 = result.messages[1]
    expect(typeof assistant1.content).not.toBe('string')
    expect((assistant1.content as Array<{ type: string }>)[0].type).toBe('tool_use')
  })

  it('selectiveSummarize ne résume jamais un message à blocs tool_result', () => {
    const messages = conversationWithOldToolPairs()
    const result = selectiveSummarize(messages, { minTokensToSummarize: 5 })
    expect(validateToolPairing(result.messages)).toBe(true)
  })

  it('la pipeline complète préserve l\'invariant sous forte pression budget', () => {
    const messages = conversationWithOldToolPairs()
    const result = runPipeline(messages, { maxContextTokens: 500 })
    expect(validateToolPairing(result.messages)).toBe(true)
  })
})
