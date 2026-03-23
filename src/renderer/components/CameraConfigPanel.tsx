import React, { useState } from 'react'
import { useAppStore } from '../store'
import type { Camera } from '../../shared/types'

// ---------------------------------------------------------------------------
// Resolve marker color options
// ---------------------------------------------------------------------------

export const RESOLVE_COLORS = [
  'Red',
  'Blue',
  'Green',
  'Yellow',
  'Cyan',
  'Pink',
  'Purple',
  'Fuchsia',
  'Rose',
  'Lavender',
  'Sky',
  'Mint',
  'Lemon',
  'Sand',
  'Cocoa',
  'Cream',
] as const

export type ResolveColor = (typeof RESOLVE_COLORS)[number]

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  } satisfies React.CSSProperties,

  panel: {
    background: '#1e1e1e',
    borderRadius: '10px',
    border: '1px solid #444',
    padding: '28px',
    width: '680px',
    maxWidth: '95vw',
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
    overflowY: 'auto' as const,
  } satisfies React.CSSProperties,

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  } satisfies React.CSSProperties,

  title: {
    margin: 0,
    fontSize: '17px',
    fontWeight: 600,
    color: '#fff',
  } satisfies React.CSSProperties,

  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#aaa',
    fontSize: '20px',
    cursor: 'pointer',
    lineHeight: 1,
    padding: '4px 8px',
  } satisfies React.CSSProperties,

  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '14px',
  } satisfies React.CSSProperties,

  th: {
    textAlign: 'left' as const,
    padding: '6px 8px',
    color: '#888',
    fontWeight: 500,
    borderBottom: '1px solid #333',
    fontSize: '12px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } satisfies React.CSSProperties,

  td: {
    padding: '6px 8px',
    verticalAlign: 'middle' as const,
    borderBottom: '1px solid #2a2a2a',
    color: '#ddd',
  } satisfies React.CSSProperties,

  input: {
    padding: '5px 8px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#fff',
    width: '100%',
    boxSizing: 'border-box' as const,
  } satisfies React.CSSProperties,

  numberInput: {
    padding: '5px 8px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#fff',
    width: '56px',
    boxSizing: 'border-box' as const,
  } satisfies React.CSSProperties,

  select: {
    padding: '5px 8px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#fff',
    width: '100%',
    boxSizing: 'border-box' as const,
  } satisfies React.CSSProperties,

  colorSwatch: {
    display: 'inline-block',
    width: '28px',
    height: '28px',
    borderRadius: '4px',
    border: '2px solid #555',
    cursor: 'pointer',
    verticalAlign: 'middle',
  } satisfies React.CSSProperties,

  colorInput: {
    position: 'absolute' as const,
    opacity: 0,
    width: '28px',
    height: '28px',
    cursor: 'pointer',
    top: 0,
    left: 0,
  } satisfies React.CSSProperties,

  colorCell: {
    position: 'relative' as const,
    display: 'inline-block',
  } satisfies React.CSSProperties,

  iconBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    fontSize: '16px',
    padding: '4px',
    borderRadius: '4px',
  } satisfies React.CSSProperties,

  addBtn: {
    padding: '7px 14px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px dashed #555',
    background: 'none',
    color: '#aaa',
    cursor: 'pointer',
    alignSelf: 'flex-start' as const,
  } satisfies React.CSSProperties,

  errorText: {
    color: '#e74c3c',
    fontSize: '13px',
    margin: 0,
  } satisfies React.CSSProperties,

  confirmOverlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1100,
  } satisfies React.CSSProperties,

  confirmDialog: {
    background: '#2a2a2a',
    borderRadius: '8px',
    padding: '24px',
    minWidth: '300px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
    border: '1px solid #444',
  } satisfies React.CSSProperties,

  confirmTitle: {
    margin: 0,
    fontSize: '15px',
    fontWeight: 600,
    color: '#fff',
  } satisfies React.CSSProperties,

  row: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
  } satisfies React.CSSProperties,

  cancelBtn: {
    padding: '6px 14px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#3a3a3a',
    color: '#ccc',
    cursor: 'pointer',
  } satisfies React.CSSProperties,

  dangerBtn: {
    padding: '6px 14px',
    fontSize: '14px',
    borderRadius: '4px',
    border: 'none',
    background: '#c0392b',
    color: '#fff',
    cursor: 'pointer',
  } satisfies React.CSSProperties,
}

