/**
 * The Playhead: where it is, what moves it, when it paints and when it commits.
 *
 * The arithmetic below used to live in a module of its own while the loop that
 * drives it stayed inline in TimelineEditor — two `requestAnimationFrame` effects,
 * an `onScroll` handler and eleven refs that existed for nothing else. Every
 * Playhead defect of the last round landed in that inline half and none in the
 * extracted one, because the inline half could not be reached without mounting a
 * component:
 *
 *   - painting the Playhead re-rendered the whole timeline every frame;
 *   - the paint path read `clientWidth` between style writes, forcing a
 *     synchronous layout 60 times a second;
 *   - the loop died on a zoom step or a Shot edit, because the RAF effect listed
 *     the values its tick reads as dependencies and so cancelled, restarted and
 *     re-origined itself;
 *   - attaching Reference media while the Playhead was already running froze it
 *     at the media offset, because nothing started the new element;
 *   - and the echo-scroll guard was wrong twice over (see `isEchoScroll`).
 *
 * So the whole cluster is here, and the clock and the frame scheduler are injected
 * rather than reached for. That is the point: the rules above can be asserted by
 * stepping frames by hand against fake paint targets, with no DOM and no React.
 *
 * Three rules hold the design together, and each of them is one of the defects:
 *
 * 1. Nothing in the per-frame path reads layout. Every width the paint functions
 *    need is mirrored in by `setWidths`, from the one ResizeObserver that can
 *    change them, and every other input by `setGeometry` from the render body.
 * 2. Painting writes to DOM nodes directly; only the throttled commit goes
 *    through React. A frame that committed would re-render the timeline at the
 *    display's refresh rate.
 * 3. The loop's inputs are read per tick through the mirrors, never captured. A
 *    zoom change, a Shot edit or Reference media appearing mid-playback must not
 *    stop the loop or move its origin.
 */

import { msAtPx, pxAtMs } from './coordinates'

/* ------------------------------------------------------------------ *
 * The arithmetic.
 *
 * Exported because it is pure and deserves its own assertions, but it is an
 * internal of this module: nothing outside `playhead.ts` should import it. The
 * position has three possible sources depending on what is happening — the
 * Reference media's own clock during edit playback, the wall clock when the
 * Playhead is before the media starts or there is no media, and the Live session
 * when a show is running — and choosing between them is exactly what used to be
 * spread across two RAF effects, six refs and four setters, all of which had to
 * agree.
 * ------------------------------------------------------------------ */

export interface MediaClock {
  /** Media position in seconds, or null when there is no Reference media. */
  currentTimeSec: number | null
  /** Where the media sits on the timeline, in milliseconds. */
  offsetMs: number
}

export interface EditPlaybackInput {
  /** Position and wall time captured when playback started. */
  origin: { headMs: number; wallMs: number }
  /** Wall time now, from the same source as `origin.wallMs`. */
  nowMs: number
  media: MediaClock | null
  totalMs: number
}

/**
 * Playhead position during edit-mode playback.
 *
 * The media's clock is authoritative once the Playhead has reached it — following
 * it means zero drift against the audio the operator is cutting to. Before the
 * media starts, its clock is pinned at zero and would not advance, so the wall
 * clock takes over.
 */
export function editPlayheadMs({ origin, nowMs, media, totalMs }: EditPlaybackInput): number {
  if (media?.currentTimeSec != null) {
    const mediaMs = media.currentTimeSec * 1000 + media.offsetMs
    if (mediaMs >= 0) return Math.min(mediaMs, totalMs)
  }
  return Math.min(origin.headMs + (nowMs - origin.wallMs), totalMs)
}

export interface LivePlaybackInput {
  /** Start of the live Shot on the timeline. */
  shotStartMs: number
  /** Duration of the live Shot. */
  shotDurationMs: number
  /** Milliseconds since the Shot went live. */
  elapsedMs: number
}

/**
 * Playhead position during a Live session.
 *
 * Clamped to the end of the live Shot: Shots overrun constantly and the Playhead
 * running on into the next Shot's territory would claim something is live that
 * is not. See docs/adr/0002-timers-are-advisory.md.
 */
