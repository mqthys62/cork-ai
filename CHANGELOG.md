# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-08-16

### Fixed

- **Le hook détruisait toutes les lectures d'images** — `fs.readFileSync(png, 'utf-8')` ne lève pas d'erreur : il renvoie du mojibake. Un PNG de 3,5 Mo revenait sous forme de ~12 700 « lignes » de garbage binaire, était tronqué tête/queue, puis renvoyé au modèle via `decision: 'block'` **à la place de l'image**. La vision de Claude était supprimée silencieusement à chaque lecture d'image. Aucune garde binaire n'existait : ni détection de null-byte, ni liste d'extensions. Mesuré sur un historique réel : **60 fichiers binaires interceptés, 25,7 Mo**, dont des PNG de 3,7 Mo, avec 76 % de re-lecture sur `.png`. Le hook lit désormais des `Buffer` et passe par `eligibility()` (nouveau `src/cli/file-eligibility.ts`) : liste d'extensions binaires, plus un reniflage de contenu (NUL, densité de caractères de contrôle C0) pour les fichiers dont l'extension ment.
- **Les économies annoncées étaient très majoritairement fictives** — un PNG de 3,5 Mo comptait ~1M tokens dans l'heuristique du hook, alors que l'API l'aurait facturé ~1 600 tokens vision. Sur l'historique de référence, les binaires représentaient à eux seuls ~4,46M de tokens « économisés » contre 4,44M annoncés au total. Le correctif ci-dessus supprime la source ; les `stats.json` antérieurs restent pollués et ne peuvent pas être corrigés rétroactivement (l'attribution par fichier n'est pas stockée) — `cork-ai reset` donne une base propre.
- **La leçon des re-lectures mourait avec la session** — la whitelist vivait dans le fichier de reads indexé par `session_id`, donc un fichier re-lu en session A était re-compressé en session B, indéfiniment. Taux de re-lecture mesuré : **54 % des fichiers compressés**. Or une re-lecture envoie le fichier **deux fois** (compressé puis brut), ce qui est strictement pire que de ne rien faire. Nouveau `src/cli/skip-list.ts` : liste persistante dans `~/.cork-ai/skip-list.json`, alimentée par les re-lectures et les échecs d'`Edit`, avec expiration à 30 jours (un fichier réécrit reprend sa chance) et plafond de 5 000 entrées.
- **Les langages non listés tombaient sur une troncature tête/queue destructrice** — `compressContent` finissait par un `return compressText(...)` attrape-tout. `.luau` (absent de `CODE_EXTS`) perdait tout son milieu : 70 % de re-lecture. La stratégie est désormais choisie par allowlist — code connu, JSON, prose listée — et **s'abstient** sur tout le reste plutôt que de deviner.
- **`.tsx` et `.jsx` perdaient toutes leurs méthodes** — le regex de méthodes d'`extractCodeSignatures` était gardé par `ext === '.ts' || ext === '.js'` alors que `.tsx` était déclaré compressible (62 % de re-lecture). Remplacé par `BRACE_METHOD_EXTS`, qui couvre les langages dont le corps de méthode s'ouvre par une accolade — et exclut volontairement Python, Ruby et Lua, où la même forme est généralement un appel.

### Added

- **`CODE_EXTS` étendu** — `.luau`, `.lua`, `.vue`, `.svelte`, `.dart`, `.ex`, `.exs`, `.zig`, `.sql`, `.hpp`. Et `TEXT_EXTS`, une allowlist explicite pour la prose et le markup (taux de re-lecture mesurés : `.md` 15 %, `.css`/`.scss` 25 %, `.html` 38 %).
- **Bloc `Health` dans `gain --all`** — taux de re-lecture (vert < 15 %, jaune < 30 %, rouge au-delà), échecs d'`Edit`, et nombre de fichiers appris. C'est ce ratio, pas le pourcentage d'économie, qui dit si cork-ai aide ou nuit.

### Changed

