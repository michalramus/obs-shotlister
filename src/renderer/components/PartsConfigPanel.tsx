import React, { useMemo, useState } from 'react'
import { useAppStore } from '../store'
import type { Part, Rundown } from '../../shared/types'
import type { PartScope } from '../../shared/ipc-contract'
import { CAMERA_PALETTE } from '../../shared/camera-palette'
import { visibleFolderNames } from './RundownSidebar'
import { ASSIGNMENT_STRIP_ROW_GAP } from './timeline/assignment-strip'
import { ps } from './panel-styles'
import { ColorSwatch, PaletteStrip } from './ColorPicker'
import { ConfirmDestructive } from './ConfirmDestructive'
import { useDraftRow } from './use-draft-row'

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
  ...ps,

  hint: {
    margin: 0,
    fontSize: '12px',
    color: '#777',
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

  errorMark: {
    color: '#e74c3c',
    fontSize: '12px',
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

/**
 * The folders the scope select offers for one Part.
 *
 * `folders` is derived from the Rundowns that exist, so the last Rundown leaving
 * a folder takes that folder's option with it. A select whose value matches no
 * option shows the first one instead — "Project" — and the row would then claim
 * a Project-scoped Part while greying it as defined elsewhere. The Part's own
 * folder is therefore always offered, empty or not.
 */
export function scopeFolderOptions(folders: string[], part: Part): string[] {
  if (part.folder === null || folders.includes(part.folder)) return folders
  return [...folders, part.folder]
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
  const row = useDraftRow<PartRowState>(
    { number: part.number, name: part.name, color: part.color },
    async (draft) => {
      await upsertPart({
        id: part.id,
        projectId: part.projectId,
        number: draft.number,
        name: draft.name,
        color: draft.color,
      })
    },
  )
  // Scope is not part of the draft: promotion is a move rather than an edit, and
  // it commits the moment the select changes.
  const [promoting, setPromoting] = useState(false)
  const [promoteError, setPromoteError] = useState<string | null>(null)

  const handleScopeChange = async (value: string): Promise<void> => {
    setPromoting(true)
    setPromoteError(null)
    try {
      // Promotion keeps the Part's id, so every Call pointing at it survives.
      await promotePart(part.id, valueToScope(value))
    } catch (err) {
      setPromoteError(err instanceof Error ? err.message : 'Promotion failed.')
    } finally {
      setPromoting(false)
    }
  }

  const busy = row.saving || promoting
  const error = row.error ?? promoteError

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
          value={row.draft.number}
          aria-label="Part number"
          onChange={(e) => row.set({ number: parseInt(e.target.value, 10) || 1 })}
          onBlur={row.commit}
          disabled={busy}
        />
      </td>
      <td style={s.td}>
        <input
          style={s.cellInput}
          type="text"
          value={row.draft.name}
          aria-label="Part name"
          onChange={(e) => row.set({ name: e.target.value })}
          onBlur={row.commit}
          disabled={busy}
        />
      </td>
      <td style={{ ...s.td, width: '56px' }}>
        <ColorSwatch
          value={row.draft.color}
          label="Part color"
          onChange={(color) => row.set({ color })}
          onBlur={row.commit}
          disabled={busy}
        />
        <PaletteStrip
          selected={row.draft.color}
          onPick={(color) => row.pick({ color })}
          disabled={busy}
        />
      </td>
      <td style={s.td}>
        <select
          style={s.select}
          value={scopeToValue(scopeOfPart(part))}
          aria-label={`Scope of ${part.name}`}
          onChange={(e) => void handleScopeChange(e.target.value)}
          disabled={busy}
        >
          <option value="project">Project</option>
          {scopeFolderOptions(folders, part).map((f) => (
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
          <span style={s.errorMark} title={error}>
            ⚠
          </span>
        )}
        <button
          style={s.iconBtn}
          onClick={() => onRequestDelete(part)}
          title="Delete part"
          aria-label={`Delete part ${part.name}`}
          disabled={busy}
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

interface NewPartRowState {
  number: number
  name: string
  /** Null until the operator picks one; the main process fills it in. */
  color: string | null
  scopeValue: string
}

function NewPartRow({
  projectId,
  nextNumber,
  activeRundownId,
  folders,
  onDone,
}: NewPartRowProps): React.JSX.Element {
  const upsertPart = useAppStore((st) => st.upsertPart)
  const row = useDraftRow<NewPartRowState>(
    { number: nextNumber, name: '', color: null, scopeValue: 'project' },
    async (draft) => {
      if (!draft.name.trim()) throw new Error('Name is required.')
      // An unset colour is left to the main process, which picks the first
      // palette entry the Project has not used — same rule as a new Camera.
      await upsertPart({
        projectId,
        number: draft.number,
        name: draft.name.trim(),
        color: draft.color ?? undefined,
        scope: valueToScope(draft.scopeValue),
      })
      onDone()
    },
    'Failed to add part.',
  )

  return (
    <tr>
      <td style={{ ...s.td, width: '28px' }} />
      <td style={s.td}>
        <input
          style={s.numberInput}
          type="number"
          min={1}
          value={row.draft.number}
          aria-label="Part number"
          onChange={(e) => row.set({ number: parseInt(e.target.value, 10) || 1 })}
          disabled={row.saving}
        />
      </td>
      <td style={s.td}>
        <input
          autoFocus
          style={s.cellInput}
          type="text"
          placeholder="Part name"
          value={row.draft.name}
          aria-label="Part name"
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
          label="Part color"
          emptyTitle="Next free palette colour"
          onChange={(color) => row.set({ color })}
          disabled={row.saving}
        />
        {/* Nothing is written until the ✓, so a pick here only fills the draft. */}
        <PaletteStrip
          selected={row.draft.color ?? ''}
          onPick={(color) => row.set({ color })}
          disabled={row.saving}
        />
      </td>
      <td style={s.td}>
        <select
          style={s.select}
          value={row.draft.scopeValue}
          aria-label="Scope"
          onChange={(e) => row.set({ scopeValue: e.target.value })}
          disabled={row.saving}
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
        {row.error !== null && (
          <span style={{ ...s.errorMark, marginRight: '4px' }} title={row.error}>
            ⚠
          </span>
        )}
        <button
          style={{ ...s.iconBtn, color: '#4a90d9' }}
          onClick={row.submit}
          title="Save part"
          aria-label="Save new part"
          disabled={row.saving}
        >
          ✓
        </button>
        <button
          style={s.iconBtn}
          onClick={onDone}
          title="Cancel"
          aria-label="Cancel new part"
          disabled={row.saving}
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
        <div style={s.panel({ width: '720px', maxHeight: '80vh', gap: '16px' })}>
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
              <ColorSwatch value={bulkColor} label="Group color" onChange={setBulkColor} />
              {/* The bar has its own Set colour button, so a pick only stages one. */}
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
        <ConfirmDestructive
          noun="part"
          subject={`#${pendingDelete.number} ${pendingDelete.name}`}
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
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        // This is the bar that wraps inside the timeline's assignment strip, and
        // the strip's height is derived from how many lines it takes: the gap the
        // arithmetic assumes and the gap drawn here are the same number.
        rowGap: ASSIGNMENT_STRIP_ROW_GAP,
      }}
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
        <div style={s.buttonRow}>
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