export function livePlayheadMs({
  shotStartMs,
  shotDurationMs,
  elapsedMs,
}: LivePlaybackInput): number {
  return shotStartMs + Math.min(Math.max(0, elapsedMs), shotDurationMs)
}

/** True once the live Shot has run past its planned duration. */
export function isOverrunning({ shotDurationMs, elapsedMs }: LivePlaybackInput): boolean {
  return elapsedMs >= shotDurationMs
}

/** Media position for a timeline position, never seeking before the media starts. */
export function mediaTimeSecFor(ms: number, offsetMs: number): number {
  return Math.max(0, (ms - offsetMs) / 1000)
}

/**
 * Whether a painted Playhead position should also be committed to React state.
 *
 * Painting happens every frame; committing re-renders the timeline, so it runs at
 * a much lower rate. Anything reading the Playhead from state sees it lag by at
 * most `intervalMs`.
 */
export function shouldCommit(nowMs: number, lastCommitMs: number, intervalMs: number): boolean {
  return nowMs - lastCommitMs >= intervalMs
}

/**
 * Whether a scroll event is the echo of our own programmatic write.
 *
 * Telling our own scrolling apart from the operator's is harder than it looks.
 * The timeline scrolls itself every frame to keep a fixed Playhead over moving
 * content, and each of those writes comes back as a `scroll` event. Acting on
 * those events re-renders the whole timeline once per frame, which is what
 * defeated the Playhead's commit budget in the first place.
 *
 * It cannot be guarded with a flag cleared in a `setTimeout(0)`: a browser
 * dispatches `scroll` during the *next* frame's rendering steps, long after that
 * task has run, so the flag is always back to false by the time it matters. It
 * cannot be guarded on "is playback running" either — during an overrunning Live
 * Shot the Playhead is deliberately frozen and nothing scrolls, so an operator
 * dragging the overview then produces real events that must be acted on.
 *
 * What does work is comparing against the last value we wrote. `expectedPx` is
 * that value, or null if this code has not written one since the operator last
 * scrolled. The tolerance absorbs the sub-pixel rounding a browser applies when
 * storing `scrollLeft`.
 */
export function isEchoScroll(
  actualPx: number,
  expectedPx: number | null,
  tolerancePx = 1,
): boolean {
  if (expectedPx === null) return false
  return Math.abs(actualPx - expectedPx) <= tolerancePx
}

/* ------------------------------------------------------------------ *
 * The ports.
 *
 * Structural, and as narrow as the paint path actually needs: a real
 * `HTMLSpanElement`, `HTMLDivElement` and scroll container satisfy them, and so
 * does a plain object in a test. Nothing here mentions `Element`, so nothing here
 * needs a DOM.
 * ------------------------------------------------------------------ */

/** Somewhere the position readout is written. */
export interface TextTarget {
  textContent: string | null
}

/** Something positioned along the overview strip. */
export interface BoxTarget {
  style: { left: string; width: string }
}

/** The horizontally scrolling timeline. */
export interface ScrollTarget {
  scrollLeft: number
}

/**
 * The nodes the per-frame path writes into, looked up per call because they mount
 * and unmount independently of this module's lifetime.
 */
export interface PlayheadTargets {
  /** The transport's time readout. */
  readout: () => TextTarget | null
  /** The Playhead marker on the overview strip. */
  overviewMarker: () => BoxTarget | null
  /** The overview strip's viewport rect. */
  viewportRect: () => BoxTarget | null
  scroller: () => ScrollTarget | null
}

/**
 * The Reference media, as this module needs it: a clock to follow, an offset, and
 * three commands. Deliberately not an element — the media may be the video node
 * the host renders or an `Audio` it created for a bare audio file, and which one
 * is in play is the host's business.
 */
