/**
 * Authoring a Lyric: set In, play, set Out, type the line.
 *
 * The Lyrics Track's *geometry* has been a module for a while — `lyrics.ts` says
 * where a line lands and what it collides with — but the loop that puts a line
 * there was a hundred and seventy-five lines of handlers inside TimelineEditor,
 * and it is a state machine rather than a form:
 *
 * - In with a Lyric selected moves that Lyric's in point; In with nothing
 *   selected only opens a pending mark, because the operator should not have to
 *   know whether they are correcting or creating.
 * - Out without an In is the one outright mistake in the loop.
 * - Out closes either the selection or the pending mark.
 * - A write the store refuses has to leave the typed text on screen: retyping a
 *   sung line because the range clashed is the worst thing this lane could do.
 *
 * Five separate places set the error string, and none of them could be reached
 * without mounting the largest component in the app.
 *
 * So the loop lives here as one state value and one transition over it. It
 * decides and it never writes: a transition that wants a line stored returns the
 * write as an intent, and whoever owns the store performs it and reports the
 * outcome back as one more event (`saved` or `refused`). Nothing here touches the
 * DOM, the store or a `MouseEvent`, so every rule above can be asserted directly.
 */

import type { Lyric } from '../../shared/types'
import { lyricRange, overlappingLyric } from './lyrics'

/** A line whose range is already fixed and whose text is still being typed. */
export interface LyricDraft {
  /** The line being re-worded, or null while a new line is being authored. */
  id: string | null
  startMs: number
  endMs: number
  text: string
}

/** Everything the Lyrics Track remembers between two operator actions. */
export interface LyricAuthoringState {
  /** An In point set but not yet closed by an Out: the dashed mark on the lane. */
  pendingInMs: number | null
  draft: LyricDraft | null
  selectedId: string | null
  /** What the operator is being told went wrong, or null. */
  error: string | null
}

export const initialLyricAuthoring: LyricAuthoringState = {
  pendingInMs: null,
  draft: null,
  selectedId: null,
  error: null,
}

/**
 * A line the loop wants stored.
 *
 * An intent rather than a call, so the decisions stay testable without a store:
 * the caller turns this into its one `upsertLyric` and reports back.
 */
export interface LyricWrite {
  /** The line being changed, or null for a new one. */
  id: string | null
  startMs: number
  endMs: number
  text: string
  /**
   * Whether success ends the authoring loop — clearing the draft, the pending In
   * point and the selection. True only for the line being typed: moving a stored
   * line's boundary leaves the operator where they were, with it still selected.
   */
  closesLoop: boolean
}

export interface LyricTransition {
  state: LyricAuthoringState
  /** The one write this transition asks for, or null. */
  write: LyricWrite | null
}

/**
 * What the operator did, in their own vocabulary, plus the two outcomes the
 * store reports back.
 *
 * `setIn` and `setOut` carry the playhead rather than reading it: where the
 * Playhead is belongs to `playhead.ts`, and a loop that asked it would need one.
 */
export type LyricAuthoringEvent =
  | { type: 'setIn'; atMs: number }
  | { type: 'setOut'; atMs: number }
  /** Typing into the draft. */
  | { type: 'type'; text: string }
  /** Enter in the draft: store the line. */
  | { type: 'commit' }
  /** Escape in the draft. */
  | { type: 'cancel' }
  /** Clicking a line: a toggle, so clicking the selected one deselects it. */
  | { type: 'select'; id: string }
  /** Clicking the lane's background. */
  | { type: 'clearSelection' }
  /** Double-clicking a line to re-word it. */
  | { type: 'reword'; id: string }
  /** Pressing an edge handle, before any movement. */
  | { type: 'grabEdge'; id: string }
  /** An edge drag that finished somewhere, as resolved by `grab.resizeLyric`. */
  | { type: 'edgeDragged'; id: string; startMs: number; endMs: number }
  | { type: 'deleted'; id: string }
  /** Clicking the error away. */
  | { type: 'dismissError' }
  | { type: 'saved'; write: LyricWrite }
  | { type: 'refused'; message: string }

/* The five things the operator gets told. Named because they used to be five
 * string literals scattered through a two-thousand-line component. */
const NO_LENGTH = 'That would leave the line no length'
const NO_IN_POINT = 'Set an In point first'
const OUT_ON_IN = 'Set the Out point away from the In point'
const NO_TEXT = 'A line needs some text'
const overlapsMessage = (clash: Lyric): string => `Overlaps “${clash.text}”`

function refuse(state: LyricAuthoringState, error: string): LyricTransition {
  return { state: { ...state, error }, write: null }
}

