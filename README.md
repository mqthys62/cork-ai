# cork-ai

[![npm version](https://img.shields.io/npm/v/cork-ai.svg)](https://www.npmjs.com/package/cork-ai)
[![CI](https://github.com/mathysthery/cork-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mathysthery/cork-ai/actions)
[![Coverage](https://codecov.io/gh/mathysthery/cork-ai/branch/main/graph/badge.svg)](https://codecov.io/gh/mathysthery/cork-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

> Cut your Claude API costs by **60–75%** on long sessions — without changing how you code.

**Translations:** [Français](docs/README.fr.md) · [Español](docs/README.es.md)

---

## What is cork-ai?

Every time Claude Code makes an API call, it sends the **entire conversation history** — including every file it has read, every bash output, every repeated header. On a 2-hour session, that's easily **100,000+ tokens per request**, most of it redundant.

cork-ai sits between your code and the Anthropic API. It intercepts each request, compresses what's redundant, and forwards a leaner context. **Your code doesn't change. The results don't change. The bill does.**

```
Your code  →  cork-ai  →  Anthropic API
                ↓
         [removes 60-75%
          of redundant tokens]
```

---

## How does it work?

cork-ai applies **seven independent compression strategies**, each targeting a different source of token waste:

| # | What's wasted | How cork-ai fixes it | Savings |
|---|--------------|---------------------|---------|
| 1 | **Tool results** — files read by Claude are resent every turn, in full | Extracts signatures from code, truncates bash output, flattens JSON | **30–50%** |
| 2 | **Repetitive headers** — Claude Code injects CWD, open files, OS info on every message | Keeps the first one, replaces the rest with a short diff | **5–10%** |
| 3 | **Duplicate code** — code Claude just wrote to a file gets resent in conversation history | Replaces with `[code written to src/foo.ts — omitted]` | **10–20%** |
| 4 | **Irrelevant history** — old CSS discussion when you're debugging SQL | Scores relevance, summarizes low-score messages to one line | **15–25%** |
| 5 | **Repeated concepts** — same idea expressed 5 different ways across messages | TF-IDF + Jaccard similarity, replaces near-duplicates with a reference | **10–15%** |
| 6 | **Bloated old messages** — exploration text that could be 10% its size | Summarizes while preserving exact file paths, error messages, and decisions | **20–30%** |
| 7 | **Cold start** — next session re-discovers the whole project from scratch | Saves a compressed project snapshot, loads it at session start | **40–60%** next session |

cork-ai is **adaptive**: it does nothing when your context is small, and scales up compression as the session grows. No waste, no over-compression.

---

## Measured results

| Session length | Without cork-ai | With cork-ai | Reduction |
|---------------|----------------|-------------|-----------|
| Short (< 30 min) | ~15,000 tokens | ~12,000 | ~20% |
| Medium (1h) | ~60,000 tokens | ~22,000 | **~63%** |
| Long (2h+) | ~140,000 tokens | ~38,000 | **~73%** |
| Next session (same project) | ~50,000 tokens | ~18,000 | **~64%** |

Combined with [RTK](https://github.com/reachingforthejack/rtk): realistic **65–75% total reduction** on long sessions.

---

## Installation

### One-line install (recommended)

**macOS / Linux / WSL2:**
```bash
curl -fsSL https://raw.githubusercontent.com/mathysthery/cork-ai/main/scripts/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/mathysthery/cork-ai/main/scripts/install.ps1 | iex
```

The script auto-detects your package manager (npm / yarn / pnpm / bun), installs cork-ai globally, and runs `cork-ai hooks install` — you're done in one command.

---

### Manual install

**Global install** (for the CLI + Claude Code hooks — works across all your projects):
```bash
npm install -g cork-ai     # or: yarn global add cork-ai
pnpm install -g cork-ai   #     bun install -g cork-ai
cork-ai hooks install      # ← adds the hook to ~/.claude/settings.json
```

**Per-project install** (for the library API — `wrapClient`, `CtxForge`):
```bash
npm install cork-ai
npm install @anthropic-ai/sdk   # peer dep, only needed for wrapClient()
```

---

## How cork-ai integrates with Claude Code

```
Claude Code reads a file
        ↓
cork-ai hook intercepts (PreToolUse)
        ↓
Compresses file content → extracts signatures, truncates boilerplate
        ↓
Claude receives compressed digest instead of full file
        ↓
60–90% fewer tokens per Read — automatically, for every session
```

After `cork-ai hooks install`, this is **global** — active for every Claude Code session in every project on your machine. No per-project configuration. No code changes.

---

## Quickstart — `cork-ai init`

If you have code that calls the Anthropic API directly (not just Claude Code), run:

```bash
cd your-project
cork-ai init
```

cork-ai scans for files that instantiate `new Anthropic()` and either:

- **Auto-patches** the file (adds `wrapClient` import + wraps the client) — when exactly one file is found
- **Generates** a ready-to-import `cork-ai-client.ts` wrapper — when no existing client is found
- **Shows targeted instructions** — when multiple files are found

That's it. No config file, no manual edits. Run `cork-ai gain` after your first session.

---

## CLI — `cork-ai gain`

After sessions run, check your savings from anywhere:

```
$ cork-ai gain

cork-ai — Last Session
────────────────────────────────────────────────────────────
  Date         May 26, 6:42 PM
  Requests     34

  Tokens in    45,200
  Tokens out   14,800
  Saved        30,400 tokens

  Savings      [████████████████████░░░░░░░░░░] 67.3%
  Cost saved   $0.0912 USD

  By module:
    toolResultCompressor       18,200 tokens  (40.3%)
    codeDedup                   5,400 tokens  (11.9%)
    headerStripper              2,800 tokens   (6.2%)
    heatmap                     2,900 tokens   (6.4%)
    semanticDedup               1,100 tokens   (2.4%)
────────────────────────────────────────────────────────────
  All-time total saved: 284,000 tokens — $0.852 USD
```

```bash
cork-ai gain              # last session
cork-ai gain --all        # all-time totals
cork-ai gain --history    # all recorded sessions in a table
cork-ai reset             # reset stats
```

Stats are stored in `~/.cork-ai/stats.json` and updated automatically when your process exits.

---

## Using the library

### Option A — Wrap your Anthropic client (recommended)

One line to add cork-ai to any project. The API is identical — no other changes needed.

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { wrapClient } from 'cork-ai'

const client = wrapClient(new Anthropic(), {
  maxContextTokens: 150_000,
})

// Use it exactly like the normal Anthropic client
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  messages: conversationHistory,
})

// Stats are saved automatically on process exit → visible with `cork-ai gain`
```

### Option B — Compress manually

```typescript
import { CtxForge } from 'cork-ai'

const forge = new CtxForge({ maxContextTokens: 150_000 })

// Compress before sending
const { messages, stats } = forge.compress(conversationHistory)

// Then send to the API yourself
await anthropic.messages.create({ model: '...', max_tokens: 4096, messages })

console.log(`${stats.request.savingsPercent}% saved this request`)
```

---

## Setting up across projects (global usage)

cork-ai is a library — it needs to be called from code. The most practical setup for using it globally across all your projects is to put the wrapped client in a shared location.

**Option 1 — Global npm package with a shared wrapper**

Create a shared file (e.g. `~/scripts/claude-client.ts`) and import it from your projects:

```typescript
// ~/scripts/claude-client.ts
import Anthropic from '@anthropic-ai/sdk'
import { wrapClient } from 'cork-ai'

export const claude = wrapClient(new Anthropic(), {
  maxContextTokens: 150_000,
  aggressiveness: 0.6,
  onStats: (stats) => {
    if (stats.request.savingsPercent > 5) {
      process.stderr.write(`[cork-ai] ${stats.request.savingsPercent}% saved\n`)
    }
  },
})
```

**Option 2 — Per-project (2 lines)**

If you have an existing `claude.ts` or `ai.ts` in each project, add the wrap there. It's two lines and `cork-ai gain` still aggregates stats globally.

**Why cork-ai is a library (not a CLI proxy like RTK)**

RTK intercepts bash commands at the shell level — it doesn't need to understand your code. cork-ai compresses JavaScript/TypeScript message arrays, which requires integration at the code level where API calls happen. The upside: cork-ai can be much smarter about what it compresses. The tradeoff: it needs to be imported. Once imported, `cork-ai gain` works globally for all stats.

---

## Session cache — carry context across sessions

```typescript
import { SessionCache } from 'cork-ai'

const cache = new SessionCache()

// At startup: inject the previous session's context
const previousContext = cache.load(process.cwd())
if (previousContext) {
  systemPrompt += '\n\n' + previousContext
}

// At the end: save this session
process.on('exit', () => {
  cache.save(conversationHistory, process.cwd())
})
```

cork-ai extracts a compressed snapshot of your project (decisions made, errors + solutions, file signatures, code conventions) and saves it to `.cork-ai/cache/[project-hash].json`. The next session starts with full context in ~4,000 tokens instead of ~40,000.

---

## Adaptive compression levels

cork-ai checks the token count before each request and decides what to run:

```
Token usage          Level         What runs
──────────────────────────────────────────────────────────────
< 40% of budget   → Passthrough   Nothing. Session is small.
40–65%            → Level 1       Tool results + Headers
65–80%            → Level 2       + Code dedup + Heatmap
> 80%             → Level 3       + Semantic dedup + Summarizer
```

On a short session, cork-ai is completely transparent. It gets out of the way.

---

## All options

```typescript
wrapClient(client, {
  // How hard to compress (0 = very conservative, 1 = aggressive)
  // Default: 0.6
  aggressiveness: 0.6,

  // Context window size in tokens. Compression kicks in above 40% of this.
  // Default: 150,000
  maxContextTokens: 150_000,

  budget: {
    maxTokens: 150_000,
    // If true: throw if context still exceeds budget after full compression
    hardLimit: false,
  },

  // Pricing used to estimate cost savings (USD / 1M tokens)
  // Default: Claude Sonnet 4 pricing
  pricing: { input: 3.0, output: 15.0 },

  // Print compression logs to stdout
  debug: false,

  // Called after every request with full stats
  onStats: (stats) => { ... },

  // Turn off specific modules
  disabledModules: ['semanticDedup', 'selectiveSummarizer'],
})
```

---

## Dynamic system prompt (optional)

If your system prompt contains instructions for Python, Docker, SQL, etc., and you're not always working on all of them, cork-ai can inject only what's relevant:

```typescript
const systemPrompt = `
Core instructions — always included.

<!-- @cork-ai section: python -->
When working on Python: use type hints, pytest, list comprehensions.
<!-- @cork-ai end -->

<!-- @cork-ai section: typescript triggers: typescript, ts, tsx -->
When working on TypeScript: strict types, no any, .js imports.
<!-- @cork-ai end -->
`

import { DynamicSystemPrompt } from 'cork-ai'
const dsp = new DynamicSystemPrompt()
// Only includes sections relevant to the recent conversation
const optimized = dsp.build(systemPrompt, recentMessages)
```

---

## Works alongside RTK

If you already use RTK for global summarization, cork-ai adds the layers RTK doesn't cover:

```
RTK     → summarizes entire old exchanges into a compact block
cork-ai → compresses tool results, headers, code, history scoring
────────────────────────────────────────────────────────────────
Together → 65–75% total reduction on long sessions
```

They don't conflict. Use both.

---

## Compatibility

- **Node.js** 18, 20, 22
- **Linux** (Ubuntu 20.04+, Debian, Alpine), **macOS** (Intel + Apple Silicon), **Windows** (native + WSL2)
- **Zero native dependencies** — no compiled binaries, no ML, no external services
- **Peer dependency**: `@anthropic-ai/sdk ≥0.20.0` — optional, only needed for `wrapClient()`

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © 2026 Mathys Thery
