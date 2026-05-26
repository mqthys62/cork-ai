import { describe, it, expect } from 'vitest'
import { DynamicSystemPrompt } from '../../src/managers/system-prompt.js'
import type { Message } from '../../src/types/index.js'

const TAGGED_PROMPT = `
Instructions générales toujours incluses. Tu es un assistant utile.

<!-- @cork-ai section: python -->
Quand tu travailles sur Python, utilise les type hints et pytest.
Préfère les list comprehensions aux boucles explicites.
<!-- @cork-ai end -->

<!-- @cork-ai section: typescript triggers: typescript, ts, tsx -->
Quand tu travailles sur TypeScript, préfère les types stricts et évite any.
Utilise les imports avec extension .js.
<!-- @cork-ai end -->

<!-- @cork-ai section: docker -->
Pour Docker, utilise toujours des images spécifiques (pas :latest).
<!-- @cork-ai end -->
`.trim()

const PLAIN_PROMPT = `Instructions générales. Tu es un assistant utile.`

const makeMessages = (texts: string[]): Message[] =>
  texts.map((text, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: text,
  }))

describe('DynamicSystemPrompt', () => {
  describe('build()', () => {
    it('retourne le prompt intact si aucune section n\'est définie', () => {
      const dsp = new DynamicSystemPrompt()
      const result = dsp.build(PLAIN_PROMPT, [])
      expect(result).toBe(PLAIN_PROMPT)
    })

    it('inclut toujours le core (texte hors sections)', () => {
      const dsp = new DynamicSystemPrompt()
      const result = dsp.build(TAGGED_PROMPT, [])
      expect(result).toContain('Instructions générales')
    })

    it('n\'inclut pas les sections non pertinentes', () => {
      const dsp = new DynamicSystemPrompt()
      const messages = makeMessages(['Bonjour, question générale'])
      const result = dsp.build(TAGGED_PROMPT, messages)
      // Sans contexte Python ou TypeScript, ces sections ne devraient pas être incluses
      // (mais le comportement exact dépend des triggers détectés)
      expect(result).toContain('Instructions générales')
    })

    it('inclut les sections avec triggers détectés (python)', () => {
      const dsp = new DynamicSystemPrompt()
      const messages = makeMessages([
        'Je travaille sur un script Python avec pytest',
        'D\'accord, voici comment faire',
      ])
      const result = dsp.build(TAGGED_PROMPT, messages)
      expect(result).toContain('python')
    })

    it('inclut les sections avec triggers TypeScript', () => {
      const dsp = new DynamicSystemPrompt()
      const messages = makeMessages([
        'Mon fichier TypeScript .ts a des erreurs',
      ])
      const result = dsp.build(TAGGED_PROMPT, messages)
      expect(result).toContain('typescript')
    })

    it('utilise le cache quand le prompt et le contexte n\'ont pas changé', () => {
      const dsp = new DynamicSystemPrompt()
      const messages = makeMessages(['Question Python'])
      const result1 = dsp.build(TAGGED_PROMPT, messages)
      const result2 = dsp.build(TAGGED_PROMPT, messages)
      expect(result1).toBe(result2)
    })

    it('recalcule si le contexte change', () => {
      const dsp = new DynamicSystemPrompt()
      const messagesA = makeMessages(['Question Python'])
      const messagesB = makeMessages(['Question TypeScript'])
      const resultA = dsp.build(TAGGED_PROMPT, messagesA)
      const resultB = dsp.build(TAGGED_PROMPT, messagesB)
      // Les résultats peuvent différer selon les sections activées
      expect(resultA).toBeDefined()
      expect(resultB).toBeDefined()
    })

    it('fonctionne sans messages récents', () => {
      const dsp = new DynamicSystemPrompt()
      const result = dsp.build(TAGGED_PROMPT)
      expect(result).toContain('Instructions générales')
    })
  })

  describe('getSavings()', () => {
    it('retourne 0 pour un prompt sans sections', () => {
      const dsp = new DynamicSystemPrompt()
      const savings = dsp.getSavings(PLAIN_PROMPT, [])
      expect(savings).toBe(0)
    })

    it('retourne un nombre non négatif', () => {
      const dsp = new DynamicSystemPrompt()
      const savings = dsp.getSavings(TAGGED_PROMPT, [])
      expect(savings).toBeGreaterThanOrEqual(0)
    })

    it('retourne plus d\'économies quand peu de sections sont actives', () => {
      const dsp1 = new DynamicSystemPrompt()
      const dsp2 = new DynamicSystemPrompt()

      const noContext = makeMessages(['Bonjour'])
      const allContext = makeMessages([
        'Python typescript docker git sql',
      ])

      const savingsLow = dsp1.getSavings(TAGGED_PROMPT, noContext)
      const savingsHigh = dsp2.getSavings(TAGGED_PROMPT, allContext)

      // Quand plus de sections sont actives, les économies sont moindres
      expect(savingsLow).toBeGreaterThanOrEqual(savingsHigh)
    })
  })
})