/**
 * The guard every write passes, wherever it came from.
 *
 * The store refuses an overlap already; checking here too is what lets the
 * operator be told *which* line is in the way instead of waiting for a round trip
 * to say "overlaps an existing line". The length check is belt and braces — every
 * caller went through {@link lyricRange} — but a zero-length line is unclickable
 * once stored, so it is refused at the one place all writes pass through rather
 * than trusted to stay refused at four.
 */
function propose(
  state: LyricAuthoringState,
  lyrics: readonly Lyric[],
  candidate: LyricWrite,
): LyricTransition {
  if (candidate.endMs <= candidate.startMs) return refuse(state, NO_LENGTH)
  const clash = overlappingLyric(lyrics, candidate, candidate.id)
  if (clash !== null) return refuse(state, overlapsMessage(clash))
  return { state, write: candidate }
}

/**
 * One step of the authoring loop.
 *
 * Returns the state unchanged — the same object, so a `useState` setter bails out
 * — for an event that means nothing where the loop currently stands.
 */
export function applyLyricEvent(
  state: LyricAuthoringState,
  event: LyricAuthoringEvent,
  lyrics: readonly Lyric[],
): LyricTransition {
  switch (event.type) {
    case 'setIn': {
      const selected = lyrics.find((l) => l.id === state.selectedId)
      if (selected !== undefined) {
        const range = lyricRange(event.atMs, selected.endMs)
        if (range === null) return refuse(state, NO_LENGTH)
        return propose(state, lyrics, {
          id: selected.id,
          ...range,
          text: selected.text,
          closesLoop: false,
        })
      }
      return {
        state: { ...state, error: null, pendingInMs: Math.round(event.atMs) },
        write: null,
      }
    }

    case 'setOut': {
      const selected = lyrics.find((l) => l.id === state.selectedId)
      if (selected !== undefined) {
        const range = lyricRange(selected.startMs, event.atMs)
        if (range === null) return refuse(state, NO_LENGTH)
        return propose(state, lyrics, {
          id: selected.id,
          ...range,
          text: selected.text,
          closesLoop: false,
        })
      }
      if (state.pendingInMs === null) return refuse(state, NO_IN_POINT)
      const range = lyricRange(state.pendingInMs, event.atMs)
      if (range === null) return refuse(state, OUT_ON_IN)
      const clash = overlappingLyric(lyrics, range)
      if (clash !== null) return refuse(state, overlapsMessage(clash))
      // Not a write yet: a line with no text is not a line. The draft is the
      // range held on screen until the operator has typed one.
      return {
        state: { ...state, error: null, draft: { id: null, ...range, text: '' } },
        write: null,
      }
    }

    case 'type':
      if (state.draft === null) return { state, write: null }
      return { state: { ...state, draft: { ...state.draft, text: event.text } }, write: null }

    case 'commit': {
      const draft = state.draft
      if (draft === null) return { state, write: null }
      const text = draft.text.trim()
      if (text === '') return refuse(state, NO_TEXT)
      return propose(state, lyrics, { ...draft, text, closesLoop: true })
    }

    case 'cancel':
      // The pending In point deliberately stands: the operator abandoned the
      // wording, not the mark they made before typing it.
      return { state: { ...state, draft: null, error: null }, write: null }

    case 'select':
      return {
        state: {
          ...state,
          error: null,
          selectedId: state.selectedId === event.id ? null : event.id,
        },
        write: null,
      }

    case 'clearSelection':
      if (state.selectedId === null) return { state, write: null }
      return { state: { ...state, selectedId: null }, write: null }

    case 'reword': {
      const lyric = lyrics.find((l) => l.id === event.id)
      if (lyric === undefined) return { state, write: null }
      return {
        state: {
          ...state,
          selectedId: lyric.id,
          draft: {
            id: lyric.id,
            startMs: lyric.startMs,
            endMs: lyric.endMs,
            text: lyric.text,
          },
        },
        write: null,
      }
    }

    case 'grabEdge':
      return { state: { ...state, selectedId: event.id, error: null }, write: null }

    case 'edgeDragged': {
      const lyric = lyrics.find((l) => l.id === event.id)
      if (lyric === undefined) return { state, write: null }
      return propose(state, lyrics, {
        id: lyric.id,
        startMs: event.startMs,
        endMs: event.endMs,
        text: lyric.text,
        closesLoop: false,
      })
    }

    case 'deleted':
      if (state.selectedId !== event.id) return { state, write: null }
      return { state: { ...state, selectedId: null }, write: null }

    case 'dismissError':
      if (state.error === null) return { state, write: null }
      return { state: { ...state, error: null }, write: null }

    case 'saved':
      return {
        state: event.write.closesLoop ? initialLyricAuthoring : { ...state, error: null },
        write: null,
      }

    case 'refused':
      // The draft stays exactly as typed. This is the whole reason a refusal is
      // an event rather than a thrown error swallowed at the call site.
      return { state: { ...state, error: event.message }, write: null }
  }
}
