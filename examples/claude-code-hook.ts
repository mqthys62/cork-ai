/**
 * Exemple d'intégration cork-ai via hook Claude Code.
 * À documenter dans le CLAUDE.md du projet cible.
 *
 * Usage : ajouter dans votre CLAUDE.md :
 *
 *   ## Cork-AI Context Optimization
 *   Before each API call, compress the conversation history with cork-ai.
 *   See examples/claude-code-hook.ts for the implementation.
 *
 * Exécuter : tsx examples/claude-code-hook.ts
 */

import { wrapClient } from '../src/index.js'

// ─── Configuration recommandée pour Claude Code ───────────────────────────────

export function createOptimizedClient() {
  // Lazy import pour éviter d'exiger @anthropic-ai/sdk si non installé
  let Anthropic: typeof import('@anthropic-ai/sdk').default

  try {
    Anthropic = require('@anthropic-ai/sdk')
  } catch {
    console.error('[@anthropic-ai/sdk] doit être installé : npm install @anthropic-ai/sdk')
    process.exit(1)
  }

  const client = new Anthropic()

  return wrapClient(client, {
    // Budget adapté aux sessions Claude Code typiques
    maxContextTokens: 150_000,
    // Niveau d'aggressivité : 0.6 = conservateur (recommandé pour Claude Code)
    aggressiveness: 0.6,
    // Callback pour monitorer les économies en temps réel
    onStats: (stats) => {
      if (stats.request.savingsPercent > 5) {
        console.error(
          `[cork-ai] ${stats.request.savingsPercent}% économisé (${stats.request.savedTokens} tokens) ` +
          `| Session: $${stats.session.estimatedCostSaved} économisé`
        )
      }
    },
    // Modules à désactiver si nécessaire
    // disabledModules: ['semanticDedup'],
  })
}

// ─── Exemple d'usage ──────────────────────────────────────────────────────────

console.log(`
=== cork-ai — Intégration Claude Code ===

Pour utiliser cork-ai dans votre projet Claude Code :

1. Installer la lib :
   npm install cork-ai

2. Dans votre code qui appelle l'API Anthropic :
   import { wrapClient } from 'cork-ai'
   import Anthropic from '@anthropic-ai/sdk'

   const client = wrapClient(new Anthropic(), {
     maxContextTokens: 150_000,
     aggressiveness: 0.6,
   })

   // Utilisation identique à l'API Anthropic normale
   const response = await client.messages.create({
     model: 'claude-sonnet-4-6',
     max_tokens: 4096,
     messages: conversationHistory,
   })

   // Accéder aux stats
   const stats = client.getStats()
   console.log(\`Économisé : \${stats?.request.savingsPercent}%\`)

3. Dans votre CLAUDE.md, documenter l'intégration :
   <!-- cork-ai est actif pour cette session -->
   <!-- Compression automatique : tool_results, headers, code dupliqué -->

L'intégration est transparente : l'API reste identique au SDK Anthropic.
`)
