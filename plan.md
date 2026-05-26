# cork-ai — Roadmap & Spécification Technique

> Librairie d'optimisation de contexte pour Claude Code.  
> Objectif : réduire de 60 à 75% le coût en tokens sur les sessions longues, sans perte de précision ni de contexte utile.

---

## Contexte et problème

Lors d'une session Claude Code, chaque requête envoyée à l'API contient :

1. Le **system prompt complet** — renvoyé intégralement à chaque tour (~2 000–5 000 tokens)
2. **Tout l'historique de conversation** depuis le début de la session
3. **Tous les résultats d'outils** (fichiers lus, sorties bash, résultats de recherche) — en entier
4. **Le message utilisateur** — souvent précédé d'un header auto-généré (CWD, fichiers ouverts, etc.)

Les items 2 et 3 grossissent à chaque tour. Sur une session de 2h, l'input peut dépasser 100 000–150 000 tokens par requête, générant des coûts exponentiels.

Les librairies existantes (RTK, claude-context-optimizer, GitNexus) couvrent la summarization globale et la truncation basique. **cork-ai** se positionne en complément ou en remplacement, avec des optimisations chirurgicales que ces libs n'adressent pas.

---

## Architecture générale

```
cork-ai/
├── src/
│   ├── core/
│   │   ├── pipeline.ts          # Orchestrateur principal
│   │   ├── tokenizer.ts         # Comptage de tokens (cl100k approximation)
│   │   └── interceptor.ts       # Middleware SDK Anthropic
│   ├── compressors/
│   │   ├── tool-result.ts       # Compression des blocs tool_result
│   │   ├── code-dedup.ts        # Dédup code assistant → fichiers
│   │   ├── semantic-dedup.ts    # Dédup sémantique inter-messages
│   │   └── header-stripper.ts   # Suppression headers répétitifs
│   ├── managers/
│   │   ├── budget.ts            # Gestion dynamique du budget tokens
│   │   ├── heatmap.ts           # Scoring de pertinence de l'historique
│   │   ├── system-prompt.ts     # System prompt dynamique/sectionnel
│   │   └── session-cache.ts     # Cache inter-sessions
│   ├── stats/
│   │   └── tracker.ts           # Stats par module + coût estimé
│   └── types/
│       └── index.ts             # Types TypeScript partagés
├── tests/
│   ├── unit/                    # Tests unitaires par module
│   └── integration/             # Tests bout-en-bout avec fixtures
├── examples/
│   ├── basic-usage.ts           # Exemple minimal
│   ├── with-rtk.ts              # Exemple combiné avec RTK
│   └── claude-code-hook.ts      # Intégration Claude Code
├── benchmarks/
│   └── cost-comparison.ts       # Mesure réelle avant/après
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE                      # MIT
├── package.json
├── tsconfig.json
└── .github/
    └── workflows/
        └── ci.yml               # Tests CI sur Node 18, 20, 22
```

---

## Modules à implémenter — par priorité

---

### NIVEAU 1 — Gains immédiats (implémenter en premier)

---

#### Module 1.1 — Tool Result Compressor

**Fichier :** `src/compressors/tool-result.ts`

**Problème :** Quand Claude Code lit un fichier de 400 lignes via l'outil `Read`, ce contenu entier est réinjecté dans le contexte à chaque tour suivant. Un seul `Read` peut représenter 1 000–3 000 tokens persistants. RTK ne compresse jamais les blocs `tool_result`.

**Ce qu'il faut faire :**

Détecter tous les blocs `tool_result` dans l'historique et appliquer une compression selon le type de contenu détecté :

- **Fichier de code** (`.ts`, `.js`, `.py`, `.go`, `.rs`, etc.) :
  - Extraire les imports, les signatures de fonctions/classes/types/exports
  - Supprimer les corps de fonctions
  - Garder les premiers N commentaires de documentation
  - Stocker le contenu original dans un cache side-channel avec un `refId`
  - Remplacer dans le contexte par : `[cork-ai: fichier compressé — X lignes | refId: abc123 | signatures: ...]`

- **Sortie bash** :
  - Garder les 10 premières lignes + les 5 dernières
  - Détecter et remonter les lignes contenant `error`, `Error`, `FAIL`, `exception`
  - Indiquer le nombre de lignes omises

- **Contenu JSON** :
  - Garder la structure de premier niveau uniquement
  - Remplacer les tableaux par `Array(N)` et les objets imbriqués par `{clé1, clé2...}`

- **Texte générique** :
  - Garder les N premières lignes selon le niveau d'agressivité