export interface PlayheadMedia {
  /** Media position in seconds, or null when there is no media or it has no time yet. */
  currentTimeSec: () => number | null
  /** Where the media sits on the timeline, or null when none is attached. */
  offsetMs: () => number | null
  play: () => void
  pause: () => void
  /** Seeks the media to `sec`. */
  seekSec: (sec: number) => void
}

/** Geometry the per-frame path needs, mirrored so no frame measures anything. */
export interface PlayheadGeometry {
  /** Duration of the whole Rundown. */
  totalMs: number
  /** Width of the whole Rundown at the current zoom. */
  totalPx: number
  zoomPxPerSec: number
}

/**
 * Element widths, mirrored for the same reason.
 *
 * Reading `clientWidth` after writing a style or a `scrollLeft` forces a
 * synchronous layout, and the paint path runs on every animation frame. A
 * ResizeObserver is the only thing that can change either width, so a mirror
 * cannot go stale.
 */
export interface PlayheadWidths {
  scrollerPx: number
  overviewPx: number
}

export interface PlayheadDeps {
  /**
   * Monotonic clock, for the playback origin and the commit budget.
   * `performance.now` in the app.
   */
  now: () => number
  /**
   * Wall clock on the same epoch as a Live session's `startedAt`, which is
   * stamped in the main process. `Date.now` in the app — deliberately a second
   * clock, because `performance.now` is not on that epoch.
   */
  epochNow?: () => number
  scheduleFrame: (cb: () => void) => number
  cancelFrame: (handle: number) => void
  targets: PlayheadTargets
  media: PlayheadMedia
  /** Formats the position for the readout. */
  formatPosition: (ms: number) => string
  /** Throttled position for React state. */
  onCommitPosition: (ms: number) => void
  /**
   * Scroll position for React state, on stop only.
   *
   * `handleScroll` ignores everything while the Playhead drives the scroller, so
   * without this the overview's viewport rect would snap back to wherever the
   * timeline was when playback started, on the next render after it ends.
   */
  onCommitScrollLeft: (px: number) => void
  /** Edit playback ran off the end of the Rundown and stopped itself. */
  onEditEnded: () => void
  /** One advancing frame was served; for the playback probe. */
  onFrame?: () => void
  /** How often a painted position is also committed to React. */
  commitIntervalMs?: number
}

/** What the operator's own scroll was allowed to do. */
export type ScrollVerdict = 'echo' | 'operator'

/** One run of the Live loop: a Shot and when it went live. */
export interface LiveShot {
  /** Start of the Shot on the timeline. */
  startMs: number
  durationMs: number
  /** When the Shot went live, on `epochNow`'s epoch. */
  startedAt: number
}

export interface Playhead {
  /** Where the Playhead is, without waiting for a commit. */
  positionMs: () => number
  /** Whether a loop currently owns the Playhead and the scroll position. */
  isRunning: () => boolean
  /** Mirrors the geometry the per-frame path reads. Call from the render body. */
  setGeometry: (geometry: PlayheadGeometry) => void

  /**
   * Mirrors element widths. Call from the ResizeObserver that measures them, with
   * whichever of the two it actually measured.
   */
  setWidths: (widths: Partial<PlayheadWidths>) => void
  /**
   * Repaints at the current position.
   *
   * The overview marker is painted rather than rendered, so React will not move
   * it when the geometry it is derived from changes underneath it.
   */
  repaint: () => void
  /** Moves the Playhead for a discrete interaction: a click, a drag, an arrow key. */
  moveTo: (ms: number) => void
  /** Brings a timeline position to the left edge, while a loop is following. */
  bringIntoView: (ms: number) => void
  /** Seeks the Reference media to a timeline position. */
  seekMedia: (ms: number) => void
  /**
   * Starts edit playback, or — when it is already running — re-issues `play()` for
   * Reference media that has just appeared or changed, without touching the origin.
   */
  playEdit: () => void
  stopEdit: () => void
  /** (Re)starts the Live loop for one Shot. */
  runLive: (shot: LiveShot) => void
  stopLive: () => void
  /**
   * Classifies a `scroll` event from the timeline and acts on it.
   *
   * `movePlayhead` says whether the operator's scroll is allowed to drag the
   * Playhead with it — false while something else owns the Playhead, which is
   * playback, a Live session, or a boundary, Marker or media drag in progress.
   */
  handleScroll: (scrollLeftPx: number, movePlayhead: boolean) => ScrollVerdict
}

