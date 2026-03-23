# Feature: Phone Browser UI

## Dependencies
- `specs/data-model.md`
- `specs/shotlist-widget.md`
- `specs/live-controls.md` (Socket.io events)

## Goal

A read-only phone-optimised browser UI (`src/web/`) that mirrors the active rundown shotlist in real time via Socket.io. Supports filtering by camera.

## Server: replace `ws` with Socket.io

Replace `src/main/server/ws.ts` (bare `ws`) with Socket.io server.

```ts
// src/main/server/socket.ts
import { Server } from 'socket.io'
import type { HttpServer } from 'http'

export function attachSocketServer(httpServer: HttpServer): Server { ... }
```

Install: `socket.io` (server), `socket.io-client` (web UI).

## Socket.io events

### Server → client

| Event | Payload | When |
|---|---|---|
| `state:rundown` | `{ rundown: Rundown \| null, shots: Shot[], cameras: Camera[] }` | On connect; on any rundown/shot/camera change |
| `state:live` | `{ liveIndex: number \| null, startedAt: number \| null, skippedIds: string[] }` | On next/skip action |
| `state:playback` | `{ running: boolean }` | On start/stop |

### Client → server

None (read-only).

## Phone UI (`src/web/App.tsx`)

### On connect
1. Receive `state:rundown` → populate store
2. Receive `state:live` + `state:playback` → populate store

### Store (`src/web/store.ts`, Zustand)
```ts
{
  rundown: Rundown | null
  shots: Shot[]
  cameras: Camera[]
  liveIndex: number | null
  startedAt: number | null
  skippedIds: string[]
  running: boolean
  cameraFilter: number[]   // empty = show all
  connected: boolean
}
```

### Layout

```
┌──────────────────────┐
│ Camera filter:       │
│ [CAM1] [CAM2] [CAM3] │  ← toggle pills
├──────────────────────┤
│  ShotlistWidget      │  ← shared component
│  (filtered view)     │
└──────────────────────┘
```

Connection status indicator: small dot (green = connected, red = disconnected) in header.

### Camera filter pills

- One pill per camera in `cameras` array
- All active by default
- Toggle: tap to include/exclude camera from `cameraFilter`
- `cameraFilter` passed as prop to `ShotlistWidget`

### Reconnection

Use Socket.io built-in reconnection. On reconnect: re-subscribe to events, refresh full state (server sends `state:rundown` on every new connection).

## Shared component import

`ShotlistWidget` lives in `src/shared/components/ShotlistWidget.tsx`.
`tsconfig.web.json` must include `src/shared/**/*`.
Web build (`vite.config.web.ts`) must resolve `src/shared/` alias.

## Acceptance criteria

- Phone browser connects to `http://{laptop-ip}:3000`
- Shotlist renders and updates in real time
- Camera filter pills show/hide rows; time-until-live recalculated correctly
- Connection indicator shows live status
- Reconnects automatically on network drop
- `yarn test` passes