**Interface publique :**
```typescript
compressToolResults(messages: Message[], options: ToolResultOptions): CompressResult
restore(refId: string): string | null
```

**Gain estimé : 30–50% des tokens input sur les sessions longues**

---

#### Module 1.2 — Assistant Code Deduplicator

**Fichier :** `src/compressors/code-dedup.ts`

**Problème :** Quand Claude génère du code et l'écrit dans un fichier via `Write` ou `create_file`, ce code existe en double : dans l'historique de conversation ET dans le filesystem. À chaque tour suivant, il est renvoyé intégralement dans le contexte même si le fichier est là.

**Ce qu'il faut faire :**

- Scanner les `tool_use` de type `Write` / `create_file` / `str_replace_editor` pour construire une map `hash → chemin de fichier`
- Détecter les blocs de code dans les messages `assistant` qui correspondent à du code déjà écrit dans un fichier (par hash normalisé)
- Remplacer dans l'historique par :  
  `` `[code écrit dans \`src/index.ts\` — omis pour économiser les tokens]` ``
- Détecter aussi les blocs de code identiques qui apparaissent plus d'une fois dans la conversation (sans nécessairement être dans un fichier) et remplacer les occurrences suivantes par une référence à la première

**Gain estimé : 10–20% des tokens input**

---

#### Module 1.3 — Header Stripper

**Fichier :** `src/compressors/header-stripper.ts`

**Problème :** Claude Code injecte automatiquement dans chaque message utilisateur un header contenant le répertoire courant, la liste des fichiers ouverts, le timestamp, les variables d'environnement actives. Ces blocs font 100–300 tokens et sont quasi-identiques d'un message à l'autre.

**Ce qu'il faut faire :**

- Détecter les patterns de header Claude Code dans les messages `user` (blocs `<environment>`, `<files>`, préfixes `CWD:`, `OS:`, etc.)
- Sur le premier message : conserver intégralement
- Sur les messages suivants : ne garder que les champs qui ont **changé** depuis le dernier message
- Ajouter une ligne de résumé : `[env: identique au message précédent]` ou `[env: CWD inchangé, +2 fichiers ouverts]`

**Gain estimé : 5–10% des tokens input**

---

### NIVEAU 2 — Gains structurels

---

#### Module 2.1 — Heatmap Manager

**Fichier :** `src/managers/heatmap.ts`

