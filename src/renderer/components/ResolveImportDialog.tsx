import React, { useState } from 'react'
import { useAppStore } from '../store'
import type { Camera } from '../../shared/types'
import type { ParsedRow } from '../electron-api.d'

const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const

const s = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  } satisfies React.CSSProperties,

  dialog: {
    background: '#1e1e1e',
    border: '1px solid #333',
    borderRadius: '8px',
    padding: '24px',
    width: '600px',
    maxWidth: '90vw',
    maxHeight: '90vh',
    overflowY: 'auto' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
  } satisfies React.CSSProperties,

  heading: {
    fontSize: '16px',
    fontWeight: 700,
    color: '#fff',
    margin: 0,
  } satisfies React.CSSProperties,

  label: {
    fontSize: '12px',
    color: '#888',
    marginBottom: '4px',
  } satisfies React.CSSProperties,

  select: {
    background: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '3px',
    color: '#fff',
    fontSize: '13px',
    padding: '5px 8px',
    minWidth: '160px',
  } satisfies React.CSSProperties,

  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '13px',
  } satisfies React.CSSProperties,

  th: {
    textAlign: 'left' as const,
    color: '#666',
    padding: '4px 8px',
    borderBottom: '1px solid #2a2a2a',
    fontWeight: 600,
    fontSize: '11px',
    textTransform: 'uppercase' as const,
  } satisfies React.CSSProperties,

  td: {
    padding: '5px 8px',
    color: '#ccc',
    borderBottom: '1px solid #1a1a1a',
  } satisfies React.CSSProperties,

  warning: {
    color: '#f39c12',
    fontSize: '12px',
  } satisfies React.CSSProperties,

  radioGroup: {
    display: 'flex',
    gap: '16px',
    fontSize: '13px',
    color: '#ccc',
  } satisfies React.CSSProperties,

  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  } satisfies React.CSSProperties,

  primaryBtn: {
    padding: '8px 16px',
    background: '#27ae60',
    border: 'none',
    borderRadius: '4px',
    color: '#fff',
    fontWeight: 700,
    fontSize: '13px',
    cursor: 'pointer',
  } satisfies React.CSSProperties,

  cancelBtn: {
    padding: '8px 16px',
    background: '#3a3a3a',
    border: 'none',
    borderRadius: '4px',
    color: '#ccc',
    fontSize: '13px',
    cursor: 'pointer',
  } satisfies React.CSSProperties,

  openBtn: {
    padding: '8px 14px',
    background: '#2a4a6a',
    border: '1px solid #3a6a9a',
    borderRadius: '4px',
    color: '#7ec9e7',
    fontSize: '13px',
    cursor: 'pointer',
    fontWeight: 600,
  } satisfies React.CSSProperties,
}

function msToMss(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function parseTimecodeForPreview(tc: string, fps: number): number | null {
  const parts = tc.split(':')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => parseInt(p, 10))
  if (nums.some((n) => isNaN(n))) return null
  const [hh, mm, ss, ff] = nums
  return (hh * 3600 + mm * 60 + ss) * 1000 + Math.round((ff / fps) * 1000)
}

interface Props {
  onClose: () => void
}

