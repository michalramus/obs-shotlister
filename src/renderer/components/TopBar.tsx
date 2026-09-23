import React, { useState } from 'react'
import type { OBSConnectionStatus } from '../../shared/ipc-contract'
import { ProjectSelector } from './ProjectSelector'

// ---------------------------------------------------------------------------
// Indicator derivation
//
// Collapsing a control must not hide the state it was communicating: the
// speaker button stands in for three audio settings and the Connections button
// for two connections, so each needs an at-a-glance summary of what it hides.
// ---------------------------------------------------------------------------

export interface AudioState {
  muteCount: boolean
  muteBeep: boolean
  volume: number
}

export type AudioIndicator = 'on' | 'partial' | 'muted'

export function audioIndicator({ muteCount, muteBeep, volume }: AudioState): AudioIndicator {
  if (volume === 0 || (muteCount && muteBeep)) return 'muted'
  if (muteCount || muteBeep) return 'partial'
  return 'on'
}

export function audioLabel({ muteCount, muteBeep, volume }: AudioState): string {
  const count = muteCount ? 'countdown muted' : 'countdown on'
  const beep = muteBeep ? 'beep muted' : 'beep on'
  return `Audio: ${count}, ${beep}, volume ${Math.round(volume * 100)}%`
}

export interface ConnectionsState {
  obsStatus: OBSConnectionStatus
  oscEnabled: boolean
  oscPort: number
}

/**
 * OBS is the connection a show depends on, so it owns the dot. The OSC server's
 * state is carried in the label and the menu instead.
 */
export function connectionsLabel({ obsStatus, oscEnabled, oscPort }: ConnectionsState): string {
  // "enabled", not "listening": osc:settings:get reports the saved setting, and
  // the OSC server has no runtime status channel the way OBS does.
  const osc = oscEnabled ? `OSC enabled on ${oscPort}` : 'OSC off'
  return `OBS ${obsStatus} · ${osc}`
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const AUDIO_ICON: Record<AudioIndicator, string> = {
  on: '🔊',
  partial: '🔉',
  muted: '🔇',
}

const styles = {
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '10px 16px',
    background: '#1a1a1a',
    borderBottom: '1px solid #333',
    gap: '12px',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  appName: {
    fontSize: '15px',
    fontWeight: 700,
    color: '#fff',
    marginRight: '12px',
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,

  actions: {
    marginLeft: 'auto',
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  } satisfies React.CSSProperties,

  barBtn: {
    padding: '5px 12px',
    background: 'none',
    border: '1px solid #444',
    borderRadius: '4px',
    color: '#888',
    fontSize: '12px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,

  popoverWrapper: {
    position: 'relative' as const,
  } satisfies React.CSSProperties,

  popoverBackdrop: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 99,
  } satisfies React.CSSProperties,

  menu: {
    position: 'absolute' as const,
    right: 0,
    top: '100%',
    marginTop: '4px',
    background: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '4px',
    zIndex: 100,
    minWidth: '190px',
    overflow: 'hidden',
    padding: '4px 0',
  } satisfies React.CSSProperties,

  menuItem: {
    display: 'block',
    width: '100%',
    padding: '7px 14px',
    background: 'none',
    border: 'none',
    color: '#ccc',
    fontSize: '12px',
    cursor: 'pointer',
    textAlign: 'left' as const,
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,

  menuNote: {
    color: '#777',
    marginLeft: '6px',
  } satisfies React.CSSProperties,

  separator: {
    height: '1px',
    background: '#3d3d3d',
    margin: '4px 0',
  } satisfies React.CSSProperties,

  popover: {
    position: 'absolute' as const,
    right: 0,
    top: '100%',
    marginTop: '4px',
    background: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '4px',
    zIndex: 100,
    minWidth: '190px',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  } satisfies React.CSSProperties,

  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    color: '#ccc',
    fontSize: '12px',
  } satisfies React.CSSProperties,

  toggleBtn: (muted: boolean): React.CSSProperties => ({
    padding: '3px 8px',
    background: 'none',
    border: '1px solid #444',
    borderRadius: '4px',
    color: muted ? '#555' : '#888',
    fontSize: '12px',
    cursor: 'pointer',
  }),

  volumeRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    color: '#ccc',
    fontSize: '12px',
  } satisfies React.CSSProperties,

  statusDot: (status: OBSConnectionStatus): React.CSSProperties => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block',
    background: status === 'connected' ? '#27ae60' : status === 'connecting' ? '#f39c12' : '#555',
    flexShrink: 0,
  }),
}

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

export interface TopBarProps {
  flash: boolean

  // Audio
  audio: AudioState
  onToggleMuteCount: () => void
  onToggleMuteBeep: () => void
  onChangeVolume: (volume: number) => void

  // File
  hasActiveProject: boolean
  hasActiveRundown: boolean
  onImportResolve: () => void
  onImportProject: () => void
  onImportRundown: () => void
  onImportDatabase: () => void
  onExportRundown: () => void
  onExportProject: () => void
  onExportDatabase: () => void

  // Connections
  connections: ConnectionsState
  onOpenObsPanel: () => void
  onOpenOscPanel: () => void

  // Project settings
  onOpenCameraConfig: () => void
}

type OpenMenu = 'audio' | 'file' | 'connections' | null

