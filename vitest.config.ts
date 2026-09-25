import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Node stays the default: every existing suite is pure logic and gains
    // nothing from a DOM. Only files named `*.dom.test.tsx` mount components.
    environment: 'node',
    environmentMatchGlobs: [['src/**/*.dom.test.tsx', 'jsdom']],
    setupFiles: ['./scripts/vitest-dom-setup.ts'],
    // Swaps in the Node build of better-sqlite3 first, so `vitest` works
    // regardless of whether the app was last built for Electron.
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
  },
})
