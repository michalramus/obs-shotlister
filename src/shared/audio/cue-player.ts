/**
 * Playing a Live session's Cues.
 *
 * The Cues are a fixed, tiny set of clips that ship with the app, so they are all
 * held open for the whole session: constructing an element per beep put a fetch
 * and a decode on the countdown's critical path.
 *
 * This owns the elements and their devices, nothing else. Which Cue sounds at
 * which moment is ./cue-schedule.ts, and whether the operator has muted it is
 * Live-session policy that stays in the view running the session.
 */

import type { AudioOutput } from '../ipc-contract'
import {
  createAudioElement,
  createRoutedSound,
  soundDestinations,
  type AudioElementFactory,
  type RoutedSound,
  type SoundDestination,
} from './routed-clip'

/** The fixed Cues: the countdown numbers, and the beeps at a Shot's edges. */
export const CUES = ['one', 'two', 'three', 'beep', 'beep-low'] as const

export type Cue = (typeof CUES)[number]

export interface CuePlayOptions {
  /**
   * Silences Output 1's copy only, never another Output's. The operator's mute
   * button is about their ears: muting the beep to concentrate must not take the
   * band's countdown away.
   */
  silentToOperator?: boolean
  /**
   * Play only the copies of the Outputs delayed by this much — the one moment
   * {@link cuesDueAt} says is due. Omitted plays every Output that carries Cues,
   * which is what a Cue nobody could schedule ahead has to do.
   */
  delayMs?: number
}

/** What a Live session needs of a player: it picks the moment, this finds the devices. */
export interface CuePlayback {
  /** Plays one Cue on the destinations {@link CuePlayOptions} names. */
  play: (cue: Cue, options?: CuePlayOptions) => void
  /**
   * The distinct delays of the Outputs that carry Cues, earliest moment first.
   *
   * The trigger asks for these rather than reading the settings: it is shared with
   * the Phone view, where there is one handset and no delay at all, and a view
   * that cannot name a device must not have to know what an Output is.
   */
  cueDelaysMs: () => readonly number[]
}

/** The operator window's player: it knows the Outputs, and can be re-pointed. */
export interface CuePlayer extends CuePlayback {
  /**
   * Points the whole pool at the Outputs that carry Cues.
   *
   * Called whenever the settings change, never on the way to a Cue: `setSinkId` is
   * async, so a device switched while a beep was due would put that beep on the
   * old device — the one beep the operator changed the setting to move.
   */
  setOutputs: (outputs: readonly [AudioOutput, AudioOutput]) => void
  setVolume: (volume: number) => void
  /** Releases every element. Call on unmount; a later play rebuilds the pool. */
  dispose: () => void
}

/**
 * The Phone view's player: the handset's own output, and no way to name another.
 *
 * A handset has no device choice to make, and a camera operator's phone must never
 * be routed anywhere else — so it is not handed the method that would name an
 * Output, rather than being trusted not to call it.
 */
export type PhoneCuePlayer = Omit<CuePlayer, 'setOutputs'>

/** One destination on the system default device: every player starts here. */
const DEFAULT_DESTINATIONS: readonly SoundDestination[] = [
  { sinkId: null, delayMs: 0, primary: true },
]

/**
 * @param baseUrl Where the Cue clips are served from — `media://` in the operator
 *   window, `/audio` over the LAN.
 */
export function createCuePlayer(
  baseUrl: string,
  createElement: AudioElementFactory = createAudioElement,
): CuePlayer {
  let destinations: readonly SoundDestination[] = DEFAULT_DESTINATIONS
  let volume = 1
  const pool = new Map<Cue, RoutedSound>()

  function soundFor(cue: Cue): RoutedSound {
    let sound = pool.get(cue)
    if (!sound) {
      sound = createRoutedSound(`${baseUrl}/${cue}.opus`, destinations, createElement, volume)
      pool.set(cue, sound)
    }
    return sound
  }

  // Preloaded up front rather than at the first beep, which is the one beep that
  // would then arrive late.
  for (const cue of CUES) soundFor(cue)

  return {
    play(cue, options) {
      soundFor(cue).play(options)
    },

    cueDelaysMs() {
      // Read off what actually plays rather than off the settings, so a phone
      // answers with its one local moment and the operator's player with theirs.
      const delays = new Set(destinations.map((d) => d.delayMs))
      return [...delays].sort((a, b) => b - a)
    },

    setOutputs(outputs) {
      destinations = soundDestinations(outputs, 'cue')
      for (const sound of pool.values()) sound.setDestinations(destinations)
    },

    setVolume(next) {
      volume = next
      for (const sound of pool.values()) sound.setVolume(next)
    },

    dispose() {
      for (const sound of pool.values()) sound.release()
      // Emptied rather than marked dead: a remount asks for the same Cues again,
      // and rebuilding one lazily is better than a silent countdown.
      pool.clear()
    },
  }
}

export function createPhoneCuePlayer(
  baseUrl: string,
  createElement: AudioElementFactory = createAudioElement,
): PhoneCuePlayer {
  const { play, cueDelaysMs, setVolume, dispose } = createCuePlayer(baseUrl, createElement)
  return { play, cueDelaysMs, setVolume, dispose }
}
