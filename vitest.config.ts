import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // Swaps in the Node build of better-sqlite3 first, so `vitest` works
    // regardless of whether the app was last built for Electron.
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
  },
})
