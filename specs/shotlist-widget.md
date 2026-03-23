# Feature: Shotlist Widget

## Dependencies
- `specs/data-model.md`

## Goal

A shared React component (`ShotlistWidget`) used in both the renderer (operator UI) and the phone browser UI. Displays the active rundown's shots with live timing indicators.

## Component API

```ts
interface ShotlistWidgetProps {
  rundownName: string
  shots: Shot[]
  cameras: Camera[]
  liveIndex: number | null     // index into shots[] of current live shot
  startedAt: number | null     // Date.now() when live shot started
  running: boolean
  cameraFilter?: number[]      // camera numbers to show; undefined = show all
}
```

Location: `src/shared/components/ShotlistWidget.tsx`
Types imported from `src/shared/types.ts`.

## Layout

```
┌──────────────────────────────────────────────┐
│  Morning show rundown            ⏱  02:14    │  ← rundown name + live countdown
├──────────────────────────────────────────────┤
│ [CAM1] Main Wide    "Opening"   ████████░░  2:14 remaining  │  ← live shot
│ [CAM2] Close-up     "Interview" ░░░░░░████  1:30 until live │  ← next visible
│ [CAM3] Overhead     "Wide"                  3:00            │  ← static
└──────────────────────────────────────────────┘
```

## Shot row

Each row shows:
- **Camera badge**: background color = `camera.color`, text = `CAM{camera.number}`
- **Camera name**: `camera.name`
- **Label**: shot label/title (if not null)
- **Duration**: formatted as `m:ss`
- **Progress bar** (only for live and next-visible shots — see below)
- **Time display** (right-aligned)

### Live shot row
- Progress bar fills left-to-right, shrinks as time passes (elapsed / durationMs)
- Time display: `{remaining}` formatted `m:ss`
- Remaining = `durationMs - (Date.now() - startedAt)`
- Bar class: `progress--live`

### Next visible shot row
The "next visible shot" is the first shot after liveIndex that passes the `cameraFilter`.

- Time display: countdown until this shot goes live
- **Without filter (or filter includes all intermediate shots)**:
  `timeUntilLive = remaining on live shot`
- **With filter (some shots between live and next visible are hidden)**:
  `timeUntilLive = remaining on live shot + sum of durationMs of all shots between live and next visible (including hidden ones)`
- Progress bar fills left-to-right as time passes toward going live
- Bar class: `progress--next`

### All other rows
- No progress bar
- Static duration display

## Header

Above the shotlist:
- Left: rundown name
- Right: large countdown timer for current live shot (`m:ss`), or `--:--` if not running

## Filtering

If `cameraFilter` is provided, only render rows whose `shot.cameraId` maps to a camera in the filter. Hidden shots still count toward `timeUntilLive` calculation for the next visible shot.

## Timing updates

The widget uses `setInterval(16ms)` (≈60fps) or `requestAnimationFrame` to recompute remaining/timeUntilLive from `Date.now()` while `running === true`. Interval cleared when `running === false` or component unmounts.

## Shared module strategy

`src/shared/` is included in both `tsconfig.web.json` and `tsconfig.node.json` (renderer). Types and this component must not import from Electron-specific modules.

## Acceptance criteria

- Renders shot rows with correct camera color badges
- Live shot shows shrinking progress bar and live countdown
- Next visible shot shows correct `timeUntilLive` (sum of hidden shots accounted for)
- Camera filter hides rows but keeps time calculation correct
- Timer updates smoothly while running; freezes when stopped
- `yarn test` passes (unit tests for `timeUntilLive` calculation logic)
