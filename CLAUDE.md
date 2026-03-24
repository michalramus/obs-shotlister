# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn dev          # Electron + Vite dev mode
yarn build        # Production build
yarn lint         # ESLint
yarn format       # Prettier
yarn test         # Vitest (single run)
yarn test:watch   # Vitest (watch mode)
```

## Architecture

Electron desktop app that also hosts a web server for phone browsers on LAN.

### Layers

**Electron main process** (`src/main/`)
- App lifecycle, window management
- Hosts embedded Express + WebSocket server (`src/main/server/`)
- obs-websocket client (OBS integration) (`src/main/obs/`)
- SQLite via `better-sqlite3` (persistence) (`src/main/db/`)

**Electron renderer** (`src/renderer/`)
- React + Vite operator UI
- Shotlist view, camera queue, skip/go-to controls
- Communicates with main via `ipcRenderer`/`ipcMain`

**Embedded Express server** (runs in main process)
- Serves phone web UI bundle
- Listens on configurable port (default `3000`)
- WebSocket server (`ws`) attached to the same HTTP server: pushes full state to phone browsers on connect and on every state change
- Server is single source of truth for state

**Phone browser UI** (`src/web/`)
- Shotlist with camera filters
- Progress bar + timer (time on live / time until next)
- Timers are advisory — operator decides all camera switches

**DaVinci Resolve import**
- Accepts CSV marker export from Resolve
- Markers → shotlist entries (camera name, duration)

### Data flow

```
OBS ←→ obs-websocket ←→ Electron main ←→ SQLite
                               ↕ ipc
                         Electron renderer
                               ↕ WebSocket
                         Phone browsers (LAN)
```

## Robustness requirements

This runs in production. All async operations must handle errors explicitly. No unhandled promise rejections. Electron `uncaughtException` and `unhandledRejection` must be caught and logged without crashing the app.

#live mode approach
When any feature is about live mode, don't edit database - any changes made in live mode should be not be persistand.
