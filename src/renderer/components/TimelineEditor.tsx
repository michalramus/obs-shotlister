import React, { useEffect, useRef, useState } from 'react'
import type { Shot, Camera } from '../../shared/types'

interface TimelineEditorProps {
  shots: Shot[]
  cameras: Camera[]
  liveIndex: number | null
  running: boolean
  onShotClick: (shotId: string) => void
  onSplitShot: (shotId: string, atMs: number, newCameraId: string) => void
  onResizeShots: (shotAId: string, newDurationA: number, shotBId: string, newDurationB: number) => void
}

const TRACK_HEIGHT = 50
const RULER_HEIGHT = 20
const TOOLBAR_HEIGHT = 32
const MARKER_ROW_HEIGHT = 20
const MEDIA_ROW_HEIGHT = 20
const CAM_BUTTONS_HEIGHT = 36

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

interface DragState {
  shotA: Shot
  shotB: Shot
  startX: number
  origDurA: number
  origDurB: number
}

export function TimelineEditor({
  shots,
  cameras,
  liveIndex,
  running,
  onShotClick,
  onSplitShot,
  onResizeShots,
}: TimelineEditorProps): React.JSX.Element {
  const [zoomPxPerSec, setZoomPxPerSec] = useState(80)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [dragOverride, setDragOverride] = useState<Record<string, number>>({})
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const zoomRef = useRef(zoomPxPerSec)

  // Keep zoomRef in sync so drag handlers always have current value
  useEffect(() => {
    zoomRef.current = zoomPxPerSec
  }, [zoomPxPerSec])

  const totalMs = shots.reduce((sum, s) => sum + s.durationMs, 0)
  const totalPx = Math.max((totalMs / 1000) * zoomPxPerSec, 300)

  // Auto-scroll to live shot
  useEffect(() => {
    if (!running || liveIndex === null || liveIndex < 0 || liveIndex >= shots.length) return
    const container = scrollContainerRef.current
    if (!container) return
    const shotStartMs = shots.slice(0, liveIndex).reduce((sum, s) => sum + s.durationMs, 0)
    const shotStartPx = (shotStartMs / 1000) * zoomPxPerSec
    const shotWidthPx = (shots[liveIndex].durationMs / 1000) * zoomPxPerSec
    const containerWidth = container.clientWidth
    container.scrollLeft = shotStartPx - containerWidth / 2 + shotWidthPx / 2
  }, [liveIndex, running, zoomPxPerSec, shots])

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left + (scrollContainerRef.current?.scrollLeft ?? 0)
    const ms = (x / zoomPxPerSec) * 1000
    setPlayheadMs(Math.max(0, Math.min(ms, totalMs)))
  }

  function handleBlockClick(e: React.MouseEvent, shotId: string): void {
    e.stopPropagation()
    onShotClick(shotId)
  }

  function handleCamButtonClick(camera: Camera): void {
    let accumulated = 0
    for (const shot of shots) {
      const shotStart = accumulated
      const shotEnd = accumulated + shot.durationMs
      if (playheadMs >= shotStart && playheadMs < shotEnd) {
        const atMs = playheadMs - shotStart
        onSplitShot(shot.id, atMs, camera.id)
        return
      }
      accumulated = shotEnd
    }
  }

  function handleBoundaryMouseDown(e: React.MouseEvent, shotA: Shot, shotB: Shot): void {
    e.preventDefault()
    e.stopPropagation()
    dragStateRef.current = {
      shotA,
      shotB,
      startX: e.clientX,
      origDurA: shotA.durationMs,
      origDurB: shotB.durationMs,
    }

    function onMouseMove(ev: MouseEvent): void {
      const ds = dragStateRef.current
      if (!ds) return
      const deltaMs = ((ev.clientX - ds.startX) / zoomRef.current) * 1000
      const newDurA = Math.max(1000, ds.origDurA + deltaMs)
      const newDurB = Math.max(1000, ds.origDurB - deltaMs)
      setDragOverride({ [ds.shotA.id]: newDurA, [ds.shotB.id]: newDurB })
    }

    function onMouseUp(ev: MouseEvent): void {
      const ds = dragStateRef.current
      if (ds) {
        const deltaMs = ((ev.clientX - ds.startX) / zoomRef.current) * 1000
        const newDurA = Math.max(1000, ds.origDurA + deltaMs)
        const newDurB = Math.max(1000, ds.origDurB - deltaMs)
        onResizeShots(ds.shotA.id, newDurA, ds.shotB.id, newDurB)
        dragStateRef.current = null
      }
      setDragOverride({})
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const playheadPx = (playheadMs / 1000) * zoomPxPerSec

  // Build tick marks for ruler
  const ticks: { px: number; major: boolean; label?: string }[] = []
  const minorIntervalMs = 5000
  const majorIntervalMs = 30000
  const endMs = totalMs + majorIntervalMs
  for (let ms = 0; ms <= endMs; ms += minorIntervalMs) {
    const px = (ms / 1000) * zoomPxPerSec
    const major = ms % majorIntervalMs === 0
    ticks.push({ px, major, label: major ? formatTime(ms) : undefined })
  }

  // Camera lookup map
  const cameraMap = new Map(cameras.map((c) => [c.id, c]))

  // Compute shot left offsets using dragOverride durations
  const shotOffsets: number[] = []
  let acc = 0
  for (const shot of shots) {
    shotOffsets.push((acc / 1000) * zoomPxPerSec)
    acc += dragOverride[shot.id] ?? shot.durationMs
  }

  const sortedCameras = [...cameras].sort((a, b) => a.number - b.number)

  return (
    <div
      style={{
        background: '#1a1a1a',
        borderTop: '1px solid #2a2a2a',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        height: `${TOOLBAR_HEIGHT + RULER_HEIGHT + TRACK_HEIGHT + MARKER_ROW_HEIGHT + MEDIA_ROW_HEIGHT + CAM_BUTTONS_HEIGHT}px`,
        overflow: 'hidden',
      }}
    >
      {/* Row 1: Toolbar */}
      <div
        style={{
          height: TOOLBAR_HEIGHT,
          background: '#252525',
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          gap: '6px',
          flexShrink: 0,
          borderBottom: '1px solid #333',
        }}
      >
        <button
          style={{
            background: '#333',
            border: '1px solid #444',
            borderRadius: '3px',
            color: '#ccc',
            fontSize: '14px',
            width: '24px',
            height: '22px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
          onClick={() => setZoomPxPerSec((z) => Math.max(10, z - 10))}
          title="Zoom out"
        >
          −
        </button>
        <button
          style={{
            background: '#333',
            border: '1px solid #444',
            borderRadius: '3px',
            color: '#ccc',
            fontSize: '14px',
            width: '24px',
            height: '22px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
          onClick={() => setZoomPxPerSec((z) => Math.min(400, z + 10))}
          title="Zoom in"
        >
          +
        </button>
        <span style={{ color: '#888', fontSize: '11px', minWidth: '52px', textAlign: 'center' }}>
          {zoomPxPerSec}px/s
        </span>
        <div style={{ flex: 1 }} />
        <button
          disabled
          style={{
            background: 'none',
            border: '1px solid #333',
            borderRadius: '3px',
            color: '#555',
            fontSize: '11px',
            padding: '2px 8px',
            cursor: 'not-allowed',
          }}
          title="Import media — Phase 5"
        >
          Import media
        </button>
      </div>

      {/* Scrollable area: ruler + camera track */}
      <div
        ref={scrollContainerRef}
        style={{
          overflowX: 'auto',
          overflowY: 'hidden',
          flexShrink: 0,
          position: 'relative',
        }}
      >
        {/* Playhead spans ruler + track */}
        <div
          style={{
            position: 'absolute',
            left: playheadPx,
            top: 0,
            width: '2px',
            height: RULER_HEIGHT + TRACK_HEIGHT,
            background: '#e74c3c',
            pointerEvents: 'none',
            zIndex: 20,
          }}
        />

        {/* Row 2: Time ruler */}
        <div
          style={{
            height: RULER_HEIGHT,
            width: totalPx,
            background: '#1a1a1a',
            position: 'relative',
            flexShrink: 0,
          }}
        >
          {ticks.map((tick) => (
            <div
              key={tick.px}
              style={{
                position: 'absolute',
                left: tick.px,
                top: 0,
                height: '100%',
                width: '1px',
                background: '#444',
              }}
            >
              {tick.label !== undefined && (
                <span
                  style={{
                    position: 'absolute',
                    top: '2px',
                    left: '2px',
                    fontSize: '9px',
                    color: '#888',
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                  }}
                >
                  {tick.label}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Row 3: Camera track */}
        <div
          style={{
            height: TRACK_HEIGHT,
            width: totalPx,
            background: '#0d0d0d',
            position: 'relative',
            cursor: 'crosshair',
          }}
          onClick={handleTrackClick}
        >
          {shots.length === 0 ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#555',
                fontSize: '12px',
                pointerEvents: 'none',
              }}
            >
              No shots — create a rundown
            </div>
          ) : (
            shots.map((shot, i) => {
              const cam = cameraMap.get(shot.cameraId)
              const bgColor = cam?.color ?? '#555'
              const leftPx = shotOffsets[i]
              const effectiveDuration = dragOverride[shot.id] ?? shot.durationMs
              const widthPx = (effectiveDuration / 1000) * zoomPxPerSec
              const isLive = liveIndex !== null && shots[liveIndex]?.id === shot.id

              // Transition triangle
              const hasTransition = shot.transitionName !== null && shot.transitionMs > 0
              const triWidthPx = hasTransition ? (shot.transitionMs / 1000) * zoomPxPerSec : 0

              // Boundary handle (rendered after each shot except the last)
              const nextShot = shots[i + 1]
              const boundaryLeftPx = leftPx + widthPx

              return (
                <React.Fragment key={shot.id}>
                  {/* Shot block */}
                  <div
                    style={{
                      position: 'absolute',
                      left: leftPx,
                      top: 0,
                      width: widthPx,
                      height: TRACK_HEIGHT,
                      background: bgColor,
                      boxShadow: isLive ? 'inset 0 0 0 2px white' : undefined,
                      overflow: 'hidden',
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                    onClick={(e) => handleBlockClick(e, shot.id)}
                    title={cam ? `${cam.name} (${shot.durationMs}ms)` : shot.id}
                  >
                    {widthPx > 20 && (
                      <span
                        style={{
                          color: 'white',
                          fontSize: '11px',
                          paddingLeft: '4px',
                          lineHeight: `${TRACK_HEIGHT}px`,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          display: 'block',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {cam ? `${cam.number}` : '?'}
                      </span>
                    )}
                  </div>

                  {/* Transition triangle overlay */}
                  {hasTransition && triWidthPx > 0 && (
                    <svg
                      style={{
                        position: 'absolute',
                        left: leftPx,
                        top: 0,
                        width: triWidthPx,
                        height: TRACK_HEIGHT,
                        pointerEvents: 'none',
                        zIndex: 5,
                      }}
                    >
                      <polygon
                        points={`0,0 ${triWidthPx},${TRACK_HEIGHT / 2} 0,${TRACK_HEIGHT}`}
                        fill="rgba(255,255,255,0.4)"
                      />
                    </svg>
                  )}

                  {/* Boundary drag handle between this shot and the next */}
                  {nextShot !== undefined && (
                    <div
                      style={{
                        position: 'absolute',
                        left: boundaryLeftPx - 4,
                        top: 0,
                        width: 8,
                        height: TRACK_HEIGHT,
                        cursor: 'ew-resize',
                        background: 'transparent',
                        zIndex: 10,
                      }}
                      onMouseDown={(e) => handleBoundaryMouseDown(e, shot, nextShot)}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.2)'
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                      }}
                    />
                  )}
                </React.Fragment>
              )
            })
          )}
        </div>
      </div>

      {/* Row 4: Marker track placeholder — Phase 4 */}
      <div
        style={{
          height: MARKER_ROW_HEIGHT,
          background: '#1e1e1e',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: '8px',
          borderTop: '1px solid #2a2a2a',
        }}
      >
        <span style={{ color: '#444', fontSize: '10px', fontFamily: 'monospace' }}>
          // markers – Phase 4
        </span>
      </div>

      {/* Row 5: Media track placeholder — Phase 5 */}
      <div
        style={{
          height: MEDIA_ROW_HEIGHT,
          background: '#1e1e1e',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: '8px',
          borderTop: '1px solid #2a2a2a',
        }}
      >
        <span style={{ color: '#444', fontSize: '10px', fontFamily: 'monospace' }}>
          // media – Phase 5
        </span>
      </div>

      {/* Row 6: Camera buttons */}
      <div
        style={{
          height: CAM_BUTTONS_HEIGHT,
          background: '#252525',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          gap: '6px',
          borderTop: '1px solid #2a2a2a',
          overflowX: 'auto',
        }}
      >
        {sortedCameras.map((cam) => (
          <button
            key={cam.id}
            style={{
              background: 'none',
              border: '1px solid #555',
              borderRadius: '3px',
              color: '#ccc',
              fontSize: '11px',
              padding: '3px 8px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              whiteSpace: 'nowrap',
            }}
            title={`Split at playhead and assign ${cam.name}`}
            onClick={() => handleCamButtonClick(cam)}
          >
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: cam.color,
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
            + {cam.name}
          </button>
        ))}
        {sortedCameras.length === 0 && (
          <span style={{ color: '#444', fontSize: '11px' }}>No cameras configured</span>
        )}
      </div>
    </div>
  )
}
