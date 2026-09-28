import React, { useId, useState } from 'react'
import { ps } from './panel-styles'

export interface ConfirmDestructiveProps {
  /** The thing being deleted, in the operator's words: "camera", "part". */
  noun: string
  /** Which one, named the way the table names it. */
  subject: React.ReactNode
  onCancel: () => void
  onConfirm: () => Promise<void>
  /**
   * Turns a refusal into something the operator can act on.
   *
   * A refusal is the whole reason this dialog stays open on failure, so the
   * message it shows has to be about the show and not about the database.
   */
  describeError?: (err: unknown) => string
}

/**
 * "Delete X? This cannot be undone."
 *
 * The Cameras and Parts panels each had this dialog, differing only in the noun.
 * The deletion itself stays with the caller, along with what a refusal means:
 * a Part counts the Calls still pointing at it, and a Camera cannot.
 */
export function ConfirmDestructive({
  noun,
  subject,
  onCancel,
  onConfirm,
  describeError,
}: ConfirmDestructiveProps): React.JSX.Element {
  const titleId = useId()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      // Never swallowed: a refusal the operator does not see reads as a delete
      // that worked, and the row is still there when they look again.
      setError(
        describeError?.(err) ?? (err instanceof Error ? err.message : `Failed to delete ${noun}.`),
      )
      setLoading(false)
    }
  }

  return (
    <div style={ps.confirmOverlay} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div style={ps.confirmDialog}>
        <h3 id={titleId} style={ps.confirmTitle}>
          Delete {noun}?
        </h3>
        <p style={ps.confirmBody}>
          Delete <strong style={{ color: '#fff' }}>{subject}</strong>? This cannot be undone.
        </p>
        {error !== null && <p style={ps.errorText}>{error}</p>}
        <div style={ps.buttonRow}>
          <button style={ps.cancelBtn} onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button style={ps.dangerBtn} onClick={() => void handleConfirm()} disabled={loading}>
            {loading ? 'Deleting…' : `Delete ${noun}`}
          </button>
        </div>
      </div>
    </div>
  )
}
