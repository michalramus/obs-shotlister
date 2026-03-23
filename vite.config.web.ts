import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone Vite config for the phone browser UI (src/web/).
// Built separately from electron-vite; output lands in out/web/
// so the Express server can serve it as static files.

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/web/index.html'),
      },
    },
  },
  plugins: [react()],
})
