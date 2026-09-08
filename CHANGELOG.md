# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-rc.1] — 2026-09-08

Release candidate for 1.0: three features measured on real transcripts, then stabilisation. Beta testers and the Windows checklist decide what becomes 1.0.0.

### Added
- **Re-read cache.** A file served raw earlier in the session, unchanged since (mtime, size and a content hash agree) and not lost to a compaction, is answered with an 80-token reminder — `already read N turns ago, unchanged since (L1–L340): the full content is still in your context above` — instead of the file. Measured on real sessions: 18 % of whole-file reads are re-reads of an unchanged file, about 5k tokens per session. Never cached: files edited since, files named in the last prompt, skip-listed files, ranged reads, reads by another agent. Compactions are detected from the transcript (`compact_boundary` / compaction summary after the first read). One wrong call — the model re-reads anyway — serves the file raw for the rest of the session and feeds the `cache:` re-read rate in `policy.json`, which starts from a lower prior (0.3) and its own 800-token bar. `policy.reReadCache` config key (default true).
- **Policy by agent class.** Reads are classed `main` (the conversation), `readonly` (Explore, Plan, claude-code-guide, statusline-setup) or `editing` (general-purpose, forks, custom agents — unknown means editing). Read-only agents are outlined from 800 saved tokens instead of 1,500 and skip the edited-file rule; learned re-read rates are kept per class (`ro:` keys). Read state is per agent: what a subagent read never counts as a re-read for the conversation. `policy.readonlyAgentsAggressive` config key (default true).
- **Session digests in `gain`.** `cork-ai gain` shows the last finished session (duration, turns, average/max context, cost, saving at 200k, compactions, outlines, re-reads, edit failures, guard bands) when no session is live; `cork-ai gain --sessions [N] [--json]` lists the last N digests with totals. Digests are pruned after 30 days, like Claude Code's transcripts.
- **PowerShell reads.** `Get-Content` / `gc` / `type` / `cat` under Claude Code's PowerShell tool (Windows without Git Bash) are handled like `cat` under Bash: whole-file reads go through the gate, `-TotalCount` / `-Head` / `-Tail` pass through, and re-reads are counted. The hooks' `PreToolUse` matcher is now `Bash|PowerShell`.
- **`CORK_AI_DEBUG=1`**: the hook writes swallowed errors and one trace line per event to `~/.cork-ai/debug.log` (1 MB rotation). `doctor` reports the log when it exists.
- `doctor` checks the Claude Code version against the tested range (2.1.47 → 2.1.263), the age of the last telemetry snapshot when telemetry is on, and the state of the local caches.
- `docs/METHODOLOGY.md`: how every figure is computed (first pass vs lifetime vs penalties, amplification, the EV gate, the replay at 200k, token estimation), the payload fields the hook reads, and the known limits. Linked from the README.
- Telemetry: `hook_read` gains `decision: cached`, `turns_ago`, `cache_miss` and `agent_class`; `hook_reread` gains `kind: after-cache` and `agent_class`. Two insights on the Savings dashboard: *Cache hits vs re-reads*, *Decisions by agent class*.

### Changed
- Every state file cork-ai writes (`config.json`, `policy.json`, `reads-*.json`, `sessions-seen.json`, `heartbeat.json`, stats, caches, digests) is written to a temporary file and renamed: concurrent hooks (subagents) can no longer leave a truncated file behind.
- The hook never throws: a failing handler is logged (`CORK_AI_DEBUG`) and the read passes through untouched.
- `context --set-autocompact` says so and changes nothing when the value is already set; setting it by hand marks the install question as answered.
- SDK tests moved out of the default `npm test` (`npm run test:sdk`, still run in CI); unit and integration tests each get their own `CORK_AI_HOME`.
- `docs/SDK.md`: the deprecated library is scheduled for removal in 1.1.0.

## [0.9.1] — 2026-09-08

### Fixed
- **Windows: the hooks never fired.** Since Claude Code 2.1.120, hook commands run through PowerShell when Git Bash is not installed, and the shell-form command cork-ai wrote — `"C:\…\cork-ai.exe" hook` — is a PowerShell parse error (`Unexpected token 'hook'`), a silent non-blocking failure: no outline, no heartbeat, no session tracked. On Windows `hooks install` now writes the exec form (`command` + `args`, Claude Code ≥ 2.1.139), which spawns the binary directly with no shell in between; an existing shell-form install is migrated by re-running `cork-ai hooks install` (or the PowerShell installer).
- `cork-ai doctor` on Windows fails the hooks check when a hook is still in shell form, and reports whether the Claude Code version supports the exec form.
- `scripts/install.ps1` no longer pipes `hooks install` to `Out-Null`: the telemetry and auto-compaction questions were invisible, so the installer looked hung.
- `cork-ai update` on Windows prints a PowerShell `Move-Item` command instead of cmd's `move /Y`.

