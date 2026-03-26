import React, { useState, useRef, useEffect } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  DragCancelEvent,
  useDroppable,
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

  item: (isActive: boolean, indented: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    padding: '7px 14px',
    paddingLeft: indented ? '28px' : '14px',
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
    margin: '4px 10px',
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

  folderDeleteBtn: {
    background: 'none',
    border: 'none',
    color: '#5a7a9a',
    cursor: 'pointer',
    fontSize: '13px',
    padding: '0 2px',
    lineHeight: 1,
    flexShrink: 0,
    marginLeft: 'auto',
  } satisfies React.CSSProperties,
}

const DROP_LINE_STYLE: React.CSSProperties = {
  height: '2px',
  background: '#5a9fd4',
  borderRadius: '1px',
  margin: '0 8px',
  pointerEvents: 'none',
}

interface ContextMenuState {
  rundownId: string
  x: number
  y: number
}

interface SortableRundownItemProps {
  rundown: Rundown
  isActive: boolean
  indented: boolean
  editingId: string | null
  editingName: string
  editInputRef: React.RefObject<HTMLInputElement | null>
  running: boolean
  isDraggingThis: boolean
  isDropTarget: boolean
  onSelect: (id: string) => void
  onStartEdit: (id: string, name: string) => void
  onEditChange: (val: string) => void
  onEditKeyDown: (e: React.KeyboardEvent) => void
  onCommitEdit: () => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onContextMenu: (rundownId: string, e: React.MouseEvent) => void
}

function RundownItemContent({
  rundown,
  isActive,
  indented,
  editingId,
  editingName,
  editInputRef,
  running,
  hovered,
  setHovered,
  dragHandleProps,
  onSelect,
  onStartEdit,
  onEditChange,
  onEditKeyDown,
  onCommitEdit,
  onDelete,
  onContextMenu,
  style,
  nodeRef,
}: {
  rundown: Rundown
  isActive: boolean
  indented: boolean
  editingId: string | null
  editingName: string
  editInputRef: React.RefObject<HTMLInputElement | null>
  running: boolean
  hovered: boolean
  setHovered: (v: boolean) => void
  dragHandleProps: object
  onSelect: (id: string) => void
  onStartEdit: (id: string, name: string) => void
  onEditChange: (val: string) => void
  onEditKeyDown: (e: React.KeyboardEvent) => void
  onCommitEdit: () => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onContextMenu: (rundownId: string, e: React.MouseEvent) => void
  style?: React.CSSProperties
  nodeRef?: (node: HTMLElement | null) => void
}): React.JSX.Element {
  return (
    <li
      ref={nodeRef}
      style={{ ...s.item(isActive, indented), ...style }}
      onClick={() => onSelect(rundown.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid="rundown-item"
    >
      <span
        style={s.dragHandle}
        {...dragHandleProps}
        onClick={(e) => e.stopPropagation()}
        title="Drag to reorder or drop on folder"
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

function SortableRundownItem({
  rundown,
  isActive,
  indented,
  editingId,
  editingName,
  editInputRef,
  running,
  isDraggingThis,
  isDropTarget,
  onSelect,
  onStartEdit,
  onEditChange,
  onEditKeyDown,
  onCommitEdit,
  onDelete,
  onContextMenu,
}: SortableRundownItemProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)

  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: rundown.id,
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // invisible placeholder while dragging — keeps layout frozen
    opacity: isDraggingThis ? 0 : 1,
    pointerEvents: isDraggingThis ? 'none' : undefined,
  }

  return (
    <>
      {isDropTarget && <li style={DROP_LINE_STYLE} aria-hidden="true" />}
      <RundownItemContent
        rundown={rundown}
        isActive={isActive}
        indented={indented}
        editingId={editingId}
        editingName={editingName}
        editInputRef={editInputRef}
        running={running}
        hovered={hovered}
        setHovered={setHovered}
        dragHandleProps={{ ...attributes, ...listeners }}
        onSelect={onSelect}
        onStartEdit={onStartEdit}
        onEditChange={onEditChange}
        onEditKeyDown={onEditKeyDown}
        onCommitEdit={onCommitEdit}
        onDelete={onDelete}
        onContextMenu={onContextMenu}
        style={style}
        nodeRef={setNodeRef}
      />
    </>
  )
}

interface FolderHeaderProps {
  folderName: string
  collapsed: boolean
  isOver: boolean
  onToggle: () => void
  onRename: (newName: string) => void
  onDelete: () => void
}

function FolderHeader({
  folderName,
  collapsed,
  isOver,
  onToggle,
  onRename,
  onDelete,
}: FolderHeaderProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(folderName)
  const inputRef = useRef<HTMLInputElement>(null)

  const { setNodeRef } = useDroppable({ id: 'folder:' + folderName })

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  function commitRename(): void {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== folderName) {
      onRename(trimmed)
    }
    setEditing(false)
  }

  const baseStyle: React.CSSProperties = {
    padding: '7px 10px',
    background: isOver ? '#253547' : '#1e2837',
    borderLeft: isOver ? '3px solid #5a9fd4' : '3px solid #3d6b9e',
    fontSize: '12px',
    fontWeight: 700,
    color: '#c8d8e8',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    cursor: 'pointer',
    marginTop: '8px',
    userSelect: 'none',
    listStyle: 'none',
  }

  return (
    <li
      ref={setNodeRef}
      style={baseStyle}
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid="folder-header"
    >
      <span style={{ fontSize: '10px', flexShrink: 0 }}>{collapsed ? '▸' : '▾'}</span>
      <span style={{ fontSize: '14px', flexShrink: 0 }}>📁</span>

      {editing ? (
        <input
          ref={inputRef}
          style={{ ...s.inlineInput, fontSize: '12px', padding: '1px 4px' }}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            else if (e.key === 'Escape') {
              setEditValue(folderName)
              setEditing(false)
            }
          }}
          onClick={(e) => e.stopPropagation()}
          aria-label="Rename folder"
        />
      ) : (
        <span
          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setEditValue(folderName)
            setEditing(true)
          }}
          title="Double-click to rename folder"
        >
          {folderName}
        </span>
      )}

      {hovered && !editing && (
        <button
          style={s.folderDeleteBtn}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="Remove folder (rundowns become ungrouped)"
          aria-label={`Delete folder ${folderName}`}
        >
          ×
        </button>
      )}
    </li>
  )
}

