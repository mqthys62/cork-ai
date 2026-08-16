# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-08-16

### Fixed

- **Opus 5 facturé au tarif legacy $15/$75 — économies surestimées ×3** — les règles de pricing sont évaluées dans l'ordre et `claude-opus-5` ne matchait pas `/opus-4-[5-9]/`, retombant sur la règle générique `/opus/` réservée aux Opus 3 / 4.0 / 4.1. Tout gain affiché sur une session Opus 5 valait donc $15/M au lieu de $5/M (600k tokens annoncés à $9.00 au lieu de $3.00). Nouvelle règle `/opus-[5-9]/` placée avant, disjointe de la règle Opus 4.x, plus deux tests de non-régression — la table ne couvrait que `opus-4-8` et `opus-4-1`, d'où le passage inaperçu. Les stats déjà écrites dans `stats.json` restent gonflées : le correctif ne rétroagit pas.
- **`hooks install` ne réparait pas les installations en `cork-ai hook` nu** — la forme sans chemin absolu (antérieure à `resolveHookBinary()`) dépend du PATH hérité par le sous-process de hook de Claude Code, ce qui n'est pas garanti : dans certains contextes de lancement le hook échouait silencieusement (`cork-ai: not found`, erreur non bloquante). `ensureHookGroup()` migre désormais ces entrées vers le chemin absolu résolu au lieu de les considérer comme déjà installées.
- La version affichée par le CLI était restée à 0.4.0 alors que le paquet était en 0.4.1.

## [0.4.1] - 2026-07-21

### Fixed

- **`cork-ai gain` crashait sur des fichiers de suivi de re-read périmés** — `listLiveFiles()` ramassait tous les `*.json` de `~/.cork-ai/live/`, y compris les `reads-<sessionId>.json` (suivi des re-reads par session, structure entièrement différente). Parsé comme une `LiveSession`, un fichier oublié n'avait ni `startedAt` ni `requests` et faisait planter `gain` sur `undefined.toLocaleString()` au lieu d'être ignoré comme expiré.

## [0.4.0] - 2026-07-03

### Fixed

