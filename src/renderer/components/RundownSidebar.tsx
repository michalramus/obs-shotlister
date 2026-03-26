import React, { useState, useRef, useEffect } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useAppStore } from '../store'
import type { Rundown } from '../../shared/types'

const s = {
  sidebar: {
    width: '220px',
    flexShrink: 0,
    background: '#1a1a1a',
    borderRight: '1px solid #2a2a2a',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  } satisfies React.CSSProperties,

  header: {
    padding: '12px 14px 8px',
    fontSize: '11px',
    fontWeight: 700,
    color: '#666',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    borderBottom: '1px solid #2a2a2a',
  } satisfies React.CSSProperties,

  list: {
    flex: 1,
    overflowY: 'auto' as const,
    listStyle: 'none',
    margin: 0,
    padding: '4px 0',
  } satisfies React.CSSProperties,

  folderHeader: {
    padding: '6px 14px 3px',
    fontSize: '10px',
    fontWeight: 700,
    color: '#555',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    marginTop: '4px',
  } satisfies React.CSSProperties,

  item: (isActive: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    padding: '7px 14px',
    cursor: 'pointer',
    background: isActive ? '#2a3a4a' : 'transparent',
    color: isActive ? '#fff' : '#bbb',
    fontSize: '13px',
    position: 'relative',
    gap: '6px',
  }),

  activeDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: '#e74c3c',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  name: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,

  deleteBtn: {
    background: 'none',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    fontSize: '14px',
    padding: '0 2px',
    lineHeight: 1,
    flexShrink: 0,
  } satisfies React.CSSProperties,

  menuBtn: {
    background: 'none',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    fontSize: '13px',
    padding: '0 2px',
    lineHeight: 1,
    flexShrink: 0,
  } satisfies React.CSSProperties,

  inlineInput: {
    background: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '3px',
    color: '#fff',
    fontSize: '13px',
    padding: '3px 6px',
    outline: 'none',
    width: '100%',
  } satisfies React.CSSProperties,

  addBtn: {
    margin: '8px 10px',
    padding: '6px 10px',
    background: 'none',
    border: '1px solid #333',
    borderRadius: '4px',
    color: '#888',
    fontSize: '13px',
    cursor: 'pointer',
    textAlign: 'left' as const,
  } satisfies React.CSSProperties,

  contextMenu: {
    position: 'fixed' as const,
    background: '#222',
    border: '1px solid #444',
    borderRadius: '4px',
    zIndex: 1000,
    minWidth: '160px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
    padding: '4px 0',
  } satisfies React.CSSProperties,

  contextMenuItem: {
    padding: '7px 14px',
    fontSize: '12px',
    color: '#ccc',
    cursor: 'pointer',
    display: 'block',
    width: '100%',
    background: 'none',
    border: 'none',
    textAlign: 'left' as const,
  } satisfies React.CSSProperties,

  dragHandle: {
    cursor: 'grab',
    color: '#444',
    fontSize: '12px',
    flexShrink: 0,
    lineHeight: 1,
    userSelect: 'none' as const,
  } satisfies React.CSSProperties,
}

interface ContextMenuState {
  rundownId: string
  x: number
  y: number
}

interface SortableRundownItemProps {
  rundown: Rundown
  isActive: boolean
  editingId: string | null
  editingName: string
  editInputRef: React.RefObject<HTMLInputElement | null>
  running: boolean
  folders: string[]
  onSelect: (id: string) => void
  onStartEdit: (id: string, name: string) => void
  onEditChange: (val: string) => void
  onEditKeyDown: (e: React.KeyboardEvent) => void
  onCommitEdit: () => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onContextMenu: (rundownId: string, e: React.MouseEvent) => void
  contextMenuState: ContextMenuState | null
  onCloseContextMenu: () => void
  onSetFolder: (id: string, folder: string | null) => void
}

