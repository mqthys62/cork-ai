# Contributing to cork-ai

## Development setup

cork-ai is distributed as standalone binaries (no Node.js required to use it), but development requires Node.js ≥ 18 and npm.

```bash
git clone https://github.com/mathys62/cork-ai.git
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

# Build library + CLI
npm run build
```

All 144 tests must pass before opening a PR.

## Project structure

```
src/
├── cli/               # Standalone CLI (cork-ai hook, gain, report, init, hooks)
│   ├── index.ts       # All CLI commands — compiled to a standalone binary
│   └── persistent-stats.ts  # ~/.cork-ai/stats.json read/write
├── compressors/       # Stateless content compression modules
├── managers/          # Stateful modules and orchestration
├── core/              # Infrastructure (tokenizer, pipeline, interceptor, wrapClient)
├── stats/             # Per-request and per-session stats tracking
└── types/             # Shared TypeScript types
```

Modules in `compressors/` and `managers/` do not know about each other. Everything goes through the pipeline (`src/core/pipeline.ts`).

The CLI (`src/cli/index.ts`) only imports Node.js built-ins (`fs`, `os`, `path`) and local files — no npm dependencies. This is required for `bun build --compile` to produce a zero-dependency binary.

## Adding a new compression module

1. **Create the source file** in `src/compressors/` (stateless) or `src/managers/` (stateful / orchestrated)

2. **Implement the `CompressResult` interface**:
   ```typescript
   export function myModule(messages: Message[], options?: Partial<MyOptions>): CompressResult {
     return { messages: [...], savedTokens: 0 }
   }
   ```

3. **Write tests** in `tests/unit/my-module.test.ts`:
   - Happy path
   - Empty messages array
   - Edge cases: short content, already minimal content, content just above/below threshold
   - Verify the message count is preserved (modules summarize, never delete)

4. **Register the module** in `src/managers/budget.ts`:
   - Add a `ModuleName` in `src/types/index.ts`
   - Add the call in `compressWithBudget()` at the appropriate level (1, 2, or 3)

5. **Export from** `src/index.ts`

6. **Update** `CHANGELOG.md` under `[Unreleased]` and add a row to the README table

## CLI commands

The CLI is a single compiled file. All commands are in `src/cli/index.ts`.

To add a new command, add a branch to the `main()` switch and wire it to a function. Keep all compression logic inline or in `src/cli/` — do not import from `src/compressors/` or `src/managers/` in the CLI (it would break binary compilation).

To test a CLI command during development:
```bash
npm run build
node dist/cli/index.js <command>
```

To test the hook specifically:
```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/path/to/file.ts"},"session_id":"test","cwd":"/tmp"}' \
  | node dist/cli/index.js hook
```

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
