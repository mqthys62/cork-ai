# cork-ai — Documentation française

[![CI](https://github.com/mqthys62/cork-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mqthys62/cork-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Réduit 60–75% des tokens sur les sessions longues — sans changer ta façon de coder.**

> [English (main)](../README.md) · [Español](README.es.md)

---

## C'est quoi cork-ai ?

À chaque appel API de Claude Code, l'**historique entier** est renvoyé — chaque fichier lu, chaque sortie bash, chaque header répétitif. Sur une session de 2h, ça dépasse facilement **100 000 tokens par requête**, dont la plupart sont redondants.

cork-ai se branche sur Claude Code et fait deux choses. Il garde les lectures de fichiers entiers hors du contexte quand ça rapporte, et — c'est ce qui fait bouger la facture — il te montre ce que coûte la taille de ton contexte et t'aide à la tenir. **Ton workflow ne change pas. Les résultats ne changent pas. La facture, oui.**

```
Claude Code lit un fichier — outil `Read`, ou `cat fichier` via Bash (mode auto)
        ↓
cork-ai intercepte (hook PreToolUse Read / Bash)
        ↓
Ça vaut le coup ? (porte de valeur attendue : taille du fichier × taille du contexte × taux de relecture appris)
        ↓
Claude reçoit un outline numéroté (L12 export function …) au lieu du fichier entier,
et lit exactement la région qu'il lui faut avec offset/limit ou sed -n
        ↓
Pendant ce temps, le garde contexte te prévient quand le contexte passe 150k / 300k / 500k tokens
et ce que coûte chaque appel d'outil supplémentaire — /compact ou /autocompact règle ça
```

> **Où part vraiment l'argent.** Sur un historique réel de 2 mois (16k tours, 4,3 k$), **78 % de la dépense était des cache reads du préfixe de conversation** — tout le contexte renvoyé à chaque appel d'outil, 400k tokens en moyenne, sur des sessions montées jusqu'à la fenêtre de 1M. Rejoué avec une auto-compaction à 200k, le même travail coûte **57 % de moins**. La compression des Read pèse ~1 %. `cork-ai context` le montre sur ton propre historique ; `cork-ai context --set-autocompact 200k` applique le correctif.

---

## Installation

**Pas de Node.js, pas de npm.** cork-ai est un binaire standalone.

### macOS / Linux / WSL2

```bash
curl -fsSL https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.sh | sh
```

Télécharge le bon binaire pour ton OS + architecture, le place dans `~/.local/bin`, et lance `cork-ai hooks install`.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.ps1 | iex
```

### Téléchargement manuel

[Releases GitHub](https://github.com/mqthys62/cork-ai/releases/latest) → télécharge le binaire pour ta plateforme :

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

### Après un `claude update`

Les mises à jour de Claude Code ne touchent pas `~/.claude/settings.json` : les hooks survivent. Ce qui change, c'est la façon dont le modèle lit les fichiers : depuis le mode auto, Claude lit via Bash (`cat`, `sed -n`) plutôt qu'avec l'outil `Read` — c'est pour ça que les installations antérieures à la 0.7.0 sont devenues muettes. Si `cork-ai gain` semble figé :

```bash
cork-ai doctor          # binaire, hooks, auto-test, et quelles sessions récentes ont produit des événements
cork-ai hooks install   # ajoute les hooks qui manquent à une installation plus ancienne
```

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

Enregistre les hooks cork-ai globalement dans `~/.claude/settings.json`. Actifs pour toutes les sessions sur tous les projets, sans configuration par projet. À relancer après une mise à jour : la commande ajoute les hooks qui manquent à une installation plus ancienne et recible le chemin du binaire.

```bash
cork-ai hooks install   # activer / mettre à niveau
cork-ai hooks status    # lesquels des 5 hooks sont actifs
cork-ai hooks remove    # désactiver
```

| Hook | Rôle |
|------|------|
| `PreToolUse` **Read** | Les lectures de fichiers entiers reçoivent un outline numéroté quand la porte de valeur attendue dit que ça rapporte |
| `PreToolUse` **Bash** | Pareil pour `cat fichier`, `nl`, `bat`, `rtk proxy cat` — en mode auto, Claude Code lit via Bash, pas via `Read`. Les lectures ciblées (`sed -n`, `head`, `tail`) passent toujours, et `sed -i` / les redirections marquent le fichier comme en cours d'édition |
| `PostToolUse` **Edit / Write** | Edit échoués sur fichiers outlinés, suivi des fichiers édités, garde contexte |
| `UserPromptSubmit`, `Stop` | Notices du garde contexte |

Le hook ne compresse jamais au détriment du modèle. Les garde-fous, tous mesurés sur de vrais transcripts :

- **Une porte de valeur attendue décide lecture par lecture** — `tokens économisés × amplification × prix cache-read` contre `P(relecture) × (outline mort + un tour de plus sur le contexte courant + sortie)`. Petits fichiers, contextes énormes et extensions qui se retournent contre nous sont servis bruts. `P(relecture)` est appris par extension sur ta machine (`~/.cork-ai/policy.json`) ; une extension au-dessus de 35 % de relectures passe en probation et n'est sondée qu'une lecture sur dix.
- **L'outline est navigable** — chaque entrée porte son numéro de ligne (`L127  export async function fetchAll(...)`) : la suite, c'est `Read offset=127 limit=40` ou `sed -n '127,166p'`, pas une relecture complète.
- **Les Read avec `offset`/`limit` explicites ne sont jamais compressés** — le modèle cible une zone précise.
- **Les relectures sont servies brutes** — un fichier relu après un outline reçoit le contenu complet, est mémorisé d'une session à l'autre (`skip-list.json`), et son coût — les tokens bruts *et* le tour API supplémentaire — est déduit dans `cork-ai gain`.
- **Les fichiers en cours d'édition sont servis bruts** — 59 % des fichiers outlinés étaient édités ensuite (97 % des `.tsx`) ; un `Edit`, `Write`, `sed -i` ou une redirection sur un fichier le passe en brut pour la session.
- **Le fichier dont l'utilisateur parle n'est jamais compressé** — si ton dernier message mentionne `interceptor.ts`, sa lecture passe telle quelle.
- **Les Edit échoués sont détectés** — un `Edit` qui échoue sur un fichier vu uniquement outliné whitelist le fichier et remonte la nuisance.

### `cork-ai context`

Où part l'argent, d'après les transcripts de Claude Code : par session, le contexte moyen et maximal, le coût par tour, la part de cache reads, et ce que les mêmes tours auraient coûté avec une auto-compaction à 150k / 200k / 300k.

```bash
cork-ai context                        # 30 derniers jours
cork-ai context --days 90 --ceiling 150k
cork-ai context --set-autocompact 200k # écrit autoCompactWindow dans ~/.claude/settings.json
cork-ai context guard off              # coupe les notices live (activées par défaut)
```

Le **garde contexte** se déclenche une fois par palier (150k / 300k / 500k / 750k tokens) et par session : une notice pour toi avec le coût par appel et l'alternative compactée, et un court rappel au modèle (grouper les commandes, lire des plages, proposer `/compact` au prochain point d'arrêt). Il ne bloque jamais rien.

### `cork-ai doctor`

cork-ai est-il vraiment appelé ? Vérifie le binaire, les cinq hooks, exécute le hook sur un payload synthétique, lit le heartbeat laissé par le dernier vrai événement (version de Claude Code, mode de permission), et compare les 14 derniers jours de sessions Claude Code avec celles que cork-ai a vues — avec la répartition Read / lectures Bash qui explique l'écart. À lancer après un `claude update` ou dès que `cork-ai gain` semble figé.

```bash
cork-ai doctor
```

### `cork-ai statusline`

Un segment de barre de statut : taille du contexte, coût cache-read du prochain appel, coût de la session, et un rappel `/compact?` passé 150k. Lit le JSON de statut de Claude Code sur stdin, donc se greffe sur un script existant :

```json
{ "statusLine": { "type": "command", "command": "cork-ai statusline" } }
```

### `cork-ai calibrate`

Les comptages de tokens et les estimations de coût valent ce que vaut le tokenizer derrière. `calibrate` mesure les **vrais** facteurs de tokens Claude pour ton modèle via l'endpoint gratuit `count_tokens` (échantillons code + anglais + français) et les stocke dans `~/.cork-ai/calibration.json` — tous les comptages (bibliothèque + hook) deviennent exacts pour ce modèle :

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cork-ai calibrate                    # utilise le modèle auto-détecté
cork-ai calibrate claude-sonnet-5    # ou un modèle précis
```

Pas de clé API sous la main ? `wrapClient` **calibre aussi passivement** : à chaque réponse, il compare son estimation locale aux tokens de prompt réellement facturés par l'API et corrige l'estimateur automatiquement.

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
cork-ai gain --all        # totaux, dépense réelle, bloc Contexte, vivacité du hook
cork-ai gain --history    # toutes les sessions enregistrées
```

`gain --all` lit les transcripts de Claude Code pour la **dépense réelle** (l'`usage` de chaque tour, sous-agents compris), en garde une copie durable par session dans `~/.cork-ai/spend-cache.json` pour que l'historique survive au nettoyage des transcripts après 30 jours, et valorise les économies sur toute leur vie en contexte. Le net déduit les deux pénalités de relecture : les tokens bruts renvoyés, et le coût réel des tours qui n'ont existé que pour relire un fichier outliné.

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
curl -fsSL https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.sh | sh
```

---

## cork-ai vs les fonctionnalités natives d'Anthropic

L'API Anthropic embarque désormais de la gestion de contexte côté serveur. cork-ai est conçu pour la compléter, pas la concurrencer — quand utiliser quoi :

| Besoin | Utiliser | Pourquoi |
|---|---|---|
| Conversations longues proches de la limite de contexte | **Compaction native** (bêta `compact-2026-01-12`) | Résumé côté serveur, conscient du modèle — meilleure qualité que toute heuristique côté client |
| Purger les vieux résultats d'outils dans les boucles agentiques | **Context editing natif** (`clear_tool_uses_20250919`) | Élagage côté serveur, aucune logique client |
| L'historique re-envoyé coûte plein tarif à chaque tour | **Prompt caching** (`cache_control`) | Les lectures de cache coûtent 0,1× — le plus gros levier de coût |
| Réduire le contenu **avant qu'il n'entre dans le contexte** (lectures de fichiers, sorties d'outils) | **cork-ai** | L'API ne peut gérer que les tokens déjà envoyés — cork-ai les empêche de partir |
| Mesurer ce que la compression économise vraiment | **cork-ai** | Comptabilité vérité-terrain depuis `response.usage`, par modèle, par session |

Deux règles que cork-ai suit pour rester compatible avec le prompt caching :

1. **Stabilité du préfixe** (défaut dans `wrapClient`) : les décisions de compression sur les anciens messages sont gelées byte-identiques entre les requêtes. Réécrire le préfixe à chaque tour invaliderait le prompt cache et coûterait jusqu'à 8× plus cher que ne rien compresser.
2. **Comptabilité cache-aware** : les économies sur le contenu déjà gelé sont valorisées au tarif cache-read (0,1×), pas au tarif input — pas de chiffres gonflés.

---

## API bibliothèque (pour les développeurs d'apps IA)

Si tu construis une application qui appelle l'API Anthropic directement, tu peux utiliser cork-ai comme bibliothèque pour compresser ton historique automatiquement.

Compilation depuis les sources :

```bash
git clone https://github.com/mqthys62/cork-ai.git
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

### Option B — Compression manuelle (CtxForge)

```typescript
import { CtxForge } from './dist/index.js'

const forge = new CtxForge({ maxContextTokens: 150_000 })
const { messages, stats } = forge.compress(historique)

await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 4096, messages })
console.log(`${stats.request.savingsPercent}% économisé`)
```

### Niveaux de compression adaptatifs (API bibliothèque uniquement)

Quand tu utilises `wrapClient()` ou `CtxForge`, cork-ai compte les tokens dans ton tableau `messages[]` et décide du niveau de compression en fonction du taux de remplissage de la fenêtre de contexte. Tu contrôles le budget via `maxContextTokens`.

```
Utilisation tokens / maxContextTokens   Niveau    Ce qui s'exécute
────────────────────────────────────────────────────────────────────────
< 40%   → Passthrough   Rien — le contexte est petit.
40–65%  → Niveau 1      Tool results + Headers
65–80%  → Niveau 2      + Code dedup + Heatmap
> 80%   → Niveau 3      + Semantic dedup + Summarizer
```

Ajuste `maxContextTokens` selon ta fenêtre de contexte réelle et le moment où tu veux que la compression démarre :

```typescript
// Commencer plus tôt — ex: sur une fenêtre 200k de Claude,
// la compression démarre à 20k tokens au lieu de 80k
wrapClient(client, { maxContextTokens: 50_000 })
```

> **Note :** Cette logique adaptative ne s'applique qu'à l'API bibliothèque. Le hook Claude Code
> compresse **chaque** lecture de fichier inconditionnellement — il ne connaît pas la taille de la
> conversation, et c'est voulu : chaque token économisé sur un Read est économisé peu importe
> où tu en es dans la session.

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

MIT © 2026 mqthys62
