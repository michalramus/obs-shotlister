import { useState } from 'react'

// ---------------------------------------------------------------------------
// Draft rows
//
// Every editable row in the Cameras and Parts panels works the same way: typing
// changes a draft, leaving a field writes it, and the row shows what went wrong
// beside itself rather than throwing the operator out of the table. Four rows
// had four copies of that, and the copies disagreed — which is how a colour
// picked from the palette came to be saved by nothing at all. A swatch is a
// button, so clicking one blurs no field, and the only writer was `onBlur`.
//
// `pick` is the answer to that: a control with nothing to blur says so, and
// sets and commits in one move.
// ---------------------------------------------------------------------------

export interface DraftRow<T> {
  /** What the fields show — the operator's typing, not what is stored. */
  draft: T
  /** Types into one field. Writes nothing. */
  set: (patch: Partial<T>) => void
  /** The blur handler every field shares; a no-op when nothing changed. */
  commit: () => void
  /** Sets and commits at once, for a control that is never blurred. */
  pick: (patch: Partial<T>) => void
  /** Writes the draft whether or not it differs — a Save button's handler. */
  submit: () => void
  saving: boolean
  error: string | null
}

/** Whether two drafts say the same thing, so an idle blur writes nothing. */
function sameDraft<T extends object>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((key) => a[key] === b[key])
}

/**
 * One row's draft, and the single place it is written from.
 *
 * `committed` is the stored record as the row's fields read it, and it is only
 * the initial draft: re-reading it on every render would throw away whatever the
 * operator is halfway through typing. It is compared against, though, so a blur
 * that changed nothing never reaches the database.
 *
 * `save` rejecting is how a row reports a refusal — the message it carries is
 * what the operator is shown, so a validation failure is just a thrown Error.
 */
export function useDraftRow<T extends object>(
  committed: T,
  save: (draft: T) => Promise<unknown>,
  fallbackError = 'Save failed.',
): DraftRow<T> {
  const [draft, setDraft] = useState<T>(committed)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function write(next: T): void {
    setSaving(true)
    setError(null)
    save(next)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : fallbackError))
      .finally(() => setSaving(false))
  }

  function writeIfChanged(next: T): void {
    if (sameDraft(next, committed)) return
    write(next)
  }

  return {
    draft,
    set: (patch) => setDraft((d) => ({ ...d, ...patch })),
    commit: () => writeIfChanged(draft),
    pick: (patch) => {
      // Committed from the value in hand rather than from state: `setDraft` has
      // not landed yet, and a commit reading the old draft would save the
      // colour that was there before the click.
      const next = { ...draft, ...patch }
      setDraft(next)
      writeIfChanged(next)
    },
    submit: () => write(draft),
    saving,
    error,
  }
}