## [0.9.0] — 2026-09-08

Telemetry that can answer questions — and be shown.

### Added
- `savings_snapshot` event: one daily aggregate per install of what cork-ai measured — tokens kept out of context, USD saved (first pass, lifetime, penalties, net), re-read rate, median amplification, 30-day context picture (spend bucketed), setup (autoCompactWindow, guard, hooks). Sent by a detached child after a session ends or on `cork-ai gain`; never inside a hook.
- `session_start` event on the first hook event of a session, so sessions are counted even when SessionEnd never fires.
- PostHog person profiles (`$set` / `$set_once`): version, OS, runtime, Claude Code version, telemetry, guard, lifetime totals, first version / first seen. Every event now carries `claude_version` and `runtime`.
- `cork-ai telemetry preview [--json]`: the exact daily payload and where it is built from. `telemetry status` shows the last snapshot.
- `session_digest` gains `saved_tokens` and `duration_min`.
- `scripts/posthog-setup.mjs` (maintainers): idempotent setup of the PostHog project — IP anonymisation, a transformation that keeps GeoIP at country level (no city, postal code or coordinates), event/property descriptions, four dashboards (Overview, Savings, Context, Adoption) with 44 insights.
- `scripts/adoption.mjs --push` and `.github/workflows/adoption.yml`: GitHub release download counts pushed daily to PostHog as `release_downloads`, the adoption denominator.
- `scripts/stats.mjs` and `.github/workflows/stats.yml`: weekly community stats → `docs/stats.json`, shields.io badges, README block (only once 5 installs share data).

### Changed
- Transcript scans are memoised by file size and mtime (`spend-cache.json`) and the per-session analyses (amplification, re-read turns) are cached in `analysis-cache.json`: `gain --all` goes from ~9 s to well under a second on a 750 MB history. `reset --spend-cache` clears both.
- The savings maths moved from the CLI entry point to `src/cli/savings.ts`; Claude settings helpers to `src/cli/claude-settings.ts`.

## [0.8.0] - 2026-09-08

**cork-ai est désormais l'outil Claude Code, et seulement lui.** La bibliothèque de compression de conversation (`wrapClient`, `CtxForge`, les sept stratégies) dont le projet est parti est dépréciée : elle reste dans le dépôt (`src/sdk/`, tests dans `tests/sdk/`, `npm run build:sdk`) mais n'est plus exportée par le paquet npm ni maintenue comme produit. Mesurée sur deux mois d'historique réel, la compression des lectures pèse ~1 % de la facture ; la gouvernance du contexte, 50 % et plus. Le README cesse de promettre « 60–75 % » et dit ce que l'outil fait. Détails et migration : `docs/SDK.md`.

### Changed

- **Le hook est une fonction pure et testée** — `src/cli/hook.ts` : `handleHookEvent(payload) → JSON | undefined`, sans `process.exit` ni `console.log` ; l'entrée CLI ne fait plus que lire stdin et écrire stdout. 17 tests unitaires couvrent chaque chemin (outline, relecture complète, suite ciblée, fichier cité, contexte énorme, image, fichier édité, sous-agent, `cat`, `sed -n`, `sed -i`, Edit échoué, garde, SessionEnd, heartbeat). `index.ts` passe de 2 300 à 1 940 lignes ; config, télémétrie, heartbeat et version ont leur module.
- **Paquet npm CLI seul** — plus de `main`/`exports`/`peerDependencies` ; `bin` inchangé (`dist/cli/index.js`). `cork-ai init` (intégration du SDK dans un projet) est retiré.
- **`hooks install` pose la question qui compte** — après les hooks et la télémétrie, propose de régler `autoCompactWindow` à 200k (une fois ; `cork-ai context --set-autocompact` sinon). Réponse mémorisée dans `config.json`.
- **Télémétrie v2 sur PostHog Cloud EU** — l'ancien endpoint PHP auto-hébergé n'a jamais fonctionné : dans le binaire compilé, `spawn(process.execPath, ['-e', …])` lançait `cork-ai -e …` et n'envoyait rien. Remplacé par `POST eu.i.posthog.com/capture` via un sous-processus détaché `cork-ai __send-telemetry`, clé de projet en écriture seule, identifiant d'installation aléatoire. Événements : `install`, `telemetry_toggled`, `command`, `hook_read` (décision et raison), `hook_reread`, `guard_notice`, `session_digest`. Jamais de chemin, de nom, de contenu ni d'identifiant de session ; tokens, contexte et coûts en tranches. Tout est listé dans `docs/TELEMETRY.md`, et les tests vérifient qu'aucun chemin ne fuit.

