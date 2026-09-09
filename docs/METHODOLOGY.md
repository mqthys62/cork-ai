# Methodology — how cork-ai counts

Every number cork-ai prints is an estimate built from two sources: what the hook
saw (the file it served, raw or outlined) and what Claude Code wrote in its own
transcripts (the `usage` block of every assistant turn). This page says exactly
how the two are combined, what the measured figures in the README come from,
and where the estimate is weakest.

## 1. The three savings figures

`cork-ai gain --all` prints three lines that are easy to confuse.

**First pass only.** The tokens cork-ai kept out of the context, valued once at
the model's input price. This is the figure a naive tool would report. It is
the smallest of the three and it is *not* what you saved.

**Lifetime in context.** Claude Code re-sends the whole conversation on every
tool call. A file that entered the context on turn 40 is paid as a cache read
on every one of the following turns. So a token kept out of the context is
worth one cache write plus *amplification* cache reads:

```
lifetime_value(tokens) = tokens × (cacheWrite5m + amplification × cacheRead)
```

**Amplification** is measured per session from the transcript: the ratio of
cache-read tokens to cache-write tokens over the session's assistant turns
(subagent transcripts excluded, duplicate message ids deduplicated). `gain`
prints the median across measured sessions, and a session with no transcript
gets amplification 0, which collapses the value to the cache-write tier: close
to the first-pass figure, never inflated. Sessions where Claude Code already
purged the transcript (30-day cleanup) therefore count *less*, not more.

**Net.** Lifetime minus two penalties:

- *Re-read penalty.* When the model re-reads a file cork-ai had outlined, the
  raw content goes into the context after all, and it is re-billed on every
  subsequent turn. The penalty is the raw tokens served on re-read, valued at
  the same lifetime rate as the savings. Valuing savings at lifetime and
  re-reads at 1× would bias the net in cork-ai's favour, so both use the same
  formula.
- *Re-read extra turns.* The assistant turn that issued the re-read exists only
  because of the compression. It is billed at its real, transcript-recorded
  cost (prompt cache reads + output), found by locating in the transcript the
  turns whose only tool call re-reads a file that had received a compressed
  view (`sessionReReadTurns`).

## 2. The expected-value gate

Compressing everything above a size threshold was a net loss on real
transcripts (2026-07 → 2026-09: 72–81 % of compressed reads were followed by a
full re-read, 42 % of them immediately). Since 0.7 every candidate goes through
a gate:

```
gain  = saved × amplification × cacheRead
loss  = p(re-read) × (compressed × amplification × cacheRead
                      + context × cacheRead
                      + 300 × output)
compress ⇔ saved ≥ minSaved ∧ not on probation ∧ gain − loss > 0
```

- `saved` is raw tokens minus compressed tokens; `minSaved` is 1 500 for the
  main conversation and editing agents, 800 for read-only agents (Explore,
  Plan) and for the re-read cache.
- `context` is the prompt size of the last main-thread turn, read from the
  tail of the transcript, so the same file is compressed at 50k context and
  served raw at 900k, where one extra turn costs more than the file.
- `p(re-read)` is a Beta posterior per key: prior 0.5 weighted like 4
  observations (0.3 for the re-read cache), updated with this machine's own
  compressions and re-reads. Keys are `.ts` (main + editing agents), `ro:.ts`
  (read-only agents) and `cache:.ts` (re-read cache).
- *Probation*: a key with ≥ 10 samples and p > 0.35 is served raw, with one
  read in ten still compressed so the estimate can recover.

## 3. The replay at 200k

The README's headline figures (78 % of spend in cache reads, −57 % with
auto-compaction at 200k) come from `cork-ai context`, which replays each
main-thread transcript under a lower `autoCompactWindow`:

- Turns are identical: same output tokens, same model, same date-resolved
  pricing.
- The context grows by whatever the real turn added (cache writes + fresh
  input).
- Whenever it crosses the ceiling, one compaction is paid: a cache read of
  the whole context plus 4 000 output tokens for the summary, and the context
  drops to a 25 000-token residual (summary + system prompt).

