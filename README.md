# cork-ai

[![CI](https://github.com/mqthys62/cork-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mqthys62/cork-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Cut your Claude Code token usage by **60–75%** on long sessions — without changing how you code.

**Translations:** [Français](docs/README.fr.md) · [Español](docs/README.es.md)

---

## What is cork-ai?

Every time Claude Code makes an API call, it sends the **entire conversation history** — including every file it has read, every bash output, every repeated header. On a 2-hour session, that's easily **100,000+ tokens per request**, most of it redundant.

cork-ai sits between Claude Code and the Anthropic API. It compresses what's redundant before each call. **Your workflow doesn't change. The results don't change. The bill does.**

```
Claude Code reads a file
        ↓
cork-ai hook intercepts (PreToolUse Read)
        ↓
Compresses: extracts signatures, truncates boilerplate
        ↓
Claude receives the compressed digest instead of the full file
        ↓
60–90% fewer tokens per Read — automatically, every session
```

---

## Installation

**No Node.js, no npm.** cork-ai is a standalone binary.

### macOS / Linux / WSL2

```bash
curl -fsSL https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.sh | sh
```

Downloads the right binary for your OS + architecture, puts it in `~/.local/bin`, and runs `cork-ai hooks install`.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.ps1 | iex
```

### Manual download

Go to [Releases](https://github.com/mqthys62/cork-ai/releases/latest) and download the binary for your platform:

| Platform | File |
|----------|------|
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

That's it. Restart Claude Code — compression is active for every session on every project.

---

## How it works — 7 compression strategies

cork-ai applies independent compression layers, each targeting a different source of token waste:

| # | What's wasted | How cork-ai fixes it | Savings |
|---|--------------|---------------------|---------|
| 1 | **File reads** — every `Read` tool call sends the full file, every time | Extracts code signatures, truncates bash output, flattens JSON | **30–50%** |
| 2 | **Repetitive headers** — Claude Code injects CWD, OS, open files on every message | Keeps the first one, replaces the rest with a short diff | **5–10%** |
| 3 | **Duplicate code** — code just written to disk gets re-sent in conversation history | Replaces with `[code written to src/foo.ts — omitted]` | **10–20%** |
| 4 | **Irrelevant history** — old CSS discussion when debugging SQL | Scores relevance, summarizes low-score messages to one line | **15–25%** |
| 5 | **Repeated concepts** — same idea expressed 5 different ways | TF-IDF + Jaccard similarity, replaces near-duplicates with a back-reference | **10–15%** |
| 6 | **Bloated old messages** — exploration text that could be 10% its size | Summarizes while preserving file paths, error messages, and decisions verbatim | **20–30%** |
| 7 | **Cold start** — next session re-discovers the whole project from scratch | Saves a compressed project snapshot, loads it at session start | **40–60%** next session |

---

## Measured results

| Session length | Without cork-ai | With cork-ai | Reduction |
|---------------|----------------|-------------|-----------|
| Short (< 30 min) | ~15,000 tokens | ~12,000 | ~20% |
| Medium (1h) | ~60,000 tokens | ~22,000 | **~63%** |
| Long (2h+) | ~140,000 tokens | ~38,000 | **~73%** |
| Next session (same project) | ~50,000 tokens | ~18,000 | **~64%** |

Combined with [RTK](https://github.com/rtk-ai/rtk): realistic **75–85% total reduction** on long sessions.

---

## CLI

### `cork-ai hooks install`

Registers cork-ai as a Claude Code hook globally in `~/.claude/settings.json`. Active for every session on every project with no per-project setup.

```bash
cork-ai hooks install   # enable
cork-ai hooks status    # check if active
cork-ai hooks remove    # disable
```

### `cork-ai init`

If you have code that calls the Anthropic API directly, run this in your project:

```bash
cd your-project
cork-ai init
```

cork-ai scans for `new Anthropic()` and either:
- **Auto-patches** the file — adds `wrapClient` import and wraps the client in-place
- **Generates** a ready-to-import `cork-ai-client.ts` — when no existing client is found
- **Shows targeted instructions** — when multiple files are found

### `cork-ai gain`

Check your savings after any session:

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
cork-ai gain --history    # all recorded sessions
```

### `cork-ai report`

Enterprise-grade analytics:

```bash
cork-ai report --daily      # daily savings trend
cork-ai report --weekly     # weekly breakdown
cork-ai report --monthly    # monthly breakdown
cork-ai report --projects   # per-project breakdown, sorted by savings
cork-ai report --forecast   # annual projection + ROI vs. setup time
cork-ai report --json       # machine-readable output for dashboards / CI
```

---

## Works alongside RTK

[RTK](https://github.com/rtk-ai/rtk) and cork-ai cover completely different layers — they are designed to be used together.

```
What RTK compresses (Bash tool calls):
  git status, git diff, cargo test, npm test, docker ps, grep, ls …
  → 60–90% savings on shell command outputs

What cork-ai compresses (Claude Code built-in tools + conversation):
  Read → file contents compressed to signatures
  Conversation history → headers deduped, code deduped, old messages summarized
  → 40–90% savings on file reads, 20–60% on conversation history

─────────────────────────────────────────────────────────────────
Together → 75–85% total token reduction on long sessions
```

RTK's own README notes: *"Claude Code built-in tools like Read, Grep, and Glob do not pass through the Bash hook."* cork-ai is the answer to that exact limitation.

```bash
# RTK — Bash command compression
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
rtk init -g

# cork-ai — Read tool + conversation compression
curl -fsSL https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.sh | sh
```

---

## Library API (for developers building AI apps)

If you're building your own application that calls the Anthropic API, you can use cork-ai as a library to compress your conversation history automatically.

Build from source:

```bash
git clone https://github.com/mqthys62/cork-ai.git
cd cork-ai && npm install && npm run build
```

Then import from `./dist`:

### Option A — Wrap your Anthropic client (recommended)

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { wrapClient } from './dist/index.js'

const client = wrapClient(new Anthropic(), {
  maxContextTokens: 150_000,
  aggressiveness: 0.6,
  onStats: (stats) => {
    if (stats.request.savingsPercent > 5) {
      process.stderr.write(`[cork-ai] ${stats.request.savingsPercent}% saved\n`)
    }
  },
})

// Identical interface to the raw Anthropic client — no other changes needed
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  messages: conversationHistory,
})
```

### Option B — Compress manually

```typescript
import { CtxForge } from './dist/index.js'

const forge = new CtxForge({ maxContextTokens: 150_000 })

// Compress before sending
const { messages, stats } = forge.compress(conversationHistory)

await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 4096, messages })
console.log(`${stats.request.savingsPercent}% saved this request`)
```

### Adaptive compression levels (library API only)

When using `wrapClient()` or `CtxForge`, cork-ai counts tokens in your `messages[]` array and decides how aggressively to compress based on how full the context window is. You control the budget via `maxContextTokens`.

```
Token usage vs. maxContextTokens    Level    What runs
──────────────────────────────────────────────────────────────────────
< 40%   → Passthrough   Nothing — context is small, no overhead.
40–65%  → Level 1       Tool results + Headers
65–80%  → Level 2       + Code dedup + Heatmap
> 80%   → Level 3       + Semantic dedup + Summarizer
```

Tune `maxContextTokens` to match your actual context window and when you want compression to kick in:

```typescript
// Start compressing earlier — e.g. on Claude's 200k window,
// this kicks in at 20k tokens instead of 80k
wrapClient(client, { maxContextTokens: 50_000 })
```

> **Note**: This adaptive logic only applies to the library API. The Claude Code hook
> compresses **every** file read unconditionally — it doesn't know the conversation size,
> and that's intentional: every token saved on a Read is a token saved regardless of
> where you are in the session.

### Session cache — carry context across sessions

```typescript
import { SessionCache } from './dist/index.js'