export function ResolveImportDialog({ onClose }: Props): React.JSX.Element {
  const cameras = useAppStore((s) => s.cameras)
  const activeRundownId = useAppStore((s) => s.activeRundownId)
  const loadShots = useAppStore((s) => s.loadShots)

  const [fps, setFps] = useState<number>(25)
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [colors, setColors] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [importing, setImporting] = useState(false)
  const [filePicked, setFilePicked] = useState(false)

  async function handlePickFile(): Promise<void> {
    try {
      const result = await window.api.shots.importCsvOpenDialog()
      if (result.canceled || result.filePaths.length === 0) return

      const parsed = await window.api.shots.importCsvParse({ filePath: result.filePaths[0] })
      setRows(parsed.rows)
      setColors(parsed.colors)

      // Pre-fill mapping from camera resolveColor settings
      const initialMapping: Record<string, string | null> = {}
      for (const color of parsed.colors) {
        const cam = cameras.find((c) => c.resolveColor === color)
        initialMapping[color] = cam?.id ?? null
      }
      setMapping(initialMapping)
      setFilePicked(true)
    } catch (err) {
      console.error('[ResolveImportDialog] parse error:', err)
    }
  }

  async function handleImport(): Promise<void> {
    if (!activeRundownId) return
    setImporting(true)
    try {
      await window.api.shots.importCsvConfirm({
        rundownId: activeRundownId,
        mode,
        mapping,
        rows,
        fps,
      })
      await loadShots(activeRundownId)
      onClose()
    } catch (err) {
      console.error('[ResolveImportDialog] confirm error:', err)
    } finally {
      setImporting(false)
    }
  }

  const importableCount = rows.filter((r) => mapping[r.resolveColor] != null).length

  return (
    <div style={s.overlay} data-testid="resolve-import-dialog">
      <div style={s.dialog}>
        <h2 style={s.heading}>Import from DaVinci Resolve</h2>

        {/* FPS selector */}
        <div>
          <div style={s.label}>Timecode FPS</div>
          <select
            style={s.select}
            value={fps}
            onChange={(e) => setFps(parseFloat(e.target.value))}
            aria-label="Timecode FPS"
          >
            {FPS_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>

        {/* File picker */}
        {!filePicked && (
          <button style={s.openBtn} onClick={() => void handlePickFile()}>
            Open CSV file…
          </button>
        )}

        {filePicked && (
          <>
            {/* Color → Camera mapping */}
            {colors.length > 0 && (
              <div>
                <div style={s.label}>Map Resolve colors to cameras</div>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Resolve Color</th>
                      <th style={s.th}>Camera</th>
                    </tr>
                  </thead>
                  <tbody>
                    {colors.map((color) => (
                      <tr key={color}>
                        <td style={s.td}>{color}</td>
                        <td style={s.td}>
                          <select
                            style={s.select}
                            value={mapping[color] ?? ''}
                            onChange={(e) =>
                              setMapping((prev) => ({
                                ...prev,
                                [color]: e.target.value || null,
                              }))
                            }
                            aria-label={`Camera for ${color}`}
                          >
                            <option value="">— unmapped —</option>
                            {cameras.map((c: Camera) => (
                              <option key={c.id} value={c.id}>
                                CAM{c.number} — {c.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Import mode */}
            <div>
              <div style={s.label}>Import mode</div>
              <div style={s.radioGroup}>
                <label>
                  <input
                    type="radio"
                    name="importMode"
                    value="append"
                    checked={mode === 'append'}
                    onChange={() => setMode('append')}
                  />{' '}
                  Append
                </label>
                <label>
                  <input
                    type="radio"
                    name="importMode"
                    value="replace"
                    checked={mode === 'replace'}
                    onChange={() => setMode('replace')}
                  />{' '}
                  Replace
                </label>
              </div>
            </div>

            {/* Preview table */}
            <div>
              <div style={s.label}>Preview ({rows.length} rows)</div>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>#</th>
                    <th style={s.th}>Color</th>
                    <th style={s.th}>Camera</th>
                    <th style={s.th}>Label</th>
                    <th style={s.th}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const camId = mapping[row.resolveColor]
                    const cam = cameras.find((c) => c.id === camId)
                    const durationMs = parseTimecodeForPreview(row.durationTimecode, fps)
                    const isMapped = camId != null

                    return (
                      <tr key={i} style={isMapped ? {} : { opacity: 0.5 }}>
                        <td style={s.td}>{i + 1}</td>
                        <td style={s.td}>{row.resolveColor}</td>
                        <td style={s.td}>
                          {cam ? `CAM${cam.number} ${cam.name}` : <span style={s.warning}>⚠ unmapped</span>}
                        </td>
                        <td style={s.td}>{row.label}</td>
                        <td style={s.td}>
                          {durationMs !== null ? msToMss(durationMs) : row.durationTimecode}
                          {!isMapped && <span style={{ ...s.warning, marginLeft: '4px' }}>← will be skipped</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={onClose} disabled={importing}>
            Cancel
          </button>
          {filePicked && (
            <button
              style={s.primaryBtn}
              onClick={() => void handleImport()}
              disabled={importing || importableCount === 0}
              aria-label={`Import ${importableCount} shots`}
            >
              {importing ? 'Importing…' : `Import ${importableCount} shot${importableCount !== 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
