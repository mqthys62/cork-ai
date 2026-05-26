## TODO — cork-ai

### Fondation du projet
- [x] Initialiser package.json (name, version, description, main, types, exports, scripts, keywords, license, engines)
- [x] Configurer tsconfig.json (target ES2020, moduleResolution NodeNext, strict, declaration, sourceMap, outDir dist)
- [x] Créer .gitignore (node_modules, dist, coverage, .cork-ai)
- [x] Créer .npmignore (src, tests, benchmarks, examples, .github, coverage)
- [x] Installer les dépendances de dev (typescript, vitest, @vitest/coverage-v8, @types/node)
- [x] Installer tiktoken comme dépendance optionnelle
- [x] Déclarer @anthropic-ai/sdk en peerDependency optionnelle

### Types partagés — src/types/index.ts
- [x] Définir le type `Message` (compatible Anthropic SDK : role, content)
- [x] Définir `ContentBlock` (text, tool_use, tool_result)
- [x] Définir `CompressResult` (messages compressés + stats de ce module)
- [x] Définir `ModuleStats` (saved, runs, name)
- [x] Définir `RequestStats` (originalTokens, compressedTokens, savedTokens, savingsPercent, estimatedCostSaved)
- [x] Définir `SessionStats` (totalSaved, totalProcessed, estimatedCostSaved, requestCount)
- [x] Définir `FullStats` (request, session, byModule)
- [x] Définir `PricingConfig` (input, output en USD/1M tokens)
- [x] Définir `CorkAIOptions` (aggressiveness, maxContextTokens, budget, pricing, debug, onStats)
- [x] Définir `ToolResultOptions` (aggressiveness, maxCodeLines, maxBashLines, cacheEnabled)
- [x] Définir `HeatmapScore` (messageIndex, score, reason)
- [x] Exporter tous les types depuis src/types/index.ts

### Tokenizer — src/core/tokenizer.ts
- [x] Implémenter `countTokens(text: string): number` avec tiktoken (cl100k_base)
- [x] Implémenter fallback pur JS si tiktoken indisponible (approximation chars/4)
- [x] Implémenter `countMessageTokens(messages: Message[]): number`
- [x] Exporter `TokenizerSingleton` pour réutilisation sans re-init tiktoken
- [x] Tests unitaires : tests/unit/tokenizer.test.ts (cas nominaux + edge cases)

### Stats Tracker — src/stats/tracker.ts
- [x] Implémenter classe `StatsTracker` avec état session persistant
- [x] Méthode `recordModule(name, savedTokens)` — accumule par module
- [x] Méthode `getRequestStats(original, compressed, pricing): RequestStats`
- [x] Méthode `getSessionStats(): SessionStats`
- [x] Méthode `getFullStats(original, compressed): FullStats`
- [x] Méthode `reset()` — remet la session à zéro
- [x] Pricing configurable, défaut Sonnet 4 : `{ input: 3.0, output: 15.0 }`
- [x] Tests unitaires : tests/unit/stats-tracker.test.ts

