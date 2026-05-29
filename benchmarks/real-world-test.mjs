/**
 * Test en conditions réelles — cork-ai
 *
 * Construit une conversation Claude Code réaliste avec de vrais fichiers
 * TypeScript du projet, puis mesure les économies de tokens.
 */

import { readFileSync } from 'node:fs'
import { CtxForge, countMessageTokens } from '../dist/index.js'

// ─── Lecture des vrais fichiers du projet ─────────────────────────────────────

const FILES = {
  'src/compressors/tool-result.ts': readFileSync(
    new URL('../src/compressors/tool-result.ts', import.meta.url),
    'utf8',
  ),
  'src/core/pipeline.ts': readFileSync(
    new URL('../src/core/pipeline.ts', import.meta.url),
    'utf8',
  ),
  'src/managers/heatmap.ts': readFileSync(
    new URL('../src/managers/heatmap.ts', import.meta.url),
    'utf8',
  ),
  'src/managers/selective-summarizer.ts': readFileSync(
    new URL('../src/managers/selective-summarizer.ts', import.meta.url),
    'utf8',
  ),
  'src/index.ts': readFileSync(
    new URL('../src/index.ts', import.meta.url),
    'utf8',
  ),
}

// ─── Header Claude Code (injecté à chaque message) ───────────────────────────

const CLAUDE_CODE_HEADER = `<environment_details>
# VSCode Visible Files
src/compressors/tool-result.ts

# VSCode Open Tabs
src/index.ts
src/compressors/tool-result.ts
src/core/pipeline.ts
src/managers/heatmap.ts
src/types/index.ts

# Current Working Directory (/home/mathys/projects/cork-ai) Files
src/
  compressors/
    tool-result.ts
    header-stripper.ts
    code-dedup.ts
  core/
    pipeline.ts
    tokenizer.ts
  managers/
    heatmap.ts
    selective-summarizer.ts
  index.ts
package.json
tsconfig.json
</environment_details>`

// ─── Construction d'une session réaliste ─────────────────────────────────────

function buildRealisticSession() {
  const messages = []

  // Tour 1 — l'utilisateur demande quelque chose, Claude lit tool-result.ts
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: CLAUDE_CODE_HEADER },
      { type: 'text', text: 'Peux-tu m\'expliquer comment fonctionne la compression des tool results ?' },
    ],
  })

  messages.push({
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tool_read_1',
        name: 'Read',
        input: { file_path: 'src/compressors/tool-result.ts' },
      },
    ],
  })

  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: CLAUDE_CODE_HEADER },
      {
        type: 'tool_result',
        tool_use_id: 'tool_read_1',
        content: FILES['src/compressors/tool-result.ts'],
      },
    ],
  })

  messages.push({
    role: 'assistant',
    content: `La compression des tool results fonctionne en plusieurs étapes. D'abord, le compresseur détecte le type de contenu (code TypeScript, JSON, output bash) via l'extension de fichier ou le contenu. Ensuite, pour le code, il extrait les signatures : noms de fonctions, types exportés, interfaces. Le corps des fonctions est remplacé par \`/* ... */\`. Pour les outputs bash, il tronque après 50 lignes et résume le reste. Chaque bloc compressé reçoit un ID unique permettant de restaurer l'original si nécessaire.`,
  })

  // Tour 2 — l'utilisateur veut voir le pipeline, Claude lit pipeline.ts + heatmap.ts
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: CLAUDE_CODE_HEADER },
      { type: 'text', text: 'Et le pipeline global, comment il orchestre tout ça ? Et le heatmap ?' },
    ],
  })

  messages.push({
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tool_read_2',
        name: 'Read',
        input: { file_path: 'src/core/pipeline.ts' },
      },
    ],
  })

  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: CLAUDE_CODE_HEADER },
      {
        type: 'tool_result',
        tool_use_id: 'tool_read_2',
        content: FILES['src/core/pipeline.ts'],
      },
    ],
  })

  messages.push({
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tool_read_3',
        name: 'Read',
        input: { file_path: 'src/managers/heatmap.ts' },
      },
    ],
  })

  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: CLAUDE_CODE_HEADER },
      {
        type: 'tool_result',
        tool_use_id: 'tool_read_3',
        content: FILES['src/managers/heatmap.ts'],
      },
    ],
  })

  messages.push({
    role: 'assistant',
    content: `Le pipeline orchestre les modules dans un ordre précis basé sur le niveau de compression adaptatif. Niveau 1 (40-65% du budget) : tool results + header stripper. Niveau 2 : + code dedup + heatmap. Niveau 3 (>80%) : + semantic dedup + summarizer. Le heatmap score chaque message par pertinence en regardant si les fichiers mentionnés existent encore dans la conversation récente, si les sujets abordés sont toujours actifs, etc.`,
  })

  // Tour 3 — l'utilisateur relit tool-result.ts (lecture dupliquée — cas réel fréquent)
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: CLAUDE_CODE_HEADER },
      { type: 'text', text: 'Attends, montre-moi à nouveau tool-result.ts, je veux regarder la fonction restore()' },
    ],
  })

  messages.push({
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tool_read_4',
        name: 'Read',
        input: { file_path: 'src/compressors/tool-result.ts' },
      },
    ],
  })

  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: CLAUDE_CODE_HEADER },
      {
        type: 'tool_result',
        tool_use_id: 'tool_read_4',
        content: FILES['src/compressors/tool-result.ts'],  // même fichier relue !
      },
    ],
  })

  messages.push({
    role: 'assistant',
    content: `La fonction \`restore()\` utilise une Map interne \`contentCache\` indexée par ID de compression. Quand un tool result est compressé, son contenu original est stocké dans ce cache avec un ID du type \`cork-ref-XXXX\`. \`restore(refId)\` retrouve simplement le contenu via cet ID. La Map est globale au module, ce qui permet de restaurer n'importe quel bloc compressé pendant la session.\n\n\`\`\`typescript\nexport function restore(refId: string): string | null {\n  return contentCache.get(refId) ?? null\n}\n\`\`\``,
  })

  // Tour 4 — lecture de index.ts + discussion sur les exports
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: CLAUDE_CODE_HEADER },
      { type: 'text', text: 'Quels sont tous les exports publics ? Je veux vérifier que CtxForge et wrapClient sont bien exposés.' },
    ],
  })

  messages.push({
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tool_read_5',
        name: 'Read',
        input: { file_path: 'src/index.ts' },
      },
    ],
  })

  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: CLAUDE_CODE_HEADER },
      {
        type: 'tool_result',
        tool_use_id: 'tool_read_5',
        content: FILES['src/index.ts'],
      },
    ],
  })

  messages.push({
    role: 'assistant',
    content: `Oui, les deux points d'entrée principaux sont bien exposés : \`wrapClient\` (import depuis \`./core/interceptor.js\`) et la classe \`CtxForge\` (définie directement dans index.ts). En plus, tous les sous-modules sont ré-exportés pour un usage avancé : \`compressToolResults\`, \`stripHeaders\`, \`deduplicateCode\`, \`deduplicateSemantic\`, \`HeatmapManager\`, \`DynamicSystemPrompt\`, \`BudgetManager\`, \`SelectiveSummarizer\`, \`SessionCache\`. Les types sont aussi tous exportés.`,
  })

  return messages
}

