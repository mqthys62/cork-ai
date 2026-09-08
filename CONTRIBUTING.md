# Contributing to cork-ai

## Development setup

cork-ai is distributed as standalone binaries (no Node.js required to use it), but development requires Node.js ≥ 18 and npm.

```bash
git clone https://github.com/mqthys62/cork-ai.git
cd cork-ai
npm install
```

## Running tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# TypeScript type checking
npm run typecheck

# Build the CLI (dist/cli/index.js)
npm run build
```

All tests must pass before opening a PR (`npm test`, ~380 tests).

## Project structure

```
src/
├── cli/                     # The tool — compiled to a standalone binary (bun build --compile)
│   ├── index.ts             # Commands: gain, context, doctor, hooks, config, update, reset, telemetry, statusline
│   ├── hook.ts              # The hook, as one pure function: handleHookEvent(event) → stdout JSON | undefined
│   ├── bash-read.ts         # Which shell commands are reads (cat, sed -n, …) or edits (sed -i, redirections)
│   ├── outline.ts           # The numbered outline served instead of a whole file
│   ├── policy.ts            # Expected-value gate + per-extension re-read rates (~/.cork-ai/policy.json)
│   ├── context-guard.ts     # Band notices (150k / 300k / 500k / 750k) to the user and the model
│   ├── transcript-usage.ts  # Everything read from ~/.claude/projects transcripts (spend, context, re-reads)
│   ├── persistent-stats.ts  # ~/.cork-ai/stats.json and live sessions
│   ├── config.ts · telemetry.ts · heartbeat.ts · skip-list.ts · file-eligibility.ts · version.ts
├── pricing/                 # Single source of truth for model pricing (4 billing tiers)
├── core/tokenizer.ts        # Calibrated token estimates
├── types/                   # Shared types
└── sdk/                     # Deprecated conversation-compression library (docs/SDK.md) — tests in tests/sdk/
```

The CLI imports only Node.js built-ins and local files — no npm dependencies. This is required for `bun build --compile` to produce a zero-dependency binary.

## Working on the hook

All hook logic is in `src/cli/hook.ts` and is unit-tested in `tests/unit/hook.test.ts` by calling `handleHookEvent()` directly with a synthetic payload, a temp file and a fake transcript. Add a test for every new decision path. The I/O shell (`runHook` in `index.ts`) stays three lines.

Persistent state always goes through `CORK_AI_HOME` (vitest isolates it in a temp dir). Never write a test that touches the real `~/.cork-ai`.

To test a CLI command during development:
```bash
npx tsx src/cli/index.ts <command>
```

To test the hook end to end:
```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"cat src/cli/index.ts"},"session_id":"test","cwd":"'"$PWD"'"}' \
  | CORK_AI_HOME=/tmp/cork-dev npx tsx src/cli/index.ts hook
```

## Telemetry

Opt-in, anonymous, documented in `docs/TELEMETRY.md`. When you add an event or a property, update that file and the tests that assert no path or session id leaks (`tests/unit/hook.test.ts`, `tests/unit/telemetry.test.ts`).

## Commit convention

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new compression module
fix: correct token count in tokenizer
docs: update README with usage examples
test: add integration tests for budget manager
chore: update dependencies
refactor: simplify pipeline orchestrator
perf: optimize JSON content detection
```

## PR process

1. **Fork** the repository
2. **Create a descriptive branch**: `feat/selective-cache` or `fix/json-detection`
3. **Write tests first** (TDD recommended)
4. **Verify** `npm test` and `npm run typecheck` both pass
5. **Open a PR** with a clear description:
   - What the module does
   - Estimated token savings
   - Edge cases covered

## Code rules

- TypeScript strict — no `any` without a justification comment
- No ML or native compiled dependencies
- Test on both Windows paths (`path.join`) and Linux
- Coverage > 80% for all new code
- No comments that explain *what* the code does — only *why* if non-obvious