function UngroupedDropZone(): React.JSX.Element {
  const { setNodeRef } = useDroppable({ id: 'folder:__none__' })
  return <li ref={setNodeRef} style={{ height: '4px', listStyle: 'none' }} aria-hidden="true" />
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
  const [showFolderInput, setShowFolderInput] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [localFolders, setLocalFolders] = useState<string[]>(() =>
    Array.from(new Set(rundowns.map((r) => r.folder).filter((f): f is string => f !== null))),
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const newInputRef = useRef<HTMLInputElement>(null)
  const newFolderInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // Sync localFolders when rundowns change (add new folders from rundowns)
  useEffect(() => {
    const fromRundowns = rundowns.map((r) => r.folder).filter((f): f is string => f !== null)
    setLocalFolders((prev) => Array.from(new Set([...prev, ...fromRundowns])))
  }, [rundowns])

  useEffect(() => {
    if (showNewInput) newInputRef.current?.focus()
  }, [showNewInput])

  useEffect(() => {
    if (showFolderInput) newFolderInputRef.current?.focus()
  }, [showFolderInput])

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

  // Compute all displayed folders
  const displayedFolders = Array.from(
    new Set([
      ...localFolders,
      ...rundowns.map((r) => r.folder).filter((f): f is string => f !== null),
    ]),
  )

  const activeRundown = activeId ? rundowns.find((r) => r.id === activeId) : null

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

  function handleCreateFolder(): void {
    const trimmed = newFolderName.trim()
    if (trimmed && !localFolders.includes(trimmed)) {
      setLocalFolders((prev) => [...prev, trimmed])
    }
    setShowFolderInput(false)
    setNewFolderName('')
  }

  function handleNewFolderKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter') {
      handleCreateFolder()
    } else if (e.key === 'Escape') {
      setShowFolderInput(false)
      setNewFolderName('')
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
  }

  async function handleRenameFolder(oldName: string, newName: string): Promise<void> {
    const inFolder = rundowns.filter((r) => r.folder === oldName)
    for (const rd of inFolder) {
      await handleSetFolder(rd.id, newName)
    }
    setLocalFolders((prev) => prev.map((f) => (f === oldName ? newName : f)))
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(oldName)) {
        next.delete(oldName)
        next.add(newName)
      }
      return next
    })
  }

  async function handleDeleteFolder(folderName: string): Promise<void> {
    const inFolder = rundowns.filter((r) => r.folder === folderName)
    for (const rd of inFolder) {
      await handleSetFolder(rd.id, null)
    }
    setLocalFolders((prev) => prev.filter((f) => f !== folderName))
  }

  function toggleCollapse(folderName: string): void {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folderName)) {
        next.delete(folderName)
      } else {
        next.add(folderName)
      }
      return next
    })
  }

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(event.active.id as string)
    setOverId(null)
  }

  function handleDragOver(event: DragOverEvent): void {
    const { over } = event
    if (over && typeof over.id === 'string' && over.id.startsWith('folder:')) {
      setDragOverFolder(over.id.slice('folder:'.length))
      setOverId(null)
    } else {
      setDragOverFolder(null)
      setOverId(over ? (over.id as string) : null)
    }
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event
    setActiveId(null)
    setOverId(null)
    setDragOverFolder(null)

    if (!over) return

    if (typeof over.id === 'string' && over.id.startsWith('folder:')) {
      const folder = over.id.slice('folder:'.length)
      const targetFolder = folder === '__none__' ? null : folder
      void handleSetFolder(active.id as string, targetFolder)
      return
    }

    if (active.id === over.id) return

    const oldIndex = rundowns.findIndex((r) => r.id === active.id)
    const newIndex = rundowns.findIndex((r) => r.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(rundowns, oldIndex, newIndex)

    const targetRundown = rundowns[newIndex]
    const draggedRundown = rundowns[oldIndex]
    const targetFolder = targetRundown.folder

    const ids = reordered.map((r) => r.id)
    reorderRundowns(ids).catch((err: unknown) => {
      console.error('[RundownSidebar] reorder error:', err)
    })

    if (draggedRundown.folder !== targetFolder) {
      void handleSetFolder(draggedRundown.id, targetFolder)
    }
  }

  function handleDragCancel(_event: DragCancelEvent): void {
    setActiveId(null)
    setOverId(null)
    setDragOverFolder(null)
  }

  const ungrouped = rundowns.filter((r) => r.folder === null)
  const contextRundown = contextMenu ? rundowns.find((r) => r.id === contextMenu.rundownId) : null

  const sharedItemProps = {
    editingId,
    editingName,
    editInputRef,
    running,
    onSelect: (id: string) => void handleSelect(id),
    onStartEdit: startEdit,
    onEditChange: setEditingName,
    onEditKeyDown: handleEditKeyDown,
    onCommitEdit: () => void commitEdit(),
    onDelete: (id: string, e: React.MouseEvent) => void handleDelete(id, e),
    onContextMenu: handleContextMenu,
  }

  return (
    <aside style={s.sidebar} data-testid="rundown-sidebar">
      <div style={s.header}>Rundowns</div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={rundowns.map((r) => r.id)} strategy={verticalListSortingStrategy}>
          <ul style={s.list}>
            <UngroupedDropZone />

            {ungrouped.map((rd) => (
              <SortableRundownItem
                key={rd.id}
                rundown={rd}
                isActive={rd.id === activeRundownId}
                indented={false}
                isDraggingThis={rd.id === activeId}
                isDropTarget={rd.id === overId && rd.id !== activeId}
                {...sharedItemProps}
              />
            ))}

            {displayedFolders.map((folder) => {
              const folderRundowns = rundowns.filter((r) => r.folder === folder)
              const collapsed = collapsedFolders.has(folder)
              const isOver = dragOverFolder === folder

              return (
                <React.Fragment key={folder}>
                  <FolderHeader
                    folderName={folder}
                    collapsed={collapsed}
                    isOver={isOver}
                    onToggle={() => toggleCollapse(folder)}
                    onRename={(newName) => void handleRenameFolder(folder, newName)}
                    onDelete={() => void handleDeleteFolder(folder)}
                  />
                  {!collapsed &&
                    folderRundowns.map((rd) => (
                      <SortableRundownItem
                        key={rd.id}
                        rundown={rd}
                        isActive={rd.id === activeRundownId}
                        indented={true}
                        isDraggingThis={rd.id === activeId}
                        isDropTarget={rd.id === overId && rd.id !== activeId}
                        {...sharedItemProps}
                      />
                    ))}
                </React.Fragment>
              )
            })}

            {showNewInput && (
              <li style={s.item(false, false)}>
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

        <DragOverlay>
          {activeRundown ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, opacity: 0.9 }}>
              <RundownItemContent
                rundown={activeRundown}
                isActive={activeRundown.id === activeRundownId}
                indented={activeRundown.folder !== null}
                editingId={null}
                editingName=""
                editInputRef={{ current: null }}
                running={running}
                hovered={false}
                setHovered={() => {}}
                dragHandleProps={{}}
                onSelect={() => {}}
                onStartEdit={() => {}}
                onEditChange={() => {}}
                onEditKeyDown={() => {}}
                onCommitEdit={() => {}}
                onDelete={() => {}}
                onContextMenu={() => {}}
                style={{
                  background: '#2a3040',
                  borderRadius: '4px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                }}
              />
            </ul>
          ) : null}
        </DragOverlay>
      </DndContext>

      <button style={s.addBtn} onClick={() => setShowNewInput(true)} aria-label="Add new rundown">
        + New Rundown
      </button>

      {showFolderInput ? (
        <div style={{ margin: '0 10px 8px' }}>
          <input
            ref={newFolderInputRef}
            style={s.inlineInput}
            placeholder="Folder name…"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onBlur={handleCreateFolder}
            onKeyDown={handleNewFolderKeyDown}
            aria-label="New folder name"
          />
        </div>
      ) : (
        <button
          style={{ ...s.addBtn, marginTop: 0 }}
          onClick={() => setShowFolderInput(true)}
          aria-label="Add new folder"
        >
          + New Folder
        </button>
      )}

      {contextMenu && contextRundown && (
        <div
          style={{ ...s.contextMenu, left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            style={s.contextMenuItem}
            onClick={() => {
              setContextMenu(null)
              startEdit(contextMenu.rundownId, contextRundown.name)
            }}
          >
            Rename
          </button>
          {contextRundown.folder && (
            <button
              style={s.contextMenuItem}
              onClick={() => void handleSetFolder(contextMenu.rundownId, null)}
            >
              Remove from folder
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