// ---------------------------------------------------------------------------
// Delete camera confirmation dialog
// ---------------------------------------------------------------------------

interface DeleteCameraDialogProps {
  camera: Camera
  onCancel: () => void
  onConfirm: () => Promise<void>
}

function DeleteCameraDialog({ camera, onCancel, onConfirm }: DeleteCameraDialogProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete camera.')
      setLoading(false)
    }
  }

  return (
    <div style={s.confirmOverlay} role="dialog" aria-modal="true" aria-labelledby="delete-cam-title">
      <div style={s.confirmDialog}>
        <h3 id="delete-cam-title" style={s.confirmTitle}>
          Delete camera?
        </h3>
        <p style={{ margin: 0, color: '#ccc', fontSize: '14px' }}>
          Delete <strong style={{ color: '#fff' }}>#{camera.number} {camera.name}</strong>? This cannot be undone.
        </p>
        {error !== null && <p style={s.errorText}>{error}</p>}
        <div style={s.row}>
          <button style={s.cancelBtn} onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button style={s.dangerBtn} onClick={() => void handleConfirm()} disabled={loading}>
            {loading ? 'Deleting…' : 'Delete camera'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Camera row — inline edit
// ---------------------------------------------------------------------------

interface CameraRowState {
  number: number
  name: string
  color: string
  resolveColor: string | null
}

interface CameraRowProps {
  camera: Camera
  onRequestDelete: (camera: Camera) => void
}

function CameraRow({ camera, onRequestDelete }: CameraRowProps): React.JSX.Element {
  const upsertCamera = useAppStore((s) => s.upsertCamera)
  const [draft, setDraft] = useState<CameraRowState>({
    number: camera.number,
    name: camera.name,
    color: camera.color,
    resolveColor: camera.resolveColor,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Commit changes on blur from any field
  const handleBlur = async (): Promise<void> => {
    // Avoid saving if nothing changed
    if (
      draft.number === camera.number &&
      draft.name === camera.name &&
      draft.color === camera.color &&
      draft.resolveColor === camera.resolveColor
    ) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await upsertCamera({
        id: camera.id,
        projectId: camera.projectId,
        number: draft.number,
        name: draft.name,
        color: draft.color,
        resolveColor: draft.resolveColor,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr>
      <td style={s.td}>
        <input
          style={s.numberInput}
          type="number"
          min={1}
          value={draft.number}
          aria-label="Camera number"
          onChange={(e) => setDraft((d) => ({ ...d, number: parseInt(e.target.value, 10) || 1 }))}
          onBlur={() => void handleBlur()}
          disabled={saving}
        />
      </td>
      <td style={s.td}>
        <input
          style={s.input}
          type="text"
          value={draft.name}
          aria-label="Camera name"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          onBlur={() => void handleBlur()}
          disabled={saving}
        />
      </td>
      <td style={{ ...s.td, width: '56px' }}>
        <div style={s.colorCell}>
          <div
            style={{ ...s.colorSwatch, background: draft.color }}
            title={draft.color}
          />
          <input
            type="color"
            style={s.colorInput}
            value={draft.color}
            aria-label="Camera color"
            onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
            onBlur={() => void handleBlur()}
            disabled={saving}
          />
        </div>
      </td>
      <td style={s.td}>
        <select
          style={s.select}
          value={draft.resolveColor ?? ''}
          aria-label="Resolve color"
          onChange={(e) => {
            const val = e.target.value
            setDraft((d) => ({ ...d, resolveColor: val === '' ? null : val }))
          }}
          onBlur={() => void handleBlur()}
          disabled={saving}
        >
          <option value="">— None —</option>
          {RESOLVE_COLORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </td>
      <td style={{ ...s.td, width: '48px' }}>
        {error !== null && (
          <span style={{ color: '#e74c3c', fontSize: '12px' }} title={error}>
            ⚠
          </span>
        )}
        <button
          style={s.iconBtn}
          onClick={() => onRequestDelete(camera)}
          title="Delete camera"
          aria-label={`Delete camera ${camera.name}`}
          disabled={saving}
        >
          ✕
        </button>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// New camera row — temporary form at the bottom of the table
// ---------------------------------------------------------------------------

interface NewCameraRowProps {
  projectId: string
  nextNumber: number
  onDone: () => void
}

function NewCameraRow({ projectId, nextNumber, onDone }: NewCameraRowProps): React.JSX.Element {
  const upsertCamera = useAppStore((s) => s.upsertCamera)
  const [number, setNumber] = useState(nextNumber)
  const [name, setName] = useState('')
  const [color, setColor] = useState('#4a90d9')
  const [resolveColor, setResolveColor] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async (): Promise<void> => {
    if (!name.trim()) {
      setError('Name is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await upsertCamera({ projectId, number, name: name.trim(), color, resolveColor })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add camera.')
      setSaving(false)
    }
  }

  return (
    <tr>
      <td style={s.td}>
        <input
          style={s.numberInput}
          type="number"
          min={1}
          value={number}
          aria-label="Camera number"
          onChange={(e) => setNumber(parseInt(e.target.value, 10) || 1)}
          disabled={saving}
        />
      </td>
      <td style={s.td}>
        <input
          autoFocus
          style={s.input}
          type="text"
          placeholder="Camera name"
          value={name}
          aria-label="Camera name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSave()
            if (e.key === 'Escape') onDone()
          }}
          disabled={saving}
        />
      </td>
      <td style={{ ...s.td, width: '56px' }}>
        <div style={s.colorCell}>
          <div style={{ ...s.colorSwatch, background: color }} title={color} />
          <input
            type="color"
            style={s.colorInput}
            value={color}
            aria-label="Camera color"
            onChange={(e) => setColor(e.target.value)}
            disabled={saving}
          />
        </div>
      </td>
      <td style={s.td}>
        <select
          style={s.select}
          value={resolveColor ?? ''}
          aria-label="Resolve color"
          onChange={(e) => setResolveColor(e.target.value === '' ? null : e.target.value)}
          disabled={saving}
        >
          <option value="">— None —</option>
          {RESOLVE_COLORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </td>
      <td style={{ ...s.td, width: '48px', whiteSpace: 'nowrap' }}>
        {error !== null && (
          <span style={{ color: '#e74c3c', fontSize: '12px', marginRight: '4px' }} title={error}>
            ⚠
          </span>
        )}
        <button
          style={{ ...s.iconBtn, color: '#4a90d9' }}
          onClick={() => void handleSave()}
          title="Save camera"
          aria-label="Save new camera"
          disabled={saving}
        >
          ✓
        </button>
        <button
          style={s.iconBtn}
          onClick={onDone}
          title="Cancel"
          aria-label="Cancel new camera"
          disabled={saving}
        >
          ✕
        </button>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// CameraConfigPanel — modal
// ---------------------------------------------------------------------------

interface CameraConfigPanelProps {
  onClose: () => void
}

export function CameraConfigPanel({ onClose }: CameraConfigPanelProps): React.JSX.Element {
  const cameras = useAppStore((s) => s.cameras)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const removeCamera = useAppStore((s) => s.removeCamera)

  const [addingNew, setAddingNew] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Camera | null>(null)

  const nextNumber = cameras.length > 0 ? Math.max(...cameras.map((c) => c.number)) + 1 : 1

  const handleConfirmDelete = async (): Promise<void> => {
    if (pendingDelete === null) return
    await removeCamera(pendingDelete.id)
    setPendingDelete(null)
  }

  if (activeProjectId === null) return <></>

  return (
    <>
      <div style={s.overlay} role="dialog" aria-modal="true" aria-labelledby="camera-config-title">
        <div style={s.panel}>
          <div style={s.header}>
            <h2 id="camera-config-title" style={s.title}>
              Cameras
            </h2>
            <button style={s.closeBtn} onClick={onClose} aria-label="Close camera configuration">
              ✕
            </button>
          </div>

          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>#</th>
                <th style={s.th}>Name</th>
                <th style={s.th}>Color</th>
                <th style={s.th}>Resolve color</th>
                <th style={s.th} />
              </tr>
            </thead>
            <tbody>
              {cameras.map((cam) => (
                <CameraRow
                  key={cam.id}
                  camera={cam}
                  onRequestDelete={setPendingDelete}
                />
              ))}
              {addingNew && (
                <NewCameraRow
                  projectId={activeProjectId}
                  nextNumber={nextNumber}
                  onDone={() => setAddingNew(false)}
                />
              )}
            </tbody>
          </table>

          {!addingNew && (
            <button style={s.addBtn} onClick={() => setAddingNew(true)}>
              + Add camera
            </button>
          )}
        </div>
      </div>

      {pendingDelete !== null && (
        <DeleteCameraDialog
          camera={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={handleConfirmDelete}
        />
      )}
    </>
  )
}