The replay isolates the cost of *carrying* the context. It does not model
quality loss from compaction, nor the work the model may redo after it. The
25k/4k constants are deliberately generous (a large residual, a long summary)
so the replay under-states rather than over-states the saving.

## 4. Measured figures quoted in the README

All from one developer's real history (2026-07 → 2026-09, Claude Code 2.1.x,
Opus 5 / Fable 5.1 on the 1M window), `gain --all` and `context --days 60`:

| Figure | Where it comes from |
|---|---|
| 16k turns, $4.3k | sum of transcript `usage` at date-resolved pricing |
| 78 % cache reads | cache-read cost / total cost, sessions ≥ 20 turns |
| 407k average context | mean prompt size per assistant turn |
| −57 % at 200k | replay of §3 over the same sessions |
| ~1 % from read compression | net savings / total spend |
| 39 % re-read rate before the EV gate | compressed reads followed by a full re-read, before the gate shipped in 0.7 |
| 18 % of whole-file reads are re-reads of an unchanged file, ~5k tokens/session | `sessionReReadTurns` on raw reads; the basis of the 1.0 re-read cache |

Community figures (`docs/stats.json`, the README badges) are PostHog
aggregates of the daily `savings_snapshot` event; what is and is not sent is in
[TELEMETRY.md](TELEMETRY.md).

## 5. Token estimation

The hook has ~50 ms to decide, so it never loads a tokenizer. Tokens are
estimated from characters (3.5 chars/token by default) with a per-model
calibration factor learned by `cork-ai calibrate`, which compares the local
estimate with the API's real prompt token count. Transcript figures (`usage`)
are exact and need no estimate: everything in §1 that is called *spend* or
*amplification* is exact; everything called *saved* is an estimate.

## 6. What the hook reads from Claude Code

cork-ai is tested against Claude Code **2.1.47 → 2.1.263** (`doctor` warns
outside that range, using the `version` stamped on each transcript line).
Windows without Git Bash needs ≥ 2.1.139 (exec-form hooks).

Events: `PreToolUse` (Read, Bash, PowerShell), `PostToolUse` and
`PostToolUseFailure` (Edit, MultiEdit, Write — the latter only on Claude Code
≥ 2.1.119, where it is documented; `PostToolUse` fires on success only),
`UserPromptSubmit`, `Stop`, `SessionEnd`.

Payload fields used, and nothing else:

| Field | Use |
|---|---|
| `session_id` | per-session state file (`reads-<id>.json`), heartbeat, digest |
| `transcript_path` | live context size, compaction detection, Claude Code version |
| `cwd` | resolving relative paths; `project` in the local digest only |
| `hook_event_name`, `tool_name`, `tool_input` | the decision itself |
| `error` (PostToolUseFailure) | failed-edit detection after an outline |
| `permission_mode` | heartbeat / `doctor` (auto mode moves reads to Bash) |
| `agent_type`, `agent_id` | agent class (main / readonly / editing), per-agent read state |
| `model` | pricing tier |
| `prompt` (UserPromptSubmit) | a file named in the prompt is never compressed |

None of these leave the machine. Telemetry, when enabled, sends counts,
buckets and durations only — see [TELEMETRY.md](TELEMETRY.md).

## 7. Known limits

- **Transcripts are purged after 30 days** by Claude Code. `spend-cache.json`
  keeps a per-session copy of the spend, but amplification and re-read turns
  for sessions older than that are gone; they count at the cache-write tier.
- **Sessions without a transcript** (killed before the first assistant turn,
  custom `CLAUDE_CONFIG_DIR`) are valued at first pass.
- **Saved tokens are estimated**, spend is exact; a calibration off by 10 %
  moves the savings figures by 10 % and the spend figures by 0.
- **The replay does not price quality**: a compaction that makes the model
  redo work is not charged.
- **Bash reads** are recognised by pattern (`cat`, `head`, `tail`, `sed -n`,
  `Get-Content`, …); a read hidden behind a script or a pipe cork-ai does not
  parse is invisible to both the savings and the re-read counts.
