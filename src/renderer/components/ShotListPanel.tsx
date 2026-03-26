import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverEvent,
  DragCancelEvent,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useAppStore } from '../store'
import type { Shot, Camera } from '../../shared/types'
import type { CreateShotInput, UpdateShotInput } from '../electron-api.d'

const s = {
  panel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  } satisfies React.CSSProperties,

  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 16px',
    borderBottom: '1px solid #2a2a2a',
    background: '#1a1a1a',
  } satisfies React.CSSProperties,

  title: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#999',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  } satisfies React.CSSProperties,

  addBtn: {
    padding: '5px 12px',
    background: '#2a4a2a',
    border: '1px solid #3a6a3a',
    borderRadius: '4px',
    color: '#7ec97e',
    fontSize: '12px',
    cursor: 'pointer',
    fontWeight: 600,
  } satisfies React.CSSProperties,

  list: {
    flex: 1,
    overflowY: 'auto' as const,
    listStyle: 'none',
    margin: 0,
    padding: 0,
  } satisfies React.CSSProperties,

  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    borderBottom: '1px solid #222',
    background: '#171717',
  } satisfies React.CSSProperties,

  dragHandle: {
    cursor: 'grab',
    color: '#444',
    fontSize: '16px',
    flexShrink: 0,
    userSelect: 'none' as const,
  } satisfies React.CSSProperties,

  cameraBadge: (color: string): React.CSSProperties => ({
    background: color,
    color: '#fff',
    fontSize: '11px',
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: '3px',
    flexShrink: 0,
  }),

  name: {
    fontSize: '13px',
    color: '#ccc',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,

  duration: {
    fontSize: '13px',
    color: '#888',
    fontVariantNumeric: 'tabular-nums' as const,
    flexShrink: 0,
  } satisfies React.CSSProperties,

  iconBtn: {
    background: 'none',
    border: 'none',
    color: '#555',
    cursor: 'pointer',
    fontSize: '14px',
    padding: '2px 4px',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  transitionInfo: {
    fontSize: '11px',
    color: '#9b59b6',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  emptyState: {
    padding: '32px',
    textAlign: 'center' as const,
    color: '#444',
    fontSize: '14px',
  } satisfies React.CSSProperties,

  liveLock: {
    padding: '8px 16px',
    background: '#2a1a1a',
    color: '#e74c3c',
    fontSize: '12px',
    borderBottom: '1px solid #3a2a2a',
  } satisfies React.CSSProperties,

  formRow: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    padding: '8px 12px',
    borderBottom: '1px solid #222',
    background: '#1e2a1e',
    flexWrap: 'wrap' as const,
  } satisfies React.CSSProperties,

  select: {
    background: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '3px',
    color: '#fff',
    fontSize: '12px',
    padding: '4px 6px',
  } satisfies React.CSSProperties,

  input: {
    background: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '3px',
    color: '#fff',
    fontSize: '12px',
    padding: '4px 6px',
    width: '80px',
  } satisfies React.CSSProperties,

  labelInput: {
    background: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '3px',
    color: '#fff',
    fontSize: '12px',
    padding: '4px 6px',
    flex: 1,
  } satisfies React.CSSProperties,

  confirmBtn: {
    padding: '4px 10px',
    background: '#27ae60',
    border: 'none',
    borderRadius: '3px',
    color: '#fff',
    fontSize: '12px',
    cursor: 'pointer',
    fontWeight: 600,
  } satisfies React.CSSProperties,

  cancelBtn: {
    padding: '4px 10px',
    background: '#3a3a3a',
    border: 'none',
    borderRadius: '3px',
    color: '#ccc',
    fontSize: '12px',
    cursor: 'pointer',
  } satisfies React.CSSProperties,
}

// ---------------------------------------------------------------------------
// Duration helpers
// ---------------------------------------------------------------------------

const DROP_LINE_STYLE: React.CSSProperties = {
  height: '2px',
  background: '#5a9fd4',
  borderRadius: '1px',
  margin: '0 8px',
  pointerEvents: 'none',
}

function msToMss(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function mssToMs(mss: string): number | null {
  const match = mss.match(/^(\d+):([0-5]?\d)$/)
  if (!match) return null
  const m = parseInt(match[1], 10)
  const s = parseInt(match[2], 10)
  return (m * 60 + s) * 1000
}

function parseTransitionSecs(s: string): number {
  return Math.round(parseFloat(s) * 1000)
}

// ---------------------------------------------------------------------------
// Inline shot form
// ---------------------------------------------------------------------------

interface ShotFormProps {
  cameras: Camera[]
  initial?: {
    cameraId: string
    durationMs: number
    label: string
    transitionName: string | null
    transitionMs: number
  }
  onConfirm: (values: {
    cameraId: string
    durationMs: number
    label: string
    transitionName: string | null
    transitionMs: number
  }) => void
  onCancel: () => void
}

function ShotForm({ cameras, initial, onConfirm, onCancel }: ShotFormProps): React.JSX.Element {
  const [cameraId, setCameraId] = useState(initial?.cameraId ?? cameras[0]?.id ?? '')
  const [duration, setDuration] = useState(initial ? msToMss(initial.durationMs) : '0:30')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [transitionName, setTransitionName] = useState<string | null>(
    initial?.transitionName ?? null,
  )
  const [transitionSecs, setTransitionSecs] = useState<string>(
    initial?.transitionMs ? (initial.transitionMs / 1000).toString() : '0.5',
  )
  const [logicalTransitions, setLogicalTransitions] = useState<string[]>([])

  useEffect(() => {
    window.api.obs
      .listTransitionMappings()
      .then((mappings) =>
        setLogicalTransitions(mappings.map((m) => m.logicalName).filter((n) => n !== 'cut')),
      )
      .catch((err: unknown) => console.error('[ShotListPanel] listTransitionMappings:', err))
  }, [])

  function handleConfirm(): void {
    const durationMs = mssToMs(duration)
    if (!cameraId || durationMs === null) return
    const transitionMs = transitionName ? parseTransitionSecs(transitionSecs) : 0
    onConfirm({ cameraId, durationMs, label, transitionName, transitionMs })
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter') handleConfirm()
    if (e.key === 'Escape') onCancel()
  }

  return (
    <div style={s.formRow} onKeyDown={handleKeyDown} data-testid="shot-form">
      <select
        style={s.select}
        value={cameraId}
        onChange={(e) => setCameraId(e.target.value)}
        aria-label="Camera"
      >
        {cameras.map((c) => (
          <option key={c.id} value={c.id}>
            CAM{c.number} — {c.name}
          </option>
        ))}
      </select>

      <input
        style={s.input}
        value={duration}
        onChange={(e) => setDuration(e.target.value)}
        placeholder="m:ss"
        aria-label="Duration"
      />

      <input
        style={s.labelInput}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label (optional)"
        aria-label="Label"
      />

      <select
        style={s.select}
        value={transitionName ?? ''}
        onChange={(e) => setTransitionName(e.target.value === '' ? null : e.target.value)}
        aria-label="Transition"
      >
        <option value="">— cut —</option>
        {logicalTransitions.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
        {transitionName && !logicalTransitions.includes(transitionName) && (
          <option value={transitionName}>{transitionName}</option>
        )}
      </select>

      {transitionName && (
        <input
          style={{ ...s.input, width: '56px' }}
          value={transitionSecs}
          onChange={(e) => setTransitionSecs(e.target.value)}
          placeholder="secs"
          aria-label="Transition duration (seconds)"
          title="Transition duration in seconds"
        />
      )}

      <button style={s.confirmBtn} onClick={handleConfirm} aria-label="Confirm shot">
        ✓
      </button>
      <button style={s.cancelBtn} onClick={onCancel} aria-label="Cancel">
        ✕
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sortable shot row
// ---------------------------------------------------------------------------

interface SortableShotRowProps {
  shot: Shot
  cameras: Camera[]
  isLocked: boolean
  isLive: boolean
  isSelected: boolean
  isDraggingThis: boolean
  isDropTarget: boolean
  liveRefCallback?: (el: HTMLLIElement | null) => void
  selectedRefCallback?: (el: HTMLLIElement | null) => void
  onEdit: (shot: Shot) => void
  onDelete: (shot: Shot) => void
}

function SortableShotRow({
  shot,
  cameras,
  isLocked,
  isLive,
  isSelected,
  isDraggingThis,
  isDropTarget,
  liveRefCallback,
  selectedRefCallback,
  onEdit,
  onDelete,
}: SortableShotRowProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: shot.id,
    disabled: isLocked,
  })

  const camera = cameras.find((c) => c.id === shot.cameraId)
  const liveBg = isLive ? (camera?.color ? camera.color + '22' : '#ffffff22') : undefined

  const style: React.CSSProperties = {
    ...s.row,
    ...(isLive ? { background: liveBg } : {}),
    transform: CSS.Transform.toString(transform),
    transition,
    // invisible placeholder while dragging — keeps layout frozen
    opacity: isDraggingThis ? 0 : 1,
    pointerEvents: isDraggingThis ? 'none' : undefined,
    outline: isSelected ? '2px solid #4a90d9' : undefined,
    outlineOffset: isSelected ? '-2px' : undefined,
  }

  return (
    <>
      {isDropTarget && <li style={DROP_LINE_STYLE} aria-hidden="true" />}
      <li
        ref={(el) => {
          setNodeRef(el)
          liveRefCallback?.(el)
          selectedRefCallback?.(el)
        }}
        style={style}
        data-testid="shot-row"
      >
        {!isLocked && (
          <span style={s.dragHandle} {...attributes} {...listeners} aria-label="Drag to reorder">
            ⠿
          </span>
        )}

        {camera && <span style={s.cameraBadge(camera.color)}>CAM{camera.number}</span>}
        <span style={s.name}>
          {camera?.name ?? '—'}
          {shot.label ? ` "${shot.label}"` : ''}
        </span>
        <span style={s.duration}>{msToMss(shot.durationMs)}</span>
        {shot.transitionName && shot.transitionName !== 'cut' && (
          <span style={s.transitionInfo}>
            ↪ {shot.transitionName} {(shot.transitionMs / 1000).toFixed(1)}s
          </span>
        )}

        {!isLocked && (
          <>
            <button
              style={s.iconBtn}
              onClick={() => onEdit(shot)}
              aria-label="Edit shot"
              title="Edit"
            >
              ✎
            </button>
            <button
              style={s.iconBtn}
              onClick={() => onDelete(shot)}
              aria-label="Delete shot"
              title="Delete"
            >
              🗑
            </button>
          </>
        )}
      </li>
    </>
  )
}

// ---------------------------------------------------------------------------
// ShotListPanel
// ---------------------------------------------------------------------------

interface ShotListPanelProps {
  selectedShotId: string | null
}

export function ShotListPanel({ selectedShotId }: ShotListPanelProps): React.JSX.Element {
  const shots = useAppStore((s) => s.shots)
  const cameras = useAppStore((s) => s.cameras)
  const running = useAppStore((s) => s.running)
  const activeRundownId = useAppStore((s) => s.activeRundownId)
  const liveIndex = useAppStore((s) => s.liveIndex)
  const addShot = useAppStore((s) => s.addShot)
  const editShot = useAppStore((s) => s.editShot)
  const removeShot = useAppStore((s) => s.removeShot)
  const reorderShots = useAppStore((s) => s.reorderShots)

  const [showAddForm, setShowAddForm] = useState(false)
  const [editingShot, setEditingShot] = useState<Shot | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const liveDomRef = useRef<HTMLLIElement | null>(null)
  const setLiveRef = useCallback((el: HTMLLIElement | null) => {
    liveDomRef.current = el
  }, [])

  useEffect(() => {
    liveDomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [liveIndex])

  const selectedRowRef = useRef<HTMLLIElement | null>(null)

  useEffect(() => {
    if (selectedShotId !== null) {
      selectedRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [selectedShotId])

  const sensors = useSensors(useSensor(PointerSensor))

  async function handleAdd(values: {
    cameraId: string
    durationMs: number
    label: string
    transitionName: string | null
    transitionMs: number
  }): Promise<void> {
    if (!activeRundownId) return
    const input: CreateShotInput = {
      rundownId: activeRundownId,
      cameraId: values.cameraId,
      durationMs: values.durationMs,
      label: values.label || null,
      transitionName: values.transitionName,
      transitionMs: values.transitionMs,
    }
    try {
      await addShot(input)
    } catch (err) {
      console.error('[ShotListPanel] addShot error:', err)
    }
    setShowAddForm(false)
  }

  async function handleEdit(values: {
    cameraId: string
    durationMs: number
    label: string
    transitionName: string | null
    transitionMs: number
  }): Promise<void> {
    if (!editingShot) return
    const input: UpdateShotInput = {
      id: editingShot.id,
      cameraId: values.cameraId,
      durationMs: values.durationMs,
      label: values.label || null,
      transitionName: values.transitionName,
      transitionMs: values.transitionMs,
    }
    try {
      await editShot(input)
    } catch (err) {
      console.error('[ShotListPanel] editShot error:', err)
    }
    setEditingShot(null)
  }

  async function handleDelete(shot: Shot): Promise<void> {
    const confirmed = window.confirm(`Delete this shot?`)
    if (!confirmed) return
    try {
      await removeShot(shot.id)
    } catch (err) {
      console.error('[ShotListPanel] removeShot error:', err)
    }
  }

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(event.active.id as string)
    setOverId(null)
  }

  function handleDragOver(event: DragOverEvent): void {
    setOverId(event.over ? (event.over.id as string) : null)
  }

  function handleDragCancel(_event: DragCancelEvent): void {
    setActiveId(null)
    setOverId(null)
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event
    setActiveId(null)
    setOverId(null)
    if (!over || active.id === over.id) return

    const oldIndex = shots.findIndex((s) => s.id === active.id)
    const newIndex = shots.findIndex((s) => s.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(shots, oldIndex, newIndex)
    reorderShots(reordered.map((s) => s.id)).catch((err) => {
      console.error('[ShotListPanel] reorderShots error:', err)
    })
  }

  if (!activeRundownId) {
    return (
      <div style={s.panel}>
        <div style={s.emptyState}>Select a rundown to view shots.</div>
      </div>
    )
  }

  return (
    <div style={s.panel} data-testid="shot-list-panel">
      {running && <div style={s.liveLock}>Live — editing disabled</div>}

      <div style={s.toolbar}>
        <span style={s.title}>Shots</span>
        {!running && (
          <button
            style={s.addBtn}
            onClick={() => {
              setShowAddForm(true)
              setEditingShot(null)
            }}
            aria-label="Add shot"
          >
            + Add shot
          </button>
        )}
      </div>

      {showAddForm && !running && cameras.length > 0 && (
        <ShotForm
          cameras={cameras}
          onConfirm={(v) => void handleAdd(v)}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={shots.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ul style={s.list}>
            {shots.length === 0 && <li style={s.emptyState}>No shots. Add one above.</li>}
            {shots.map((shot) =>
              editingShot?.id === shot.id && !running ? (
                <li key={shot.id} style={{ listStyle: 'none' }}>
                  <ShotForm
                    cameras={cameras}
                    initial={{
                      cameraId: shot.cameraId,
                      durationMs: shot.durationMs,
                      label: shot.label ?? '',
                      transitionName: shot.transitionName,
                      transitionMs: shot.transitionMs,
                    }}
                    onConfirm={(v) => void handleEdit(v)}
                    onCancel={() => setEditingShot(null)}
                  />
                </li>
              ) : (
                <SortableShotRow
                  key={shot.id}
                  shot={shot}
                  cameras={cameras}
                  isLocked={running}
                  isLive={liveIndex === shots.indexOf(shot)}
                  isSelected={shot.id === selectedShotId}
                  isDraggingThis={shot.id === activeId}
                  isDropTarget={shot.id === overId && shot.id !== activeId}
                  liveRefCallback={liveIndex === shots.indexOf(shot) ? setLiveRef : undefined}
                  selectedRefCallback={
                    shot.id === selectedShotId
                      ? (el) => {
                          selectedRowRef.current = el
                        }
                      : undefined
                  }
                  onEdit={(s) => {
                    setEditingShot(s)
                    setShowAddForm(false)
                  }}
                  onDelete={(s) => void handleDelete(s)}
                />
              ),
            )}
          </ul>
        </SortableContext>

        <DragOverlay>
          {activeId
            ? (() => {
                const activeShot = shots.find((s) => s.id === activeId)
                if (!activeShot) return null
                const camera = cameras.find((c) => c.id === activeShot.cameraId)
                return (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, opacity: 0.9 }}>
                    <li
                      style={{
                        ...s.row,
                        background: '#2a3040',
                        borderRadius: '4px',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                      }}
                    >
                      <span style={s.dragHandle}>⠿</span>
                      {camera && (
                        <span style={s.cameraBadge(camera.color)}>CAM{camera.number}</span>
                      )}
                      <span style={s.name}>
                        {camera?.name ?? '—'}
                        {activeShot.label ? ` "${activeShot.label}"` : ''}
                      </span>
                      <span style={s.duration}>{msToMss(activeShot.durationMs)}</span>
                    </li>
                  </ul>
                )
              })()
            : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
