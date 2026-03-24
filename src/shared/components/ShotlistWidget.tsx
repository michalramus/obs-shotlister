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
  cameraFilter?: number[]
  showNextBackground?: boolean
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = {
  widget: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background: '#1a1a1a',
    borderRadius: '6px',
    overflow: 'clip', // clip for border-radius but don't intercept scrollIntoView
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
    alignItems: 'center',
    gap: '8px',
    padding: '8px 14px',
    borderBottom: '1px solid #2a2a2a',
    background: isLive ? 'transparent' : (isNext && showNextBg) ? 'rgba(46, 204, 113, 0.18)' : 'transparent',
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
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
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

  transitionBarRight: (leftPct: number, widthPct: number): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: `${leftPct * 100}%`,
    width: `${widthPct * 100}%`,
    background: '#9b59b6',
    opacity: 0.5,
    transition: 'none',
  }),

  progressBarRight: (pct: number): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: `${pct * 100}%`,
    background: '#2ecc71',
    opacity: 0.55,
    transition: 'none',
  }),

  rowContent: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
  } satisfies React.CSSProperties,

  emptyState: {
    padding: '24px',
    textAlign: 'center' as const,
    color: '#555',
    fontSize: '14px',
  } satisfies React.CSSProperties,

  liveBadge: {
    fontSize: '11px',
    color: '#e74c3c',
    fontWeight: 700,
    marginLeft: '4px',
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
  cameraFilter,
  showNextBackground = false,
}: ShotlistWidgetProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [headerFlash, setHeaderFlash] = useState(false)
  const rafRef = useRef<number | null>(null)
  const liveRef = useRef<HTMLLIElement | null>(null)
  // Track total wait for the current "next visible shot" period.
  // Reset only when nextVisibleIndex changes (not when startedAt changes).
  // This keeps the bar stable when operator advances filtered-out shots.
  const nextTotalWaitRef = useRef<number | null>(null)
  const prevNextVisibleIndexRef = useRef<number | null | undefined>(undefined)
  const [postTransition, setPostTransition] = useState<{
    shotIndex: number
    startedAt: number
    durationMs: number
    effectiveDurationMs: number
  } | null>(null)
  const prevLiveIndexRef = useRef<number | null>(null)
  // Stable refs so the liveIndex effect can read current values without re-running
  const shotsRef = useRef(shots)
  const camerasRef = useRef(cameras)
  const cameraFilterRef = useRef(cameraFilter)

  // 60fps ticker when running OR during post-transition animation
  const shouldTick = running || postTransition !== null
  useEffect(() => {
    if (!shouldTick) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }

    let active = true
    function tick(): void {
      if (!active) return
      setNow(Date.now())
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
  }, [shouldTick])

  // Auto-scroll to live shot when liveIndex changes
  useEffect(() => {
    liveRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [liveIndex])

  // Flash header white on camera change
  useEffect(() => {
    if (liveIndex === null) return
    setHeaderFlash(true)
    const t = setTimeout(() => setHeaderFlash(false), 350)
    return () => clearTimeout(t)
  }, [liveIndex])

  // Keep refs current so the liveIndex effect reads latest values without restarts
  shotsRef.current = shots
  camerasRef.current = cameras
  cameraFilterRef.current = cameraFilter

  // Post-transition: when liveIndex advances to a filtered-out shot with a transition,
  // keep showing the previous shot as "live" for the duration of that transition.
  useEffect(() => {
    const prevIdx = prevLiveIndexRef.current
    prevLiveIndexRef.current = liveIndex

    if (liveIndex === null || prevIdx === null) {
      setPostTransition(null)
      return
    }

    const filter = cameraFilterRef.current
    if (!filter || filter.length === 0) {
      setPostTransition(null)
      return
    }

    const allShots = shotsRef.current
    const allCameras = camerasRef.current
    const newShot = allShots[liveIndex]
    if (!newShot || newShot.transitionMs === 0) {
      setPostTransition(null)
      return
    }

    const camNumById = new Map(allCameras.map((c) => [c.id, c.number]))
    const newShotNum = camNumById.get(newShot.cameraId)
    if (newShotNum !== undefined && filter.includes(newShotNum)) {
      setPostTransition(null)
      return
    }

    // New shot is filtered out AND has transition — hold previous shot as "live"
    let effectiveDurationMs = allShots[prevIdx]?.durationMs ?? 0
    for (let i = prevIdx + 1; i < allShots.length; i++) {
      if (allShots[i].hidden) effectiveDurationMs += allShots[i].durationMs
      else break
    }

    setPostTransition({
      shotIndex: prevIdx,
      startedAt: Date.now(),
      durationMs: newShot.transitionMs,
      effectiveDurationMs,
    })

    const timer = setTimeout(() => setPostTransition(null), newShot.transitionMs)
    return () => clearTimeout(timer)
  }, [liveIndex])

  const timing = computeTiming(shots, cameras, liveIndex, startedAt, now, cameraFilter)

  // When the next visible shot changes, capture the total wait for that new period.
  // Stays fixed while nextVisibleIndex is the same, so the bar never resets mid-wait.
  if (timing.nextVisibleIndex !== prevNextVisibleIndexRef.current) {
    prevNextVisibleIndexRef.current = timing.nextVisibleIndex
    nextTotalWaitRef.current = timing.timeUntilNextVisibleMs
  }

  const cameraById = new Map(cameras.map((c) => [c.id, c]))
  const cameraNumberById = new Map(cameras.map((c) => [c.id, c.number]))

  const hasFilter = cameraFilter !== undefined && cameraFilter.length > 0

  function passesFilter(shot: Shot): boolean {
    if (!hasFilter) return true
    const num = cameraNumberById.get(shot.cameraId)
    return num !== undefined && cameraFilter!.includes(num)
  }

  // Transition time of the first non-hidden filtered-out shot after live.
  // In filter mode this warns the operator their camera stays on-screen during
  // the transition even though the live shot has ended.
  let filteredNextTransitionMs = 0
  if (hasFilter && timing.liveIndex !== null) {
    for (let i = timing.liveIndex + 1; i < shots.length; i++) {
      if (!shots[i].hidden) {
        if (!passesFilter(shots[i]) && shots[i].transitionMs > 0) {
          filteredNextTransitionMs = shots[i].transitionMs
        }
        break
      }
    }
  }

  const visibleShots = shots.filter((s) => !s.hidden && passesFilter(s))

  // Post-transition override: keep previous shot as "live" during transition
  const postTrans = postTransition
  const isPostTransitionActive = postTrans !== null && (now - postTrans.startedAt) < postTrans.durationMs
  const effectiveLiveIndex = isPostTransitionActive ? postTrans.shotIndex : timing.liveIndex
  // Don't show filteredNextTransitionMs preview while post-transition is already running
  const displayFilteredNextTransitionMs = isPostTransitionActive ? 0 : filteredNextTransitionMs

  const liveShot = timing.liveIndex !== null ? shots[timing.liveIndex] : null
  const showNextBar = hasFilter && (liveShot == null || !passesFilter(liveShot))

  const isWaitingForFiltered = showNextBar && timing.timeUntilNextVisibleMs !== null
  const headerCountdown = isWaitingForFiltered
    ? formatMs(timing.timeUntilNextVisibleMs!)
    : timing.remainingMs !== null ? formatMs(timing.remainingMs) : '--:--'
  const headerCountdownColor = isWaitingForFiltered ? '#2ecc71' : '#ff3b30'

  return (
    <div style={s.widget} data-testid="shotlist-widget">
      <div style={{ ...s.header, background: headerFlash ? '#666' : '#222', transition: 'background 0.35s ease-out' }}>
        <span style={s.rundownName}>{rundownName}</span>
        <span style={{ ...s.countdown, color: headerCountdownColor }}>
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
            const isLive = effectiveLiveIndex === shotIndexInAll
            const isNext = timing.nextVisibleIndex === shotIndexInAll

            const camera = cameraById.get(shot.cameraId)

            let timeLabel = formatMs(shot.durationMs)
            let progressPct: number | null = null

            if (isLive && isPostTransitionActive && postTrans) {
              const elapsed = now - postTrans.startedAt
              const totalMs = postTrans.effectiveDurationMs + postTrans.durationMs
              timeLabel = formatMs(Math.max(0, postTrans.durationMs - elapsed))
              progressPct = Math.min(1, (postTrans.effectiveDurationMs + elapsed) / totalMs)
            } else if (isLive && timing.remainingMs !== null) {
              const effectiveDur = timing.effectiveDurationMs ?? shot.durationMs
              const totalMs = effectiveDur + displayFilteredNextTransitionMs
              timeLabel = formatMs(timing.remainingMs + displayFilteredNextTransitionMs)
              progressPct = displayFilteredNextTransitionMs > 0
                ? (effectiveDur - timing.remainingMs) / totalMs
                : 1 - timing.remainingMs / effectiveDur
            } else if (isNext && showNextBar && timing.timeUntilNextVisibleMs !== null) {
              timeLabel = formatMs(timing.timeUntilNextVisibleMs)
              // Use the total wait captured when this shot first became "next".
              // Bar grows 0→1 from right-to-left as the wait counts down to zero.
              const totalWait = nextTotalWaitRef.current ?? timing.timeUntilNextVisibleMs
              progressPct = totalWait > 0
                ? Math.min(1, Math.max(0, 1 - timing.timeUntilNextVisibleMs / totalWait))
                : 1
            }

            const effectiveDuration = timing.effectiveDurationMs ?? shot.durationMs
            const transitionPct = shot.transitionMs > 0 && (isLive || isNext)
              ? Math.min(1, shot.transitionMs / (isLive ? effectiveDuration : shot.durationMs))
              : 0

            return (
              <li
                key={shot.id}
                ref={isLive ? (el) => { liveRef.current = el } : undefined}
                style={s.shotRow(isLive, isNext, showNextBackground)}
                data-testid={isLive ? 'shot-live' : isNext ? 'shot-next' : 'shot-row'}
                data-shot-id={isLive ? shot.id : undefined}
              >
                {(transitionPct > 0 || progressPct !== null) && (
                  <div
                    style={s.progressTrack()}
                    data-testid={isLive ? 'progress-live' : isNext ? 'progress-next' : undefined}
                  >
                    {transitionPct > 0 && (
                      <div style={s.transitionBar(transitionPct)} data-testid="progress-transition" />
                    )}
                    {progressPct !== null && (
                      isNext
                        ? <div style={s.progressBarRight(Math.min(1, Math.max(0, progressPct)))} />
                        : <div style={s.progressBar(Math.min(1, Math.max(0, progressPct)), isLive)} />
                    )}
                    {isLive && isPostTransitionActive && postTrans && (
                      <div
                        style={s.transitionBarRight(
                          postTrans.effectiveDurationMs / (postTrans.effectiveDurationMs + postTrans.durationMs),
                          postTrans.durationMs / (postTrans.effectiveDurationMs + postTrans.durationMs),
                        )}
                        data-testid="progress-transition-right"
                      />
                    )}
                    {isLive && !isPostTransitionActive && displayFilteredNextTransitionMs > 0 && timing.effectiveDurationMs !== null && (
                      <div
                        style={s.transitionBarRight(
                          timing.effectiveDurationMs / (timing.effectiveDurationMs + displayFilteredNextTransitionMs),
                          displayFilteredNextTransitionMs / (timing.effectiveDurationMs + displayFilteredNextTransitionMs),
                        )}
                        data-testid="progress-transition-right"
                      />
                    )}
                  </div>
                )}
                <div style={s.rowContent}>
                  {camera && (
                    <span style={s.cameraBadge(camera.color)}>CAM{camera.number}</span>
                  )}
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
