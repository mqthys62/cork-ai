import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The deprecated SDK (src/sdk, docs/SDK.md) keeps its tests behind `npm run test:sdk`:
    // they are not part of the product any more and cost 4 s per run on 12 CI jobs.
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Isolates all persistent state (stats.json, live sessions, policy) from
    // the user's real ~/.cork-ai: a fresh CORK_AI_HOME per test file.
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/types/**',
        // Deprecated SDK: kept buildable (build:sdk) and tested by test:sdk, not measured
        'src/sdk/**',
        // CLI entry point: standalone binary with stdin/process.exit/terminal formatting
        // Not unit-testable via vitest — covered by manual hook integration tests
        'src/cli/index.ts',
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85,
      },
    },
  },
})