**Problème :** RTK fait de la summarization globale — elle résume tout ce qui est vieux, sans distinction. Mais certains vieux messages sont critiques (une décision d'architecture, un bug résolu) et d'autres sont totalement hors-sujet pour la tâche en cours (une discussion CSS quand on debug du SQL).

**Ce qu'il faut faire :**

Scorer chaque bloc d'historique sur plusieurs dimensions :

- **Récence** : les messages récents ont un score de base plus élevé
- **Pertinence lexicale** : overlap de termes entre le message et les N derniers messages (fenêtre glissante)
- **Type de contenu** : les décisions (`j'ai décidé`, `on va utiliser`, `le problème était`), les erreurs résolues, et les configurations ont un score bonus permanent
- **Référence récente** : si un vieux message a été cité ou réutilisé récemment, son score remonte

Comportement :

- Les blocs avec score < seuil (configurable) sont candidats à la compression/suppression
- On ne supprime jamais un bloc — on le résume à une ligne : `[msg#4: discussion sur le style CSS du composant Header — non pertinent pour la tâche courante]`
- Le seuil s'ajuste dynamiquement selon la pression budgétaire (voir Module 2.3)

**Gain estimé : 15–25% des tokens input**

---

#### Module 2.2 — Dynamic System Prompt

**Fichier :** `src/managers/system-prompt.ts`

**Problème :** Le system prompt de Claude Code est monolithique. Il contient des instructions pour tous les cas possibles : notebooks Jupyter, projets Python, projets Rust, gestion de git, déploiement, etc. Sur une session donnée, 60–70% de ces instructions sont inutiles.

**Ce qu'il faut faire :**

- Permettre au développeur de découper son system prompt en **sections taguées** :
  ```
  <!-- @cork-ai section: python -->
  Instructions spécifiques Python ici
  <!-- @cork-ai end -->
  ```
- Chaque section a des **triggers** : liste de mots-clés ou patterns qui l'activent
- Avant chaque requête, analyser les N derniers messages pour détecter le contexte actif
- Injecter uniquement les sections pertinentes + le core (jamais omis)
- Conserver un fingerprint du system prompt précédent pour ne pas recalculer si le contexte n'a pas changé

**Gain estimé : 10–20% des tokens input (surtout sur les gros system prompts)**

---

#### Module 2.3 — Budget Manager

**Fichier :** `src/managers/budget.ts`

**Problème :** Sans visibilité sur le coût courant du contexte, on compresse trop (dégradation inutile sur les petites sessions) ou pas assez (explosion sur les longues). Il n'existe aucun outil qui adapte dynamiquement le niveau de compression selon la situation réelle.

**Ce qu'il faut faire :**

- Calculer le coût token du contexte complet avant chaque requête
- Définir des paliers de compression :
  - **< 40% du budget** : aucune compression (mode passthrough)
  - **40–65%** : Level 1 uniquement (tool results + headers)
  - **65–80%** : Level 1 + Level 2 (heatmap, code dedup)
  - **> 80%** : tous les modules actifs en mode agressif
- Exposer le budget courant via les stats pour monitoring en temps réel
- Option `hardLimit` : refuser d'envoyer une requête qui dépasserait le budget (throw avec message explicite)

**Ce module orchestre tous les autres — c'est lui qui décide quoi activer.**

---

### NIVEAU 3 — Gains avancés

---

#### Module 3.1 — Semantic Deduplicator

**Fichier :** `src/compressors/semantic-dedup.ts`

**Problème :** Les déduplicateurs existants font de la comparaison exacte. Si le même concept (une fonction, une erreur, une règle métier) est exprimé légèrement différemment dans 5 messages, ils passent tous. Résultat : Claude reçoit la même information reformulée 5 fois.

**Ce qu'il faut faire :**

- Extraire les chunks sémantiques de chaque message (blocs de code, paragraphes, définitions)
- Construire un fingerprint TF-IDF léger pour chaque chunk (aucune dépendance ML, 100% in-process)
- Comparer chaque nouveau chunk contre l'index existant via similarité de Jaccard
- Si similarité > seuil (défaut : 0.82) avec un chunk déjà vu, remplacer par `[↑ concept déjà établi au message #N — omis]`
- Ne jamais toucher à la première occurrence

**Important :** Ne pas embedder — rester sur du TF-IDF pour éviter toute dépendance externe et garder une latence <1ms par chunk.

**Gain estimé : 10–15% des tokens input**

---

#### Module 3.2 — Selective Summarizer

**Fichier :** `src/managers/selective-summarizer.ts`

**Problème :** La summarization globale (RTK) perd des informations précises critiques : noms de variables exacts, numéros de lignes, valeurs de configuration, erreurs verbatim. Ces détails sont souvent ce dont Claude a le plus besoin pour être précis.

**Ce qu'il faut faire :**

Classifier chaque message en deux catégories avant summarization :

**Peut être résumé** (contenu à haute redondance) :
- Explorations ("essayons X, puis Y, puis Z...")
- Discussions sur le design et l'approche
- Échanges de confirmation/validation
- Répétitions de contexte déjà établi

**Doit rester verbatim** (contenu à haute précision) :
- Noms de fichiers, chemins, variables, fonctions mentionnés explicitement
- Messages d'erreur exacts (stack traces, codes d'erreur)
- Décisions validées (`on garde`, `c'est décidé`, `la règle est`)
- Valeurs de configuration, credentials, flags

Comportement :
- Extraire et préserver les éléments verbatim dans un bloc structuré compact
- Résumer le reste en prose courte
- Résultat : un message de 500 tokens devient 80 tokens de résumé + 40 tokens de verbatim critique

**Gain estimé : 20–30% des tokens sur l'historique ancien**

---

#### Module 3.3 — Session Cache

**Fichier :** `src/managers/session-cache.ts`

**Problème :** Entre deux sessions Claude Code sur le même projet, tout le contexte est perdu. La session suivante commence de zéro et doit tout redécouvrir (architecture, conventions, décisions passées, fichiers clés). Ce bootstrapping coûte 20 000–50 000 tokens en début de session.

**Ce qu'il faut faire :**

À la fin de chaque session (ou périodiquement) :
- Extraire et sérialiser un **snapshot de projet** ultra-compressé :
  - Architecture des fichiers clés (signatures uniquement)
  - Décisions techniques actées pendant la session
  - Erreurs rencontrées et solutions appliquées
  - Conventions de code détectées (nommage, patterns récurrents)
- Stocker dans `.cork-ai/cache/[project-hash].json`

Au début de la session suivante :
- Charger le snapshot et l'injecter comme section compressée du system prompt
- Le snapshot représente 3 000–8 000 tokens au lieu de 30 000–50 000

