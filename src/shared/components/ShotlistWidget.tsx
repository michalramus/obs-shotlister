import React, { useEffect, useRef, useState } from 'react'
import type { Shot, Camera } from '../types'
import { formatMs, computeTiming } from '../timing'

export interface ShotlistWidgetProps {
  rundownName: string
  shots: Shot[]
  cameras: Camera[]
  liveIndex: number | null
  startedAt: number | null
  running: boolean
  showNextBackground?: boolean
  autoScroll?: boolean
  cameraFilter?: number[]
  audioBaseUrl?: string
  muteCount?: boolean
  muteBeep?: boolean
  audioVolume?: number // 0–1, default 1
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = {
  widget: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background: '#1a1a1a',
    borderRadius: '6px',
    overflow: 'hidden',
  } satisfies React.CSSProperties,

  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 14px',
    background: '#222',
    borderBottom: '1px solid #333',
  } satisfies React.CSSProperties,

  rundownName: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#ddd',
  } satisfies React.CSSProperties,

  countdown: {
    fontSize: '20px',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums' as const,
    color: '#ff3b30',
  } satisfies React.CSSProperties,

  shotList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  } satisfies React.CSSProperties,

  shotRow: (isLive: boolean, isNext: boolean, showNextBg: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    padding: '8px 14px',
    borderBottom: '1px solid #2a2a2a',
    background: isLive
      ? 'transparent'
      : isNext && showNextBg
        ? 'rgba(46, 204, 113, 0.18)'
        : 'transparent',
    position: 'relative',
    overflow: 'hidden',
  }),

  cameraBadge: (color: string): React.CSSProperties => ({
    background: color,
    color: '#fff',
    fontSize: '11px',
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: '3px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  }),

  cameraName: {
    fontSize: '13px',
    color: '#ccc',
    flexShrink: 0,
    minWidth: '80px',
  } satisfies React.CSSProperties,

  label: {
    fontSize: '13px',
    color: '#888',
    flex: 1,
    wordBreak: 'break-word' as const,
  } satisfies React.CSSProperties,

  timeDisplay: {
    fontSize: '13px',
    fontVariantNumeric: 'tabular-nums' as const,
    color: '#aaa',
    flexShrink: 0,
    minWidth: '60px',
    textAlign: 'right' as const,
  },

  progressTrack: (): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    pointerEvents: 'none',
    overflow: 'hidden',
  }),

  progressBar: (pct: number, isLive: boolean): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: `${pct * 100}%`,
    background: isLive ? '#ff3b30' : '#2ecc71',
    opacity: 0.55,
    transition: 'none',
  }),

  transitionBar: (pct: number): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: `${pct * 100}%`,
    background: '#9b59b6',
    opacity: 0.5,
    transition: 'none',
  }),

  outTransitionBar: (pct: number): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: `${pct * 100}%`,
    background: '#9b59b6',
    opacity: 0.5,
    pointerEvents: 'none',
    transition: 'none',
  }),

  rowContent: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    width: '100%',
  } satisfies React.CSSProperties,

  waitingBar: (pct: number): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: `${pct * 100}%`,
    background: '#2ecc71',
    opacity: 0.25,
    pointerEvents: 'none',
    transition: 'none',
  }),

  emptyState: {
    padding: '24px',
    textAlign: 'center' as const,
    color: '#555',
    fontSize: '14px',
  } satisfies React.CSSProperties,
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ShotlistWidget({
  rundownName,
  shots,
  cameras,
  liveIndex,
  startedAt,
  running,
  showNextBackground = false,
  autoScroll = false,
  cameraFilter,
  audioBaseUrl,
  muteCount = false,
  muteBeep = false,
  audioVolume = 1,
}: ShotlistWidgetProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [headerFlash, setHeaderFlash] = useState(false)
  const rafRef = useRef<number | null>(null)
  const liveRef = useRef<HTMLLIElement | null>(null)
  const waitStartRef = useRef<{ totalMs: number } | null>(null)
  const prevEffectiveDurRef = useRef<number | null>(null)
  const prevLiveIndexRef = useRef<number | null>(null)
  const capturedTransEffectiveDurRef = useRef<number | null>(null)
  const prevRemainingSecRef = useRef<number | null>(null)
  const beepFiredRef = useRef<boolean>(false)
  const prevLiveIndexForAudioRef = useRef<number | null>(null)
  const prevLiveIndexForFilterBeepRef = useRef<number | null>(null)

  // 60fps ticker while running
  useEffect(() => {
    if (!running) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }

    let active = true
    function tick(): void {
      if (!active) return
      const tickNow = Date.now()
      setNow(tickNow)

      // Countdown and natural beep (unfiltered mode only)
      const hasFilterNow = cameraFilter !== undefined && cameraFilter.length > 0
      if (!hasFilterNow && liveIndex !== null && audioBaseUrl) {
        // Reset state on liveIndex change
        if (liveIndex !== prevLiveIndexForAudioRef.current) {
          beepFiredRef.current = false
          prevRemainingSecRef.current = null
          prevLiveIndexForAudioRef.current = liveIndex
        }

        const timingNow = computeTiming(shots, cameras, liveIndex, startedAt, tickNow, cameraFilter)
        const remainingSec =
          timingNow.remainingMs !== null ? Math.floor(timingNow.remainingMs / 1000) : null

        const prevSec = prevRemainingSecRef.current
        if (remainingSec !== null) prevRemainingSecRef.current = remainingSec

        // Helper to play a sound file with volume control
        const playAudio = (filename: string): void => {
          const audio = new Audio(`${audioBaseUrl}/${filename}`)
          audio.volume = audioVolume
          audio.play().catch((err: unknown) => console.error('[ShotlistWidget] audio error:', err))
        }

        // Countdown 3→1: play word at END of that second (when it ticks away)
        // e.g. play 'three' when remainingSec goes from 3 to 2
        if (
          !muteCount &&
          prevSec !== null &&
          remainingSec !== null &&
          remainingSec < prevSec &&
          prevSec >= 1 &&
          prevSec <= 3
        ) {
          const words: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three' }
          playAudio(`${words[prevSec]}.opus`)
        }

        // Beep at expiry: fire once when remainingMs goes negative (timer expired)
        // This is one second after 'one', when the progress bar hits 100%
        if (
          !muteBeep &&
          !beepFiredRef.current &&
          timingNow.remainingMs !== null &&
          timingNow.remainingMs < 0 &&
          prevSec !== null &&
          prevSec >= 0
        ) {
          beepFiredRef.current = true
          playAudio('beep.opus')
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      active = false
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [
    running,
    liveIndex,
    shots,
    cameras,
    startedAt,
    cameraFilter,
    audioBaseUrl,
    muteCount,
    muteBeep,
    audioVolume,
  ])

  // Auto-scroll to live shot when live index changes
  useEffect(() => {
    if (!autoScroll) return
    liveRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [liveIndex, autoScroll])

  // Flash header when live camera changes
  useEffect(() => {
    if (liveIndex === null) return
    setHeaderFlash(true)
    const t = setTimeout(() => setHeaderFlash(false), 350)
    return () => clearTimeout(t)
  }, [liveIndex])

  // Filtered beep: play beep when the filtered camera goes live
  const hasFilterForEffect = cameraFilter !== undefined && cameraFilter.length > 0
  useEffect(() => {
    if (!audioBaseUrl || !running || !hasFilterForEffect || muteBeep || liveIndex === null) return
    if (liveIndex === prevLiveIndexForFilterBeepRef.current) return
    prevLiveIndexForFilterBeepRef.current = liveIndex
    const liveShot = shots[liveIndex]
    if (!liveShot) return
    const liveCam = cameras.find((c) => c.id === liveShot.cameraId)
    if (liveCam && cameraFilter && cameraFilter.includes(liveCam.number)) {
      const audio = new Audio(`${audioBaseUrl}/beep.opus`)
      audio.volume = audioVolume
      audio.play().catch((err: unknown) => console.error('[ShotlistWidget] beep error:', err))
    }
  }, [
    liveIndex,
    running,
    audioBaseUrl,
    hasFilterForEffect,
    muteBeep,
    audioVolume,
    shots,
    cameras,
    cameraFilter,
  ])

  const timing = computeTiming(shots, cameras, liveIndex, startedAt, now, cameraFilter)

  const cameraById = new Map(cameras.map((c) => [c.id, c]))
  const hasFilter = cameraFilter !== undefined && cameraFilter.length > 0
  const visibleShots = shots.filter((s) => {
    if (s.hidden) return false
    if (hasFilter) {
      const cam = cameraById.get(s.cameraId)
      return cam !== undefined && cameraFilter!.includes(cam.number)
    }
    return true
  })

  // Waiting: filter is active and the live shot is not for our camera
  const liveShot = liveIndex !== null ? shots[liveIndex] : null
  const liveCam = liveShot ? cameraById.get(liveShot.cameraId) : undefined
  const isWaiting = hasFilter && liveCam !== undefined && !cameraFilter!.includes(liveCam.number)

  // Capture totalMs once when waiting begins; clear when no longer waiting.
  // Progress is derived from timeUntilNextVisibleMs (not wall-clock) so the bar
  // naturally freezes when the live shot overruns and resumes on the next advance.
  if (!isWaiting) {
    waitStartRef.current = null
  } else if (waitStartRef.current === null && timing.totalTimeUntilNextVisibleMs !== null) {
    waitStartRef.current = { totalMs: timing.totalTimeUntilNextVisibleMs }
  }

  const waitingPct =
    waitStartRef.current !== null && timing.timeUntilNextVisibleMs !== null
      ? Math.min(1, Math.max(0, 1 - timing.timeUntilNextVisibleMs / waitStartRef.current.totalMs))
      : null

  // Capture effectiveDurationMs of the previous live shot for transitioning-out animation
  if (liveIndex !== prevLiveIndexRef.current) {
    capturedTransEffectiveDurRef.current = prevEffectiveDurRef.current
    prevLiveIndexRef.current = liveIndex
    if (liveIndex === null) capturedTransEffectiveDurRef.current = null
  }
  prevEffectiveDurRef.current = timing.effectiveDurationMs

  // Next non-hidden shot's transitionMs — extends live shot's visual row
  let nextNonHiddenTransitionMs = 0
  if (liveIndex !== null) {
    for (let i = liveIndex + 1; i < shots.length; i++) {
      if (!shots[i].hidden) {
        nextNonHiddenTransitionMs = shots[i].transitionMs
        break
      }
    }
  }

  // Last non-hidden shot before live — show red bar continuing through its out-transition zone
  const liveTransitionMs =
    liveIndex !== null && shots[liveIndex] ? shots[liveIndex].transitionMs : 0
  let transitioningOutIndex = -1
  if (liveTransitionMs > 0 && liveIndex !== null) {
    for (let i = liveIndex - 1; i >= 0; i--) {
      if (!shots[i].hidden) {
        transitioningOutIndex = i
        break
      }
    }
  }

  const isTransitioning =
    hasFilter &&
    transitioningOutIndex >= 0 &&
    capturedTransEffectiveDurRef.current !== null &&
    startedAt !== null &&
    liveTransitionMs > 0 &&
    now - startedAt <= liveTransitionMs

  const headerCountdown =
    isTransitioning && startedAt !== null
      ? formatMs(Math.max(0, liveTransitionMs - (now - startedAt)))
      : isWaiting && timing.timeUntilNextVisibleMs !== null
        ? formatMs(timing.timeUntilNextVisibleMs)
        : timing.remainingMs !== null
          ? formatMs(timing.remainingMs)
          : '--:--'

  return (
    <div style={s.widget} data-testid="shotlist-widget">
      <div
        style={{
          ...s.header,
          background: (() => {
            const headerBg = headerFlash
              ? '#666'
              : !running || !hasFilter
                ? '#222'
                : isWaiting
                  ? '#1a4a1a' // dark green = waiting for our camera
                  : '#4a1a1a' // dark red = our camera is live
            return headerBg
          })(),
          transition: 'background 0.35s ease-out',
        }}
      >
        <span style={s.rundownName}>{rundownName}</span>
        <span
          style={{ ...s.countdown, color: isWaiting && !isTransitioning ? '#2ecc71' : '#ff3b30' }}
        >
          {running && <span style={{ fontSize: '12px', marginRight: '4px' }}>▶</span>}
          {headerCountdown}
        </span>
      </div>

      {visibleShots.length === 0 ? (
        <div style={s.emptyState}>No shots</div>
      ) : (
        <ul style={s.shotList}>
          {visibleShots.map((shot) => {
            const shotIndexInAll = shots.indexOf(shot)
            const isLive = timing.liveIndex === shotIndexInAll
            const isNext = timing.nextVisibleIndex === shotIndexInAll

            const camera = cameraById.get(shot.cameraId)

            let timeLabel = formatMs(shot.durationMs)
            let progressPct: number | null = null

            const isTransitioningOut = shotIndexInAll === transitioningOutIndex

            if (isLive && timing.remainingMs !== null) {
              const effectiveDur = timing.effectiveDurationMs ?? shot.durationMs
              const totalVisual = hasFilter
                ? effectiveDur + nextNonHiddenTransitionMs
                : effectiveDur
              timeLabel = formatMs(timing.remainingMs)
              progressPct = totalVisual > 0 ? (effectiveDur - timing.remainingMs) / totalVisual : 0
            }

            if (
              isTransitioningOut &&
              hasFilter &&
              capturedTransEffectiveDurRef.current !== null &&
              startedAt !== null
            ) {
              const transEffectiveDur = capturedTransEffectiveDurRef.current
              const transitionElapsed = Math.min(now - startedAt, liveTransitionMs)
              const totalVisual = transEffectiveDur + liveTransitionMs
              progressPct =
                totalVisual > 0 ? (transEffectiveDur + transitionElapsed) / totalVisual : 1
              timeLabel = formatMs(Math.max(0, liveTransitionMs - transitionElapsed))
            }

            // Waiting bar: on the next-visible shot when operator is waiting (not during transition)
            const showWaitingBar = isWaiting && !isTransitioning && isNext && waitingPct !== null
            if (showWaitingBar && timing.timeUntilNextVisibleMs !== null) {
              timeLabel = formatMs(timing.timeUntilNextVisibleMs)
            }

            const effectiveDuration = timing.effectiveDurationMs ?? shot.durationMs
            const transitionPct =
              shot.transitionMs > 0 && (isLive || isNext)
                ? Math.min(1, shot.transitionMs / (isLive ? effectiveDuration : shot.durationMs))
                : 0

            // Out-transition zone: right-anchored purple on live shot (filter mode only)
            const outTransitionPct =
              isLive && hasFilter && nextNonHiddenTransitionMs > 0
                ? nextNonHiddenTransitionMs / (effectiveDuration + nextNonHiddenTransitionMs)
                : 0

            return (
              <li
                key={shot.id}
                ref={
                  isLive
                    ? (el) => {
                        liveRef.current = el
                      }
                    : undefined
                }
                style={s.shotRow(isLive, isNext, showNextBackground)}
                data-testid={isLive ? 'shot-live' : isNext ? 'shot-next' : 'shot-row'}
                data-shot-id={isLive ? shot.id : undefined}
              >
                {(transitionPct > 0 ||
                  outTransitionPct > 0 ||
                  progressPct !== null ||
                  showWaitingBar) && (
                  <div
                    style={s.progressTrack()}
                    data-testid={
                      isLive
                        ? 'progress-live'
                        : isNext
                          ? 'progress-next'
                          : isTransitioningOut
                            ? 'progress-transitioning-out'
                            : undefined
                    }
                  >
                    {showWaitingBar && waitingPct !== null && (
                      <div style={s.waitingBar(waitingPct)} />
                    )}
                    {transitionPct > 0 && (
                      <div
                        style={s.transitionBar(transitionPct)}
                        data-testid="progress-transition"
                      />
                    )}
                    {outTransitionPct > 0 && (
                      <div
                        style={s.outTransitionBar(outTransitionPct)}
                        data-testid="progress-out-transition"
                      />
                    )}
                    {progressPct !== null && (
                      <div
                        style={s.progressBar(
                          Math.min(1, Math.max(0, progressPct)),
                          isLive || isTransitioningOut,
                        )}
                      />
                    )}
                  </div>
                )}
                <div style={s.rowContent}>
                  {camera && <span style={s.cameraBadge(camera.color)}>CAM{camera.number}</span>}
                  <span style={s.cameraName}>{camera?.name ?? '—'}</span>
                  {shot.label && <span style={s.label}>"{shot.label}"</span>}
                  <span style={s.timeDisplay}>{timeLabel}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
