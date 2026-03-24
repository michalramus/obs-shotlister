import React from 'react'
import { useAppStore } from '../store'

const s = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 16px',
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
  } satisfies React.CSSProperties,

  btn: (variant: 'primary' | 'danger' | 'secondary' | 'mode-live' | 'mode-edit'): React.CSSProperties => ({
    padding: '6px 14px',
    borderRadius: '4px',
    border: 'none',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '13px',
    background:
      variant === 'primary'
        ? '#27ae60'
        : variant === 'danger'
          ? '#e74c3c'
          : variant === 'mode-live'
            ? '#2980b9'
            : variant === 'mode-edit'
              ? '#3a3a3a'
              : '#3a3a3a',
    color: '#fff',
  }),

  liveBadge: {
    marginLeft: 'auto',
    fontSize: '12px',
    color: '#e74c3c',
    fontWeight: 700,
    letterSpacing: '0.05em',
  } satisfies React.CSSProperties,
}

export function LiveControls(): React.JSX.Element {
  const running = useAppStore((s) => s.running)
  const shots = useAppStore((s) => s.shots)
  const activeRundownId = useAppStore((s) => s.activeRundownId)
  const liveStart = useAppStore((s) => s.liveStart)
  const liveStop = useAppStore((s) => s.liveStop)
  const liveNext = useAppStore((s) => s.liveNext)
  const liveSkipNext = useAppStore((s) => s.liveSkipNext)
  const liveRestart = useAppStore((s) => s.liveRestart)
  const liveIndex = useAppStore((s) => s.liveIndex)
  const uiMode = useAppStore((s) => s.uiMode)
  const setUiMode = useAppStore((s) => s.setUiMode)

  function handleError(label: string, err: unknown): void {
    console.error(`[LiveControls] ${label}:`, err)
  }

  function canStart(): boolean {
    return !running && shots.length > 0 && activeRundownId !== null
  }

  function hasNextShot(): boolean {
    if (!running || liveIndex === null) return false
    return liveIndex + 1 < shots.length
  }

  function canSkipNext(): boolean {
    return hasNextShot()
  }

  if (!running) {
    return (
      <div style={s.bar} data-testid="live-controls">
        <button
          style={s.btn(uiMode === 'edit' ? 'mode-live' : 'mode-edit')}
          onClick={() => setUiMode(uiMode === 'edit' ? 'live' : 'edit')}
          aria-label={uiMode === 'edit' ? 'Switch to live layout' : 'Switch to edit layout'}
        >
          {uiMode === 'edit' ? '→ Live' : '← Edit'}
        </button>
        <button
          style={s.btn('primary')}
          disabled={!canStart()}
          onClick={() => {
            if (activeRundownId) {
              liveStart(activeRundownId).catch((err) => handleError('start', err))
            }
          }}
          aria-label="Start rundown"
        >
          ▶ Start
        </button>
      </div>
    )
  }

  return (
    <div style={s.bar} data-testid="live-controls">
      <button
        style={s.btn(uiMode === 'edit' ? 'mode-live' : 'mode-edit')}
        onClick={() => setUiMode(uiMode === 'edit' ? 'live' : 'edit')}
        aria-label={uiMode === 'edit' ? 'Switch to live layout' : 'Switch to edit layout'}
      >
        {uiMode === 'edit' ? '→ Live' : '← Edit'}
      </button>
      <button
        style={s.btn('danger')}
        onClick={() => liveStop().catch((err) => handleError('stop', err))}
        aria-label="Stop rundown"
      >
        ■ Stop
      </button>

      <button
        style={s.btn('secondary')}
        onClick={() => liveRestart().catch((err) => handleError('restart', err))}
        aria-label="Restart rundown"
      >
        ↺ Restart
      </button>

      <button
        style={s.btn('secondary')}
        disabled={!canSkipNext()}
        onClick={() => liveSkipNext().catch((err) => handleError('skip-next', err))}
        aria-label="Skip next shot"
      >
        ⏭ Skip next
      </button>

      <button
        style={s.btn('primary')}
        onClick={() => liveNext().catch((err) => handleError('next', err))}
        aria-label="Next shot"
      >
        → Next
      </button>

      {!hasNextShot() && liveIndex !== null && (
        <span style={{ fontSize: '12px', color: '#888' }}>last shot</span>
      )}

      <span style={s.liveBadge}>● LIVE</span>
    </div>
  )
}
