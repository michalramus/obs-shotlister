---
name: obs-queuer project context
description: Architecture, stack, conventions, and testing patterns for the obs-queuer Electron app
type: project
---

Electron desktop app that hosts an embedded Express + WebSocket server for phone browsers on LAN. The app manages an OBS camera queue for live production use.

**Stack:** electron-vite, React 18, TypeScript strict, Express, ws, better-sqlite3, obs-websocket-js, Vitest, ESLint, Prettier

**Source layout:**
- `src/main/` — Electron main process (server/, obs/, db/)
- `src/renderer/` — Electron renderer (operator UI)
- `src/web/` — Phone browser UI, served by Express on port 3000
- `src/preload/` — contextBridge preload

**Build:** electron-vite for main+renderer+preload; vite.config.web.ts builds web UI separately to out/web/

**TypeScript:** two tsconfigs — tsconfig.node.json (main process, strict) and tsconfig.web.json (renderer + web, strict). Root tsconfig.json references both.

**Testing:** Vitest with node environment. supertest is used for HTTP route tests. Tests live alongside source as `*.test.ts(x)`.

**ESLint:** @typescript-eslint recommended + react-hooks/recommended. `no-console: warn`, `no-explicit-any: error`, `no-unused-vars` configured with `argsIgnorePattern: '^_'` so underscore-prefixed stub parameters are allowed.

**Prettier:** single quotes, no semicolons, 100 char line width, trailing commas.

**Why:** Runs in live production (multi-camera events). All async ops must handle errors explicitly. Global uncaughtException/unhandledRejection handlers are wired from day one.

**How to apply:** Treat robustness as a first-class constraint in all implementation decisions. Never leave unhandled rejections. Use `_param` prefix for intentionally unused stub parameters.
