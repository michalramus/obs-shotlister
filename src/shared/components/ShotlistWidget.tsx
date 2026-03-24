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
    color: '#e74c3c',
  } satisfies React.CSSProperties,

  shotList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  } satisfies React.CSSProperties,

  shotRow: (isLive: boolean, isNext: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 14px',
    borderBottom: '1px solid #2a2a2a',
    background: isLive ? '#1e2d1e' : isNext ? '#1e1e2d' : 'transparent',
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
    background: isLive ? '#e74c3c' : '#3498db',
    opacity: 0.18,
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
}: ShotlistWidgetProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const rafRef = useRef<number | null>(null)
  const liveRef = useRef<HTMLLIElement | null>(null)
  // Track total wait for the current "next visible shot" period.
  // Reset only when nextVisibleIndex changes (not when startedAt changes).
  // This keeps the bar stable when operator advances filtered-out shots.
  const nextTotalWaitRef = useRef<number | null>(null)
  const prevNextVisibleIndexRef = useRef<number | null | undefined>(undefined)

  // 60fps ticker when running
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
  }, [running])

  // Auto-scroll to live shot when liveIndex changes
  useEffect(() => {
    liveRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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

  const visibleShots = shots.filter(passesFilter)

  const headerCountdown = timing.remainingMs !== null ? formatMs(timing.remainingMs) : '--:--'

  return (
    <div style={s.widget} data-testid="shotlist-widget">
      <div style={s.header}>
        <span style={s.rundownName}>{rundownName}</span>
        <span style={s.countdown}>
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

            if (isLive && timing.remainingMs !== null) {
              timeLabel = formatMs(timing.remainingMs)
              progressPct = 1 - timing.remainingMs / shot.durationMs
            } else if (isNext && timing.timeUntilNextVisibleMs !== null) {
              timeLabel = formatMs(timing.timeUntilNextVisibleMs)
              // Use the total wait captured when this shot first became "next".
              // progressPct = 1 - (remaining / original total) so the bar fills
              // monotonically and never resets when operator advances filtered shots.
              const totalWait = nextTotalWaitRef.current ?? timing.timeUntilNextVisibleMs
              progressPct = totalWait > 0
                ? Math.min(1, Math.max(0, 1 - timing.timeUntilNextVisibleMs / totalWait))
                : 1
            }

            return (
              <li
                key={shot.id}
                ref={isLive ? (el) => { liveRef.current = el } : undefined}
                style={s.shotRow(isLive, isNext)}
                data-testid={isLive ? 'shot-live' : isNext ? 'shot-next' : 'shot-row'}
                data-shot-id={isLive ? shot.id : undefined}
              >
                {progressPct !== null && (
                  <div
                    style={s.progressTrack()}
                    data-testid={isLive ? 'progress-live' : 'progress-next'}
                  >
                    <div style={s.progressBar(Math.min(1, Math.max(0, progressPct)), isLive)} />
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
