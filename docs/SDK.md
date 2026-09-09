# cork-ai SDK middleware (deprecated)

> **Status: deprecated, kept in the repository, not published.** Since 0.8.0 the `cork-ai` package is the Claude Code tool only. The conversation-compression library below (`wrapClient`, `CtxForge`, the seven strategies) still lives in `src/sdk/` with its tests, and builds with `npm run build:sdk`, but it is no longer exported from the npm package and no longer maintained as a product. If you rely on it, pin `cork-ai@0.7.0` or say so in an issue — it can move to its own package if there is demand.
>
> **Timeline.** Deprecated 2026-08 (0.8.0). Its tests still run in CI behind `npm run test:sdk`, not in the default `npm test`, since 1.0.0-rc.1 (2026-09). The `src/sdk/` directory and its tests will be removed from the repository in **1.1.0**, unless an issue asks for it to be published separately before then.
>
> Why: measured on two months of real Claude Code history, the whole-file-read compression this library was built around moves about 1% of the bill; the context-size governance the tool now focuses on moves 50%+. The "60–75% token reduction" figures below were measured on synthetic conversations with the library API and never applied to the Claude Code hook.

## The seven strategies

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

## cork-ai vs Anthropic's native context features

The Anthropic API now ships server-side context management. cork-ai is designed to complement it, not compete with it — here is when to use what:

| Need | Use | Why |
|---|---|---|
| Long conversations approaching the context window | **Native compaction** (`compact-2026-01-12` beta) | Server-side, model-aware summarization — better quality than any client-side heuristic |
| Clearing stale tool results in agent loops | **Native context editing** (`clear_tool_uses_20250919`) | Server-side pruning, no client logic |
| Re-sent history costing full price every turn | **Prompt caching** (`cache_control`) | Cache reads cost 0.1× — the single biggest cost lever |
| Shrinking content **before it ever enters the context** (file reads, tool outputs) | **cork-ai** | The API can only manage tokens you already sent — cork-ai stops them from being sent at all |
| Measuring what compression actually saves | **cork-ai** | Ground-truth accounting from `response.usage`, per model, per session |

Two rules cork-ai follows to stay compatible with prompt caching:

1. **Prefix stability** (default in `wrapClient`): compression decisions on old messages are frozen byte-identical across requests. Rewriting the prefix on every turn would invalidate the prompt cache and cost up to 8× more than not compressing at all.
2. **Cache-aware accounting**: savings on already-frozen content are valued at the cache-read rate (0.1×), not the full input rate — no inflated numbers.

---

## Library API

If you're building your own application that calls the Anthropic API, you can use cork-ai as a library to compress your conversation history automatically.

Build from source:

```bash
git clone https://github.com/mqthys62/cork-ai.git
cd cork-ai && npm install && npm run build:sdk    # → dist/sdk/index.{js,mjs,d.ts}
```

Then import from `./dist/sdk`:

### Option A — Wrap your Anthropic client (recommended)

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { wrapClient } from './dist/sdk/index.js'

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

// Ground truth from the API, not estimates:
client.getMeasuredUsage()     // real input/output/cache tokens + real cost (USD)
client.getRateLimitStatus()   // parsed anthropic-ratelimit-* headers
```

Options worth knowing:

```typescript
wrapClient(new Anthropic(), {
  // Prefix-stable compression (default: true). Freezes compression decisions
  // on old messages so the Anthropic prompt cache prefix stays byte-identical
  // across requests. Disable only if you don't use prompt caching.
  prefixStable: true,

  // Delay (never degrade) requests when rate-limit quota runs low,
  // instead of eating a 429.
  softThrottle: { enabled: true, thresholdPct: 0.1, maxDelayMs: 5_000 },
})
```

### Option B — Compress manually

```typescript
import { CtxForge } from './dist/sdk/index.js'

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

> **Note**: This adaptive logic only applies to the library API. The Claude Code hook has
> its own, different gate: it reads the live context size from the transcript and compresses a
> file only when the expected saving beats the expected cost of a re-read
> (see [METHODOLOGY.md §2](METHODOLOGY.md)).

### Session cache — carry context across sessions

```typescript
import { SessionCache } from './dist/sdk/index.js'

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

import { DynamicSystemPrompt } from './dist/sdk/index.js'
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

