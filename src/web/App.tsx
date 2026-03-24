import React, { useEffect } from 'react'
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

  select: {
    background: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '4px',
    color: '#fff',
    fontSize: '12px',
    padding: '4px 8px',
  } satisfies React.CSSProperties,
}

export default function App(): React.JSX.Element {
  const setRundownState = useWebStore((s) => s.setRundownState)
  const setLiveState = useWebStore((s) => s.setLiveState)
  const setPlayback = useWebStore((s) => s.setPlayback)
  const setConnected = useWebStore((s) => s.setConnected)
  const setCameraFilter = useWebStore((s) => s.setCameraFilter)

  const connected = useWebStore((s) => s.connected)
  const rundown = useWebStore((s) => s.rundown)
  const shots = useWebStore((s) => s.shots)
  const cameras = useWebStore((s) => s.cameras)
  const liveIndex = useWebStore((s) => s.liveIndex)
  const startedAt = useWebStore((s) => s.startedAt)
  const running = useWebStore((s) => s.running)
  const cameraFilter = useWebStore((s) => s.cameraFilter)

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

    return () => {
      socket.off('connect')
      socket.off('disconnect')
      socket.off('state:rundown')
      socket.off('state:live')
      socket.off('state:playback')
    }
  }, [setRundownState, setLiveState, setPlayback, setConnected])

  function getCamerasToShow(): Camera[] {
    if (cameras.length > 0) return cameras
    try {
      const saved = localStorage.getItem('obs-queuer-cameras')
      if (saved) return JSON.parse(saved) as Camera[]
    } catch {}
    return []
  }

  const camerasToShow = getCamerasToShow()
  const selectedCam = cameraFilter.length === 0 ? 'all' : cameraFilter[0].toString()

  // "All cameras" when filter is empty = show all
  const effectiveFilter = cameraFilter.length === 0 ? undefined : cameraFilter

  return (
    <div style={s.root}>
      <header style={s.header}>
        <span style={s.title}>OBS Queuer</span>

        {camerasToShow.length > 0 && (
          <select
            style={s.select}
            value={selectedCam}
            onChange={(e) => setCameraFilter(e.target.value === 'all' ? null : parseInt(e.target.value, 10))}
            aria-label="Camera filter"
          >
            <option value="all">All cameras</option>
            {camerasToShow.map((cam) => (
              <option key={cam.id} value={cam.number}>
                CAM{cam.number} - {cam.name}
              </option>
            ))}
          </select>
        )}

        <span style={s.statusText}>
          <span style={s.statusDot(connected)} />
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </header>

      <div style={s.content}>
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
            cameraFilter={effectiveFilter}
          />
        )}
      </div>
    </div>
  )
}
