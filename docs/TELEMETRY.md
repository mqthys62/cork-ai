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

Every event carries `version`, `os`, `arch`, `runtime` (`bun-1` for the standalone binary, `node-22` from npm) and `claude_version` (Claude Code's, read from the transcript). Every event also refreshes the install's **person profile** in PostHog (`$set`: version, OS, runtime, Claude Code version, telemetry and guard state, lifetime totals; `$set_once`: first version, first seen).

`cork-ai telemetry preview` prints the daily snapshot payload byte for byte; `--json` for the raw body.

| Event | When | Properties |
|-------|------|------------|
| `install` | `cork-ai hooks install` | hooks added, whether it was an upgrade, the `autoCompactWindow` value chosen (or null) |
| `telemetry_toggled` | `telemetry on` / `off` (the *off* event is sent before the switch) | `enabled` |
| `command` | any CLI command | command name (`gain`, `context`, `doctor`, …) and its flag |
| `hook_read` | every read the hook decided on | `decision` (`outline` / `raw`), `reason` (`user-mentioned`, `skip-list`, `editing`, `probation`, `expected-value`, …), file extension, `source` (`Read`, `cat`, …), `kind` (code/json/text), token **bucket** of the file, context-size **bucket**, model family, learned re-read probability (percent), whether the call came from a subagent |
| `hook_reread` | a file served outlined is read again | `kind` (`full` / `range`), extension |
| `guard_notice` | a context band is crossed | band, context bucket, model family, which hook event fired it |
| `session_start` | first hook event of a session | which hook, permission mode, whether it came from a subagent |
| `session_digest` | Claude Code `SessionEnd` | turns, duration (minutes), tokens saved, average/max context buckets, cost **bucket**, saving at 200k (percent), compactions, outlines served, re-reads, edit failures, guard bands crossed, end reason, permission mode |
| `savings_snapshot` | once a day at most — after a session ends, or on `cork-ai gain`, `hooks install`, `telemetry on` | lifetime aggregates, **exact**: sessions, reads outlined, raw/saved tokens, saved percent, re-reads and their tokens, edit failures, USD saved (first pass, lifetime, re-read penalty, extra-turn penalty, net), measured sessions, median amplification, compactions, top model family; last 30 days: spend **bucket**, turns, sessions, average context per turn, cache-read share, saving at 200k; setup: autoCompactWindow, guard, hooks installed, Claude Code version |
| `release_downloads` | GitHub Actions, daily (not from your machine) | download counts of the release assets |

Exact figures are sent for what cork-ai itself produced — an aggregate over weeks of work cannot identify a file or a project. What you spend stays a bucket: a bill is personal, a saving is a product metric. The snapshot is built by a detached child process (`cork-ai __send-snapshot`), never inside a hook.

Buckets are coarse on purpose: tokens (`<500`, `500-1.5k`, `1.5k-3k`, `3k-6k`, `6k-15k`, `>15k`), context (`<50k`, `50k-150k`, `150k-300k`, `300k-500k`, `500k-750k`, `>750k`), cost (`<$1`, `$1-5`, `$5-20`, `$20-100`, `>$100`). Model ids are reduced to a family (`opus-5`, `sonnet-5`, `fable-5-1`).

## What is never sent

File paths, file names, directory or project names, prompt text, file content, command lines, session ids, transcript content, the Claude Code account, the token count of any single file, or what you spend (only buckets). What cork-ai *saved* is sent exactly — see `savings_snapshot`.

The property builders live in `src/cli/telemetry.ts` and `src/cli/hook.ts`; the unit tests assert that no path or session id appears in any event.

## Location

PostHog derives a location from the IP at ingestion. The project anonymises IPs and a transformation blanks the city, postal code, coordinates and region before storage; only the country, continent and time zone remain.

## For maintainers

`scripts/posthog-setup.mjs` (with a personal API key in `POSTHOG_PERSONAL_API_KEY`, never committed) configures the project and creates four dashboards — Overview, Savings, Context, Adoption. `scripts/adoption.mjs` prints downloads against installs; `scripts/stats.mjs` writes `docs/stats.json`, the badges and the README block, weekly from CI.

## Users who keep telemetry off

They send nothing, by design — so they cannot be counted directly. The adoption denominator comes from the GitHub release download counts (public API, no telemetry involved), compared with the number of distinct install ids seen in PostHog.