export function TopBar({
  flash,
  audio,
  onToggleMuteCount,
  onToggleMuteBeep,
  onChangeVolume,
  hasActiveProject,
  hasActiveRundown,
  onImportResolve,
  onImportProject,
  onImportRundown,
  onImportDatabase,
  onExportRundown,
  onExportProject,
  onExportDatabase,
  connections,
  onOpenObsPanel,
  onOpenOscPanel,
  onOpenCameraConfig,
}: TopBarProps): React.JSX.Element {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const connectionsTitle = connectionsLabel(connections)

  function toggleMenu(menu: Exclude<OpenMenu, null>): void {
    setOpenMenu((current) => (current === menu ? null : menu))
  }

  /** Runs a menu action and closes the menu it came from. */
  function pick(action: () => void): () => void {
    return () => {
      setOpenMenu(null)
      action()
    }
  }

  const backdrop = <div style={styles.popoverBackdrop} onClick={() => setOpenMenu(null)} />

  return (
    <header
      style={{
        ...styles.header,
        background: flash ? '#888' : '#1a1a1a',
        transition: 'background 0.35s ease-out',
      }}
    >
      <span style={styles.appName}>Shotlister</span>
      <ProjectSelector onOpenCameraConfig={onOpenCameraConfig} />

      <div style={styles.actions}>
        {/* Audio — mute countdown, mute beep, volume */}
        <div style={styles.popoverWrapper}>
          <button
            style={styles.barBtn}
            onClick={() => toggleMenu('audio')}
            title={audioLabel(audio)}
            aria-label={audioLabel(audio)}
            aria-expanded={openMenu === 'audio'}
          >
            {AUDIO_ICON[audioIndicator(audio)]}
          </button>
          {openMenu === 'audio' && (
            <>
              {backdrop}
              <div style={styles.popover}>
                <div style={styles.toggleRow}>
                  <span>Countdown</span>
                  <button
                    style={styles.toggleBtn(audio.muteCount)}
                    onClick={onToggleMuteCount}
                    title={audio.muteCount ? 'Unmute countdown' : 'Mute countdown'}
                    aria-label={audio.muteCount ? 'Unmute countdown' : 'Mute countdown'}
                  >
                    {audio.muteCount ? '🔇' : '🔊'}
                  </button>
                </div>
                <div style={styles.toggleRow}>
                  <span>Beep</span>
                  <button
                    style={styles.toggleBtn(audio.muteBeep)}
                    onClick={onToggleMuteBeep}
                    title={audio.muteBeep ? 'Unmute beep' : 'Mute beep'}
                    aria-label={audio.muteBeep ? 'Unmute beep' : 'Mute beep'}
                  >
                    {audio.muteBeep ? '🔇' : '🔊'}
                  </button>
                </div>
                <div style={styles.volumeRow}>
                  <span>Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={audio.volume}
                    onChange={(e) => onChangeVolume(parseFloat(e.target.value))}
                    style={{ width: 90, accentColor: '#888' }}
                    aria-label="Audio cue volume"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* File — everything that moves data in or out */}
        <div style={styles.popoverWrapper}>
          <button
            style={styles.barBtn}
            onClick={() => toggleMenu('file')}
            aria-expanded={openMenu === 'file'}
          >
            File
          </button>
          {openMenu === 'file' && (
            <>
              {backdrop}
              <div style={styles.menu}>
                {hasActiveRundown && (
                  <>
                    <button
                      style={styles.menuItem}
                      onClick={pick(onImportResolve)}
                      title="Import from DaVinci Resolve CSV"
                    >
                      Import from Resolve
                    </button>
                    <div style={styles.separator} />
                  </>
                )}
                <button style={styles.menuItem} onClick={pick(onImportProject)}>
                  Import project
                </button>
                {hasActiveProject && (
                  <button style={styles.menuItem} onClick={pick(onImportRundown)}>
                    Import rundown
                  </button>
                )}
                <button style={styles.menuItem} onClick={pick(onImportDatabase)}>
                  Import DB
                </button>
                <div style={styles.separator} />
                {hasActiveRundown && (
                  <button style={styles.menuItem} onClick={pick(onExportRundown)}>
                    Export rundown
                  </button>
                )}
                {hasActiveProject && (
                  <button style={styles.menuItem} onClick={pick(onExportProject)}>
                    Export project
                  </button>
                )}
                <button style={styles.menuItem} onClick={pick(onExportDatabase)}>
                  Export DB
                </button>
              </div>
            </>
          )}
        </div>

        {/* Connections — OBS and the OSC server */}
        <div style={styles.popoverWrapper}>
          <button
            style={styles.barBtn}
            onClick={() => toggleMenu('connections')}
            title={connectionsTitle}
            aria-label={connectionsTitle}
            aria-expanded={openMenu === 'connections'}
          >
            <span style={styles.statusDot(connections.obsStatus)} />
            Connections
          </button>
          {openMenu === 'connections' && (
            <>
              {backdrop}
              <div style={styles.menu}>
                <button
                  style={styles.menuItem}
                  onClick={pick(onOpenObsPanel)}
                  title="OBS Connection"
                >
                  OBS<span style={styles.menuNote}>{connections.obsStatus}</span>
                </button>
                <button style={styles.menuItem} onClick={pick(onOpenOscPanel)} title="OSC Server">
                  OSC
                  <span style={styles.menuNote}>
                    {connections.oscEnabled ? `enabled on ${connections.oscPort}` : 'off'}
                  </span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
