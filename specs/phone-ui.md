# Feature: Phone Browser UI

## Dependencies
- `specs/data-model.md`
- `specs/shotlist-widget.md`
- `specs/live-controls.md` (Socket.io events)

## Goal

A read-only phone-optimised browser UI (`src/web/`) that mirrors the active rundown shotlist in real time via Socket.io. Supports filtering by camera.

The payload carries the Rundown's Kind and the Project's Parts. A Voice-over Rundown is shown
unfiltered and named by its Parts — there are no Cameras to filter by. See
`specs/voice-over-rundowns.md`.

## Server

Socket.io, attached to the same HTTP server that serves the bundle, so a phone
needs no second origin and the payload is same-origin by construction.

```ts
// src/main/server/socket.ts
import { Server } from 'socket.io'
import type { HttpServer } from 'http'

export function attachSocketServer(httpServer: HttpServer): Server { ... }
```

Packages: `socket.io` (server), `socket.io-client` (web UI).

CORS is closed (`origin: false`) and the server sends a CSP confining the page to
its own origin: phones load the UI from here, so no cross-origin request is ever
legitimate, and an open origin let any page a phone happened to have open read
the whole payload off the operator's laptop.

## Socket.io events

### Server → client

| Event | Payload | When |
|---|---|---|
| `state:rundown` | `{ rundown: Rundown \| null, shots: Shot[], cameras: Camera[], parts: Part[] }` | On connect; on any rundown/shot/camera/part change |
| `state:live` | `{ liveIndex: number \| null, elapsedMs: number \| null }` | On next/skip action |
| `state:playback` | `{ running: boolean }` | On start/stop |
| `state:shot:hidden` | `{ shotId: string }` | When a Next or a Skip drops one Shot |

`state:live` carries elapsed time rather than a timestamp: a phone does not share
the operator's clock, so it anchors the position against its own on arrival
(`startedAtFromElapsed`). While a session is running, `state:rundown` carries the
queue's own hidden flags, which is what lets a reconnecting phone draw the right
list before it has seen a single `state:shot:hidden`.

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
  shots: Shot[]        // hidden flags applied; see state:shot:hidden
  cameras: Camera[]
  parts: Part[]
  liveIndex: number | null
  startedAt: number | null   // local, derived from elapsedMs on arrival
  running: boolean
  connected: boolean
}
```

A skip is not held as a list of ids: it arrives as `state:shot:hidden` and is
applied to the Shot it names. The camera filter lives in the component rather
than the store, because only the phone has one.

A Shot being held through the incoming Transition keeps its row until that
Transition finishes, rather than vanishing when the push arrives (ADR 0004).
Both surfaces take that hold from `transitionHoldMs` in `src/shared/live-view.ts`,
so they cannot disagree about what is on air.

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
