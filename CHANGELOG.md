# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/mqthys62/cork-ai/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mqthys62/cork-ai/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mqthys62/cork-ai/releases/tag/v0.1.0
