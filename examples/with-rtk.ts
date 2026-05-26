/**
 * Exemple combiné cork-ai + RTK.
 * cork-ai gère la compression chirurgicale ; RTK gère la summarization globale.
 * Exécuter : tsx examples/with-rtk.ts
 *
 * Note : cet exemple est illustratif. RTK est un proxy CLI, pas un module JS.
 * Voir la documentation pour l'intégration complète.
 */

import { CtxForge } from '../src/index.js'
import type { Message, FullStats } from '../src/types/index.js'

// Simulation d'une longue session avec du code et des tool_results
const longSession: Message[] = Array.from({ length: 40 }, (_, i) => {
  if (i % 4 === 0) {
    return {
      role: 'user' as const,
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: `tool_${i}`,
          content: `// Fichier lu #${i}
import { something } from './module-${i}'
export function process${i}(data: unknown): string {
  const result = JSON.stringify(data)
  const hash = result.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return \`result-\${hash}\`
}
export class Handler${i} {
  private data: unknown
  constructor(data: unknown) { this.data = data }
  handle(): string { return process${i}(this.data) }
}
`.repeat(3),
        },
      ],
    }
  }
  if (i % 4 === 1) {
    return {
      role: 'assistant' as const,
      content: `J'ai analysé le fichier ${i}. La fonction process${i} fait un hash du JSON.`,
    }
  }
  if (i % 4 === 2) {
    return {
      role: 'user' as const,
      content: `<environment>\nCWD: /home/user/project\nOS: Linux\nPlatform: WSL2\n</environment>\n\nContinue l'analyse du module ${i}.`,
    }
  }
  return {
    role: 'assistant' as const,
    content: `Module ${i} analysé. Architecture correcte, conventions respectées.`,
  }
})

// ─── Étape 1 : cork-ai compresse le contexte chirurgicalement ────────────────

console.log('=== cork-ai + RTK — Pipeline combiné ===\n')
console.log('Étape 1 : Compression chirurgicale avec cork-ai')

const onStats = (stats: FullStats) => {
  console.log(`\n  Tokens : ${stats.request.originalTokens} → ${stats.request.compressedTokens}`)
  console.log(`  Économie : ${stats.request.savingsPercent}% (${stats.request.savedTokens} tokens)`)
}

const forge = new CtxForge({
  maxContextTokens: 100_000,
  aggressiveness: 0.7,
  onStats,
})

const { messages: compressedMessages } = forge.compress(longSession)

// ─── Étape 2 : RTK ferait ici la summarization globale ───────────────────────
// RTK est un proxy CLI. Dans un vrai setup, il intercepte les appels au niveau shell.
// La combinaison idéale est :
// 1. cork-ai comprime les tool_results, déduplique les headers et le code
// 2. RTK résume les vieux messages en un bloc compact
// Résultat combiné : 65–75% de réduction totale

console.log('\nÉtape 2 : RTK gérerait ici la summarization globale')
console.log('  (RTK est un proxy CLI — intégration via CLAUDE.md)')

// ─── Rapport final ────────────────────────────────────────────────────────────

const stats = forge.getStats()
if (stats) {
  console.log('\n=== Rapport final ===')
  console.log(`Session : ${stats.session.requestCount} requête(s)`)
  console.log(`Total économisé : ${stats.session.totalSaved} tokens`)
  console.log(`Coût économisé estimé : $${stats.session.estimatedCostSaved}`)

  if (Object.keys(stats.byModule).length > 0) {
    console.log('\nPar module :')
    for (const [name, data] of Object.entries(stats.byModule)) {
      if (data.saved > 0) {
        console.log(`  ${name}: ${data.saved} tokens`)
      }
    }
  }
}
