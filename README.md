# cork-ai

[![CI](https://github.com/mqthys62/cork-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mqthys62/cork-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Cut your Claude Code token usage by **60–75%** on long sessions — without changing how you code.

**Translations:** [Français](docs/README.fr.md) · [Español](docs/README.es.md)

---

## What is cork-ai?

Every time Claude Code makes an API call, it sends the **entire conversation history** — including every file it has read, every bash output, every repeated header. On a 2-hour session, that's easily **100,000+ tokens per request**, most of it redundant.

cork-ai hooks into Claude Code and does two things. It keeps whole-file reads out of the context when that pays off, and — the part that moves the bill — it shows you what your context size costs and helps you keep it in check. **Your workflow doesn't change. The results don't change. The bill does.**

```
Claude Code reads a file — `Read` tool, or `cat file` through Bash (auto mode)
        ↓
cork-ai hook intercepts (PreToolUse Read / Bash)
        ↓
Worth it? (expected-value gate: file size × context size × learned re-read rate)
        ↓
Claude gets a numbered outline (L12 export function …) instead of the whole file,
and reads the exact region it needs with offset/limit or sed -n
        ↓
Meanwhile the context guard tells you when the context crosses 150k / 300k / 500k tokens
and what every further tool call costs — /compact or /autocompact fixes that
```

> **Where the money really goes.** On a real 2-month history (16k turns, $4.3k), **78% of the spend was cache reads of the conversation prefix** — the whole context re-sent on every tool call, 400k tokens on average, on sessions that ran to the 1M window. Replayed with auto-compaction at 200k, the same work costs **57% less**. Read compression moves ~1%. `cork-ai context` shows this for your own history; `cork-ai context --set-autocompact 200k` applies the fix.

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

### After a `claude update`

Claude Code updates don't touch `~/.claude/settings.json`, so the hooks survive. What *does* change is how the model reads files: since auto mode, Claude reads through Bash (`cat`, `sed -n`) rather than the `Read` tool, which is why installs older than 0.7.0 went silent. If `cork-ai gain` looks stale:

```bash
cork-ai doctor          # binary, hooks, self-test, and which recent sessions produced events
cork-ai hooks install   # adds any hook an older install lacks
```

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

Registers cork-ai's hooks globally in `~/.claude/settings.json`. Active for every session on every project with no per-project setup. Re-run it after upgrading: it adds the hooks an older install lacks and re-targets the binary path.

```bash
cork-ai hooks install   # enable / upgrade
cork-ai hooks status    # which of the 5 hooks are active
cork-ai hooks remove    # disable
```

| Hook | What it does |
|------|--------------|
| `PreToolUse` **Read** | Whole-file reads get a numbered outline when the expected-value gate says it pays off |
| `PreToolUse` **Bash** | Same for `cat file`, `nl`, `bat`, `rtk proxy cat` — Claude Code's auto mode reads through Bash, not `Read`. Targeted reads (`sed -n`, `head`, `tail`) always pass, and `sed -i` / redirections mark the file as being edited |
| `PostToolUse` **Edit / Write** | Failed edits on outlined files, edited-file tracking, context guard |
| `UserPromptSubmit`, `Stop` | Context guard notices |

The hook never compresses at the model's expense. The guardrails, all measured on real transcripts:

- **An expected-value gate decides per read** — `saved tokens × amplification × cache-read price` against `P(re-read) × (dead outline + one extra turn over the current context + output)`. Small files, huge contexts and extensions that keep backfiring are served raw. `P(re-read)` is learned per extension on your machine (`~/.cork-ai/policy.json`); an extension above 35% re-reads goes on probation and is probed one read in ten.
- **The outline is navigable** — every entry carries its line number (`L127  export async function fetchAll(...)`), so the follow-up is `Read offset=127 limit=40` or `sed -n '127,166p'`, not a full re-read.
- **Explicit `offset`/`limit` reads are never compressed** — the model is targeting a precise zone.
- **Re-reads are served raw** — a file re-read after an outline gets the full content, is remembered across sessions (`skip-list.json`), and its cost — the raw tokens *and* the extra API turn — is deducted in `cork-ai gain`.
- **Files being edited are served raw** — 59% of outlined files were edited afterwards (97% of `.tsx`); an `Edit`, `Write`, `sed -i` or redirection on a file switches it to raw for the session.
- **The file the user is asking about is never compressed** — if your last message mentions `interceptor.ts`, its read passes through untouched.
- **Failed edits are detected** — an `Edit` that fails on a file only seen outlined whitelists the file and reports the harm.

### `cork-ai context`

Where the money goes, from Claude Code's own transcripts: per session, the average and maximum context, the cost per turn, the share of cache reads, and what the same turns would have cost with auto-compaction at 150k / 200k / 300k.

```bash
cork-ai context                        # last 30 days
cork-ai context --days 90 --ceiling 150k
cork-ai context --set-autocompact 200k # writes autoCompactWindow to ~/.claude/settings.json
cork-ai context guard off              # silence the live notices (on by default)
```

The **context guard** fires once per band (150k / 300k / 500k / 750k tokens) per session: a notice to you with the per-call cost and the compacted alternative, and a short nudge to the model (batch commands, read ranges, suggest `/compact` at the next stopping point). It never blocks anything.

### `cork-ai doctor`

Is cork-ai actually being called? Checks the binary, the five hooks, runs the hook on a synthetic payload, reads the heartbeat left by the last real event (Claude Code version, permission mode), and compares the last 14 days of Claude Code sessions with the sessions cork-ai saw — with the Read vs Bash-read split that explains any gap. Run it after `claude update` or whenever `cork-ai gain` looks stale.

```bash
cork-ai doctor
```

### `cork-ai statusline`

A status-line segment: context size, cache-read cost of the next call, session cost, and a `/compact?` hint past 150k. Reads Claude Code's status JSON on stdin, so it plugs into an existing script:

```json
{ "statusLine": { "type": "command", "command": "cork-ai statusline" } }
```

### `cork-ai calibrate`

Token counts and cost estimates are only as good as the tokenizer behind them. `calibrate` measures the **real** Claude token factors for your model via the free `count_tokens` API endpoint (code + English + French samples) and stores them in `~/.cork-ai/calibration.json` — every count in the library and the hook becomes model-exact:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cork-ai calibrate                    # uses the auto-detected model
cork-ai calibrate claude-sonnet-5    # or a specific one
```

Not using the API key path? `wrapClient` also **calibrates passively**: on every response it compares its local estimate to the real prompt tokens billed by the API and corrects the estimator automatically.

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
cork-ai gain --all        # all-time totals, real spend, context block, hook liveness
cork-ai gain --history    # all recorded sessions
```

`gain --all` reads Claude Code's transcripts for the **real spend** (every turn's `usage`, subagents included), keeps a durable per-session copy in `~/.cork-ai/spend-cache.json` so the history survives Claude Code's 30-day transcript cleanup, and values savings over their life in context. The net deducts both re-read penalties: the raw tokens re-sent, and the real cost of the extra turns that only existed to re-read an outlined file.

### `cork-ai models`

Per-model usage and cost breakdown. The hook detects the active Claude model
from the session transcript on every compressed Read, so savings are priced at
the actual model rate ($1/MTok Haiku up to $10/MTok Fable 5) instead of a flat
Sonnet fallback:

```
cork-ai — Model Usage & Costs
──────────────────────────────────────────
  Active model  claude-fable-5  ($10.00/M input tokens)

  claude-fable-5    $10.00/MTok
    ████████████░░░  78.3%  312 requests
    Saved 2.1M tokens → $21.40 USD   Last used Jul 2, 06:56 PM

  claude-sonnet-5   $3.00/MTok
    ███░░░░░░░░░░░░  21.7%  86 requests
    Saved 480k tokens → $1.44 USD    Last used Jun 28, 11:02 AM
```

### `cork-ai report`

Enterprise-grade analytics:

```bash
cork-ai report --daily      # daily savings trend
cork-ai report --weekly     # weekly breakdown
cork-ai report --monthly    # monthly breakdown
cork-ai report --projects   # per-project breakdown, sorted by savings
cork-ai report --models     # per-model usage & cost breakdown
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