const DEFAULT_COMMIT_INTERVAL_MS = 100

export function createPlayhead(deps: PlayheadDeps): Playhead {
  const {
    now,
    epochNow = Date.now,
    scheduleFrame,
    cancelFrame,
    targets,
    media,
    formatPosition,
    onCommitPosition,
    onCommitScrollLeft,
    onEditEnded,
    onFrame,
    commitIntervalMs = DEFAULT_COMMIT_INTERVAL_MS,
  } = deps

  let positionMs = 0
  let geometry: PlayheadGeometry = { totalMs: 0, totalPx: 0, zoomPxPerSec: 80 }
  let widths: PlayheadWidths = { scrollerPx: 800, overviewPx: 300 }

  /**
   * Which loop owns the Playhead.
   *
   * A flag rather than "is a frame scheduled": a tick clears its own handle
   * before doing its work, so a handle check would report idle from inside the
   * very frame that needs to scroll.
   */
  let mode: 'idle' | 'edit' | 'live' = 'idle'
  let editHandle: number | null = null
  let liveHandle: number | null = null
  let origin: { headMs: number; wallMs: number } | null = null
  let lastCommitMs = 0
  /** The last `scrollLeft` this module wrote. Null once the operator has scrolled. */
  let expectedScrollLeftPx: number | null = null

  /** Reads the Reference media's clock, or null when there is none to follow. */
  function readMedia(): MediaClock | null {
    const offsetMs = media.offsetMs()
    if (offsetMs === null) return null
    return { currentTimeSec: media.currentTimeSec(), offsetMs }
  }

  /** Writes the Playhead-dependent DOM directly, bypassing React. */
  function paint(ms: number): void {
    positionMs = ms
    const readout = targets.readout()
    if (readout) readout.textContent = formatPosition(ms)
    const marker = targets.overviewMarker()
    if (marker && geometry.totalMs > 0) {
      marker.style.left = `${(ms / geometry.totalMs) * widths.overviewPx}px`
    }
  }

  /** Keeps the overview's viewport rect in sync without a React render. */
  function paintViewportRect(scrollLeftPx: number): void {
    const rect = targets.viewportRect()
    if (!rect || geometry.totalPx <= 0) return
    const ow = widths.overviewPx
    const left = (scrollLeftPx / geometry.totalPx) * ow
    const right = Math.min(ow, left + (widths.scrollerPx / geometry.totalPx) * ow)
    rect.style.left = `${left}px`
    rect.style.width = `${Math.max(4, right - left)}px`
  }

  function bringIntoView(ms: number): void {
    if (mode === 'idle') return
    const el = targets.scroller()
    if (!el) return
    // Pass the value we are about to write rather than reading `scrollLeft` back:
    // reading it immediately after writing forces a synchronous layout, and this
    // runs on every animation frame.
    const px = pxAtMs(ms, geometry.zoomPxPerSec)
    expectedScrollLeftPx = px
    el.scrollLeft = px
    paintViewportRect(px)
  }

  /** One advancing frame: paint and scroll always, commit to React rarely. */
  function advance(ms: number): void {
    onFrame?.()
    paint(ms)
    bringIntoView(ms)
    const nowMs = now()
    if (shouldCommit(nowMs, lastCommitMs, commitIntervalMs)) {
      lastCommitMs = nowMs
      onCommitPosition(ms)
    }
  }

  /** Pushes the last painted position into React state when a loop stops. */
  function commitPosition(): void {
    lastCommitMs = 0
    onCommitPosition(positionMs)
  }

  function commitScrollLeft(): void {
    const el = targets.scroller()
    if (el) onCommitScrollLeft(el.scrollLeft)
  }

  function editTick(): void {
    editHandle = null
    if (origin === null) return
    // Everything this tick reads that can change during playback — the total
    // duration, the zoom, the Reference media offset — comes from a mirror, so
    // the host never has to restart the loop to hand it a new value.
    const totalMs = geometry.totalMs
    const ms = editPlayheadMs({ origin, nowMs: now(), media: readMedia(), totalMs })
    advance(ms)
    if (ms >= totalMs) {
      mode = 'idle'
      origin = null
      media.pause()
      commitPosition()
      commitScrollLeft()
      onEditEnded()
      return
    }
    editHandle = scheduleFrame(editTick)
  }

  function liveTick(shot: LiveShot): void {
    liveHandle = null
    const position = {
      shotStartMs: shot.startMs,
      shotDurationMs: shot.durationMs,
      elapsedMs: epochNow() - shot.startedAt,
    }
    const ms = livePlayheadMs(position)
    // An overrunning Shot holds the Playhead; stop dragging the view with it, and
    // leave `expectedScrollLeftPx` alone so a drag on the overview still reads as
    // the operator's.
    if (isOverrunning(position)) paint(ms)
    else advance(ms)
    liveHandle = scheduleFrame(() => liveTick(shot))
  }

  const playhead: Playhead = {
    positionMs: () => positionMs,

    isRunning: () => mode !== 'idle',

    setGeometry(next) {
      geometry = next
    },

    setWidths(next) {
      widths = { ...widths, ...next }
    },

    repaint() {
      paint(positionMs)
    },

    moveTo(ms) {
      // Paints as well as commits: the overview marker's position is written
      // imperatively and is no longer rendered from state, so a discrete move
      // that only set state would leave the marker where it was.
      paint(ms)
      onCommitPosition(ms)
      bringIntoView(ms)
    },

    bringIntoView,

    seekMedia(ms) {
      const offsetMs = media.offsetMs()
      if (offsetMs === null) return
      media.seekSec(mediaTimeSecFor(ms, offsetMs))
    },

    playEdit() {
      if (mode === 'edit') {
        // Reference media that appeared or changed mid-playback, not a new start.
        // Re-issue `play()` and leave the origin where it is: `editPlayheadMs`
        // treats a media clock as authoritative the moment one exists, so without
        // the `play()` the Playhead freezes at the media offset — and re-stamping
        // the origin's wall time here would rewind it to where playback began.
        media.play()
        return
      }
      mode = 'edit'
      origin = { headMs: positionMs, wallMs: now() }
      media.play()
      editHandle = scheduleFrame(editTick)
    },

    stopEdit() {
      if (editHandle !== null) {
        cancelFrame(editHandle)
        editHandle = null
      }
      mode = 'idle'
      origin = null
      commitPosition()
      commitScrollLeft()
    },

    runLive(shot) {
      if (liveHandle !== null) {
        cancelFrame(liveHandle)
        liveHandle = null
      }
      mode = 'live'
      liveHandle = scheduleFrame(() => liveTick(shot))
    },

    stopLive() {
      if (liveHandle !== null) {
        cancelFrame(liveHandle)
        liveHandle = null
      }
      mode = 'idle'
      commitPosition()
      commitScrollLeft()
    },

    handleScroll(scrollLeftPx, movePlayhead) {
      // Our own auto-scroll fires this every frame, and it has already painted the
      // viewport rect imperatively; committing the position here as well would
      // re-render the whole timeline once per frame. See `isEchoScroll` for why
      // this is a value comparison rather than a flag or a "playing" check.
      if (isEchoScroll(scrollLeftPx, expectedScrollLeftPx)) return 'echo'
      expectedScrollLeftPx = null
      onCommitScrollLeft(scrollLeftPx)
      if (movePlayhead) {
        const ms = Math.max(0, msAtPx(scrollLeftPx, geometry.zoomPxPerSec))
        paint(ms)
        onCommitPosition(ms)
        // Seek directly rather than waiting for the commit to come back round as
        // a render: the operator is dragging and expects the audio to follow.
        playhead.seekMedia(ms)
      }
      return 'operator'
    },
  }

  return playhead
}
