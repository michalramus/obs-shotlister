/**
 * Where the playhead is, and what moves it.
 *
 * The position has three possible sources depending on what is happening:
 * the Reference media's own clock during edit playback, the wall clock when the
 * playhead is before the media starts or there is no media, and the Live session
 * when a show is running. Choosing between them used to be spread across two RAF
 * effects, six refs and four setters, all of which had to agree.
 *
 * Time comes in as a parameter rather than being read here, so this is testable
 * without a DOM, a clock, or a media element.
 */

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
 * The media's clock is authoritative once the playhead has reached it — following
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
 * Clamped to the end of the live Shot: Shots overrun constantly and the playhead
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
 * Whether a painted playhead position should also be committed to React state.
 *
 * Painting happens every frame; committing re-renders the timeline, so it runs at
 * a much lower rate. Anything reading the playhead from state sees it lag by at
 * most `intervalMs`.
 */
export function shouldCommit(nowMs: number, lastCommitMs: number, intervalMs: number): boolean {
  return nowMs - lastCommitMs >= intervalMs
}
