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

  filterBar: {
    padding: '10px 16px',
    borderBottom: '1px solid #2a2a2a',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap' as const,
  } satisfies React.CSSProperties,

  filterLabel: {
    fontSize: '12px',
    color: '#666',
  } satisfies React.CSSProperties,

  pill: (active: boolean, color: string): React.CSSProperties => ({
    padding: '4px 10px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: 700,
    cursor: 'pointer',
    border: 'none',
    background: active ? color : '#2a2a2a',
    color: active ? '#fff' : '#666',
    userSelect: 'none',
  }),

  content: {
    flex: 1,
    padding: '12px',
    overflowY: 'auto' as const,
  } satisfies React.CSSProperties,

  noRundown: {
    textAlign: 'center' as const,
    color: '#444',
    marginTop: '60px',
    fontSize: '14px',
  } satisfies React.CSSProperties,
}

export default function App(): React.JSX.Element {
  const setRundownState = useWebStore((s) => s.setRundownState)
  const setLiveState = useWebStore((s) => s.setLiveState)
  const setPlayback = useWebStore((s) => s.setPlayback)
  const setConnected = useWebStore((s) => s.setConnected)
  const toggleCameraFilter = useWebStore((s) => s.toggleCameraFilter)

  const connected = useWebStore((s) => s.connected)
  const rundown = useWebStore((s) => s.rundown)
  const shots = useWebStore((s) => s.shots)
  const cameras = useWebStore((s) => s.cameras)
  const liveIndex = useWebStore((s) => s.liveIndex)
  const startedAt = useWebStore((s) => s.startedAt)
  const skippedIds = useWebStore((s) => s.skippedIds)
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
      (data: { liveIndex: number | null; startedAt: number | null; skippedIds: string[] }) => {
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

  // "All cameras" when filter is empty = show all
  const effectiveFilter = cameraFilter.length === 0 ? undefined : cameraFilter

  return (
    <div style={s.root}>
      <header style={s.header}>
        <span style={s.title}>OBS Queuer</span>
        <span style={s.statusText}>
          <span style={s.statusDot(connected)} />
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </header>

      {cameras.length > 0 && (
        <div style={s.filterBar}>
          <span style={s.filterLabel}>Camera filter:</span>
          {cameras.map((cam) => {
            const isActive =
              cameraFilter.length === 0 || cameraFilter.includes(cam.number)
            return (
              <button
                key={cam.id}
                style={s.pill(isActive, cam.color)}
                onClick={() => toggleCameraFilter(cam.number)}
                aria-label={`Toggle CAM${cam.number}`}
                aria-pressed={isActive}
              >
                CAM{cam.number}
              </button>
            )
          })}
        </div>
      )}

      <div style={s.content}>
        {rundown === null ? (
          <div style={s.noRundown}>
            {connected ? 'Waiting for rundown…' : 'Connecting…'}
          </div>
        ) : (
          <ShotlistWidget
            rundownName={rundown.name}
            shots={shots}
            cameras={cameras}
            liveIndex={liveIndex}
            startedAt={startedAt}
            running={running}
            skippedIds={skippedIds}
            cameraFilter={effectiveFilter}
          />
        )}
      </div>
    </div>
  )
}
