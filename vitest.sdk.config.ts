import { defineConfig } from 'vitest/config'

/** The deprecated SDK's tests (`npm run test:sdk`) — see docs/SDK.md. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/sdk/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