// ─── Exécution du test ────────────────────────────────────────────────────────

import {
  compressToolResults,
  stripHeaders,
  deduplicateCode,
  deduplicateSemantic,
} from '../dist/index.js'

function bar(pct) {
  const filled = Math.round(pct / 2.5)
  return '█'.repeat(filled) + '░'.repeat(40 - filled)
}

function usd(tokens) {
  return ((tokens / 1_000_000) * 3.0).toFixed(4)
}

function printResult(label, tokensAvant, tokensApres) {
  const saved = tokensAvant - tokensApres
  const pct = ((saved / tokensAvant) * 100).toFixed(1)
  console.log(`\n  ${label}`)
  console.log(`    Avant  : ${tokensAvant.toLocaleString()} tokens`)
  console.log(`    Après  : ${tokensApres.toLocaleString()} tokens`)
  console.log(`    Économie : ${saved.toLocaleString()} tokens  (${pct}%)`)
  console.log(`    [${bar(parseFloat(pct))}] ${pct}%`)
  return { saved, pct: parseFloat(pct) }
}

console.log('\n╔══════════════════════════════════════════════════════════════╗')
console.log('║          cork-ai — Test en conditions réelles               ║')
console.log('╚══════════════════════════════════════════════════════════════╝\n')

const messages = buildRealisticSession()
const tokensAvant = countMessageTokens(messages)

console.log(`Session simulée : ${messages.length} messages`)
console.log(`Fichiers réels utilisés :`)
for (const [path, content] of Object.entries(FILES)) {
  const lines = content.split('\n').length
  console.log(`  ${path.padEnd(45)}  ${lines} lignes`)
}

// Tokens par message
console.log('\n─── Tokens par message (avant compression) ───────────────────')
for (let i = 0; i < messages.length; i++) {
  const tokens = countMessageTokens([messages[i]])
  const role = messages[i].role.padEnd(9)
  const minibar = '█'.repeat(Math.round(tokens / 150))
  console.log(`  [${String(i + 1).padStart(2)}] ${role}  ${String(tokens).padStart(5)} tokens  ${minibar}`)
}
console.log(`\n  TOTAL : ${tokensAvant.toLocaleString()} tokens`)

