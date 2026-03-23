import React, { useState } from 'react'
import { useAppStore } from '../store'

const styles = {
  wrapper: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  } satisfies React.CSSProperties,

  select: {
    padding: '6px 10px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#fff',
    cursor: 'pointer',
    minWidth: '180px',
  } satisfies React.CSSProperties,

  button: {
    padding: '6px 12px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#3a3a3a',
    color: '#fff',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,

  modal: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  } satisfies React.CSSProperties,

  dialog: {
    background: '#2a2a2a',
    borderRadius: '8px',
    padding: '24px',
    minWidth: '320px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
    border: '1px solid #444',
  } satisfies React.CSSProperties,

  dialogTitle: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
    color: '#fff',
  } satisfies React.CSSProperties,

  input: {
    padding: '8px 10px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#1a1a1a',
    color: '#fff',
    width: '100%',
    boxSizing: 'border-box' as const,
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

  confirmBtn: {
    padding: '6px 14px',
    fontSize: '14px',
    borderRadius: '4px',
    border: 'none',
    background: '#4a90d9',
    color: '#fff',
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

  errorText: {
    color: '#e74c3c',
    fontSize: '13px',
    margin: 0,
  } satisfies React.CSSProperties,
}

// ---------------------------------------------------------------------------
// New Project modal
// ---------------------------------------------------------------------------

interface NewProjectModalProps {
  onClose: () => void
}

function NewProjectModal({ onClose }: NewProjectModalProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const addProject = useAppStore((s) => s.addProject)

  const handleConfirm = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Project name is required.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      await addProject(trimmed)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project.')
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      void handleConfirm()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div style={styles.modal} role="dialog" aria-modal="true" aria-labelledby="new-project-title">
      <div style={styles.dialog}>
        <h2 id="new-project-title" style={styles.dialogTitle}>
          New Project
        </h2>
        <input
          autoFocus
          style={styles.input}
          type="text"
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Project name"
        />
        {error !== null && <p style={styles.errorText}>{error}</p>}
        <div style={styles.row}>
          <button style={styles.cancelBtn} onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button style={styles.confirmBtn} onClick={() => void handleConfirm()} disabled={loading}>
            {loading ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rename Project modal
// ---------------------------------------------------------------------------

interface RenameProjectModalProps {
  projectId: string
  currentName: string
  onClose: () => void
}

function RenameProjectModal({ projectId, currentName, onClose }: RenameProjectModalProps): React.JSX.Element {
  const [name, setName] = useState(currentName)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const renameProject = useAppStore((s) => s.renameProject)

  const handleConfirm = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Project name is required.')
      return
    }
    if (trimmed === currentName) {
      onClose()
      return
    }
    setLoading(true)
    setError(null)
    try {
      await renameProject(projectId, trimmed)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename project.')
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      void handleConfirm()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div style={styles.modal} role="dialog" aria-modal="true" aria-labelledby="rename-project-title">
      <div style={styles.dialog}>
        <h2 id="rename-project-title" style={styles.dialogTitle}>
          Rename Project
        </h2>
        <input
          autoFocus
          style={styles.input}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Project name"
        />
        {error !== null && <p style={styles.errorText}>{error}</p>}
        <div style={styles.row}>
          <button style={styles.cancelBtn} onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button style={styles.confirmBtn} onClick={() => void handleConfirm()} disabled={loading}>
            {loading ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delete Project confirmation modal
// ---------------------------------------------------------------------------

interface DeleteProjectModalProps {
  projectId: string
  projectName: string
  onClose: () => void
}

function DeleteProjectModal({ projectId, projectName, onClose }: DeleteProjectModalProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const removeProject = useAppStore((s) => s.removeProject)

  const handleConfirm = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      await removeProject(projectId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete project.')
      setLoading(false)
    }
  }

  return (
    <div style={styles.modal} role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
      <div style={styles.dialog}>
        <h2 id="delete-project-title" style={styles.dialogTitle}>
          Delete Project
        </h2>
        <p style={{ margin: 0, color: '#ccc', fontSize: '14px' }}>
          Delete <strong style={{ color: '#fff' }}>{projectName}</strong> and all its data? This cannot be undone.
        </p>
        {error !== null && <p style={styles.errorText}>{error}</p>}
        <div style={styles.row}>
          <button style={styles.cancelBtn} onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button style={styles.dangerBtn} onClick={() => void handleConfirm()} disabled={loading}>
            {loading ? 'Deleting…' : 'Delete project and all its data'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProjectSelector — header bar component
// ---------------------------------------------------------------------------

interface ProjectSelectorProps {
  onOpenCameraConfig: () => void
}

export function ProjectSelector({ onOpenCameraConfig }: ProjectSelectorProps): React.JSX.Element {
  const projects = useAppStore((s) => s.projects)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const setActiveProject = useAppStore((s) => s.setActiveProject)
  const loadCameras = useAppStore((s) => s.loadCameras)

  const [showNewModal, setShowNewModal] = useState(false)
  const [showRenameModal, setShowRenameModal] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const id = e.target.value || null
    setActiveProject(id)
    if (id) {
      void loadCameras(id)
    }
  }

  return (
    <>
      <div style={styles.wrapper}>
        <select
          style={styles.select}
          value={activeProjectId ?? ''}
          onChange={handleSelectChange}
          aria-label="Active project"
        >
          {projects.length === 0 && (
            <option value="" disabled>
              No projects
            </option>
          )}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {activeProject !== null && (
          <>
            <button
              style={styles.button}
              onClick={() => setShowRenameModal(true)}
              title="Rename project"
              aria-label="Rename project"
            >
              Rename
            </button>
            <button
              style={styles.button}
              onClick={onOpenCameraConfig}
              title="Camera configuration"
              aria-label="Configure cameras"
            >
              ⚙ Cameras
            </button>
            <button
              style={{ ...styles.button, borderColor: '#c0392b', color: '#e74c3c' }}
              onClick={() => setShowDeleteModal(true)}
              title="Delete project"
              aria-label="Delete project"
            >
              Delete
            </button>
          </>
        )}

        <button style={styles.button} onClick={() => setShowNewModal(true)}>
          + New Project
        </button>
      </div>

      {showNewModal && <NewProjectModal onClose={() => setShowNewModal(false)} />}

      {showRenameModal && activeProject !== null && (
        <RenameProjectModal
          projectId={activeProject.id}
          currentName={activeProject.name}
          onClose={() => setShowRenameModal(false)}
        />
      )}

      {showDeleteModal && activeProject !== null && (
        <DeleteProjectModal
          projectId={activeProject.id}
          projectName={activeProject.name}
          onClose={() => setShowDeleteModal(false)}
        />
      )}
    </>
  )
}
