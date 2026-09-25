/**
 * Turning "playback feels laggy" into numbers.
 *
 * The timeline paints every frame but is only meant to commit React state every
 * PLAYHEAD_COMMIT_INTERVAL_MS. That budget was silently lost once — a guard that
 * never held meant every frame committed — and nobody could tell, because the
 * only symptom was a warm CPU. The three numbers below distinguish the cases
 * that feel identical to an operator:
 *
 *   renders/s much above the commit rate  → the React budget is blown again
 *   frames/s well below the display rate  → the main thread is saturated
 *   dropped video frames climbing         → the media pipeline cannot keep up,
 *                                           which is a decode or compositing
 *                                           problem, not a React one
 *
 * Off unless switched on, and switched on from the console rather than at build
 * time, because the reports that matter come from packaged builds:
 *
 *   localStorage.setItem('obs-queuer-playback-probe', '1')  // then reload
 */

import { useEffect, useRef } from 'react'

export interface PlaybackProbe {
  /** Call once per React render of the timeline. */
  countRender(): void
  /** Call once per animation frame. */
  countFrame(): void
}

const OFF: PlaybackProbe = {
  countRender() {},
  countFrame() {},
}

const STORAGE_KEY = 'obs-queuer-playback-probe'
const REPORT_INTERVAL_MS = 1000

export function isProbeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // Storage can be unavailable; an instrument must never be the thing that
    // breaks playback.
    return false
  }
}

/**
 * Report line for one second of playback. Pure, so the arithmetic is testable
 * without a clock, a DOM or a media element.
 */
export function formatProbeReport(input: {
  elapsedMs: number
  renders: number
  frames: number
  droppedVideoFrames: number | null
}): string {
  const seconds = input.elapsedMs / 1000
  const perSec = (n: number): string => (seconds > 0 ? (n / seconds).toFixed(1) : '0.0')
  const dropped = input.droppedVideoFrames === null ? 'n/a' : String(input.droppedVideoFrames)
  return `[playback] ${perSec(input.renders)} renders/s · ${perSec(input.frames)} frames/s · ${dropped} dropped video frames`
}

/**
 * Counts renders and frames while `playing`, and reports once a second.
 *
 * Returns a stable object whose methods are no-ops unless the probe is enabled,
 * so the call sites can be unconditional.
 */
export function usePlaybackProbe(
  playing: boolean,
  getMediaEl: () => HTMLVideoElement | HTMLAudioElement | null,
): PlaybackProbe {
  const enabledRef = useRef<boolean | null>(null)
  if (enabledRef.current === null) enabledRef.current = isProbeEnabled()

  const rendersRef = useRef(0)
  const framesRef = useRef(0)
  const probeRef = useRef<PlaybackProbe | null>(null)
  if (probeRef.current === null) {
    probeRef.current = enabledRef.current
      ? {
          countRender: () => {
            rendersRef.current++
          },
          countFrame: () => {
            framesRef.current++
          },
        }
      : OFF
  }

  useEffect(() => {
    if (!enabledRef.current || !playing) return
    let lastMs = performance.now()
    rendersRef.current = 0
    framesRef.current = 0

    const timer = setInterval(() => {
      const nowMs = performance.now()
      const el = getMediaEl()
      const quality =
        el && 'getVideoPlaybackQuality' in el
          ? (el as HTMLVideoElement).getVideoPlaybackQuality()
          : null
      // eslint-disable-next-line no-console
      console.log(
        formatProbeReport({
          elapsedMs: nowMs - lastMs,
          renders: rendersRef.current,
          frames: framesRef.current,
          droppedVideoFrames: quality ? quality.droppedVideoFrames : null,
        }),
      )
      lastMs = nowMs
      rendersRef.current = 0
      framesRef.current = 0
    }, REPORT_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [playing]) // eslint-disable-line react-hooks/exhaustive-deps

  return probeRef.current
}