### Added

- **Hook `SessionEnd`** — écrit un digest par session dans `~/.cork-ai/digests/` (tours, contexte moyen/max, coût, coût à 200k, compactions, outlines, relectures, bandes du garde) et envoie `session_digest`. Base de la fonctionnalité « digest de session » prévue en 0.9.
- **`cork-ai update`** — remplace le binaire standalone par la dernière release GitHub (remplacement atomique sur POSIX, fichier `.new` sur Windows) ; `--check` ne fait que regarder. `doctor` signale les versions en retard.
- **`cork-ai config`** — `list` / `get` / `set` / `unset` sur `~/.cork-ai/config.json`, clés documentées (télémétrie, bandes et cadence du garde, amplification).
- **`cork-ai reset` granulaire** — `--stats` (défaut), `--policy`, `--skip-list`, `--spend-cache`, `--digests`, `--all`.
- **`--json`** sur `cork-ai context` et `cork-ai doctor`, pour les scripts et les bêta-testeurs.
- Tests : `hook`, `telemetry`, `config` ; 354 → 382.

### Fixed

- **CI rouge sur Windows (Node 18/20/22)** — le test d'intégration `hooks-install` lançait le CLI via `npx tsx` : sur Windows `npx` est un shim `.cmd` que `spawnSync` ne peut pas démarrer sans shell, et `HOME` n'y est pas lu par `os.homedir()` (`USERPROFILE`). Le test passe désormais par `process.execPath` + le `cli.mjs` de tsx résolu localement et pose les deux variables. Les chemins absolus des tests `bash-read` sont entre guillemets, comme un vrai shell l'exigerait pour des antislashs.
- L'outline normalise les fins de ligne `\r\n` — les fichiers Windows (et le checkout CRLF des runners) donnaient des lignes terminées par `\r`.
- Matrice CI : Node 24 ajouté (LTS courante) ; les jobs coverage et build passent sur Node 22.

## [0.7.0] - 2026-09-08

### Fixed