**Gain estimé : 40–60% des tokens input sur les sessions suivantes d'un même projet**

---

### Module transversal — Stats Tracker

**Fichier :** `src/stats/tracker.ts`

**Obligatoire pour démontrer la valeur de la lib.**

Exposer après chaque requête :

```typescript
{
  request: {
    originalTokens: 45200,
    compressedTokens: 14800,
    savedTokens: 30400,
    savingsPercent: 67.2,
    estimatedCostSaved: 0.091  // USD
  },
  session: {
    totalSaved: 284000,
    totalProcessed: 420000,
    estimatedCostSaved: 0.852,
    requestCount: 34
  },
  byModule: {
    toolResultCompressor:  { saved: 18200, runs: 34 },
    codeDedup:             { saved: 5400,  runs: 12 },
    headerStripper:        { saved: 2800,  runs: 34 },
    heatmap:               { saved: 2900,  runs: 8  },
    semanticDedup:         { saved: 1100,  runs: 34 }
  }
}
```

Pricing configurable, défaut Sonnet 4 : `{ input: 3.0, output: 15.0 }` (USD / 1M tokens).

---

## Spécifications du repo — open source

### Ce que le repo doit contenir obligatoirement

**README.md** doit couvrir :
- Badge NPM, badge CI, badge coverage, badge license
- Une phrase : ce que fait la lib
- Tableau de gains par module avec chiffres
- Installation (npm, yarn, pnpm)
- Quick start : 5 lignes pour être opérationnel
- Intégration avec RTK (exemple)
- Intégration Claude Code (hook CLAUDE.md)
- Toutes les options de configuration documentées
- Section "How it works" avec le diagramme du pipeline
- Compatibilité : Node 18+, Windows / WSL / Linux / macOS

**CONTRIBUTING.md** :
- Comment lancer les tests
- Comment ajouter un module
- Convention de commits (conventional commits)
- Process de PR

**CHANGELOG.md** :
- Format keep-a-changelog
- Démarrer à v0.1.0

**LICENSE** : MIT

### Compatibilité obligatoire

- Node.js 18, 20, 22
- Windows (natif + WSL2)
- Linux (Ubuntu 20.04+, Debian, Alpine)
- macOS (Intel + Apple Silicon)
- Zero dépendance native (pas de binaires compilés)
- Zéro dépendance ML / modèle externe

### Dépendances autorisées

- `tiktoken` — comptage de tokens (ou fallback pur JS si indisponible)
- `@anthropic-ai/sdk` — en peer dependency uniquement
- Aucune autre dépendance de production

### Interface d'intégration

**Cas 1 — Middleware transparent sur le SDK Anthropic :**
```typescript
import Anthropic from '@anthropic-ai/sdk'
import { wrapClient } from 'cork-ai'

const client = wrapClient(new Anthropic(), { aggressiveness: 0.6 })
// Tous les appels client.messages.create() sont automatiquement optimisés
```

**Cas 2 — Manuel sur les messages :**
```typescript
import { CtxForge } from 'cork-ai'

const forge = new CtxForge({ maxContextTokens: 150000 })
const { messages, stats } = forge.compress(conversationHistory)
```

**Cas 3 — Intégration Claude Code via CLAUDE.md :**
Documenter comment hooker cork-ai dans un projet Claude Code via le fichier `CLAUDE.md` du projet.

---

## Gains attendus combinés

| Scénario | Tokens input sans lib | Tokens input avec lib | Réduction |
|---|---|---|---|
| Session courte (< 30min) | ~15 000 | ~12 000 | ~20% |
| Session moyenne (1h) | ~60 000 | ~22 000 | ~63% |
| Session longue (2h+) | ~140 000 | ~38 000 | ~73% |
| Session suivante (même projet) | ~50 000 | ~18 000 | ~64% |

Combiné avec RTK pour la summarization globale : réduction réaliste de **65–75%** sur les sessions longues.

---

## Ordre d'implémentation recommandé

1. Types + Tokenizer (fondation)
2. Stats Tracker (nécessaire pour mesurer dès le début)
3. Tool Result Compressor (plus gros gain, valide l'architecture)
4. Header Stripper (trivial, gain rapide)
5. Assistant Code Dedup (gain moyen, logique claire)
6. Budget Manager (orchestre les précédents)
7. Heatmap Manager
8. Dynamic System Prompt
9. Semantic Deduplicator
10. Selective Summarizer
11. Session Cache
12. Tests + benchmarks + exemples
13. README complet + documentation
14. CI/CD + publication NPM