# Feature: Empty Project Structure

## Goal

Bootstrap the obs-queuer repository with a working but empty scaffold. The app must launch, the embedded web server must start, and the phone browser UI must be reachable — with no application logic yet.

## Tech stack

- **Electron** (latest stable)
- **Vite** + **React 18** (renderer + web UI)
- **TypeScript** strict mode everywhere
- **Express** + **ws** (embedded server in main process)
- **better-sqlite3** (wired up, no schema yet)
- **ESLint** + **Prettier**
- **Vitest**

## Folder structure

```
obs-queuer/
├── src/
│   ├── main/               # Electron main process
│   │   ├── index.ts        # Entry point, creates BrowserWindow
│   │   ├── server/
│   │   │   ├── index.ts    # Starts Express + WebSocket server
│   │   │   ├── routes.ts   # Placeholder REST routes
│   │   │   └── ws.ts       # WebSocket server stub
│   │   ├── obs/
│   │   │   └── client.ts   # obs-websocket client stub
│   │   └── db/
│   │       └── index.ts    # better-sqlite3 init stub
│   ├── renderer/           # Electron renderer (operator UI)
│   │   ├── index.html
│   │   ├── main.tsx
│   │   └── App.tsx         # Empty shell
│   └── web/                # Phone browser UI (served by Express)
│       ├── index.html
│       ├── main.tsx
│       └── App.tsx         # Empty shell
├── specs/
├── electron.vite.config.ts
├── tsconfig.json           # strict: true, paths for main/renderer/web
├── .eslintrc.cjs
├── .prettierrc
├── vitest.config.ts
└── package.json
```

## Configuration requirements

### TypeScript
- `strict: true`
- Separate `tsconfig` per target (main, renderer, web) if needed by electron-vite
- No `any` without explicit comment justification

### ESLint
- `@typescript-eslint` recommended rules
- `eslint-plugin-react-hooks`
- No `console.log` warnings (use a logger utility)

### Prettier
- Single quotes, no semicolons, 100 char line width

### Vitest
- Config in `vitest.config.ts`
- Test files: `src/**/*.test.ts(x)`

## Electron main — error handling baseline

Even in the empty scaffold, wire up global error handlers:

```ts
process.on('uncaughtException', (err) => { /* log, do not crash */ })
process.on('unhandledRejection', (reason) => { /* log, do not crash */ })
```

## Express + WebSocket stub

- Express listens on a configurable port (default `3000`)
- Single WebSocket server attached to the same HTTP server
- On WS client connect: send `{ type: 'state', payload: {} }`
- One placeholder route: `GET /health` → `{ status: 'ok' }`

## npm scripts

```json
"dev": "electron-vite dev",
"build": "electron-vite build",
"lint": "eslint src --ext .ts,.tsx",
"format": "prettier --write src",
"test": "vitest run",
"test:watch": "vitest"
```

## Acceptance criteria

- `npm run dev` launches the Electron window with a blank React app
- `http://localhost:3000` is reachable in a browser and shows the web UI shell
- `http://localhost:3000/health` returns `{ status: 'ok' }`
- WebSocket connection to `ws://localhost:3000` receives initial state message
- `npm run lint` passes with no errors
- `npm test` runs (zero tests, but exits 0)