// ═══════════════════════════════════════════════════════════════════════════════
// TEST A — Modules individuels (ce que fait le hook Claude Code)
// Le hook compresse chaque Read inconditionnellement, sans seuil adaptatif.
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ TEST A : Hook Claude Code (compression inconditionnelle) ══')
console.log('  (Reproduit ce qui se passe à chaque Read tool intercepté)\n')

// A1 — Tool results seuls (comme le hook Read)
const r_tools = compressToolResults(messages, { aggressiveness: 0.6 })
const tokens_tools = countMessageTokens(r_tools.messages)
printResult('Compression tool results (Read hook)', tokensAvant, tokens_tools)

// A2 — Tool results + headers (pipeline complet du hook)
const r_headers = stripHeaders(r_tools.messages, { aggressiveness: 0.6 })
const tokens_headers = countMessageTokens(r_headers.messages)
printResult('+ Suppression headers répétés', tokensAvant, tokens_headers)

// A3 — + Code dedup (dédoublonne le fichier lu deux fois)
const r_dedup = deduplicateCode(r_headers.messages, { aggressiveness: 0.6 })
const tokens_dedup = countMessageTokens(r_dedup.messages)
printResult('+ Déduplication du code (tool-result.ts lu 2×)', tokensAvant, tokens_dedup)

// A4 — + Semantic dedup
const r_sem = deduplicateSemantic(r_dedup.messages, { similarityThreshold: 0.82 })
const tokens_sem = countMessageTokens(r_sem.messages)
const { pct: pctFinal } = printResult('+ Déduplication sémantique (pipeline complet)', tokensAvant, tokens_sem)

// ═══════════════════════════════════════════════════════════════════════════════
// TEST B — Library API adaptative (ce que fait wrapClient)
// Se déclenche quand on dépasse 40% du budget maxContextTokens.
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ TEST B : Library API adaptative (wrapClient) ══════════════')
console.log(`  (11 503 tokens / 50 000 = 23% → sous le seuil de 40% → passthrough)`)
console.log(`  On simule un contexte plus rempli avec maxContextTokens = 20 000\n`)

const forge_L1 = new CtxForge({ maxContextTokens: 20_000, aggressiveness: 0.6 })
const { messages: c_L1 } = forge_L1.compress(messages)
printResult('L1 (tool results + headers)  — 11 503 / 20 000 = 57%', tokensAvant, countMessageTokens(c_L1))

const forge_L2 = new CtxForge({ maxContextTokens: 15_000, aggressiveness: 0.6 })
const { messages: c_L2 } = forge_L2.compress(messages)
printResult('L2 (+ code dedup + heatmap)  — 11 503 / 15 000 = 77%', tokensAvant, countMessageTokens(c_L2))

const forge_L3 = new CtxForge({ maxContextTokens: 12_000, aggressiveness: 0.8 })
const { messages: c_L3, stats } = forge_L3.compress(messages)
const tokensL3 = countMessageTokens(c_L3)
printResult('L3 (pipeline complet)         — 11 503 / 12 000 = 96%', tokensAvant, tokensL3)

// Détail par module si dispo
if (stats?.session?.moduleBreakdown) {
  console.log('\n  Détail par module (L3) :')
  for (const [mod, saved] of Object.entries(stats.session.moduleBreakdown)) {
    if (saved > 0) {
      const p = ((saved / tokensAvant) * 100).toFixed(1)
      console.log(`    ${mod.padEnd(26)}  ${String(saved).padStart(5)} tokens  (${p}%)`)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Projection
// ═══════════════════════════════════════════════════════════════════════════════

const N = 30
console.log(`\n═══ Projection session 1h (${N} requêtes) ═════════════════════════`)
const T0 = tokensAvant * N
const Tf = tokens_sem * N
const TL3 = tokensL3 * N
console.log(`\n  Sans cork-ai           : ${T0.toLocaleString().padStart(9)} tokens  →  $${usd(T0)}`)
console.log(`  Hook seul (pipeline)   : ${Tf.toLocaleString().padStart(9)} tokens  →  $${usd(Tf)}   (économie : $${usd(T0 - Tf)})`)
console.log(`  Library API (L3)       : ${TL3.toLocaleString().padStart(9)} tokens  →  $${usd(TL3)}   (économie : $${usd(T0 - TL3)})`)

console.log('\n╔══════════════════════════════════════════════════════════════╗')
console.log('║  Test terminé — compression sur vrais fichiers TypeScript   ║')
console.log('╚══════════════════════════════════════════════════════════════╝\n')
