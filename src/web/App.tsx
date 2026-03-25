import React, { useEffect, useState } from 'react'
import { io } from 'socket.io-client'
import { useWebStore } from './store'
import { ShotlistWidget } from '../shared/components/ShotlistWidget'
import type { Rundown, Shot, Camera } from '../shared/types'

// Connect to the same origin (Electron's embedded Express server)
const socket = io(window.location.origin, {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: Infinity,
})

const s = {
  root: {
    minHeight: '100vh',
    background: '#0f0f0f',
    color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    display: 'flex',
    flexDirection: 'column' as const,
  } satisfies React.CSSProperties,

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    flexShrink: 0,
    gap: '12px',
  } satisfies React.CSSProperties,

  title: {
    fontSize: '14px',
    fontWeight: 700,
    color: '#fff',
  } satisfies React.CSSProperties,

  statusDot: (connected: boolean): React.CSSProperties => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: connected ? '#27ae60' : '#e74c3c',
    display: 'inline-block',
    marginRight: '6px',
  }),

  statusText: {
    fontSize: '12px',
    color: '#888',
  } satisfies React.CSSProperties,

  content: {
    flex: 1,
    padding: 0,
    overflowY: 'auto' as const,
  } satisfies React.CSSProperties,

  noRundown: {
    textAlign: 'center' as const,
    color: '#444',
    marginTop: '60px',
    fontSize: '14px',
  } satisfies React.CSSProperties,

  cameraSelect: {
    background: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '4px',
    color: '#fff',
    fontSize: '13px',
    padding: '3px 6px',
    cursor: 'pointer',
    flex: 1,
    minWidth: 0,
  } satisfies React.CSSProperties,

  zoomBtn: {
    background: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '4px',
    color: '#fff',
    fontSize: '14px',
    padding: '2px 8px',
    cursor: 'pointer',
    lineHeight: '1',
  } satisfies React.CSSProperties,
}

export default function App(): React.JSX.Element {
  const [zoom, setZoom] = useState<number>(() => {
    const stored = localStorage.getItem('obs-queuer-zoom')
    const parsed = stored !== null ? parseFloat(stored) : NaN
    return isNaN(parsed) ? 1.0 : parsed
  })

  const [selectedCamera, setSelectedCamera] = useState<number | null>(() => {
    try {
      const stored = localStorage.getItem('obs-queuer-camera-filter')
      const parsed = stored !== null ? parseInt(stored, 10) : NaN
      return isNaN(parsed) ? null : parsed
    } catch {
      return null
    }
  })

  function handleCameraChange(num: number | null): void {
    setSelectedCamera(num)
    try { localStorage.setItem('obs-queuer-camera-filter', num !== null ? String(num) : '') } catch {}
  }

  function adjustZoom(delta: number): void {
    setZoom((prev) => {
      const next = Math.round((prev + delta) * 10) / 10
      const clamped = Math.min(2.0, Math.max(0.7, next))
      localStorage.setItem('obs-queuer-zoom', String(clamped))
      return clamped
    })
  }

  const setRundownState = useWebStore((s) => s.setRundownState)
  const setLiveState = useWebStore((s) => s.setLiveState)
  const setPlayback = useWebStore((s) => s.setPlayback)
  const setConnected = useWebStore((s) => s.setConnected)
  const setShotHidden = useWebStore((s) => s.setShotHidden)

  const connected = useWebStore((s) => s.connected)
  const rundown = useWebStore((s) => s.rundown)
  const shots = useWebStore((s) => s.shots)
  const cameras = useWebStore((s) => s.cameras)
  const liveIndex = useWebStore((s) => s.liveIndex)
  const startedAt = useWebStore((s) => s.startedAt)
  const running = useWebStore((s) => s.running)

  useEffect(() => {
    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on(
      'state:rundown',
      (data: { rundown: Rundown | null; shots: Shot[]; cameras: Camera[] }) => {
        setRundownState(data)
      },
    )

    socket.on(
      'state:live',
      (data: { liveIndex: number | null; elapsedMs: number | null }) => {
        setLiveState(data)
      },
    )

    socket.on('state:playback', (data: { running: boolean }) => {
      setPlayback(data)
    })

    socket.on('state:shot:hidden', ({ shotId }: { shotId: string }) => {
      const { shots, liveIndex } = useWebStore.getState()
      const liveShot = liveIndex !== null ? shots[liveIndex] : null
      const transitionMs = liveShot?.transitionMs ?? 0
      if (transitionMs > 0) {
        setTimeout(() => setShotHidden(shotId), transitionMs)
      } else {
        setShotHidden(shotId)
      }
    })

    return () => {
      socket.off('connect')
      socket.off('disconnect')
      socket.off('state:rundown')
      socket.off('state:live')
      socket.off('state:playback')
      socket.off('state:shot:hidden')
    }
  }, [setRundownState, setLiveState, setPlayback, setConnected, setShotHidden])

  return (
    <div style={s.root}>
      <header style={s.header}>
        <span style={s.title}>OBS Queuer</span>

        <button
          style={s.zoomBtn}
          onClick={() => adjustZoom(-0.1)}
          aria-label="Zoom out"
          disabled={zoom <= 0.7}
        >
          −
        </button>
        <button
          style={s.zoomBtn}
          onClick={() => adjustZoom(0.1)}
          aria-label="Zoom in"
          disabled={zoom >= 2.0}
        >
          +
        </button>

        {cameras.length > 0 && (
          <select
            style={s.cameraSelect}
            value={selectedCamera ?? ''}
            onChange={(e) => handleCameraChange(e.target.value === '' ? null : parseInt(e.target.value, 10))}
            aria-label="Filter by camera"
          >
            <option value="">All cameras</option>
            {cameras.map((cam) => (
              <option key={cam.id} value={cam.number}>CAM{cam.number} {cam.name}</option>
            ))}
          </select>
        )}

        <span style={s.statusText}>
          <span style={s.statusDot(connected)} />
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </header>

      <div style={{ ...s.content, zoom: zoom }}>
        {rundown === null ? (
          <div style={s.noRundown}>
            {connected ? 'Waiting for rundown...' : 'Connecting...'}
          </div>
        ) : (
          <ShotlistWidget
            rundownName={rundown.name}
            shots={shots}
            cameras={cameras}
            liveIndex={liveIndex}
            startedAt={startedAt}
            running={running}
            cameraFilter={selectedCamera !== null ? [selectedCamera] : []}
          />
        )}
      </div>
    </div>
  )
}
