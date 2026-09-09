# Telemetry

cork-ai's telemetry is **off by default, opt-in, and anonymous**. It exists so the tool can be improved from real usage — which files get outlined and re-read, how big contexts get, whether the guard helps — across more than one machine.

```bash
cork-ai telemetry status
cork-ai telemetry on
cork-ai telemetry off
```

`DO_NOT_TRACK=1` or `CORK_AI_TELEMETRY=0` in the environment disables it regardless of the setting.

## Where it goes

Events are sent to [PostHog Cloud EU](https://eu.posthog.com) (`https://eu.i.posthog.com/capture/`), hosted in the European Union. The project token embedded in the binary is a write-only key: it can record events, not read them. There is no cork-ai server.

Sending never delays a hook: the event is handed to a detached child process that makes one HTTPS request with a 4-second timeout and exits. Offline, the event is simply lost.

## Identity

The `distinct_id` is a random UUID generated on this machine when telemetry is first enabled (`installId` in `~/.cork-ai/config.json`). It is not derived from hardware, user name, hostname or anything else, and `cork-ai reset` never changes it. Delete the key from the config file to start over.

## What is sent

Every event carries `version`, `os`, `arch`, `runtime` (`bun-1` for the standalone binary, `node-22` from npm) and `claude_version` (Claude Code's, read from the transcript). Events emitted from inside a hook also carry `hook_ms`: how long the hook process had been running when it decided, process start included — the latency Claude Code waited for. Every event also refreshes the install's **person profile** in PostHog (`$set`: version, OS, arch, runtime, Claude Code version, telemetry and guard state, whether a Claude Code *managed settings* file exists (the file an IT team deploys — its presence only, never its content), autoCompactWindow, hooks installed, projects bucket over 30 days, lifetime sessions / saved tokens / net USD, median amplification, top model family, average context and saving at 200k over the last 30 days, time of the last snapshot; `$set_once`: first version, first seen).

`cork-ai telemetry preview` prints the daily snapshot payload byte for byte; `--json` for the raw body.

| Event | When | Properties |
|-------|------|------------|
| `install` | `cork-ai hooks install` | hooks added, hooks skipped for an old Claude Code, whether it was an upgrade, the `autoCompactWindow` value chosen (or null), `channel` (`sh` / `ps1` when an installer script ran it, else `manual`), `managed_settings` (boolean), `config_dir_custom` (whether `CLAUDE_CONFIG_DIR` is set) |
| `telemetry_toggled` | `telemetry on` / `off` (the *off* event is sent before the switch) | `enabled`, `at` (`install` when answered during `hooks install`) |
| `command` | any CLI command | command name and its first sub-command or flag, **both from a fixed allowlist** (`gain`, `context`, `doctor`, … / `--all`, `--sessions`, `install`, …): anything else — a typo, a path, a value after a flag — is dropped, never sent |
| `hook_read` | every read the hook decided on | `decision` (`outline` / `cached` / `raw`), `reason` (`user-mentioned`, `skip-list`, `editing`, `probation`, `expected-value`, …), file extension, `source` (`Read`, `cat`, `Get-Content`, …), `kind` (code/json/text), token **bucket** of the file, context-size **bucket**, model family, learned re-read probability (percent), `probe` (this outline is the one-in-ten probe of a key on probation), whether the call came from a subagent, `agent_class` (`main` / `readonly` / `editing` — never the name of a custom agent); for `cached`: `turns_ago`; for the others: `cache_miss` (`missed`, `other-agent`, `changed`, `compacted`, `unknown`) when the file had been read before |
| `hook_reread` | a file served outlined or cached is read again | `kind` (`full` / `range` / `after-cache`), extension, token bucket, model family, `agent_class`; a `range` re-read (offset/limit, `sed -n`) carries only `kind`, extension and `agent_class` |
| `guard_notice` | a context band is crossed | band, context bucket, model family, which hook event fired it |
| `session_start` | first hook event of a session | which hook, permission mode, whether it came from a subagent |
| `session_digest` | Claude Code `SessionEnd` | model family, turns, duration (minutes), tokens saved, average/max context buckets, cost **bucket**, saving at 200k (percent), compactions, outlines served, re-reads, edit failures, number of guard bands crossed, end reason, permission mode, `saved_usd` (what this session's outlines saved, valued over the life of the context like `gain` — a saving, not a bill) and `saved_pct_of_cost` (that saving as a share of what the session would have cost without it) |
| `savings_snapshot` | at most once a day after a session ends or on `cork-ai gain`; always on `hooks install`, `telemetry on` and `telemetry preview` (forced triggers) | `reason` (which trigger), `tracking_days`; lifetime aggregates, **exact**: sessions, reads outlined, raw/saved tokens, saved percent, re-reads, their tokens and rate (percent), edit failures, USD saved (first pass, lifetime, re-read penalty, extra-turn penalty, net), measured sessions, median amplification, compactions, top model family, number of model families used; last 30 days: spend **bucket**, turns, sessions, average context per turn (**exact token count** and its bucket — a context size, not a bill), cache-read share (percent), saving at 200k (percent), `projects_30d` (distinct projects worked on, as a **bucket**: `1`, `2-3`, `4-6`, `7-15`, `>15`); setup: autoCompactWindow, guard on/off and its number of bands, hooks installed, Claude Code version |
| `hook_error` | a hook crashed (the tool call went through anyway) | `stage` (`parse` / `handle`), the error **class** (`TypeError`, `Error`, …) and Node's `code` (`ENOENT`, …) when there is one — never the message, which could quote a path; which hook event and tool |
| `doctor` | `cork-ai doctor` | `ok`, number of failing checks, the **names** of failing and warning checks from the fixed list (`binary`, `settings`, `hooks`, `neighbours`, `self-test`, `heartbeat`, `coverage`, `claude-code`, `snapshot`, `debug`, `compaction`, `guard`, `version`), `managed_settings` |
| `release_downloads` | GitHub Actions, daily (not from your machine) | download counts of the release assets |

Exact figures are sent for what cork-ai itself produced — an aggregate over weeks of work cannot identify a file or a project. What you spend stays a bucket: a bill is personal, a saving is a product metric. The snapshot is built by a detached child process (`cork-ai __send-snapshot`), never inside a hook.

Buckets are coarse on purpose: tokens (`<500`, `500-1.5k`, `1.5k-3k`, `3k-6k`, `6k-15k`, `>15k`), context (`<50k`, `50k-150k`, `150k-300k`, `300k-500k`, `500k-750k`, `>750k`), cost (`<$1`, `$1-5`, `$5-20`, `$20-100`, `>$100`). Model ids are reduced to a family (`opus-5`, `sonnet-5`, `fable-5-1`). File extensions come from a fixed list of code, text and binary extensions; anything else is sent as `other` (`none` when the file has no extension), so an unusual extension cannot name a project.

## What is never sent

File paths, file names, directory or project names, prompt text, file content, command lines, session ids, transcript content, the Claude Code account, the token count of any single file, or what you spend (only buckets). What cork-ai *saved* is sent exactly — see `savings_snapshot`.

The property builders live in `src/cli/telemetry.ts` and `src/cli/hook.ts`; the unit tests assert that no path or session id appears in any event.

## Location

PostHog derives a location from the IP at ingestion. The project anonymises IPs and a transformation blanks the city, postal code, coordinates and region before storage; only the country, continent and time zone remain.

## For maintainers

`scripts/posthog-setup.mjs` (with a personal API key in `POSTHOG_PERSONAL_API_KEY`, never committed) configures the project and creates four dashboards — Overview, Savings, Context, Adoption. `scripts/adoption.mjs` prints downloads against installs; `scripts/stats.mjs` writes `docs/stats.json`, the badges and the README block, weekly from CI.

## Users who keep telemetry off

They send nothing, by design — so they cannot be counted directly. The adoption denominator comes from the GitHub release download counts (public API, no telemetry involved), compared with the number of distinct install ids seen in PostHog.