- **Plus aucun événement depuis fin août : le hook n'était plus appelé** — pas à cause d'un `claude update` (les hooks étaient toujours dans `settings.json`, et `decision: block` est toujours honoré en 2.1.263, vérifié), mais parce que le **mode auto** de Claude Code fait lire les fichiers au modèle via **Bash** (`cat`, `sed -n`, `head`) au lieu de l'outil `Read`. Session mesurée du 30/08 : 961 Bash, 0 Read. Le hook n'était branché que sur `Read`. Nouveau hook `PreToolUse` sur **`Bash`** (`src/cli/bash-read.ts`) : une lecture entière d'un seul fichier (`cat [-n] fichier`, `nl`, `bat`, `rtk proxy cat`, sans pipe ni redirection) passe par la même pipeline que `Read` ; les lectures ciblées (`sed -n`, `head`, `tail`) passent telles quelles (et, après un outline, sont comptées à part comme la suite attendue, sans peser sur la probabilité de relecture) ; `sed -i`, `tee` et les redirections marquent le fichier comme en cours d'édition. `hooks install` met à niveau les installations existantes (Bash, `Write` dans le matcher PostToolUse, `UserPromptSubmit`, `Stop`).
- **La compression était perdante** — mesuré sur les transcripts : **72–81 % des lectures compressées étaient suivies d'une relecture complète** (cork-ai n'en comptait que 39 % : il ne voyait pas les relectures faites via Bash), 42 % immédiatement, et 59 % des fichiers compressés étaient édités ensuite (`.tsx` : 97 %). Chaque relecture est un tour API de plus, qui relit tout le contexte (≈ 0,20 $ à 400k tokens sur Opus 5) — jamais compté. Trois réponses : (1) **l'outline numéroté** (`src/cli/outline.ts`) remplace les « signatures » — une ligne par déclaration avec son numéro de ligne, imports repliés, plus de `const` locaux avec `// ...` ; le modèle lit ensuite la région exacte (`Read offset/limit`, `sed -n`) au lieu de tout relire ; 85–90 % de compression mesurée sur de vrais fichiers ; (2) une **porte de valeur attendue** (`src/cli/policy.ts`) : compresser ssi `économisé × amplification × cacheRead > P(relecture) × (outline mort + contexte courant × cacheRead + sortie)`, avec le contexte lu dans la queue du transcript et `P(relecture)` **apprise par extension** sur la machine (probation au-dessus de 35 %, sondage 1/10) ; (3) les fichiers édités dans la session sont servis bruts.
- **Sonnet 5 surfacturé de 50 % depuis le 01/09** — la hausse à 3 $/15 $ prévue au 1er septembre a été annulée par Anthropic : 2 $/10 $ devient le tarif standard. **Fable 5.1 / Mythos 5.1 : cache read à 0,25 $/M (0,025×)**, pas 1 $/M — cork-ai surestimait ×4 le poste qui fait 78 % de la facture. Fast mode (`usage.speed === 'fast'`, Opus 5/4.8) facturé 10 $/50 $. `PRICING_UPDATED_AT = 2026-09-08`.
- **Dépense réelle sous-estimée : les transcripts de sous-agents étaient ignorés** — Claude Code les écrit désormais dans `<session>/subagents/**.jsonl` ; le scan descend dans ces répertoires (2 914 tours de sous-agents retrouvés sur l'historique de référence).
- **`gain --all` oubliait l'historique au fil de l'eau** — Claude Code supprime les transcripts après 30 jours (`cleanupPeriodDays`) ; la dépense réelle affichée rétrécissait d'autant. Nouveau `~/.cork-ai/spend-cache.json` : chaque scan y conserve le résultat par fichier, et les fichiers disparus sont réintégrés.
- **`gain` plantait sur `undefined.localeCompare`** dès que le garde contexte avait écrit son état (`live/guard-<session>.json`, ramassé comme une session live — le bug de la 0.4.1 avec `reads-`, revenu avec un nouveau préfixe). Liste de préfixes exclus *et* validation de forme dans `readLiveFile()`, plus un test de régression ; les fichiers inconnus ne sont plus supprimés au passage.
- Test `trie par label croissant` : dates fixes de mai avec une fenêtre glissante de 100 jours — il échouait depuis le 18/08. Dates relatives.

### Added

- **`cork-ai context`** — le rapport qui explique la facture : par session, tours, contexte moyen/max, coût, part de cache reads, et **ce que le même travail aurait coûté avec une auto-compaction à 150k / 200k / 300k** (rejeu tour par tour, coût des compactions inclus). Sur l'historique de référence : **78 % de la dépense en cache reads, 408k tokens de contexte moyen, −57 % avec un plafond à 200k**. `--set-autocompact 200k` écrit `autoCompactWindow` (réglage documenté de Claude Code, 100k–1M tokens) dans `~/.claude/settings.json`.
- **Garde contexte** (`src/cli/context-guard.ts`) — hooks `UserPromptSubmit`, `Stop` et `PostToolUse` (throttlé) : à chaque palier franchi (150k / 300k / 500k / 750k, une fois par palier et par session), un `systemMessage` pour l'utilisateur (« contexte 365k → 0,09 $ par appel, /compact ramènerait à 0,006 $ ») et un `additionalContext` court pour le modèle (grouper les commandes, lire des plages, proposer `/compact` au prochain point d'arrêt). Ne bloque jamais rien. `cork-ai context guard off` pour le couper.
- **`cork-ai doctor`** — binaire, 5 hooks, auto-test du hook sur un payload synthétique (dans un `CORK_AI_HOME` temporaire), heartbeat, **couverture** (sessions Claude Code des 14 derniers jours vues / non vues, avec la répartition Read vs lectures Bash), hooks tiers sur les mêmes matchers, `autoCompactWindow`. Lancé en fin d'`install.sh` / `install.ps1`.
- **Heartbeat** (`~/.cork-ai/heartbeat.json`) — écrit à chaque événement hook (au plus une fois par minute) avec la version de Claude Code lue dans le transcript et le `permission_mode` ; `gain` affiche « Last event … » et la couverture, et prévient quand des sessions tournent sans événement.
- **Pénalité honnête** — `gain --all` ajoute « Re-read extra turns » : le coût réel (usage du transcript) des tours qui n'ont existé que pour relire un fichier compressé. Sur l'historique de référence : 47 tours, −5,84 $.
- Bloc **Context** dans `gain --all` (part de cache reads, contexte moyen, économie à 200k) et bloc **Hook** (dernier événement, couverture).
- **`cork-ai statusline`** — segment pour `statusLine.command` : contexte, coût cache-read du prochain appel, coût de session, `/compact?` passé 150k.
- Sortie hook au format actuel `hookSpecificOutput.permissionDecision: "deny"` (le `decision: "block"` legacy est conservé, `hookSpecificOutput` prime quand les deux sont présents).
- Tests : `bash-read`, `outline`, `policy`, `context-guard`, `transcript-context` (scan récursif, dernier tour, profil de contexte, tours de relecture, cache durable) et un test d'intégration `hooks-install` (installation, mise à niveau 0.4–0.6, retrait, `--set-autocompact`). 292 → 354 tests.

### Notes

Les chiffres « Estimated savings vs spend » restent ce qu'ils sont : la compression des lectures pèse ~1 % de la facture. Le levier est la taille du contexte ; `cork-ai context --set-autocompact 200k` est la commande qui compte.

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