- **La compression cassait le prompt cache Anthropic** — la pipeline re-scorait et réécrivait les anciens messages à chaque requête (seuils adaptatifs, fenêtres relatives). Le prompt caching étant un match de préfixe byte-exact, chaque requête payait l'historique à plein tarif (1×) au lieu du tarif cache-read (0,1×) — jusqu'à 8× plus cher que sans compression. `wrapClient` utilise désormais une **compression prefix-stable** (défaut ON, option `prefixStable: false`) : les messages qui sortent de la fenêtre récente reçoivent leur forme finale une seule fois, gelée byte-identique ensuite. Seule exception documentée : un franchissement de niveau de budget (none→L1→L2→all) recompresse le préfixe une fois (3 invalidations max par conversation).
- **La heatmap pouvait produire des requêtes API invalides (400)** — un message assistant composé uniquement de blocs `tool_use` (texte vide → score ≈ recency) était résumé en bloc texte, orphelinant le `tool_result` du message suivant. La heatmap et le selective-summarizer ne touchent plus jamais aux messages porteurs de blocs `tool_use`/`tool_result`, et la pipeline valide l'appariement en sortie avec fallback sur les messages originaux.
- **Deux tables de pricing divergentes** — le tracker utilisait $3/$15 « Sonnet 4 » codé en dur (obsolète) pendant que le CLI avait sa propre table. Le pricing vit désormais dans `src/pricing` (source unique) : les 4 paliers de facturation (input, output, cache-write 5 min/1 h, cache-read) par modèle, tarif de lancement Sonnet 5 dépendant de la date ($2/$10 jusqu'au 2026-08-31), et un test garde-fou qui échoue si la table a plus de 6 mois.
- **Deux unités de comptage incompatibles additionnées dans stats.json** — le hook comptait en `chars/3.5` et la lib en tiktoken `cl100k_base` (le tokenizer d'OpenAI, qui sous-compte Claude de ~15-20 %). Les deux chemins partagent désormais le même module calibré par modèle.
- **Le hook piégeait le modèle sans issue** — un fichier compressé en « signatures extracted » n'offrait aucun moyen de récupérer le contenu brut (le re-read repassait dans le hook). Désormais : un Read avec `offset`/`limit` explicite n'est jamais compressé ; un re-read du même fichier dans la même session est servi brut (auto-whitelist) et compté comme nuisance, son coût induit **déduit** des économies affichées.
- **Deux sessions Claude Code simultanées se flushaient mutuellement** — le fichier live unique est remplacé par un fichier par `session_id` (`~/.cork-ai/live/`), plus de mini-sessions parasites.
- **Moyennes de pourcentages non pondérées** — `report --projects`/`--daily` moyennaient des % par session (une session de 200 tokens pesait autant qu'une de 2M). Les moyennes sont désormais pondérées par tokens (Σsaved/Σoriginal).
- La version du CLI affichait 0.2.0 alors que le paquet était en 0.3.0.
- **`npm test` écrasait les vraies stats utilisateur** — les tests écrivaient dans le vrai `~/.cork-ai/` (dont `resetGlobalStats()` qui vidait `stats.json` à chaque run). Tout l'état persistant respecte désormais `CORK_AI_HOME`, et vitest isole les tests dans un répertoire temporaire.

### Added

- **Couche de mesure (vérité terrain)** — `wrapClient` enregistre `response.usage` après chaque requête : tokens input/output/cache-read/cache-write réels et **coût réel** calculé sur les 4 paliers au tarif du modèle de la réponse. Exposé via `client.getMeasuredUsage()`, persisté dans `stats.json` (`allTime.measured`), affiché par `cork-ai gain --all` (dont le taux de cache hit réel).
- **`cork-ai calibrate [model]`** — mesure les facteurs de comptage réels via `POST /v1/messages/count_tokens` (gratuit, exact, par modèle) sur des échantillons code/anglais/français, et les persiste dans `~/.cork-ai/calibration.json`. Tous les comptages (lib + hook) deviennent exacts pour le modèle calibré.
- **Comptabilité cache-aware** — les économies sur le contenu déjà gelé sont valorisées au tarif cache-read (0,1×), pas au tarif input : fini les chiffres gonflés.
- **Calibration passive** — `wrapClient` compare à chaque réponse son estimation locale (`countRequestTokens`) au prompt réellement facturé (`input + cache_read + cache_creation`) et corrige automatiquement les facteurs de comptage par famille de modèle (dès 3 observations, sans clé API ni action manuelle ; `cork-ai calibrate` reste prioritaire car exact).
- **Le hook ne compresse jamais le fichier dont l'utilisateur parle** — si le dernier vrai message user du transcript mentionne le nom du fichier lu, la lecture passe telle quelle (le modèle a presque toujours besoin du contenu réel).
- **Détection des Edit échoués après compression** — nouveau hook `PostToolUse` sur `Edit`/`MultiEdit` : un Edit qui échoue sur un fichier vu uniquement compressé (le `old_string` venait des signatures) est compté (`editFailuresAfterCompression`), le fichier est auto-whitelisté pour la session, et la métrique apparaît dans `cork-ai gain`. `hooks install` upgrade automatiquement les installations existantes.
- **Headers rate-limit** — l'interceptor lit `anthropic-ratelimit-*` via `withResponse()` et les expose par `client.getRateLimitStatus()`.
- **Soft-throttle opt-in** (`softThrottle: { enabled: true }`) — retarde (jamais ne dégrade) les requêtes quand le quota restant passe sous un seuil, au lieu d'encaisser un 429.
- **Détection de régression de cache** — en mode debug, warn si `cache_read_input_tokens` s'effondre entre deux requêtes (signe qu'un réécriture du préfixe casse le cache).
- `countRequestTokens()` — comptage incluant system prompt et définitions de tools (souvent 5-15K tokens ignorés jusqu'ici).
- Cache mémoïsé des comptes par message (la pipeline ré-encodait tout l'historique à chaque requête — O(n²) sur une session).
- `validateToolPairing()` exporté, nouveaux types publics (`RateLimitStatus`, `MeasuredUsageStats`, `SoftThrottleOptions`, `ModelPricing`), et section README « cork-ai vs Anthropic's native context features ».
- Le forecast (`report --forecast`) exclut le jour courant incomplet du calcul de moyenne quotidienne.
- README (EN/FR/ES) : section « cork-ai vs les fonctionnalités natives d'Anthropic », garde-fous du hook, `cork-ai calibrate`, options `prefixStable`/`softThrottle` et méthodes de mesure documentées.

## [0.3.0] - 2026-07-02

### Fixed

- **La détection du modèle ne fonctionnait jamais** — le hook lisait `event.model`, un champ que Claude Code n'envoie pas dans le payload PreToolUse. Tous les coûts étaient donc calculés au tarif fallback Sonnet ($3/MTok). Le hook lit maintenant le modèle réel depuis le transcript de session (`transcript_path` → dernier message assistant du thread principal), donc une session Fable 5 est valorisée à $10/MTok, Haiku à $1/MTok, etc.
- **Pricing incomplet** — ajout de Fable 5 / Mythos 5 ($10/MTok) à la table de prix (mise à jour 2026-07-02).
- Le pied de page de `report --forecast` affichait un prix Sonnet codé en dur ; il reflète désormais le modèle détecté.

### Added

- **Stats par modèle** — chaque compression est désormais attribuée au modèle actif : requêtes, tokens économisés, coût économisé (au tarif du modèle au moment de l'usage) et date de dernière utilisation, agrégés par session et en cumul global (`byModel` dans `stats.json` / `live-session.json`).
- **`cork-ai models`** (alias `gain --models`, `report --models`) — répartition par modèle : fréquence d'utilisation (part des requêtes avec barre), tokens/coûts économisés par modèle, prix par MTok, dernière utilisation. Inclus dans `report` complet et dans l'export `report --json` (clé `models`).
- `cork-ai gain` affiche le(s) modèle(s) de la session en cours.

## [0.2.0] - 2026-06-01

### Fixed

- **`gain` vide sur Mac** — le hook utilisait `cork-ai hook` comme commande nue, qui échoue silencieusement quand `~/.local/bin` n'est pas dans le PATH de Claude Code (Electron n'hérite pas de `~/.zshrc`). `hooks install` résout maintenant le chemin absolu du binaire et l'inscrit directement dans `settings.json`. `hooks remove`/`hooks status` acceptent les deux formats.
- **`gain` n'affichait qu'une requête** — chaque appel au hook créait une entrée `requests: 1` dans `stats.json`. Les données sont maintenant accumulées dans `~/.cork-ai/live-session.json` : même projet + moins de 2 h d'inactivité = même session. `gain` sans argument affiche la session en cours et les totaux globaux en pied.
- **Télémétrie jamais proposée lors de l'install** — `process.stdin.isTTY` est `false` dans `curl | sh`, donc la question était sautée. `install.sh` utilise désormais `/dev/tty` pour lire la réponse sur le terminal réel, et `hooks install` applique le même fallback.

### Added

- `~/.cork-ai/live-session.json` — agrège les compressions en temps réel ; flushed dans `stats.json` à l'expiration ou au changement de projet.
- `cork-ai gain` (sans args) affiche : session en cours (ou dernière session terminée) + totaux globaux en pied de page.
- `cork-ai gain --history` affiche la session live en tête de liste (marquée `●`).
- `cork-ai gain --all` inclut la session live dans les totaux.
- `cork-ai reset` efface également `live-session.json`.
- `cork-ai hooks status` affiche la commande exacte installée (utile pour diagnostiquer les problèmes de PATH).

## [0.1.0] - 2026-05-26

### Added — CLI

- **`cork-ai hook`** — Claude Code PreToolUse hook handler
  - Intercepts `Read` tool calls before file content enters the context
  - Compresses file content inline: extracts signatures from code, truncates bash output, flattens JSON
  - Outputs `{"decision": "block", "reason": "<compressed content>"}` replacing the full file in Claude's context
  - Records savings to `~/.cork-ai/stats.json` for `cork-ai gain` reporting
  - 60–90% token reduction per file read, automatically, for every session

- **`cork-ai hooks install / remove / status`** — Claude Code integration
  - Reads and writes `~/.claude/settings.json` to register the hook globally
  - `install`: adds `cork-ai hook` to the `PreToolUse` group for the `Read` tool
  - `remove`: removes the hook entry without touching other hooks
  - `status`: shows whether the hook is active and the current settings path

- **`cork-ai init`** — project auto-integration for library users
  - Scans project files for `new Anthropic()` instantiation
  - Auto-patches a single match: adds `wrapClient` import and wraps the client in-place
  - Generates a ready-to-import `cork-ai-client.ts` when no existing client is found
  - Prints targeted instructions when multiple files are found

- **`cork-ai gain`** — token savings dashboard
  - Shows last session, all-time totals, and full history
  - Per-module breakdown (toolResultCompressor, codeDedup, headerStripper, heatmap, semanticDedup)
  - Estimated cost saved in USD (Claude Sonnet 4 pricing by default)
  - `cork-ai gain --all` · `--history`

- **`cork-ai report`** — enterprise-grade analytics
  - `--daily / --weekly / --monthly`: time-bucketed savings trends
  - `--projects`: per-project token and cost breakdown, sorted by savings
  - `--forecast`: annual cost projection based on rolling 30-day average, with ROI estimate vs. 5-minute setup cost
  - `--json`: machine-readable output for dashboards and CI pipelines

- **`cork-ai reset`** — clears global stats file

- **Standalone binary distribution** via GitHub Releases (no Node.js or npm required)
  - Built with `bun build --compile` for zero-dependency executables
  - Platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`
  - `scripts/install.sh` — one-liner curl install for macOS / Linux / WSL2
  - `scripts/install.ps1` — PowerShell one-liner for Windows
  - GitHub Actions workflow (`.github/workflows/release.yml`) builds and publishes all binaries on every `v*` tag

- **Session stats persistence** in `~/.cork-ai/stats.json`
  - Automatically recorded on process exit via `wrapClient()` or hook
  - Up to 500 sessions kept; oldest entries pruned automatically

### Added — Library

- **`CtxForge`** — main class for on-demand manual compression
- **`wrapClient()`** — transparent middleware over the Anthropic SDK
  - Identical interface to the raw SDK — no changes needed in calling code
  - Adaptive compression: does nothing below 40% of token budget
  - `onStats` callback for per-request reporting
  - `disabledModules` option to selectively disable compression stages

- **Tool Result Compressor** — compresses `tool_result` blocks in conversation history
  - Content-type detection: code, bash, JSON, plain text
  - Code: extracts imports + function/class signatures, strips bodies
  - Bash: keeps first 10 + last 5 lines, surfaces error lines from omitted section
  - JSON: top-level structure summary with value previews
  - Text: leading lines up to configurable limit
  - Side-channel cache with `restore(refId)` to recover original content
  - Estimated savings: 30–50% of input tokens

- **Header Stripper** — deduplicates Claude Code injected headers
  - Detects `<environment>`, `CWD:`, `OS:`, `Platform:` blocks
  - Keeps the first occurrence verbatim, replaces subsequent ones with a short diff
  - Estimated savings: 5–10% of input tokens

- **Assistant Code Deduplicator** — eliminates duplicate code blocks
  - Detects code written via `Write` / `create_file` / `str_replace_editor`
  - Replaces identical blocks already on disk with `[code written to src/foo.ts — omitted]`
  - Estimated savings: 10–20% of input tokens

- **Heatmap Manager** — relevance-based history scoring
  - Scores each message on four dimensions: recency, lexical relevance, content type, cross-references
  - Summarizes low-score messages to one line (never deletes)
  - Estimated savings: 15–25% of input tokens

- **Semantic Deduplicator** — concept-level deduplication
  - TF-IDF + Jaccard similarity, pure JS, no ML dependencies, < 1 ms per chunk
  - Replaces near-duplicate passages with a back-reference
  - Estimated savings: 10–15% of input tokens

- **Selective Summarizer** — intelligent summarization preserving critical information
  - Classifies messages: exploration vs. high-precision content
  - Preserves verbatim: file paths, error messages, decisions, configuration values
  - Estimated savings: 20–30% on old history

- **Session Cache** — cross-session project snapshot
  - Extracts decisions, errors + solutions, file signatures, code conventions
  - Stored in `.cork-ai/cache/[project-hash].json`
  - Estimated savings: 40–60% on session startup tokens

- **Budget Manager** — adaptive compression orchestration
  - Passthrough below 40% of budget — zero overhead on short sessions
  - Level 1 (40–65%): Tool results + Headers
  - Level 2 (65–80%): + Code dedup + Heatmap
  - Level 3 (> 80%): + Semantic dedup + Selective summarizer
  - `hardLimit` option: throws if context still exceeds budget after full compression

- **Dynamic System Prompt** — selective section injection
  - Sections tagged with `<!-- @cork-ai section: name -->`
  - Keyword and pattern-based triggers
  - Estimated savings: 10–20% on system prompt tokens

- **Stats Tracker** — per-module savings accounting
  - Per-request and per-session stats
  - Configurable pricing (default: Sonnet 4 at $3/M input tokens)

- tiktoken (cl100k_base) support with pure-JS fallback
- Node.js 18, 20, 22 compatibility
- Windows (native + WSL2), Linux, macOS support
- Zero native compiled dependencies
- Unit and integration test suite (> 80% coverage)
- Examples in `examples/`
- Benchmark in `benchmarks/cost-comparison.ts`
- CI/CD GitHub Actions (Node 18/20/22 × Ubuntu/Windows/macOS)

[Unreleased]: https://github.com/mqthys62/cork-ai/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/mqthys62/cork-ai/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/mqthys62/cork-ai/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/mqthys62/cork-ai/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mqthys62/cork-ai/compare/v0.2.3...v0.3.0
[0.2.0]: https://github.com/mqthys62/cork-ai/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mqthys62/cork-ai/releases/tag/v0.1.0