### Tool Result Compressor — src/compressors/tool-result.ts
- [x] Détecter les blocs `tool_result` dans les messages `user`
- [x] Implémenter la compression de fichiers de code (extraire imports + signatures, supprimer les corps)
- [x] Implémenter la compression de sortie bash (10 premières + 5 dernières lignes, lignes d'erreur remontées)
- [x] Implémenter la compression de JSON (structure premier niveau, Array(N), {clés...})
- [x] Implémenter la compression de texte générique (N premières lignes selon aggressivité)
- [x] Stocker le contenu original dans un cache side-channel avec `refId` unique
- [x] Remplacer dans le contexte par le placeholder `[cork-ai: ...]`
- [x] Détecter le type de contenu automatiquement (extension, structure JSON, motifs bash)
- [x] Exposer `compressToolResults(messages, options): CompressResult`
- [x] Exposer `restore(refId): string | null`
- [x] Respecter le niveau d'aggressivité (0.0 à 1.0)
- [x] Tests unitaires : tests/unit/tool-result.test.ts (fichier code, bash, JSON, texte, edge cases)

### Header Stripper — src/compressors/header-stripper.ts
- [x] Détecter les patterns de header Claude Code dans les messages `user`
- [x] Reconnaître les blocs `<environment>`, `<files>`, préfixes `CWD:`, `OS:`, timestamps
- [x] Conserver le premier header intégralement
- [x] Sur les suivants : ne garder que les champs changés
- [x] Ajouter un résumé de diff : `[env: identique au message précédent]`
- [x] Exposer `stripHeaders(messages, options): CompressResult`
- [x] Tests unitaires : tests/unit/header-stripper.test.ts

### Assistant Code Deduplicator — src/compressors/code-dedup.ts
- [x] Scanner les `tool_use` de type `Write`/`create_file`/`str_replace_editor` pour construire une map hash → chemin
- [x] Normaliser le hash du code (trim, normalize line endings)
- [x] Détecter les blocs de code dans les messages `assistant` qui correspondent à des fichiers écrits
- [x] Remplacer par `[code écrit dans \`path\` — omis pour économiser les tokens]`
- [x] Détecter les blocs de code dupliqués dans la conversation (sans fichier associé)
- [x] Remplacer les occurrences suivantes par une référence à la première
- [x] Exposer `deduplicateCode(messages, options): CompressResult`
- [x] Tests unitaires : tests/unit/code-dedup.test.ts

### Budget Manager — src/managers/budget.ts
- [x] Calculer le coût token du contexte avant chaque requête
- [x] Implémenter les paliers de compression (passthrough < 40%, L1 40–65%, L1+L2 65–80%, all > 80%)
- [x] Orchestrer l'appel aux modules selon le palier actif
- [x] Exposer le budget courant dans les stats
- [x] Option `hardLimit` : throw si dépassement
- [x] Ajustement dynamique du seuil selon la pression budgétaire
- [x] Exposer `BudgetManager` avec méthode `compress(messages, options): CompressResult`
- [x] Tests unitaires : tests/unit/budget.test.ts

### Heatmap Manager — src/managers/heatmap.ts
- [x] Scorer chaque bloc d'historique sur la récence
- [x] Scorer sur la pertinence lexicale (overlap de termes avec les N derniers messages)
- [x] Scorer sur le type de contenu (décisions, erreurs résolues, configurations → bonus permanent)
- [x] Scorer sur les références récentes à un ancien message
- [x] Résumer les blocs sous le seuil à une ligne (jamais supprimer)
- [x] Ajuster le seuil selon la pression budgétaire
- [x] Exposer `HeatmapManager` avec méthode `score(messages): HeatmapScore[]`
- [x] Exposer méthode `compress(messages, threshold, options): CompressResult`
- [x] Tests unitaires : tests/unit/heatmap.test.ts

### Dynamic System Prompt — src/managers/system-prompt.ts
- [x] Parser les sections taguées `<!-- @cork-ai section: name -->...<!-- @cork-ai end -->`
- [x] Gérer les triggers (liste de mots-clés ou patterns regex) par section
- [x] Analyser les N derniers messages pour détecter le contexte actif
- [x] Injecter uniquement les sections pertinentes + le core (jamais omis)
- [x] Conserver un fingerprint du system prompt précédent pour éviter les recalculs
- [x] Exposer `DynamicSystemPrompt` avec méthode `build(systemPrompt, recentMessages): string`
- [x] Tests unitaires : tests/unit/system-prompt.test.ts

### Semantic Deduplicator — src/compressors/semantic-dedup.ts
- [x] Extraire les chunks sémantiques de chaque message (blocs de code, paragraphes, définitions)
- [x] Construire un fingerprint TF-IDF léger pour chaque chunk (pur JS, zéro dépendance ML)
- [x] Comparer chaque chunk contre l'index via similarité de Jaccard
- [x] Remplacer les chunks similaires (seuil 0.82) par `[↑ concept déjà établi au message #N — omis]`
- [x] Ne jamais toucher à la première occurrence
- [x] Latence < 1ms par chunk
- [x] Exposer `deduplicateSemantic(messages, options): CompressResult`
- [x] Tests unitaires : tests/unit/semantic-dedup.test.ts

### Selective Summarizer — src/managers/selective-summarizer.ts
- [x] Classifier les messages en « peut être résumé » vs « doit rester verbatim »
- [x] Détecter le contenu à haute précision : noms de fichiers, stack traces, décisions validées, configs
- [x] Extraire et préserver les éléments verbatim dans un bloc structuré compact
- [x] Résumer le reste en prose courte
- [x] Exposer `SelectiveSummarizer` avec méthode `summarize(messages, options): CompressResult`
- [x] Tests unitaires : tests/unit/selective-summarizer.test.ts

### Session Cache — src/managers/session-cache.ts
- [x] Extraire le snapshot de projet en fin de session (signatures, décisions, erreurs, conventions)
- [x] Sérialiser dans `.cork-ai/cache/[project-hash].json`
- [x] Charger le snapshot au début de la session suivante
- [x] Injecter le snapshot comme section compressée du system prompt (3 000–8 000 tokens)
- [x] Calculer le project-hash (basé sur le répertoire courant)
- [x] Exposer `SessionCache` avec méthodes `save(messages, projectPath)` et `load(projectPath): string | null`
- [x] Tests unitaires : tests/unit/session-cache.test.ts

### Pipeline — src/core/pipeline.ts
- [x] Orchestrateur principal qui compose tous les modules
- [x] Méthode `run(messages, options): CompressResult` — applique les modules selon l'ordre et les options
- [x] Chaque module peut être activé/désactivé indépendamment via options
- [x] Les modules ne se connaissent pas entre eux — communication uniquement via pipeline
- [x] Logger interne silencieux par défaut, activable via `debug: true`
- [x] Tests unitaires : tests/unit/pipeline.test.ts

### Interceptor (wrapClient) — src/core/interceptor.ts
- [x] Implémenter `wrapClient(client, options): WrappedClient`
- [x] Intercepter `client.messages.create()` et `client.messages.stream()`
- [x] Appliquer le pipeline avant chaque requête
- [x] Appeler `onStats` callback si configuré
- [x] Retourner les stats via `.getStats()`
- [x] Rester transparent (l'interface est identique au SDK Anthropic)
- [x] Tests unitaires : tests/unit/interceptor.test.ts

### CtxForge — interface manuelle
- [x] Implémenter classe `CtxForge` dans src/index.ts
- [x] Constructeur accepte `CorkAIOptions`
- [x] Méthode `compress(messages): { messages, stats }` — compression à la demande
- [x] Méthode `getStats(): FullStats`
- [x] Méthode `restore(refId): string | null`
- [x] Tests unitaires : tests/unit/ctx-forge.test.ts

### Point d'entrée — src/index.ts
- [x] Exporter `wrapClient`
- [x] Exporter `CtxForge`
- [x] Exporter tous les types publics depuis src/types/index.ts
- [x] Exporter les modules individuels pour usage avancé

### Tests d'intégration
- [x] tests/integration/full-pipeline.test.ts — session simulée bout-en-bout
- [x] tests/integration/fixtures/ — messages de test réalistes (fichier code, bash, JSON, headers)
- [x] Vérifier que la compression est non-destructive (les informations critiques sont préservées)
- [x] Vérifier les stats bout-en-bout (totalSaved cohérent avec la somme des modules)

### Exemples
- [x] examples/basic-usage.ts — usage minimal avec CtxForge.compress()
- [x] examples/with-rtk.ts — exemple combiné avec RTK pour summarization globale
- [x] examples/claude-code-hook.ts — intégration via CLAUDE.md hook

### Benchmarks
- [x] benchmarks/cost-comparison.ts — mesure réelle avant/après sur des fixtures de session longue
- [x] Rapport de gains lisible en sortie (tableau par module + total)

### Documentation
- [x] README.md : badge NPM, CI, coverage, license
- [x] README.md : phrase de présentation, tableau de gains par module avec chiffres
- [x] README.md : installation (npm, yarn, pnpm)
- [x] README.md : quick start (5 lignes pour être opérationnel)
- [x] README.md : exemple wrapClient et CtxForge
- [x] README.md : intégration RTK
- [x] README.md : intégration Claude Code (hook CLAUDE.md)
- [x] README.md : toutes les options de configuration documentées
- [x] README.md : section "How it works" avec diagramme du pipeline
- [x] README.md : compatibilité Node 18+, Windows/WSL/Linux/macOS
- [x] CONTRIBUTING.md : lancer les tests, ajouter un module, conventional commits, process PR
- [x] CHANGELOG.md : format keep-a-changelog, version initiale v0.1.0
- [x] LICENSE : MIT avec année 2026

### CI/CD
- [x] .github/workflows/ci.yml : tests sur Node 18, 20, 22
- [x] CI sur ubuntu-latest, windows-latest, macos-latest
- [x] Build TypeScript sans erreur
- [x] Coverage > 80% (statements/functions/lines), > 75% (branches)

### Validation finale
- [x] npm test passe sans erreur (144 tests)
- [x] npm run build produit un dist/ propre sans erreur TypeScript
- [x] npm run benchmark produit un rapport de gains lisible
- [x] Les exemples dans examples/ s'exécutent sans erreur
- [x] package.json exports correctement configurés (ESM + CJS)
- [x] Tous les items précédents cochés
