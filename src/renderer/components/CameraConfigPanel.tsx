import React, { useState } from 'react'
import { useAppStore } from '../store'
import type { Camera } from '../../shared/types'
import { nextCameraColor } from '../../shared/camera-palette'
import { ps } from './panel-styles'
import { ColorSwatch, PaletteStrip } from './ColorPicker'
import { ConfirmDestructive } from './ConfirmDestructive'
import { useDraftRow } from './use-draft-row'

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
// Refusals
// ---------------------------------------------------------------------------

/**
 * What a refused delete means, in the operator's terms.
 *
 * Deleting a Camera a Shot still points at trips the foreign key, and the raw
 * `SqliteError: FOREIGN KEY constraint failed` says neither that Shots are the
 * reason nor what to do. The count belongs in the main process, which can
 * actually run it — every Rundown's Shots, not just the open one's — so this
 * names the cause without pretending to a number it cannot get.
 */
export function describeCameraDeleteError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/FOREIGN KEY/i.test(message)) {
    return 'Shots still use this camera. Point those shots at another camera, or delete them, and then delete the camera.'
  }
  return message === '' ? 'Failed to delete camera.' : message
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = {
  ...ps,

  errorMark: {
    color: '#e74c3c',
    fontSize: '12px',
  } satisfies React.CSSProperties,
}

// ---------------------------------------------------------------------------
// Camera row — inline edit (no OBS scene column)
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
  const upsertCamera = useAppStore((st) => st.upsertCamera)
  const row = useDraftRow<CameraRowState>(
    {
      number: camera.number,
      name: camera.name,
      color: camera.color,
      resolveColor: camera.resolveColor,
    },
    async (draft) => {
      await upsertCamera({
        id: camera.id,
        projectId: camera.projectId,
        number: draft.number,
        name: draft.name,
        color: draft.color,
        resolveColor: draft.resolveColor,
        // The scene is not edited here, but it is written here: the main process
        // rewrites every column, so it has to be carried through. It comes from
        // the store, which the OBS panel writes through too — a scene set there
        // and a rename here are the same Camera.
        obsScene: camera.obsScene ?? null,
      })
    },
  )

  return (
    <tr>
      <td style={s.td}>
        <input
          style={s.numberInput}
          type="number"
          min={1}
          value={row.draft.number}
          aria-label="Camera number"
          onChange={(e) => row.set({ number: parseInt(e.target.value, 10) || 1 })}
          onBlur={row.commit}
          disabled={row.saving}
        />
      </td>
      <td style={s.td}>
        <input
          style={s.cellInput}
          type="text"
          value={row.draft.name}
          aria-label="Camera name"
          onChange={(e) => row.set({ name: e.target.value })}
          onBlur={row.commit}
          disabled={row.saving}
        />
      </td>
      <td style={{ ...s.td, width: '56px' }}>
        <ColorSwatch
          value={row.draft.color}
          label="Camera color"
          onChange={(color) => row.set({ color })}
          onBlur={row.commit}
          disabled={row.saving}
        />
        <PaletteStrip
          selected={row.draft.color}
          onPick={(color) => row.pick({ color })}
          disabled={row.saving}
        />
      </td>
      <td style={s.td}>
        <select
          style={s.select}
          value={row.draft.resolveColor ?? ''}
          aria-label="Resolve color"
          onChange={(e) => row.set({ resolveColor: e.target.value === '' ? null : e.target.value })}
          onBlur={row.commit}
          disabled={row.saving}
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
        {row.error !== null && (
          <span style={s.errorMark} title={row.error}>
            ⚠
          </span>
        )}
        <button
          style={s.iconBtn}
          onClick={() => onRequestDelete(camera)}
          title="Delete camera"
          aria-label={`Delete camera ${camera.name}`}
          disabled={row.saving}
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
  const upsertCamera = useAppStore((st) => st.upsertCamera)
  const cameras = useAppStore((st) => st.cameras)
  const row = useDraftRow<CameraRowState>(
    {
      number: nextNumber,
      name: '',
      // Pre-filled from the palette; the picker below still lets it be overridden.
      color: nextCameraColor(cameras),
      resolveColor: null,
    },
    async (draft) => {
      if (!draft.name.trim()) throw new Error('Name is required.')
      await upsertCamera({
        projectId,
        number: draft.number,
        name: draft.name.trim(),
        color: draft.color,
        resolveColor: draft.resolveColor,
        obsScene: null,
      })
      onDone()
    },
    'Failed to add camera.',
  )

  return (
    <tr>
      <td style={s.td}>
        <input
          style={s.numberInput}
          type="number"
          min={1}
          value={row.draft.number}
          aria-label="Camera number"
          onChange={(e) => row.set({ number: parseInt(e.target.value, 10) || 1 })}
          disabled={row.saving}
        />
      </td>
      <td style={s.td}>
        <input
          autoFocus
          style={s.cellInput}
          type="text"
          placeholder="Camera name"
          value={row.draft.name}
          aria-label="Camera name"
          onChange={(e) => row.set({ name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') row.submit()
            if (e.key === 'Escape') onDone()
          }}
          disabled={row.saving}
        />
      </td>
      <td style={{ ...s.td, width: '56px' }}>
        <ColorSwatch
          value={row.draft.color}
          label="Camera color"
          onChange={(color) => row.set({ color })}
          disabled={row.saving}
        />
        {/* Nothing is written until the ✓, so a pick here only fills the draft. */}
        <PaletteStrip
          selected={row.draft.color}
          onPick={(color) => row.set({ color })}
          disabled={row.saving}
        />
      </td>
      <td style={s.td}>
        <select
          style={s.select}
          value={row.draft.resolveColor ?? ''}
          aria-label="Resolve color"
          onChange={(e) => row.set({ resolveColor: e.target.value === '' ? null : e.target.value })}
          disabled={row.saving}
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
        {row.error !== null && (
          <span style={{ ...s.errorMark, marginRight: '4px' }} title={row.error}>
            ⚠
          </span>
        )}
        <button
          style={{ ...s.iconBtn, color: '#4a90d9' }}
          onClick={row.submit}
          title="Save camera"
          aria-label="Save new camera"
          disabled={row.saving}
        >
          ✓
        </button>
        <button
          style={s.iconBtn}
          onClick={onDone}
          title="Cancel"
          aria-label="Cancel new camera"
          disabled={row.saving}
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
  const cameras = useAppStore((st) => st.cameras)
  const activeProjectId = useAppStore((st) => st.activeProjectId)
  const removeCamera = useAppStore((st) => st.removeCamera)

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
        <div style={s.panel({ width: '680px', maxHeight: '80vh', gap: '16px' })}>
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
                <CameraRow key={cam.id} camera={cam} onRequestDelete={setPendingDelete} />
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
        <ConfirmDestructive
          noun="camera"
          subject={`#${pendingDelete.number} ${pendingDelete.name}`}
          onCancel={() => setPendingDelete(null)}
          onConfirm={handleConfirmDelete}
          describeError={describeCameraDeleteError}
        />
      )}
    </>
  )
}
