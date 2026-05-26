# cork-ai — Documentation française

[![npm version](https://img.shields.io/npm/v/cork-ai.svg)](https://www.npmjs.com/package/cork-ai)
[![CI](https://github.com/mathys62/cork-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mathys62/cork-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Optimisation chirurgicale du contexte pour Claude Code. Réduit 60–75% des tokens sur les sessions longues.**

> [English (main)](../README.md) · [Español](README.es.md)

---

## Démarrage rapide — `cork-ai init`

La façon la plus rapide d'intégrer cork-ai dans un projet existant :

```bash
cd ton-projet
cork-ai init
```

cork-ai scanne les fichiers qui instancient `new Anthropic()` et soit :

- **Patche automatiquement** le fichier (ajout de `wrapClient`) — si un seul fichier est trouvé
- **Génère** un fichier wrapper `cork-ai-client.ts` prêt à l'emploi — si aucun client existant
- **Affiche les instructions ciblées** — si plusieurs fichiers sont trouvés

C'est tout. Pas de fichier de config, pas d'édition manuelle. Lance `cork-ai gain` après ta première session.

---

## CLI — `cork-ai gain`

Après chaque session, consulte tes économies depuis n'importe où :

```bash
cork-ai gain              # dernière session
cork-ai gain --all        # total depuis le début
cork-ai gain --history    # toutes les sessions enregistrées
cork-ai reset             # remettre à zéro
```

Les stats sont sauvegardées automatiquement dans `~/.cork-ai/stats.json` quand ton process se termine.

---

## Le problème

Sur une session Claude Code de 2h, chaque requête API contient :

- Le **system prompt complet** (~2 000–5 000 tokens) — renvoyé intégralement à chaque tour
- **Tout l'historique de conversation** depuis le début de la session
- **Tous les résultats d'outils** (fichiers lus, sorties bash, résultats de recherche) — en entier
- **Les headers auto-injectés** (CWD, fichiers ouverts, timestamp) — quasi-identiques d'un message à l'autre

Résultat : 100 000–150 000 tokens par requête sur les longues sessions, avec des coûts exponentiels.

## La solution

cork-ai applique des compressions chirurgicales à chaque couche :

| Module | Ce qu'il fait | Gain estimé |
|--------|--------------|-------------|
| Tool Result Compressor | Extrait signatures de code, tronque les bash, résume les JSON | **30–50%** |
| Header Stripper | Déduplique les headers Claude Code répétitifs | **5–10%** |
| Code Deduplicator | Remplace les blocs de code déjà écrits dans des fichiers | **10–20%** |
| Heatmap Manager | Résume les vieux messages peu pertinents à une ligne | **15–25%** |
| Semantic Deduplicator | Déduplique les concepts exprimés différemment (TF-IDF) | **10–15%** |
| Selective Summarizer | Résume en préservant verbatim les infos critiques | **20–30%** |
| Session Cache | Snapshot de projet inter-sessions | **40–60%** sur la session suivante |

**Gains combinés :**

| Scénario | Sans lib | Avec lib | Réduction |
|----------|---------|---------|-----------|
| Session courte (< 30min) | ~15 000 tokens | ~12 000 | ~20% |
| Session moyenne (1h) | ~60 000 tokens | ~22 000 | ~63% |
| Session longue (2h+) | ~140 000 tokens | ~38 000 | ~73% |
| Session suivante (même projet) | ~50 000 tokens | ~18 000 | ~64% |

---

## Installation

### Installation en une ligne (recommandée)

**macOS / Linux / WSL2 :**
```bash
curl -fsSL https://raw.githubusercontent.com/mathys62/cork-ai/main/scripts/install.sh | sh
```

**Windows (PowerShell) :**
```powershell
irm https://raw.githubusercontent.com/mathys62/cork-ai/main/scripts/install.ps1 | iex
```

Le script détecte automatiquement ton gestionnaire de paquets (npm / yarn / pnpm / bun), installe cork-ai globalement et configure les hooks Claude Code — **une seule commande**.

---

### Installation manuelle

**Globale** (CLI + hooks Claude Code — actif sur tous tes projets) :
```bash
npm install -g cork-ai        # ou: yarn global add, pnpm install -g, bun install -g
cork-ai hooks install         # configure ~/.claude/settings.json
```

**Par projet** (pour l'API bibliothèque) :
```bash
npm install cork-ai
npm install @anthropic-ai/sdk
```

---

## Comment ça s'intègre à Claude Code

Après `cork-ai hooks install`, c'est **global** — actif pour toutes tes sessions Claude Code sur tous tes projets :

```
Claude Code lit un fichier
        ↓
cork-ai intercepte (PreToolUse Read)
        ↓
Compresse → signatures extraites, boilerplate tronqué
        ↓
Claude reçoit la version compressée (60–90% moins de tokens)
```

---

## Démarrage rapide

### Mode 1 — Middleware transparent (recommandé)

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { wrapClient } from 'cork-ai'

const client = wrapClient(new Anthropic(), {
  maxContextTokens: 150_000,
  aggressiveness: 0.6,
})

// Interface identique au SDK Anthropic — aucun changement dans ton code
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  messages: historique,
})

// Consulter les économies
const stats = client.getStats()
console.log(`${stats?.request.savingsPercent}% économisé`)
```

### Mode 2 — Compression manuelle

```typescript
import { CtxForge } from 'cork-ai'

const forge = new CtxForge({ maxContextTokens: 150_000 })
const { messages, stats } = forge.compress(historique)

// Envoyer les messages compressés à l'API toi-même
await anthropic.messages.create({ model: '...', max_tokens: 4096, messages })

console.log(`${stats.request.savingsPercent}% économisé — ${stats.request.savedTokens} tokens`)
```

---

## Intégration avec Claude Code

### Option A — Dans ton wrapper API (le plus courant)

Si tu as un fichier qui appelle l'API Anthropic (ex. `src/claude.ts`), wrappe le client là :

```typescript
// src/claude.ts
import Anthropic from '@anthropic-ai/sdk'
import { wrapClient } from 'cork-ai'

export const claude = wrapClient(new Anthropic(), {
  maxContextTokens: 150_000,
  aggressiveness: 0.6,
  onStats: (stats) => {
    // Afficher les économies dans le terminal Claude Code
    if (stats.request.savingsPercent > 5) {
      process.stderr.write(
        `[cork-ai] ${stats.request.savingsPercent}% économisé | ` +
        `session: $${stats.session.estimatedCostSaved}\n`
      )
    }
  },
})
```

Utilise `claude` partout à la place du client Anthropic brut. Aucun autre changement nécessaire.

### Option B — Via CLAUDE.md

Documente l'intégration dans le `CLAUDE.md` de ton projet :

```markdown
## Optimisation du contexte

cork-ai est actif pour ce projet via `src/claude.ts`.
Le client compresse automatiquement les tool_results, déduplique les headers,
et supprime les blocs de code redondants avant chaque appel API.

Pour voir les économies : `client.getStats()`
```

### Option C — Cache inter-sessions

```typescript
import { SessionCache } from 'cork-ai'

const cache = new SessionCache()

// Au démarrage : injecter le contexte de la session précédente
const contextePrec = cache.load(process.cwd())
if (contextePrec) {
  systemPrompt += '\n\n' + contextePrec
}

// À la fin de session : sauvegarder
process.on('exit', () => {
  cache.save(historique, process.cwd())
})
```

Le snapshot est stocké dans `.cork-ai/cache/[hash].json` et rechargé automatiquement à la session suivante — économisant 40–60% des tokens de démarrage.

---

## Niveaux de compression adaptatifs

cork-ai décide automatiquement du niveau de compression selon le ratio tokens/budget :

| Utilisation tokens | Niveau | Modules actifs |
|--------------------|--------|----------------|
| < 40% du budget | Passthrough | Aucun — pas besoin de compresser |
| 40–65% | Niveau 1 | Tool results + Headers |
| 65–80% | Niveau 2 | + Code dedup + Heatmap |
| > 80% | Niveau 3 | + Semantic dedup + Selective summarizer |

cork-ai **ne fait rien** sur les petites sessions et s'active automatiquement à mesure que le contexte grossit.

---

## Options de configuration

```typescript
wrapClient(client, {
  aggressiveness: 0.6,        // 0 = conservateur, 1 = agressif
  maxContextTokens: 150_000,  // Budget tokens max
  budget: {
    maxTokens: 150_000,
    hardLimit: false,          // Si true : throw si dépassement
  },
  pricing: {
    input: 3.0,               // USD / 1M tokens (défaut : Sonnet 4)
    output: 15.0,
  },
  debug: false,               // Activer les logs de debug
  onStats: (stats) => { ... }, // Callback après chaque compression
  disabledModules: ['semanticDedup'], // Désactiver des modules
})
```

---

## System prompt dynamique

Si ton system prompt est volumineux, tagge les sections pour que cork-ai n'injecte que ce qui est pertinent :

```typescript
const systemPrompt = `
Instructions générales — toujours incluses.

<!-- @cork-ai section: python -->
Pour Python : type hints, pytest, list comprehensions.
<!-- @cork-ai end -->

<!-- @cork-ai section: typescript triggers: typescript, ts, tsx -->
Pour TypeScript : types stricts, pas de any, imports avec .js.
<!-- @cork-ai end -->
`

import { DynamicSystemPrompt } from 'cork-ai'
const dsp = new DynamicSystemPrompt()
const optimized = dsp.build(systemPrompt, messagesRecents)
```

---

## Intégration avec RTK

RTK gère la summarization globale des anciens échanges. cork-ai s'en occupe des couches que RTK n'adresse pas :

```
cork-ai : tool_results → headers → code dupliqué → heatmap
RTK     : summarization globale des vieux échanges
─────────────────────────────────────────────────────────
Résultat combiné : 65–75% de réduction totale
```

Les deux sont complémentaires, pas concurrents.

---

## Compatibilité

- **Node.js** : 18, 20, 22
- **OS** : Linux, macOS (Intel + Apple Silicon), Windows (natif + WSL2)
- **Zéro dépendance native** : pas de binaires compilés, pas de ML, pas de service externe
- **Peer dependency** : `@anthropic-ai/sdk >=0.20.0` (optionnel — uniquement pour `wrapClient()`)

---

## Contribuer

Voir [CONTRIBUTING.md](../CONTRIBUTING.md) pour lancer les tests, ajouter un module, et soumettre une PR.

---

## Licence

MIT © 2026 mathys62
