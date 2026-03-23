import React, { useState, useRef, useEffect } from 'react'
import { useAppStore } from '../store'

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

  const [newName, setNewName] = useState('')
  const [showNewInput, setShowNewInput] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const newInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (showNewInput) newInputRef.current?.focus()
  }, [showNewInput])

  useEffect(() => {
    if (editingId) editInputRef.current?.focus()
  }, [editingId])

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

  return (
    <aside style={s.sidebar} data-testid="rundown-sidebar">
      <div style={s.header}>Rundowns</div>

      <ul style={s.list}>
        {rundowns.map((rd) => (
          <li
            key={rd.id}
            style={s.item(rd.id === activeRundownId)}
            onClick={() => void handleSelect(rd.id)}
            onMouseEnter={() => setHoveredId(rd.id)}
            onMouseLeave={() => setHoveredId(null)}
            data-testid="rundown-item"
          >
            {rd.id === activeRundownId && <span style={s.activeDot} />}

            {editingId === rd.id ? (
              <input
                ref={editInputRef}
                style={s.inlineInput}
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={() => void commitEdit()}
                onKeyDown={handleEditKeyDown}
                onClick={(e) => e.stopPropagation()}
                aria-label="Rename rundown"
              />
            ) : (
              <span
                style={s.name}
                onDoubleClick={() => startEdit(rd.id, rd.name)}
                title={running ? 'Rename disabled while live' : 'Double-click to rename'}
              >
                {rd.name}
              </span>
            )}

            {hoveredId === rd.id && editingId !== rd.id && (
              <button
                style={s.deleteBtn}
                onClick={(e) => void handleDelete(rd.id, e)}
                title="Delete rundown"
                aria-label={`Delete ${rd.name}`}
              >
                ×
              </button>
            )}
          </li>
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

      <button
        style={s.addBtn}
        onClick={() => setShowNewInput(true)}
        aria-label="Add new rundown"
      >
        + New Rundown
      </button>
    </aside>
  )
}