- **Les tokens économisés sont désormais valorisés sur toute leur durée de vie en contexte, plus seulement au premier envoi** — c'était la principale sous-évaluation restante. cork-ai comptait chaque token économisé **une fois, au prix input plein (1×)**. Or dans une boucle d'agent, un token qui entre dans le contexte est payé une fois en écriture de cache (1,25× en TTL 5 min, 2× en TTL 1 h) **puis en lecture de cache (0,1×) à chaque tour suivant** : l'empêcher d'entrer évite toute la traînée. Mesuré sur les transcripts : **94,5 lectures médianes par token écrit**, soit un multiplicateur d'environ 10× par rapport à ce qui était affiché. Nouvelle fonction `costOfAvoidedTokens()` (`src/pricing/index.ts`) et `sessionAmplification()` (`src/cli/transcript-usage.ts`), qui mesure le ratio sur le transcript de la session — `SessionRecord.sessionId` est le nom du fichier transcript, donc la jointure ne demande aucun changement de schéma et s'applique rétroactivement à tout l'historique.
- **`gain --all` encadre l'économie au lieu d'annoncer un chiffre unique** — « First pass only » (l'ancienne borne basse, gardée pour que le chiffre reste auditable), « Lifetime in context », pénalité de re-read, net, et le facteur d'amplification avec la couverture (`12/14 sessions measured`). Une couverture partielle doit se voir.
- **La pénalité de re-read est valorisée sur la même base** — un re-read réinjecte du contenu brut dans le contexte et se paie lui aussi à chaque tour. La laisser à 1× pendant que les économies passent au tarif lifetime aurait biaisé le net en faveur de cork-ai. Effet concret : la pénalité passe de $7 à $106 et absorbe 73 % du brut.

### Added

- **Migration `stats.json` v1 → v2** — les coûts écrits avant la 0.4.2 utilisaient le tarif Opus 5 erroné ($15/M). La migration recalcule `estimatedCostSaved` et `byModel[].costSaved` à partir des `savedTokens` stockés avec la table corrigée, ne touche à **aucun** compteur de tokens, et sauvegarde `stats.json.v1.bak` avant d'écrire.
- `CLAUDE_PROJECTS_DIR` redirige la racine des transcripts. Claude Code ne lit pas cette variable — elle existe pour que les tests pointent sur des fixtures au lieu de l'historique réel du développeur.

### Notes

L'amplification est une **borne haute** : elle suppose que les tokens économisés seraient restés en contexte jusqu'à la fin de la session. Les tours postérieurs à une frontière de compaction (`compact_boundary`) sont exclus, les tours de sous-agents aussi (ils ont leur propre contexte). Les sessions sans transcript retombent sur le coût d'écriture seul et sont exclues du décompte « measured ». Seul le bloc « Real spend » reste de la vérité terrain.

## [0.5.0] - 2026-08-16

### Added

- **Dépense réelle dans `gain --all`** — jusqu'ici cork-ai ne savait chiffrer que ce qu'il avait *évité* sur les sorties de `Read` vues par le hook ; le coût réellement payé restait hors de portée. Nouveau module `src/cli/transcript-usage.ts` : les transcripts Claude Code (`~/.claude/projects/<slug>/<session>.jsonl`) portent l'objet `usage` de l'API sur chaque tour assistant. `gain --all` affiche désormais prompt/output, taux de cache hit, total en $ ventilé par modèle, tours de sous-agents, et l'économie estimée en pourcentage de la dépense réelle. Déduplication obligatoire sur `message.id` (Claude Code écrit 2 à 5 lignes par message pendant le stream — sans dédup le coût est surestimé d'environ 2,5×). Validé contre `ccusage` : concordance des tokens à 0,1–1 %.
- **Ventilation par modèle des économies dans `gain --all`** — `byModel[].costSaved` était enregistré depuis la 0.4.0 mais jamais affiché : un historique multi-modèles ne montrait qu'un chiffre agrégé.
- **Économies brutes / pénalité de re-read / net** — le coût affiché était net des re-reads, la déduction restant invisible. Les trois lignes sont désormais séparées (dans le cas présent : $17.60 brut, -$7.25 de pénalité, $10.35 net — la pénalité pesait 41 % sans être montrée).

### Fixed

- **Facturation des écritures de cache 1 heure à 1,25× au lieu de 2×** — `costOfUsage()` traitait tout `cache_creation_input_tokens` comme du cache 5 minutes. `ApiUsage` accepte désormais le split `cache_creation.ephemeral_{5m,1h}_input_tokens` que l'API renvoie, et facture chaque palier à son propre tarif.
- **`gain --all` : libellés « Total tokens in / out » trompeurs** — ils ne désignaient pas les tokens input/output de l'API (que le hook ne voit jamais) mais la taille des fichiers lus avant et après compression. Renommés « Read raw » / « After compression ».

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

[Unreleased]: https://github.com/mqthys62/cork-ai/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/mqthys62/cork-ai/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mqthys62/cork-ai/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/mqthys62/cork-ai/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/mqthys62/cork-ai/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/mqthys62/cork-ai/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mqthys62/cork-ai/compare/v0.2.3...v0.3.0
[0.2.0]: https://github.com/mqthys62/cork-ai/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mqthys62/cork-ai/releases/tag/v0.1.0
