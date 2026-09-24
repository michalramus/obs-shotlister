import React, { useMemo, useState } from 'react'
import { useAppStore } from '../store'
import type { Part, Rundown } from '../../shared/types'
import type { PartScope } from '../../shared/ipc-contract'
import { CAMERA_PALETTE } from '../../shared/camera-palette'
import { visibleFolderNames } from './RundownSidebar'

// ---------------------------------------------------------------------------
// Assignment keymap
//
// Parts are assigned exactly as Cameras are, except that a Voice-over Rundown
// routinely has more moments than a Project has Cameras, so the nine number
// keys run out. The letter row continues where the digits stop.
//
// Cameras key off the Camera's own `number`; Parts cannot, because `number` is
// unique per Project while the picker only ever offers the Parts in scope — a
// Rundown seeing Parts 3, 7 and 12 would leave most keys dead. The keys index
// the in-scope list in `number` order instead, so they are always contiguous.
// ---------------------------------------------------------------------------

/**
 * Opens the one-field dialog that names a new Part mid-authoring.
 *
 * Kept off the assignment keymap on purpose: N is not one of the nineteen
 * Part keys, so claiming it costs no Part its shortcut.
 */
export const ADD_PART_KEY = 'n'

export const PART_KEYS: readonly string[] = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'q',
  'w',
  'e',
  'r',
  't',
  'y',
  'u',
  'i',
  'o',
  'p',
]

/** The Parts in `number` order — the order every Part affordance presents. */
export function partsByNumber(parts: Part[]): Part[] {
  return [...parts].sort((a, b) => a.number - b.number)
}

/**
 * The Part a keypress assigns, or null when the key is unmapped or maps past
 * the end of the list.
 *
 * `parts` is the in-scope list; array order is ignored in favour of `number`,
 * so the key a Part answers to does not change with however the list arrived.
 */
export function partForKey(key: string, parts: Part[]): Part | null {
  const index = PART_KEYS.indexOf(key.toLowerCase())
  if (index === -1) return null
  const ordered = partsByNumber(parts)
  return ordered[index] ?? null
}

/** The key that assigns `part`, or null when it falls past the keymap. */
export function keyForPart(part: Part, parts: Part[]): string | null {
  const index = partsByNumber(parts).findIndex((p) => p.id === part.id)
  if (index === -1) return null
  return PART_KEYS[index] ?? null
}

// ---------------------------------------------------------------------------
// Filtering and scope
// ---------------------------------------------------------------------------

/**
 * Type-to-filter over Parts: matches on name anywhere, or on the number the
 * operator can see on the button bar. Results stay in `number` order so the
 * list does not reshuffle under the cursor as the query narrows.
 */
export function filterParts(parts: Part[], query: string): Part[] {
  const q = query.trim().toLowerCase()
  const ordered = partsByNumber(parts)
  if (q === '') return ordered
  return ordered.filter((p) => p.name.toLowerCase().includes(q) || String(p.number).startsWith(q))
}

/** The scope a Part is currently defined at. */
export function scopeOfPart(part: Part): PartScope {
  if (part.rundownId !== null) return { kind: 'rundown', rundownId: part.rundownId }
  if (part.folder !== null) return { kind: 'folder', folder: part.folder }
  return { kind: 'project' }
}

/** How a Part's scope reads in the panel. */
export function scopeLabel(part: Part, rundowns: Rundown[]): string {
  if (part.rundownId !== null) {
    const owner = rundowns.find((r) => r.id === part.rundownId)
    return owner ? `Rundown: ${owner.name}` : 'Rundown'
  }
  if (part.folder !== null) return `Folder: ${part.folder}`
  return 'Project'
}

/**
 * Whether `rundown` may choose `part` for a new Call — the additive union of
 * Project, folder and Rundown scope (ADR 0006).
 *
 * A Part outside it is still a real Part, and Calls elsewhere still point at
 * it, which is why the panel greys those rows rather than hiding them.
 */
export function isPartInScope(part: Part, rundown: Rundown | null): boolean {
  if (part.rundownId === null && part.folder === null) return true
  if (rundown === null) return false
  if (part.rundownId !== null) return part.rundownId === rundown.id
  return part.folder !== null && part.folder === rundown.folder
}

// ---------------------------------------------------------------------------
// Scope <-> select value
// ---------------------------------------------------------------------------

