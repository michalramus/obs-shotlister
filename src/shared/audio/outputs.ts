/**
 * The app's two Outputs, and what each one is owed.
 *
 * An Output is a device, a delay and what it carries (ADR 0010). Every question
 * that follows from that — which Outputs a Cue is played on, how many distinct
 * moments a sound has to be played at, what the worst delay is — is answered
 * here, once, because the answers are needed on both sides of the process
 * divide: the renderer routes elements with them and the main process builds one
 * Announcement plan per delay with them.
 *
 * Kept apart from routed-clip.ts, which owns the same subject on the Chromium
 * side, precisely so the main process can import this without importing a module
 * that mentions an audio element. routed-clip re-exports what the renderer
 * needs, so a player still reads as though routing were one module.
 */

import type { AudioOutput, OutputCarries } from '../ipc-contract'

/**
 * Bounds on an Output's delay.
 *
 * Five seconds is far beyond any Mumble buffer and already longer than the gap
 * between most countdown numbers, so anything larger would only mute the sounds
 * it was meant to move. Negative covers a route that runs ahead.
 *
 * Defined with the Output rather than with either player, so the field that
 * validates what the operator types, the reader that bounds what was stored, and
 * the schedulers that honour it cannot drift apart.
 */
export const OUTPUT_DELAY_MIN_MS = -5000
export const OUTPUT_DELAY_MAX_MS = 5000

/** Which sort of sound is being routed: a Cue, or an Announcement. */
export type SoundKind = 'cue' | 'voice'

/** Whether an Output carrying `carries` is one of `kind`'s destinations. */
export function carriesKind(carries: OutputCarries, kind: SoundKind): boolean {
  if (carries === 'both') return true
  return carries === (kind === 'cue' ? 'cues' : 'voice')
}

/**
 * The two Outputs a fresh install starts with.
 *
 * Output 1 carries everything on the system default device, so a machine nobody
 * has configured is audible; Output 2 is off until somebody has a second
 * listener to feed.
 */
export function defaultAudioOutputs(): [AudioOutput, AudioOutput] {
  return [
    { enabled: true, sinkId: null, delayMs: 0, carries: 'both' },
    { enabled: false, sinkId: null, delayMs: 0, carries: 'voice' },
  ]
}

/** One sound on its way to one listener. */
export interface SoundDestination {
  /** The device. `null` is the system default. */
  sinkId: string | null
  /** The Output's delay: this copy is played that much before it is wanted. */
  delayMs: number
  /**
   * True for Output 1's copy — the operator's own. It is the copy their mute
   * button silences and the only one that falls back to the default device when
   * its own is gone.
   */
  primary: boolean
}

/**
 * Every destination one kind of sound has, Output 1's first.
 *
 * A disabled Output is not a destination, and neither is an Output whose
 * `carries` excludes the kind — that is the whole of the selector's meaning, and
 * it lives here rather than in the two players.
 *
 * Two Outputs on one device are deduplicated only when their delays match as
 * well. The identical pair is the stutter this rule exists to prevent: two
 * elements playing one clip into one device, which sounds like a fault rather
 * than a duplicate. The same device at two delays is not that — it is two wanted
 * sounds at two moments, which is exactly what an operator asks for when one
 * Output feeds their speakers now and the other feeds the same cable early.
 */
export function soundDestinations(
  outputs: readonly [AudioOutput, AudioOutput],
  kind: SoundKind,
): SoundDestination[] {
  const destinations: SoundDestination[] = []
  outputs.forEach((output, index) => {
    if (!output.enabled) return
    if (!carriesKind(output.carries, kind)) return
    const already = destinations.some(
      (d) => d.sinkId === output.sinkId && d.delayMs === output.delayMs,
    )
    if (already) return
    // Output 1 is index 0 and is pushed first, so the primary copy is also the
    // first one played — the players treat every copy after it as expendable.
    destinations.push({ sinkId: output.sinkId, delayMs: output.delayMs, primary: index === 0 })
  })
  return destinations
}

/**
 * The distinct delays one kind of sound has to be played at, earliest first.
 *
 * A trigger fires a sound once per delay — a countdown word crosses one
 * threshold per delay, an Announcement is planned once per delay — so this is
 * how many times, and how far ahead. Empty when nothing carries the kind, which
 * is an operator choosing silence and not a fault.
 */
export function soundDelaysMs(
  outputs: readonly [AudioOutput, AudioOutput],
  kind: SoundKind,
): number[] {
  const delays = new Set(soundDestinations(outputs, kind).map((d) => d.delayMs))
  // Largest first: it is the earliest moment, so a caller walking the list
  // handles the copy with the least time to spare first.
  return [...delays].sort((a, b) => b - a)
}

/**
 * The longest delay one kind of sound faces, or zero when it has no destination.
 *
 * The worst case is what Edit mode badges against: an Announcement that does not
 * fit the most delayed Output is one the band may not hear, and the operator has
 * to be told while they can still lengthen the Call.
 */
export function worstCaseDelayMs(
  outputs: readonly [AudioOutput, AudioOutput],
  kind: SoundKind,
): number {
  return soundDelaysMs(outputs, kind)[0] ?? 0
}
