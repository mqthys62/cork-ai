# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-26

### Added
- `CtxForge` — classe principale pour compression manuelle à la demande
- `wrapClient()` — middleware transparent sur le SDK Anthropic
- **Tool Result Compressor** — compression des blocs `tool_result` (code, bash, JSON, texte)
  - Cache side-channel avec `restore(refId)` pour récupérer le contenu original
  - Gain estimé : 30–50% des tokens input
- **Header Stripper** — suppression des headers répétitifs Claude Code
  - Détection des blocs `<environment>`, `CWD:`, `OS:`, `Platform:`
  - Conservation du premier header, diff pour les suivants
  - Gain estimé : 5–10% des tokens input
- **Assistant Code Deduplicator** — déduplication des blocs de code
  - Détection du code écrit via `Write`/`create_file`/`str_replace_editor`
  - Déduplication des blocs identiques dans la conversation
  - Gain estimé : 10–20% des tokens input
- **Heatmap Manager** — scoring de pertinence de l'historique
  - Score sur 4 dimensions : récence, pertinence lexicale, type de contenu, références
  - Résumé des messages peu pertinents à une ligne (jamais supprimés)
  - Gain estimé : 15–25% des tokens input
- **Dynamic System Prompt** — injection sélective des sections du system prompt
  - Sections taguées `<!-- @cork-ai section: name -->`
  - Triggers par mots-clés ou patterns
  - Gain estimé : 10–20% des tokens input
- **Budget Manager** — orchestration adaptative par paliers
  - Passthrough < 40%, Level 1 40–65%, Level 1+2 65–80%, tout > 80%
  - Option `hardLimit` pour refuser les requêtes dépassant le budget
- **Semantic Deduplicator** — déduplication sémantique via TF-IDF + Jaccard
  - Pur JS, zéro dépendance ML, latence < 1ms par chunk
  - Gain estimé : 10–15% des tokens input
- **Selective Summarizer** — résumé intelligent préservant les informations critiques
  - Classification : explorations vs contenu à haute précision
  - Préservation verbatim des chemins, erreurs, décisions, configs
  - Gain estimé : 20–30% des tokens sur l'historique ancien
- **Session Cache** — snapshot de projet inter-sessions
  - Extraction des décisions, erreurs, conventions, signatures de fichiers
  - Stockage dans `.cork-ai/cache/[project-hash].json`
  - Gain estimé : 40–60% des tokens input sur les sessions suivantes
- **Stats Tracker** — suivi complet des économies par module
  - Stats par requête et par session
  - Pricing configurable (défaut : Sonnet 4 à $3/M tokens input)
- Support tiktoken (cl100k_base) avec fallback pur JS
- Compatibilité Node.js 18, 20, 22
- Support Windows (natif + WSL2), Linux, macOS
- Zéro dépendance native compilée
- Tests unitaires et d'intégration (> 80% de coverage)
- Exemples d'usage dans `examples/`
- Benchmark dans `benchmarks/cost-comparison.ts`
- CI/CD GitHub Actions (Node 18/20/22 × Ubuntu/Windows/macOS)

[Unreleased]: https://github.com/mathys62/cork-ai/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mathys62/cork-ai/releases/tag/v0.1.0