function scopeToValue(scope: PartScope): string {
  switch (scope.kind) {
    case 'project':
      return 'project'
    case 'folder':
      return `folder:${scope.folder}`
    case 'rundown':
      return `rundown:${scope.rundownId}`
  }
}

function valueToScope(value: string): PartScope {
  if (value.startsWith('folder:')) return { kind: 'folder', folder: value.slice('folder:'.length) }
  if (value.startsWith('rundown:'))
    return { kind: 'rundown', rundownId: value.slice('rundown:'.length) }
  return { kind: 'project' }
}

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
    width: '720px',
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

  hint: {
    margin: 0,
    fontSize: '12px',
    color: '#777',
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

  paletteStrip: {
    display: 'grid',
    gridTemplateColumns: 'repeat(12, 1fr)',
    gap: '2px',
    marginTop: '4px',
    width: '132px',
  } satisfies React.CSSProperties,

  paletteSwatch: {
    width: '9px',
    height: '9px',
    borderRadius: '2px',
    border: '1px solid rgba(0,0,0,0.4)',
    padding: 0,
    cursor: 'pointer',
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

  bulkBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid #3a4a5a',
    background: '#22303c',
    fontSize: '13px',
    color: '#cfd8dc',
    flexWrap: 'wrap' as const,
  } satisfies React.CSSProperties,

  primaryBtn: {
    padding: '6px 14px',
    fontSize: '14px',
    borderRadius: '4px',
    border: 'none',
    background: '#4a90d9',
    color: '#fff',
    cursor: 'pointer',
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
    minWidth: '320px',
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

  partBtn: {
    background: 'none',
    border: '1px solid #555',
    borderRadius: '3px',
    color: '#ccc',
    fontSize: '13px',
    padding: '6px 12px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,

  keyCap: {
    fontSize: '10px',
    color: '#888',
    border: '1px solid #444',
    borderRadius: '2px',
    padding: '0 3px',
    lineHeight: '14px',
  } satisfies React.CSSProperties,

  pickerList: {
    listStyle: 'none',
    margin: '6px 0 0',
    padding: 0,
    maxHeight: '220px',
    overflowY: 'auto' as const,
  } satisfies React.CSSProperties,

  pickerItem: (highlighted: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
    cursor: 'pointer',
    borderRadius: '4px',
    background: highlighted ? '#2a3a4a' : 'transparent',
    color: highlighted ? '#fff' : '#ccc',
    fontSize: '13px',
  }),

  dot: (color: string): React.CSSProperties => ({
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    background: color,
    display: 'inline-block',
    flexShrink: 0,
  }),
}

// ---------------------------------------------------------------------------
// Palette strip — same affordance the Camera panel offers
// ---------------------------------------------------------------------------

interface PaletteStripProps {
  selected: string
  onPick: (color: string) => void
  disabled?: boolean
}

function PaletteStrip({ selected, onPick, disabled }: PaletteStripProps): React.JSX.Element {
  return (
    <div style={s.paletteStrip} role="group" aria-label="Palette colors">
      {CAMERA_PALETTE.map((c) => {
        const isSelected = c.toLowerCase() === selected.trim().toLowerCase()
        return (
          <button
            key={c}
            type="button"
            title={c}
            aria-label={c}
            aria-pressed={isSelected}
            disabled={disabled}
            onClick={() => onPick(c)}
            style={{
              ...s.paletteSwatch,
              background: c,
              outline: isSelected ? '2px solid #fff' : 'none',
              outlineOffset: isSelected ? '1px' : undefined,
            }}
          />
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delete part confirmation
// ---------------------------------------------------------------------------

interface DeletePartDialogProps {
  part: Part
  onCancel: () => void
  onConfirm: () => Promise<void>
}

function DeletePartDialog({ part, onCancel, onConfirm }: DeletePartDialogProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      // The refusal carries the number of Calls still pointing at the Part;
      // swallowing it here would let the operator believe it was deleted.
      setError(err instanceof Error ? err.message : 'Failed to delete part.')
      setLoading(false)
    }
  }

  return (
    <div
      style={s.confirmOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-part-title"
    >
      <div style={s.confirmDialog}>
        <h3 id="delete-part-title" style={s.confirmTitle}>
          Delete part?
        </h3>
        <p style={{ margin: 0, color: '#ccc', fontSize: '14px' }}>
          Delete{' '}
          <strong style={{ color: '#fff' }}>
            #{part.number} {part.name}
          </strong>
          ? This cannot be undone.
        </p>
        {error !== null && <p style={s.errorText}>{error}</p>}
        <div style={s.row}>
          <button style={s.cancelBtn} onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button style={s.dangerBtn} onClick={() => void handleConfirm()} disabled={loading}>
            {loading ? 'Deleting…' : 'Delete part'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Part row — inline edit, plus the promotion control
// ---------------------------------------------------------------------------

interface PartRowState {
  number: number
  name: string
  color: string
}

interface PartRowProps {
  part: Part
  rundowns: Rundown[]
  folders: string[]
  activeRundownId: string | null
  inScope: boolean
  selected: boolean
  onToggleSelect: (id: string) => void
  onRequestDelete: (part: Part) => void
}

function PartRow({
  part,
  rundowns,
  folders,
  activeRundownId,
  inScope,
  selected,
  onToggleSelect,
  onRequestDelete,
}: PartRowProps): React.JSX.Element {
  const upsertPart = useAppStore((st) => st.upsertPart)
  const promotePart = useAppStore((st) => st.promotePart)
  const [draft, setDraft] = useState<PartRowState>({
    number: part.number,
    name: part.name,
    color: part.color,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Commit changes on blur from any field, exactly as the Camera panel does.
  const handleBlur = async (): Promise<void> => {
    if (draft.number === part.number && draft.name === part.name && draft.color === part.color) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await upsertPart({
        id: part.id,
        projectId: part.projectId,
        number: draft.number,
        name: draft.name,
        color: draft.color,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const handleScopeChange = async (value: string): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      // Promotion keeps the Part's id, so every Call pointing at it survives.
      await promotePart(part.id, valueToScope(value))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Promotion failed.')
    } finally {
      setSaving(false)
    }
  }

  const ownRundown = part.rundownId !== null ? rundowns.find((r) => r.id === part.rundownId) : null
  const activeRundown =
    activeRundownId !== null ? (rundowns.find((r) => r.id === activeRundownId) ?? null) : null

  // Rundown scope offers the open Rundown, plus whichever Rundown already owns
  // this Part so the select always has a value to show.
  const rundownOptions: Rundown[] = []
  for (const candidate of [activeRundown, ownRundown]) {
    if (candidate && !rundownOptions.some((r) => r.id === candidate.id)) {
      rundownOptions.push(candidate)
    }
  }

  return (
    <tr
      // Out-of-scope Parts are greyed, never hidden: the Rundown that owns one
      // still has Calls on it, so it is a real Part everywhere (ADR 0006).
      style={inScope ? undefined : { opacity: 0.5 }}
      title={inScope ? undefined : 'Defined elsewhere — not offered for this rundown'}
    >
      <td style={{ ...s.td, width: '28px' }}>
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${part.name}`}
          onChange={() => onToggleSelect(part.id)}
        />
      </td>
      <td style={s.td}>
        <input
          style={s.numberInput}
          type="number"
          min={1}
          value={draft.number}
          aria-label="Part number"
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
          aria-label="Part name"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          onBlur={() => void handleBlur()}
          disabled={saving}
        />
      </td>
      <td style={{ ...s.td, width: '56px' }}>
        <div style={s.colorCell}>
          <div style={{ ...s.colorSwatch, background: draft.color }} title={draft.color} />
          <input
            type="color"
            style={s.colorInput}
            value={draft.color}
            aria-label="Part color"
            onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
            onBlur={() => void handleBlur()}
            disabled={saving}
          />
        </div>
        <PaletteStrip
          selected={draft.color}
          onPick={(c) => setDraft((d) => ({ ...d, color: c }))}
          disabled={saving}
        />
      </td>
      <td style={s.td}>
        <select
          style={s.select}
          value={scopeToValue(scopeOfPart(part))}
          aria-label={`Scope of ${part.name}`}
          onChange={(e) => void handleScopeChange(e.target.value)}
          disabled={saving}
        >
          <option value="project">Project</option>
          {folders.map((f) => (
            <option key={f} value={`folder:${f}`}>
              Folder: {f}
            </option>
          ))}
          {rundownOptions.map((r) => (
            <option key={r.id} value={`rundown:${r.id}`}>
              Rundown: {r.name}
            </option>
          ))}
        </select>
      </td>
      <td style={{ ...s.td, width: '48px', whiteSpace: 'nowrap' }}>
        {error !== null && (
          <span style={{ color: '#e74c3c', fontSize: '12px' }} title={error}>
            ⚠
          </span>
        )}
        <button
          style={s.iconBtn}
          onClick={() => onRequestDelete(part)}
          title="Delete part"
          aria-label={`Delete part ${part.name}`}
          disabled={saving}
        >
          ✕
        </button>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// New part row
// ---------------------------------------------------------------------------

interface NewPartRowProps {
  projectId: string
  nextNumber: number
  activeRundownId: string | null
  folders: string[]
  onDone: () => void
}

function NewPartRow({
  projectId,
  nextNumber,
  activeRundownId,
  folders,
  onDone,
}: NewPartRowProps): React.JSX.Element {
  const upsertPart = useAppStore((st) => st.upsertPart)
  const [number, setNumber] = useState(nextNumber)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [scopeValue, setScopeValue] = useState('project')
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
      // An unset colour is left to the main process, which picks the first
      // palette entry the Project has not used — same rule as a new Camera.
      await upsertPart({
        projectId,
        number,
        name: name.trim(),
        color: color ?? undefined,
        scope: valueToScope(scopeValue),
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add part.')
      setSaving(false)
    }
  }

  return (
    <tr>
      <td style={{ ...s.td, width: '28px' }} />
      <td style={s.td}>
        <input
          style={s.numberInput}
          type="number"
          min={1}
          value={number}
          aria-label="Part number"
          onChange={(e) => setNumber(parseInt(e.target.value, 10) || 1)}
          disabled={saving}
        />
      </td>
      <td style={s.td}>
        <input
          autoFocus
          style={s.input}
          type="text"
          placeholder="Part name"
          value={name}
          aria-label="Part name"
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
          <div
            style={{ ...s.colorSwatch, background: color ?? 'transparent' }}
            title={color ?? 'Next free palette colour'}
          />
          <input
            type="color"
            style={s.colorInput}
            value={color ?? '#000000'}
            aria-label="Part color"
            onChange={(e) => setColor(e.target.value)}
            disabled={saving}
          />
        </div>
        <PaletteStrip selected={color ?? ''} onPick={setColor} disabled={saving} />
      </td>
      <td style={s.td}>
        <select
          style={s.select}
          value={scopeValue}
          aria-label="Scope"
          onChange={(e) => setScopeValue(e.target.value)}
          disabled={saving}
        >
          <option value="project">Project</option>
          {folders.map((f) => (
            <option key={f} value={`folder:${f}`}>
              Folder: {f}
            </option>
          ))}
          {activeRundownId !== null && (
            <option value={`rundown:${activeRundownId}`}>This rundown</option>
          )}
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
          title="Save part"
          aria-label="Save new part"
          disabled={saving}
        >
          ✓
        </button>
        <button
          style={s.iconBtn}
          onClick={onDone}
          title="Cancel"
          aria-label="Cancel new part"
          disabled={saving}
        >
          ✕
        </button>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// PartsConfigPanel — modal, the Voice-over counterpart of the Camera panel
// ---------------------------------------------------------------------------

interface PartsConfigPanelProps {
  onClose: () => void
}

export function PartsConfigPanel({ onClose }: PartsConfigPanelProps): React.JSX.Element {
  const parts = useAppStore((st) => st.parts)
  const rundowns = useAppStore((st) => st.rundowns)
  const activeProjectId = useAppStore((st) => st.activeProjectId)
  const activeRundownId = useAppStore((st) => st.activeRundownId)
  const removePart = useAppStore((st) => st.removePart)
  const setPartsColor = useAppStore((st) => st.setPartsColor)

  const [addingNew, setAddingNew] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Part | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkColor, setBulkColor] = useState(CAMERA_PALETTE[0])
  const [bulkError, setBulkError] = useState<string | null>(null)

  const ordered = useMemo(() => partsByNumber(parts), [parts])
  const folders = useMemo(
    () => visibleFolderNames([], rundowns, activeProjectId),
    [rundowns, activeProjectId],
  )
  const activeRundown =
    activeRundownId !== null ? (rundowns.find((r) => r.id === activeRundownId) ?? null) : null

  const nextNumber = parts.length > 0 ? Math.max(...parts.map((p) => p.number)) + 1 : 1

  function toggleSelect(id: string): void {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const handleConfirmDelete = async (): Promise<void> => {
    if (pendingDelete === null) return
    await removePart(pendingDelete.id)
    setSelectedIds((prev) => prev.filter((id) => id !== pendingDelete.id))
    setPendingDelete(null)
  }

  const handleApplyColor = async (): Promise<void> => {
    setBulkError(null)
    try {
      // Colour grouping is a convention, not a model: one write over a
      // hand-picked set, no Group entity behind it.
      await setPartsColor(selectedIds, bulkColor)
      setSelectedIds([])
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Failed to set colour.')
    }
  }

  if (activeProjectId === null) return <></>

  return (
    <>
      <div style={s.overlay} role="dialog" aria-modal="true" aria-labelledby="parts-config-title">
        <div style={s.panel}>
          <div style={s.header}>
            <h2 id="parts-config-title" style={s.title}>
              Parts
            </h2>
            <button style={s.closeBtn} onClick={onClose} aria-label="Close parts configuration">
              ✕
            </button>
          </div>

          <p style={s.hint}>
            Scope only ever adds: a rundown sees the project&apos;s parts, its folder&apos;s parts
            and its own. Parts defined elsewhere are greyed here.
          </p>

          {selectedIds.length > 0 && (
            <div style={s.bulkBar}>
              <span>
                {selectedIds.length} selected — set one colour to group them (all zwrotkas green,
                say).
              </span>
              <div style={s.colorCell}>
                <div style={{ ...s.colorSwatch, background: bulkColor }} title={bulkColor} />
                <input
                  type="color"
                  style={s.colorInput}
                  value={bulkColor}
                  aria-label="Group color"
                  onChange={(e) => setBulkColor(e.target.value)}
                />
              </div>
              <PaletteStrip selected={bulkColor} onPick={setBulkColor} />
              <button style={s.primaryBtn} onClick={() => void handleApplyColor()}>
                Set colour
              </button>
              <button style={s.cancelBtn} onClick={() => setSelectedIds([])}>
                Clear selection
              </button>
              {bulkError !== null && <span style={s.errorText}>{bulkError}</span>}
            </div>
          )}

          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th} />
                <th style={s.th}>#</th>
                <th style={s.th}>Name</th>
                <th style={s.th}>Color</th>
                <th style={s.th}>Defined at</th>
                <th style={s.th} />
              </tr>
            </thead>
            <tbody>
              {ordered.map((part) => (
                <PartRow
                  key={part.id}
                  part={part}
                  rundowns={rundowns}
                  folders={folders}
                  activeRundownId={activeRundownId}
                  inScope={isPartInScope(part, activeRundown)}
                  selected={selectedIds.includes(part.id)}
                  onToggleSelect={toggleSelect}
                  onRequestDelete={setPendingDelete}
                />
              ))}
              {addingNew && (
                <NewPartRow
                  projectId={activeProjectId}
                  nextNumber={nextNumber}
                  activeRundownId={activeRundownId}
                  folders={folders}
                  onDone={() => setAddingNew(false)}
                />
              )}
            </tbody>
          </table>

          {ordered.length === 0 && !addingNew && (
            <p style={s.hint}>No parts yet. Add the moments your songs are made of.</p>
          )}

          {!addingNew && (
            <button style={s.addBtn} onClick={() => setAddingNew(true)}>
              + Add part
            </button>
          )}
        </div>
      </div>

      {pendingDelete !== null && (
        <DeletePartDialog
          part={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={handleConfirmDelete}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// PartButtonBar — assign by clicking when the key is not remembered
// ---------------------------------------------------------------------------

export interface PartButtonBarProps {
  /** The Parts in scope for the open Rundown. */
  parts: Part[]
  onAssign: (part: Part) => void
  /** Highlighted as the current assignment, when there is one. */
  activePartId?: string | null
  disabled?: boolean
  /** Renders the "Add new description" affordance beside the Parts. */
  onAddNew?: () => void
}

export function PartButtonBar({
  parts,
  onAssign,
  activePartId,
  disabled,
  onAddNew,
}: PartButtonBarProps): React.JSX.Element {
  const ordered = partsByNumber(parts)

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}
      role="group"
      aria-label="Assign part"
    >
      {ordered.map((part, i) => {
        const key = PART_KEYS[i]
        return (
          <button
            key={part.id}
            style={{
              ...s.partBtn,
              borderColor: part.id === activePartId ? part.color : '#555',
              color: part.id === activePartId ? '#fff' : '#ccc',
            }}
            title={key ? `Assign ${part.name} (${key})` : `Assign ${part.name}`}
            onClick={() => onAssign(part)}
            disabled={disabled}
          >
            <span style={s.dot(part.color)} />
            {part.name}
            {key !== undefined && <span style={s.keyCap}>{key}</span>}
          </button>
        )
      })}
      {ordered.length === 0 && (
        <span style={{ color: '#444', fontSize: '11px' }}>No parts in scope</span>
      )}
      {onAddNew !== undefined && (
        <button
          style={s.partBtn}
          onClick={onAddNew}
          disabled={disabled}
          title={`Add new description (${ADD_PART_KEY.toUpperCase()})`}
        >
          + Add new description
          <span style={s.keyCap}>{ADD_PART_KEY.toUpperCase()}</span>
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PartPicker — type-to-filter, so a long Part list stays usable
// ---------------------------------------------------------------------------

export interface PartPickerProps {
  /** The Parts in scope for the open Rundown. */
  parts: Part[]
  onPick: (part: Part) => void
  onCancel?: () => void
  placeholder?: string
  autoFocus?: boolean
}

export function PartPicker({
  parts,
  onPick,
  onCancel,
  placeholder,
  autoFocus = true,
}: PartPickerProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)

  const matches = filterParts(parts, query)
  // A narrowing query can strand the highlight past the end of the list.
  const index = Math.min(highlight, Math.max(matches.length - 1, 0))

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(Math.min(index + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(Math.max(index - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const picked = matches[index]
      if (picked) onPick(picked)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel?.()
    }
  }

  return (
    <div>
      <input
        autoFocus={autoFocus}
        style={s.input}
        type="text"
        value={query}
        placeholder={placeholder ?? 'Filter parts…'}
        aria-label="Filter parts"
        onChange={(e) => {
          setQuery(e.target.value)
          setHighlight(0)
        }}
        onKeyDown={handleKeyDown}
      />
      <ul style={s.pickerList}>
        {matches.map((part, i) => (
          <li
            key={part.id}
            style={s.pickerItem(i === index)}
            onMouseEnter={() => setHighlight(i)}
            onClick={() => onPick(part)}
          >
            <span style={s.dot(part.color)} />
            <span>{part.name}</span>
            <span style={{ marginLeft: 'auto', color: '#666', fontSize: '11px' }}>
              #{part.number}
            </span>
          </li>
        ))}
        {matches.length === 0 && (
          <li style={{ ...s.pickerItem(false), color: '#666' }}>No matching part</li>
        )}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AddPartDialog — one field, mid-authoring
// ---------------------------------------------------------------------------

export interface AddPartDialogProps {
  onClose: () => void
  /** The created Part, so the caller can assign it straight away. */
  onCreated?: (part: Part) => void
}

export function AddPartDialog({ onClose, onCreated }: AddPartDialogProps): React.JSX.Element {
  const upsertPart = useAppStore((st) => st.upsertPart)
  const activeProjectId = useAppStore((st) => st.activeProjectId)
  const activeRundownId = useAppStore((st) => st.activeRundownId)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Name is required.')
      return
    }
    if (activeProjectId === null || activeRundownId === null) {
      setError('Open a rundown first.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      // Rundown scope, deliberately: the operator is mid-authoring and cannot
      // answer a scope question yet. Promotion from the Parts panel comes later.
      const part = await upsertPart({
        projectId: activeProjectId,
        name: trimmed,
        scope: { kind: 'rundown', rundownId: activeRundownId },
      })
      onCreated?.(part)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add part.')
      setSaving(false)
    }
  }

  return (
    <div style={s.confirmOverlay} role="dialog" aria-modal="true" aria-labelledby="add-part-title">
      <div style={s.confirmDialog}>
        <h3 id="add-part-title" style={s.confirmTitle}>
          Add new description
        </h3>
        <input
          autoFocus
          style={s.input}
          type="text"
          value={name}
          placeholder="gitara, wokal 1, refren…"
          aria-label="Part name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate()
            if (e.key === 'Escape') onClose()
          }}
          disabled={saving}
        />
        <p style={s.hint}>Added to this rundown. Promote it later from the Parts panel.</p>
        {error !== null && <p style={s.errorText}>{error}</p>}
        <div style={s.row}>
          <button style={s.cancelBtn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button style={s.primaryBtn} onClick={() => void handleCreate()} disabled={saving}>
            {saving ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}