const cache = new SessionCache()

// At startup: inject the previous session's context (~4,000 tokens instead of ~40,000)
const previousContext = cache.load(process.cwd())
if (previousContext) systemPrompt += '\n\n' + previousContext

// At the end: save this session
process.on('exit', () => cache.save(conversationHistory, process.cwd()))
```

### Dynamic system prompt (optional)

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

import { DynamicSystemPrompt } from './dist/index.js'
const dsp = new DynamicSystemPrompt()
const optimized = dsp.build(systemPrompt, recentMessages)
```

### All options

```typescript
wrapClient(client, {
  aggressiveness: 0.6,        // 0 = conservative, 1 = aggressive (default: 0.6)
  maxContextTokens: 150_000,  // token budget — compression kicks in above 40% of this
  budget: {
    maxTokens: 150_000,
    hardLimit: false,          // throw if context still exceeds budget after full compression
  },
  pricing: {
    input: 3.0,               // USD / 1M tokens (default: Claude Sonnet 4)
    output: 15.0,
  },
  debug: false,
  onStats: (stats) => { ... },
  disabledModules: ['semanticDedup', 'selectiveSummarizer'],
})
```

---

## Compatibility

- **OS**: Linux (Ubuntu 20.04+, Debian, Alpine), macOS (Intel + Apple Silicon), Windows (native + WSL2)
- **Zero runtime dependencies** — standalone binary, no Node.js or npm required
- **Library API**: requires Node.js ≥ 18 and `@anthropic-ai/sdk ≥ 0.20.0`

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © 2026 mqthys62
