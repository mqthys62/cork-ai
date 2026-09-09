# cork-ai

[![CI](https://github.com/mqthys62/cork-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/mqthys62/cork-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tokens kept out of context](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmqthys62%2Fcork-ai%2Fmain%2Fdocs%2Fbadges%2Ftokens-saved.json)](docs/stats.json)
[![Net saved](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmqthys62%2Fcork-ai%2Fmain%2Fdocs%2Fbadges%2Fusd-saved.json)](docs/stats.json)

> See what your Claude Code sessions really cost, and cut the part that matters — without changing how you code.

**Translations:** [Français](docs/README.fr.md) · [Español](docs/README.es.md)

---

## What is cork-ai?

Every time Claude Code makes an API call, it re-sends the **entire conversation** — every file read, every command output, every earlier turn. On the 1M-context models that is routinely 300–500k tokens per tool call, paid as cache reads on every single turn. That, not the files themselves, is the bill.

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

> **Where the money really goes.** On a real 2-month history (16k turns, $4.3k), **78% of the spend was cache reads of the conversation prefix** — the whole context re-sent on every tool call, 400k tokens on average, on sessions that ran to the 1M window. Replayed with auto-compaction at 200k, the same work costs **57% less**. Read compression moves ~1%. `cork-ai context` shows this for your own history; `cork-ai context --set-autocompact 200k` applies the fix. How every figure is computed, and where it is weakest: [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

<!-- cork-ai:stats -->
<!-- /cork-ai:stats -->

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

Needs Claude Code 2.1.139 or newer: on Windows the hooks are installed in exec form (`command` + `args`), the only form that works whether Claude Code runs hooks through Git Bash or PowerShell. `cork-ai doctor` says so if the version is too old.

### Release candidates

GitHub keeps `/releases/latest` clear of pre-releases, so the installers and `cork-ai update` follow stable releases unless told otherwise:

```bash
curl -fsSL https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.sh | CORK_AI_PRERELEASE=1 sh   # macOS / Linux / WSL2
$env:CORK_AI_PRERELEASE = 1; irm https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.ps1 | iex  # Windows
cork-ai update --pre      # already installed: switch to the pre channel and update (--stable to go back)
```

The choice is remembered (`config set channel pre|stable`). After `gain`, `context`, `doctor`, `hooks`, `report` or `models`, one line tells you when your channel has a newer version; a stable install that is up to date but could try a candidate gets a quieter invitation, at most once every three days.

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
cork-ai hooks install   # adds any hook an older install lacks, re-targets the binary path
```

---

## CLI

### `cork-ai hooks install`

Registers cork-ai's hooks globally in `~/.claude/settings.json`. Active for every session on every project with no per-project setup. Re-run it after upgrading: it adds the hooks an older install lacks and re-targets the binary path.

```bash
cork-ai hooks install   # enable / upgrade
cork-ai hooks status    # which of the 7 hooks are active
cork-ai hooks remove    # disable
```

| Hook | What it does |
|------|--------------|
| `PreToolUse` **Read** | Whole-file reads get a numbered outline when the expected-value gate says it pays off |
| `PreToolUse` **Bash / PowerShell** | Same for `cat file`, `nl`, `bat`, `rtk proxy cat`, and `Get-Content` / `gc` / `type` under PowerShell — Claude Code's auto mode reads through the shell, not `Read`. Targeted reads (`sed -n`, `head`, `tail`, `-TotalCount`) always pass, and `sed -i` / redirections mark the file as being edited |
| `PostToolUse` **Edit / Write** | Edited-file tracking, context guard |
| `PostToolUseFailure` **Edit / Write** | Failed edits on outlined files: the file is served raw for good (Claude Code ≥ 2.1.119) |
| `UserPromptSubmit`, `Stop` | Context guard notices |
| `SessionEnd` | Session digest (`~/.cork-ai/digests/`, shown by `cork-ai gain`) |

The hook never compresses at the model's expense. The guardrails, all measured on real transcripts:

- **An expected-value gate decides per read** — `saved tokens × amplification × cache-read price` against `P(re-read) × (dead outline + one extra turn over the current context + output)`. Small files, huge contexts and extensions that keep backfiring are served raw. `P(re-read)` is learned per extension on your machine (`~/.cork-ai/policy.json`); an extension above 35% re-reads goes on probation and is probed one read in ten.
- **The outline is navigable** — every entry carries its line number (`L127  export async function fetchAll(...)`), so the follow-up is `Read offset=127 limit=40` or `sed -n '127,166p'`, not a full re-read.
- **Explicit `offset`/`limit` reads are never compressed** — the model is targeting a precise zone.
- **A file already in context is not sent twice** — the *re-read cache*: a file served raw earlier in the session, unchanged since (mtime, size and a content hash agree) and not lost to a compaction, gets an 80-token reminder (`already read 12 turns ago, unchanged since (L1–L340): the full content is still in your context above`) instead of the file. Edited files, files named in your prompt, ranged reads and other agents' reads never hit the cache; one wrong call (the model re-reads anyway) switches the file back to raw for the session. Off with `cork-ai config set policy.reReadCache false`.
- **Read-only subagents get a lower bar** — Explore, Plan, claude-code-guide and statusline-setup never edit what they read and their context is discarded at the end, so they are outlined from 800 saved tokens instead of 1,500 and skip the edited-file rule; every other agent (general-purpose, forks, custom agents) keeps the main conversation's rules. Learned re-read rates are kept per agent class. Off with `cork-ai config set policy.readonlyAgentsAggressive false`.
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

Is cork-ai actually being called? Checks the binary, the seven hooks (and their form on Windows), the Claude Code version against the tested range, runs the hook on a synthetic payload, reads the heartbeat left by the last real event (Claude Code version, permission mode), and compares the last 14 days of Claude Code sessions with the sessions cork-ai saw — with the Read vs shell-read split that explains any gap. Run it after `claude update` or whenever `cork-ai gain` looks stale.

```bash
cork-ai doctor
CORK_AI_DEBUG=1 claude     # the hook logs swallowed errors and one line per event to ~/.cork-ai/debug.log
```

### `cork-ai statusline`

A status-line segment: context size, cache-read cost of the next call, session cost, and a `/compact?` hint past 150k. Reads Claude Code's status JSON on stdin, so it plugs into an existing script:

```json
{ "statusLine": { "type": "command", "command": "cork-ai statusline" } }
```

### `cork-ai update`, `config`, `reset`, `telemetry`

```bash
cork-ai update            # replace the standalone binary with the latest release (--check to only look, --pre for release candidates)
cork-ai config set updateCheck false  # no daily background check, no one-line update notice after commands
cork-ai config            # list settings in ~/.cork-ai/config.json · config set contextGuard.bands 150k,400k
cork-ai config set policy.reReadCache false            # disable the re-read cache
cork-ai config set policy.readonlyAgentsAggressive false  # Explore/Plan follow the main rules
cork-ai reset             # clear stats · --policy (learned re-read rates) · --skip-list · --all
cork-ai telemetry on      # anonymous usage events, opt-in — what is sent: docs/TELEMETRY.md
cork-ai telemetry preview # the exact daily payload, byte for byte, before you decide
```

### Share your numbers

Telemetry is **off by default**. Turned on, cork-ai sends anonymous events to [PostHog Cloud EU](https://eu.posthog.com) — never a path, a file name, a project name, a prompt or a line of code — plus one daily aggregate of what it saved you: tokens kept out of context, what they were worth, re-read rate, how much auto-compaction would save. Those aggregates are what the community numbers above and the Savings dashboard are built from, and what decides where the tool goes next. `cork-ai telemetry preview` prints the payload; [docs/TELEMETRY.md](docs/TELEMETRY.md) lists every event.

### `cork-ai calibrate`

Token counts and cost estimates are only as good as the tokenizer behind them. `calibrate` measures the **real** Claude token factors for your model via the free `count_tokens` API endpoint (code + English + French samples) and stores them in `~/.cork-ai/calibration.json` — every count the hook makes becomes model-exact:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cork-ai calibrate                    # uses the auto-detected model
cork-ai calibrate claude-sonnet-5    # or a specific one
```


### `cork-ai gain`

Check the session after any Claude Code run:

```
$ cork-ai gain --all

cork-ai — All-Time Stats
──────────────────────────────────────────────────────────────────
  Cost saved
    First pass only      $12.46 USD
    Lifetime in context  $94.63 USD
    Re-read penalty      -$48.47 USD (174 re-reads · 3.63M raw)
    Re-read extra turns  -$5.84 USD  (47 turns that only existed to re-read an outlined file, at their real cost)
    Net                  $40.32 USD

  Real spend (Claude Code transcripts · 15,822 assistant turns)
    Prompt             5,716,813,618 tokens (101.5k fresh · 5668.90M cache read · 47.81M cache write)
    Total              $4290.55 USD
    Estimated savings vs spend  0.9%

  Context (last 30 days · 22 sessions ≥ 20 turns)
    Cache reads          78.4% of spend — the context re-read on every turn, 407.8k tokens on average
    Auto-compact at 200k would have saved $2290.81 USD (−57.3%) → cork-ai context

  Hook
    Last event           1 min ago (Claude Code 2.1.263 · auto mode)
    Coverage (14 days)   8/8 sessions with cork-ai events
```

Yes, that is a real report, and yes, the honest line is *0.9%*: outlining reads is a small lever. The Context block is the large one.

```bash
cork-ai gain              # the last session cork-ai saw: its outlines (live or finished) and its SessionEnd digest
cork-ai gain --sessions   # the last 10 session digests: duration, turns, context, cost, saving at 200k (--json)
cork-ai gain --all        # all-time totals, real spend, context block, hook liveness
cork-ai gain --history    # all recorded sessions
```

Digests are written at `SessionEnd` and kept 30 days (`reset --digests` clears them).

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

## Works alongside RTK and Anthropic's native features

[RTK](https://github.com/rtk-ai/rtk) rewrites Bash commands to trim their outputs; cork-ai handles what RTK's own README says it cannot reach — the built-in `Read` tool — plus whole-file reads made *through* Bash, and the context-size governance that neither does. Anthropic's server-side compaction and context editing manage tokens you already sent; cork-ai stops tokens from being sent and tells you when the context has grown past what it costs to keep. They stack.

The conversation-compression library cork-ai started as (`wrapClient`, seven strategies) is deprecated and documented in [docs/SDK.md](docs/SDK.md).

---

## Compatibility

- **OS**: Linux x64 / arm64 on glibc (Ubuntu 20.04+, Debian, Fedora…; Alpine/musl binaries are not shipped yet), macOS (Intel + Apple Silicon), Windows (native + WSL2)
- **Zero runtime dependencies** — standalone binary, no Node.js or npm required
- **Claude Code**: tested from 2.1.47 to 2.1.263 (`doctor` warns outside the range); Windows without Git Bash needs ≥ 2.1.139

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © 2026 mqthys62