function SortableRundownItem({
  rundown,
  isActive,
  editingId,
  editingName,
  editInputRef,
  running,
  onSelect,
  onStartEdit,
  onEditChange,
  onEditKeyDown,
  onCommitEdit,
  onDelete,
  onContextMenu,
}: SortableRundownItemProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rundown.id,
  })

  const style: React.CSSProperties = {
    ...s.item(isActive),
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      onClick={() => onSelect(rundown.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid="rundown-item"
    >
      <span
        style={s.dragHandle}
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        title="Drag to reorder"
      >
        ⠿
      </span>

      {isActive && <span style={s.activeDot} />}

      {editingId === rundown.id ? (
        <input
          ref={editInputRef as React.RefObject<HTMLInputElement>}
          style={s.inlineInput}
          value={editingName}
          onChange={(e) => onEditChange(e.target.value)}
          onBlur={onCommitEdit}
          onKeyDown={onEditKeyDown}
          onClick={(e) => e.stopPropagation()}
          aria-label="Rename rundown"
        />
      ) : (
        <span
          style={s.name}
          onDoubleClick={() => onStartEdit(rundown.id, rundown.name)}
          title={running ? 'Rename disabled while live' : 'Double-click to rename'}
        >
          {rundown.name}
        </span>
      )}

      {hovered && editingId !== rundown.id && (
        <>
          <button
            style={s.menuBtn}
            onClick={(e) => {
              e.stopPropagation()
              onContextMenu(rundown.id, e)
            }}
            title="More options"
            aria-label={`Options for ${rundown.name}`}
          >
            ⋯
          </button>
          <button
            style={s.deleteBtn}
            onClick={(e) => onDelete(rundown.id, e)}
            title="Delete rundown"
            aria-label={`Delete ${rundown.name}`}
          >
            ×
          </button>
        </>
      )}
    </li>
  )
}

export function RundownSidebar(): React.JSX.Element {
  const rundowns = useAppStore((s) => s.rundowns)
  const activeRundownId = useAppStore((s) => s.activeRundownId)
  const running = useAppStore((s) => s.running)
  const setActiveRundown = useAppStore((s) => s.setActiveRundown)
  const loadShots = useAppStore((s) => s.loadShots)
  const addRundown = useAppStore((s) => s.addRundown)
  const renameRundown = useAppStore((s) => s.renameRundown)
  const removeRundown = useAppStore((s) => s.removeRundown)
  const reorderRundowns = useAppStore((s) => s.reorderRundowns)
  const setRundownFolder = useAppStore((s) => s.setRundownFolder)

  const [newName, setNewName] = useState('')
  const [showNewInput, setShowNewInput] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [folderInput, setFolderInput] = useState<{ rundownId: string; value: string } | null>(null)

  const newInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  useEffect(() => {
    if (showNewInput) newInputRef.current?.focus()
  }, [showNewInput])

  useEffect(() => {
    if (editingId) editInputRef.current?.focus()
  }, [editingId])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handler = (): void => setContextMenu(null)
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [contextMenu])

  async function handleSelect(id: string): Promise<void> {
    setActiveRundown(id)
    await loadShots(id).catch((err: unknown) => {
      console.error('[RundownSidebar] loadShots error:', err)
    })
  }

  async function handleCreate(): Promise<void> {
    const trimmed = newName.trim()
    if (!trimmed) {
      setShowNewInput(false)
      setNewName('')
      return
    }
    try {
      await addRundown(trimmed)
    } catch (err) {
      console.error('[RundownSidebar] create error:', err)
    }
    setShowNewInput(false)
    setNewName('')
  }

  function handleNewKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter') {
      void handleCreate()
    } else if (e.key === 'Escape') {
      setShowNewInput(false)
      setNewName('')
    }
  }

  function startEdit(id: string, name: string): void {
    if (running) return
    setEditingId(id)
    setEditingName(name)
  }

  async function commitEdit(): Promise<void> {
    if (!editingId) return
    const trimmed = editingName.trim()
    if (trimmed) {
      try {
        await renameRundown(editingId, trimmed)
      } catch (err) {
        console.error('[RundownSidebar] rename error:', err)
      }
    }
    setEditingId(null)
    setEditingName('')
  }

  function handleEditKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter') {
      void commitEdit()
    } else if (e.key === 'Escape') {
      setEditingId(null)
      setEditingName('')
    }
  }

  async function handleDelete(id: string, e: React.MouseEvent): Promise<void> {
    e.stopPropagation()
    const rundown = rundowns.find((r) => r.id === id)
    if (!rundown) return
    const confirmed = window.confirm(`Delete rundown "${rundown.name}"?`)
    if (!confirmed) return
    try {
      await removeRundown(id)
    } catch (err) {
      console.error('[RundownSidebar] delete error:', err)
    }
  }

  function handleContextMenu(rundownId: string, e: React.MouseEvent): void {
    e.preventDefault()
    setContextMenu({ rundownId, x: e.clientX, y: e.clientY })
  }

  async function handleSetFolder(id: string, folder: string | null): Promise<void> {
    try {
      await setRundownFolder(id, folder)
    } catch (err) {
      console.error('[RundownSidebar] setFolder error:', err)
    }
    setContextMenu(null)
    setFolderInput(null)
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = rundowns.findIndex((r) => r.id === active.id)
    const newIndex = rundowns.findIndex((r) => r.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(rundowns, oldIndex, newIndex)

    // Determine target folder from the item at newIndex in reordered list
    const targetRundown = reordered[newIndex]
    const draggedRundown = rundowns[oldIndex]
    const targetFolder = targetRundown.id !== draggedRundown.id ? targetRundown.folder : draggedRundown.folder

    const ids = reordered.map((r) => r.id)

    reorderRundowns(ids).catch((err: unknown) => {
      console.error('[RundownSidebar] reorder error:', err)
    })

    // If the dragged item moved to a different folder context, update the folder
    if (draggedRundown.folder !== targetFolder) {
      handleSetFolder(draggedRundown.id, targetFolder).catch((err: unknown) => {
        console.error('[RundownSidebar] setFolder on drag error:', err)
      })
    }
  }

  // Collect unique folders (excluding null)
  const folders = Array.from(new Set(rundowns.map((r) => r.folder).filter((f): f is string => f !== null)))

  // Build groups: ungrouped first, then each folder
  const ungrouped = rundowns.filter((r) => r.folder === null)
  const grouped = folders.map((folder) => ({
    folder,
    rundowns: rundowns.filter((r) => r.folder === folder),
  }))

  const contextRundown = contextMenu ? rundowns.find((r) => r.id === contextMenu.rundownId) : null

  return (
    <aside style={s.sidebar} data-testid="rundown-sidebar">
      <div style={s.header}>Rundowns</div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={rundowns.map((r) => r.id)} strategy={verticalListSortingStrategy}>
          <ul style={s.list}>
            {/* Ungrouped rundowns */}
            {ungrouped.map((rd) => (
              <SortableRundownItem
                key={rd.id}
                rundown={rd}
                isActive={rd.id === activeRundownId}
                editingId={editingId}
                editingName={editingName}
                editInputRef={editInputRef}
                running={running}
                folders={folders}
                onSelect={(id) => void handleSelect(id)}
                onStartEdit={startEdit}
                onEditChange={setEditingName}
                onEditKeyDown={handleEditKeyDown}
                onCommitEdit={() => void commitEdit()}
                onDelete={(id, e) => void handleDelete(id, e)}
                onContextMenu={handleContextMenu}
                contextMenuState={contextMenu}
                onCloseContextMenu={() => setContextMenu(null)}
                onSetFolder={(id, folder) => void handleSetFolder(id, folder)}
              />
            ))}

            {/* Folder groups */}
            {grouped.map(({ folder, rundowns: folderRundowns }) => (
              <React.Fragment key={folder}>
                <li style={s.folderHeader}>
                  <span style={{ marginRight: '4px' }}>▸</span>
                  {folder}
                </li>
                {folderRundowns.map((rd) => (
                  <SortableRundownItem
                    key={rd.id}
                    rundown={rd}
                    isActive={rd.id === activeRundownId}
                    editingId={editingId}
                    editingName={editingName}
                    editInputRef={editInputRef}
                    running={running}
                    folders={folders}
                    onSelect={(id) => void handleSelect(id)}
                    onStartEdit={startEdit}
                    onEditChange={setEditingName}
                    onEditKeyDown={handleEditKeyDown}
                    onCommitEdit={() => void commitEdit()}
                    onDelete={(id, e) => void handleDelete(id, e)}
                    onContextMenu={handleContextMenu}
                    contextMenuState={contextMenu}
                    onCloseContextMenu={() => setContextMenu(null)}
                    onSetFolder={(id, folder) => void handleSetFolder(id, folder)}
                  />
                ))}
              </React.Fragment>
            ))}

            {showNewInput && (
              <li style={s.item(false)}>
                <input
                  ref={newInputRef}
                  style={s.inlineInput}
                  placeholder="Rundown name…"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onBlur={() => void handleCreate()}
                  onKeyDown={handleNewKeyDown}
                  aria-label="New rundown name"
                />
              </li>
            )}
          </ul>
        </SortableContext>
      </DndContext>

      <button
        style={s.addBtn}
        onClick={() => setShowNewInput(true)}
        aria-label="Add new rundown"
      >
        + New Rundown
      </button>

      {/* Context menu */}
      {contextMenu && contextRundown && (
        <div
          style={{ ...s.contextMenu, left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {folderInput && folderInput.rundownId === contextMenu.rundownId ? (
            <div style={{ padding: '6px 10px' }}>
              <input
                style={{ ...s.inlineInput, width: '130px' }}
                placeholder="Folder name…"
                value={folderInput.value}
                autoFocus
                onChange={(e) => setFolderInput({ ...folderInput, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = folderInput.value.trim()
                    void handleSetFolder(contextMenu.rundownId, v || null)
                  } else if (e.key === 'Escape') {
                    setFolderInput(null)
                    setContextMenu(null)
                  }
                }}
              />
            </div>
          ) : (
            <>
              <button
                style={s.contextMenuItem}
                onClick={() => setFolderInput({ rundownId: contextMenu.rundownId, value: contextRundown.folder ?? '' })}
              >
                {contextRundown.folder ? 'Change folder…' : 'Add to folder…'}
              </button>
              {contextRundown.folder && (
                <button
                  style={s.contextMenuItem}
                  onClick={() => void handleSetFolder(contextMenu.rundownId, null)}
                >
                  Remove from folder
                </button>
              )}
              <button
                style={s.contextMenuItem}
                onClick={() => {
                  setContextMenu(null)
                  startEdit(contextMenu.rundownId, contextRundown.name)
                }}
              >
                Rename
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  )
}
