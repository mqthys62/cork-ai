# cork-ai — Documentation française

[![CI](https://github.com/mathys62/cork-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mathys62/cork-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Réduit 60–75% des tokens sur les sessions longues — sans changer ta façon de coder.**

> [English (main)](../README.md) · [Español](README.es.md)

---

## C'est quoi cork-ai ?

À chaque appel API de Claude Code, l'**historique entier** est renvoyé — chaque fichier lu, chaque sortie bash, chaque header répétitif. Sur une session de 2h, ça dépasse facilement **100 000 tokens par requête**, dont la plupart sont redondants.

cork-ai s'intercale entre Claude Code et l'API Anthropic. Il compresse ce qui est redondant avant chaque appel. **Ton workflow ne change pas. Les résultats ne changent pas. La facture, oui.**

```
Claude Code lit un fichier
        ↓
cork-ai intercepte (hook PreToolUse Read)
        ↓
Compresse : extrait les signatures, tronque le boilerplate
        ↓
Claude reçoit le résumé compressé au lieu du fichier complet
        ↓
60–90% de tokens en moins par Read — automatiquement, à chaque session
```

---

## Installation

**Pas de Node.js, pas de npm.** cork-ai est un binaire standalone.

### macOS / Linux / WSL2

```bash
curl -fsSL https://raw.githubusercontent.com/mathys62/cork-ai/main/scripts/install.sh | sh
```

Télécharge le bon binaire pour ton OS + architecture, le place dans `~/.local/bin`, et lance `cork-ai hooks install`.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/mathys62/cork-ai/main/scripts/install.ps1 | iex
```

### Téléchargement manuel

[Releases GitHub](https://github.com/mathys62/cork-ai/releases/latest) → télécharge le binaire pour ta plateforme :

| Plateforme | Fichier |
|------------|---------|
| Linux x64 | `cork-ai-linux-x64` |
| Linux arm64 | `cork-ai-linux-arm64` |
| macOS Intel | `cork-ai-darwin-x64` |
| macOS Apple Silicon | `cork-ai-darwin-arm64` |
| Windows x64 | `cork-ai-windows-x64.exe` |

```bash
chmod +x cork-ai-linux-x64
mv cork-ai-linux-x64 ~/.local/bin/cork-ai
cork-ai hooks install
```

C'est tout. Redémarre Claude Code — la compression est active pour toutes tes sessions sur tous tes projets.

---

## Comment ça marche — 7 stratégies de compression

| # | Ce qui est gaspillé | Comment cork-ai le corrige | Gain |
|---|--------------------|-----------------------------|------|
| 1 | **Lectures de fichiers** — chaque `Read` renvoie le fichier entier, à chaque tour | Extrait les signatures de code, tronque les bash, aplatit les JSON | **30–50%** |
| 2 | **Headers répétitifs** — Claude Code injecte CWD, OS, fichiers ouverts à chaque message | Garde le premier, remplace les suivants par un diff court | **5–10%** |
| 3 | **Code dupliqué** — le code qu'on vient d'écrire sur disque est renvoyé dans l'historique | Remplacé par `[code written to src/foo.ts — omitted]` | **10–20%** |
| 4 | **Historique non pertinent** — vieille discussion CSS quand on debug du SQL | Scoring de pertinence, résume les messages peu pertinents à une ligne | **15–25%** |
| 5 | **Concepts répétés** — la même idée exprimée 5 fois différemment | TF-IDF + similarité Jaccard, remplace les quasi-doublons par une référence | **10–15%** |
| 6 | **Vieux messages verbeux** — texte d'exploration qui pourrait faire 10% de sa taille | Résumé en préservant verbatim les chemins, erreurs, décisions | **20–30%** |
| 7 | **Démarrage à froid** — la session suivante redécouvre tout le projet depuis zéro | Snapshot de projet compressé, rechargé au démarrage | **40–60%** session suivante |

cork-ai est **adaptatif** : ne fait rien sur les petites sessions, monte en intensité au fur et à mesure que le contexte grossit.

---

## Résultats mesurés

| Durée de session | Sans cork-ai | Avec cork-ai | Réduction |
|-----------------|-------------|-------------|-----------|
| Courte (< 30 min) | ~15 000 tokens | ~12 000 | ~20% |
| Moyenne (1h) | ~60 000 tokens | ~22 000 | **~63%** |
| Longue (2h+) | ~140 000 tokens | ~38 000 | **~73%** |
| Session suivante (même projet) | ~50 000 tokens | ~18 000 | **~64%** |

Combiné avec [RTK](https://github.com/rtk-ai/rtk) : **75–85% de réduction totale** sur les longues sessions.

---

## CLI

### `cork-ai hooks install`

Enregistre cork-ai comme hook Claude Code globalement dans `~/.claude/settings.json`. Actif pour toutes les sessions sur tous les projets, sans configuration par projet.

```bash
cork-ai hooks install   # activer
cork-ai hooks status    # vérifier si actif
cork-ai hooks remove    # désactiver
```

### `cork-ai init`

Si tu as du code qui appelle l'API Anthropic directement :

```bash
cd ton-projet
cork-ai init
```

cork-ai scanne les fichiers qui instancient `new Anthropic()` et soit :
- **Patche automatiquement** le fichier — ajoute `wrapClient` et wrappe le client en place
- **Génère** un fichier `cork-ai-client.ts` prêt à l'emploi — si aucun client existant
- **Affiche les instructions ciblées** — si plusieurs fichiers sont trouvés

### `cork-ai gain`

Consulte tes économies après chaque session :

```
$ cork-ai gain

cork-ai — Dernière session
────────────────────────────────────────────────────────────
  Date         26 mai, 18h42
  Requêtes     34

  Tokens in    45 200
  Tokens out   14 800
  Économisés   30 400 tokens

  Économies    [████████████████████░░░░░░░░░░] 67.3%
  Coût économisé  0,09 $ USD

  Par module :
    toolResultCompressor       18 200 tokens  (40,3%)
    codeDedup                   5 400 tokens  (11,9%)
    headerStripper              2 800 tokens   (6,2%)
    heatmap                     2 900 tokens   (6,4%)
    semanticDedup               1 100 tokens   (2,4%)
────────────────────────────────────────────────────────────
  Total depuis le début : 284 000 tokens — 0,85 $ USD
```

```bash
cork-ai gain              # dernière session
cork-ai gain --all        # total depuis le début
cork-ai gain --history    # toutes les sessions enregistrées
```

### `cork-ai report`

Reporting entreprise :

```bash
cork-ai report --daily      # tendance journalière
cork-ai report --weekly     # bilan hebdomadaire
cork-ai report --monthly    # bilan mensuel
cork-ai report --projects   # par projet, trié par économies
cork-ai report --forecast   # projection annuelle + ROI
cork-ai report --json       # sortie machine pour dashboards / CI
```

---

## Niveaux de compression adaptatifs

```
Utilisation tokens   Niveau        Ce qui s'exécute
──────────────────────────────────────────────────────────────
< 40% du budget   → Passthrough   Rien. La session est courte.
40–65%            → Niveau 1      Tool results + Headers
65–80%            → Niveau 2      + Code dedup + Heatmap
> 80%             → Niveau 3      + Semantic dedup + Summarizer
```

Sur une courte session, cork-ai est complètement transparent.

---

## Utilisation conjointe avec RTK

[RTK](https://github.com/rtk-ai/rtk) et cork-ai couvrent des couches complètement différentes — ils sont conçus pour être utilisés ensemble.

```
Ce que RTK compresse (appels Bash) :
  git status, git diff, cargo test, npm test, docker ps, grep, ls …
  → 60–90% d'économie sur les sorties de commandes shell

Ce que cork-ai compresse (outils natifs Claude Code + conversation) :
  Read → contenu de fichiers compressé en signatures
  Historique → headers dédupliqués, code dédupliqué, vieux messages résumés
  → 40–90% sur les lectures de fichiers, 20–60% sur l'historique

──────────────────────────────────────────────────────────────────
Ensemble → 75–85% de réduction totale sur les longues sessions
```

Le README de RTK précise lui-même : *"Claude Code built-in tools like Read, Grep, and Glob do not pass through the Bash hook."* cork-ai est la réponse exacte à cette limitation.

```bash
# RTK — compression des commandes Bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
rtk init -g

# cork-ai — compression de l'outil Read + historique de conversation
curl -fsSL https://raw.githubusercontent.com/mathys62/cork-ai/main/scripts/install.sh | sh
```

---

## API bibliothèque (pour les développeurs d'apps IA)

Si tu construis une application qui appelle l'API Anthropic directement, tu peux utiliser cork-ai comme bibliothèque pour compresser ton historique automatiquement.

Compilation depuis les sources :

```bash
git clone https://github.com/mathys62/cork-ai.git
cd cork-ai && npm install && npm run build
```

Puis importer depuis `./dist` :

### Option A — Wrapper transparent (recommandé)

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { wrapClient } from './dist/index.js'

const client = wrapClient(new Anthropic(), {
  maxContextTokens: 150_000,
  aggressiveness: 0.6,
  onStats: (stats) => {
    if (stats.request.savingsPercent > 5) {
      process.stderr.write(`[cork-ai] ${stats.request.savingsPercent}% économisé\n`)
    }
  },
})

// Interface identique au SDK brut — aucun autre changement nécessaire
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  messages: historique,
})
```

### Option B — Compression manuelle

```typescript
import { CtxForge } from './dist/index.js'

const forge = new CtxForge({ maxContextTokens: 150_000 })
const { messages, stats } = forge.compress(historique)

await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 4096, messages })
console.log(`${stats.request.savingsPercent}% économisé`)
```

### Cache inter-sessions

```typescript
import { SessionCache } from './dist/index.js'

const cache = new SessionCache()

// Au démarrage : injecter le contexte de la session précédente (~4 000 tokens au lieu de ~40 000)
const contextePrec = cache.load(process.cwd())
if (contextePrec) systemPrompt += '\n\n' + contextePrec

// À la fin : sauvegarder
process.on('exit', () => cache.save(historique, process.cwd()))
```

### Toutes les options

```typescript
wrapClient(client, {
  aggressiveness: 0.6,        // 0 = conservateur, 1 = agressif (défaut : 0.6)
  maxContextTokens: 150_000,  // budget tokens (défaut : 150 000)
  budget: {
    maxTokens: 150_000,
    hardLimit: false,          // throw si le contexte dépasse encore après compression totale
  },
  pricing: {
    input: 3.0,               // USD / 1M tokens (défaut : Sonnet 4)
    output: 15.0,
  },
  debug: false,
  onStats: (stats) => { ... },
  disabledModules: ['semanticDedup', 'selectiveSummarizer'],
})
```

---

## Compatibilité

- **OS** : Linux (Ubuntu 20.04+, Debian, Alpine), macOS (Intel + Apple Silicon), Windows (natif + WSL2)
- **Zéro dépendance runtime** — binaire standalone, pas de Node.js ni de npm requis
- **API bibliothèque** : requiert Node.js ≥ 18 et `@anthropic-ai/sdk ≥ 0.20.0`

---

## Contribuer

Voir [CONTRIBUTING.md](../CONTRIBUTING.md).

## Licence

MIT © 2026 mathys62
