# cork-ai — Documentation française

[![CI](https://github.com/mqthys62/cork-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mqthys62/cork-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Réduit 60–75% des tokens sur les sessions longues — sans changer ta façon de coder.**

> [English (main)](../README.md) · [Español](README.es.md)

---

## C'est quoi cork-ai ?

À chaque appel API, Claude Code renvoie **toute la conversation** — chaque fichier lu, chaque sortie de commande, chaque tour précédent. Sur les modèles à 1M de contexte, ça fait couramment 300 à 500k tokens par appel d'outil, facturés en cache reads à chaque tour. C'est ça la facture, pas les fichiers eux-mêmes.

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

### `cork-ai update`, `config`, `reset`, `telemetry`

```bash
cork-ai update            # remplace le binaire par la dernière release (--check pour seulement regarder)
cork-ai config            # liste les réglages de ~/.cork-ai/config.json · config set contextGuard.bands 150k,400k
cork-ai reset             # efface les stats · --policy (taux de relecture appris) · --skip-list · --all
cork-ai telemetry on      # événements d'usage anonymes, opt-in — ce qui est envoyé : docs/TELEMETRY.md
```

### `cork-ai calibrate`

Les comptages de tokens et les estimations de coût valent ce que vaut le tokenizer derrière. `calibrate` mesure les **vrais** facteurs de tokens Claude pour ton modèle via l'endpoint gratuit `count_tokens` (échantillons code + anglais + français) et les stocke dans `~/.cork-ai/calibration.json` — tous les comptages (bibliothèque + hook) deviennent exacts pour ce modèle :

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cork-ai calibrate                    # utilise le modèle auto-détecté
cork-ai calibrate claude-sonnet-5    # ou un modèle précis
```

Pas de clé API sous la main ? `wrapClient` **calibre aussi passivement** : à chaque réponse, il compare son estimation locale aux tokens de prompt réellement facturés par l'API et corrige l'estimateur automatiquement.

### `cork-ai gain`

```
$ cork-ai gain --all

  Cost saved
    First pass only      $12.46 USD
    Lifetime in context  $94.63 USD
    Re-read penalty      -$48.47 USD (174 re-reads · 3.63M raw)
    Re-read extra turns  -$5.84 USD  (47 turns that only existed to re-read an outlined file)
    Net                  $40.32 USD

  Real spend (Claude Code transcripts · 15,822 assistant turns)
    Total              $4290.55 USD
    Estimated savings vs spend  0.9%

  Context (last 30 days · 22 sessions ≥ 20 turns)
    Cache reads          78.4% of spend — the context re-read on every turn, 407.8k tokens on average
    Auto-compact at 200k would have saved $2290.81 USD (−57.3%) → cork-ai context
```

Oui, c'est un vrai rapport, et oui, la ligne honnête dit *0,9 %* : outliner les lectures est un petit levier. Le bloc Context est le gros.

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

## Avec RTK et les fonctionnalités natives d'Anthropic

[RTK](https://github.com/rtk-ai/rtk) réécrit les commandes Bash pour élaguer leurs sorties ; cork-ai couvre ce que le README de RTK dit ne pas atteindre — l'outil `Read` — plus les lectures de fichiers entiers faites *via* Bash, et la gouvernance de la taille de contexte qu'aucun des deux ne fait. La compaction et l'édition de contexte côté serveur d'Anthropic gèrent les tokens déjà envoyés ; cork-ai empêche des tokens d'être envoyés et te prévient quand le contexte a dépassé ce qu'il coûte de le garder. Les trois s'empilent.

La bibliothèque de compression de conversation dont cork-ai est parti (`wrapClient`, sept stratégies) est dépréciée et documentée dans [docs/SDK.md](SDK.md).

---

## Compatibilité

- **OS** : Linux (Ubuntu 20.04+, Debian, Alpine), macOS (Intel + Apple Silicon), Windows (natif + WSL2)
- **Zéro dépendance runtime** — binaire standalone, pas de Node.js ni de npm requis
- **Depuis npm** (`npx cork-ai`) : Node.js ≥ 18

---

## Contribuer

Voir [CONTRIBUTING.md](../CONTRIBUTING.md).

## Licence

MIT © 2026 mqthys62
