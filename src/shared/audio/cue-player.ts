/**
 * Playing a Live session's Cues.
 *
 * The Cues are a fixed, tiny set of clips that ship with the app, so they are all
 * held open for the whole session: constructing an element per beep put a fetch
 * and a decode on the countdown's critical path.
 *
 * This owns the elements and their devices, nothing else. Which Cue sounds at
 * which moment, and whether the operator has muted it, is Live-session policy and
 * stays in the view that runs the session.
 */

import {
  createAudioElement,
  createRoutedSound,
  type AudioElementFactory,
  type RoutedSound,
  type SoundSinks,
} from './routed-clip'

/** The fixed Cues: the countdown numbers, and the beeps at a Shot's edges. */
export const CUES = ['one', 'two', 'three', 'beep', 'beep-low'] as const

export type Cue = (typeof CUES)[number]

/** What a Live session needs of a player: it picks the moment, this finds the devices. */
export interface CuePlayback {
  /**
   * Plays one Cue.
   *
   * @param silentToOperator Silences the operator's own copy only, never the
   *   Intercom output's. Their mute button is about their ears: muting the beep to
   *   concentrate must not take the band's countdown away.
   */
  play: (cue: Cue, silentToOperator?: boolean) => void
}

/** The operator window's player: it chooses devices, and feeds the Intercom output. */
export interface CuePlayer extends CuePlayback {
  /**
   * Points the whole pool at the operator's device and the Intercom output.
   *
   * @param sinks `cue` is the device the Cue setting names, `null` the system
   *   default; `intercom` is the Intercom output, or `null` when it is off.
   */
  setSinks: (sinks: { cue: string | null; intercom: string | null }) => void
  setVolume: (volume: number) => void
  /** Releases every element. Call on unmount; a later play rebuilds the pool. */
  dispose: () => void
}

/**
 * The Phone view's player: the handset's own output, and no way to name another.
 *
 * A handset has no device choice to make, and a camera operator's phone must never
 * become an Intercom output — so it is not handed the method that would name one,
 * rather than being trusted not to call it.
 */
export type PhoneCuePlayer = Omit<CuePlayer, 'setSinks'>

/**
 * @param baseUrl Where the Cue clips are served from — `media://` in the operator
 *   window, `/audio` over the LAN.
 */
export function createCuePlayer(
  baseUrl: string,
  createElement: AudioElementFactory = createAudioElement,
): CuePlayer {
  let sinks: SoundSinks = { primary: null, intercom: null }
  let volume = 1
  const pool = new Map<Cue, RoutedSound>()

  function soundFor(cue: Cue): RoutedSound {
    let sound = pool.get(cue)
    if (!sound) {
      sound = createRoutedSound(`${baseUrl}/${cue}.opus`, sinks, createElement, volume)
      pool.set(cue, sound)
    }
    return sound
  }

  // Preloaded up front rather than at the first beep, which is the one beep that
  // would then arrive late.
  for (const cue of CUES) soundFor(cue)

  return {
    play(cue, silentToOperator = false) {
      soundFor(cue).play(silentToOperator)
    },

    setSinks(next) {
      sinks = { primary: next.cue, intercom: next.intercom }
      // Re-routed here rather than on the way to a play, because `setSinkId` is
      // async: switching devices while a beep is due would put that beep on the
      // old device, which is the one beep the operator changed the setting to
      // move.
      for (const sound of pool.values()) sound.setSinks(sinks)
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
  const { play, setVolume, dispose } = createCuePlayer(baseUrl, createElement)
  return { play, setVolume, dispose }
}
