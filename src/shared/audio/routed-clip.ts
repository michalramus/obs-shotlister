/**
 * Getting one sound onto the devices it has to be heard on.
 *
 * Both players in the app — the Cue player and the Announcement player — face the
 * same three facts about Chromium's output routing, and each used to solve them
 * its own way, which is why a second destination had to be built twice and why
 * two later fixes only landed on one side:
 *
 * - `setSinkId` is async, so a device is opened *ahead* of the sound, never at it;
 * - an Output duplicates rather than moves, so one sound is as many elements as
 *   it has destinations;
 * - a copy that misses its device must go silent rather than fall back onto the
 *   operator's own speakers, where it would be heard twice.
 *
 * This module owns all three. Which sound plays at which moment is the callers'
 * business and stays with them, and *which* Outputs carry a sound is
 * ./outputs.ts — re-exported below, so a player has one import for routing while
 * the main process can still ask the same question without meeting an audio
 * element.
 */

/** `setSinkId` is not in the DOM lib but is what Chromium exposes. */
export type RoutableAudio = HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> }

/**
 * Makes the element behind one clip.
 *
 * Injected rather than called directly so the players can be tested without a
 * DOM, a network or a sound card.
 */
export type AudioElementFactory = (url: string) => RoutableAudio

/** The real factory: an element told to fetch and decode before it is needed. */
export function createAudioElement(url: string): RoutableAudio {
  const audio = new Audio(url) as RoutableAudio
  audio.preload = 'auto'
  return audio
}

import type { SoundDestination } from './outputs'

export {
  soundDestinations,
  soundDelaysMs,
  worstCaseDelayMs,
  type SoundDestination,
  type SoundKind,
} from './outputs'

/** One sound on its way to one device. */
export interface RoutedClip {
  /**
   * The element behind the clip. Exposed because a caller may need to watch it
   * load — an Announcement waits for `canplaythrough` before its cue.
   */
  readonly audio: RoutableAudio
  /** Settles once the device is open, or once routing has given up on it. */
  readonly routed: Promise<void>
  /** Points the clip at a device, replacing wherever it was pointing. */
  route: (sinkId: string | null) => void
  /** Plays from the top. Never awaited: a sound must not be able to fail a caller. */
  play: () => void
  setVolume: (volume: number) => void
  /** Stops the clip and releases its decoder. */
  release: () => void
}

/**
 * @param duplicate True for the copy of an Output that is not Output 1. It is
 *   held to a stricter rule than the operator's own: it is heard on its device or
 *   nowhere. Output 1 is the operator's own device, so it is the one copy that
 *   may fall back — a copy meant for the band leaking into the operator's ears
 *   is every sound twice in the ear that has to hear the countdown.
 */
export function createRoutedClip(
  url: string,
  sinkId: string | null,
  createElement: AudioElementFactory,
  duplicate = false,
): RoutedClip {
  const audio = createElement(url)
  let routed: Promise<void> = Promise.resolve()

  // Muted until its routing lands. `setSinkId` is async, so an unmuted fresh
  // element would sound its first Cue on the default device — in the operator's
  // ear, doubled. It unmutes itself on success.
  if (duplicate) audio.muted = true

  function route(next: string | null): void {
    if (typeof audio.setSinkId !== 'function') {
      // Nothing can be mis-routed in a renderer that cannot name a device:
      // every copy plays on the system default, which is where this one already
      // is. Unmuted here because the mute above is only ever lifted by a routing
      // that lands, and no routing will be attempted — a copy left muted would
      // be played, gated and counted, and simply never heard. Reachable
      // wherever Output 1 carries only Cues, which leaves every Announcement a
      // non-primary copy.
      audio.muted = false
      return
    }
    // '' is how the API says "system default". Passing it matters: clips are
    // pooled and keep whichever sink they were last given, so without this,
    // choosing System default leaves them on the old device until a restart.
    routed = audio.setSinkId(next ?? '').then(
      () => {
        if (duplicate) audio.muted = false
      },
      (err: unknown) => {
        if (duplicate) {
          // Output 2's copy is a copy. Played on the operator's own device by
          // mistake it is every sound heard twice in their ear, so it is muted
          // instead: the element stays pooled and starts sounding again the
          // moment the device comes back.
          audio.muted = true
          console.error('[audio] output unavailable, muting its copy:', err)
          return
        }
        // A device unplugged since it was chosen must not silence the operator —
        // they would rather hear the countdown on the wrong speakers than not at
        // all — so the element is left on the default device.
        console.error('[audio] output device unavailable, using default:', err)
      },
    )
  }

  route(sinkId)

  return {
    audio,
    get routed() {
      return routed
    },
    route,
    play() {
      audio.currentTime = 0
      audio.play().catch((err: unknown) => console.error('[audio] playback failed:', err))
    },
    setVolume(volume) {
      audio.volume = volume
    },
    release() {
      audio.pause()
      // Releases the decoder immediately rather than at the next GC; a show can
      // cut off hundreds of these.
      audio.src = ''
    },
  }
}

/**
 * One sound and every destination it is heard on: Output 1's copy, and Output 2's.
 *
 * Separate elements per destination rather than one element retargeted per sound:
 * `setSinkId` is async and a beep is 200ms, so a retargeted element would still
 * be opening the device when the sound was due.
 */
export interface RoutedSound {
  /**
   * The clips, Output 1's first. Exposed for a caller that has to gate each copy
   * separately; playing them is what {@link RoutedSound.play} is for.
   */
  readonly clips: readonly RoutedClip[]
  /** What each clip is for, in the same order. */
  readonly destinations: readonly SoundDestination[]
  /** Plays on the destinations {@link PlayOptions} names. */
  play: (options?: PlayOptions) => void
  /** Re-points the existing elements, adding or dropping a copy. */
  setDestinations: (destinations: readonly SoundDestination[]) => void
  setVolume: (volume: number) => void
  /** Releases every element. */
  release: () => void
}

export interface PlayOptions {
  /**
   * Silences Output 1's copy only, never the other. The operator's mute button is
   * about their ears: the Cue Tray is not silenced by it either, and the band is
   * another listener rather than a speaker on this desk. Muting the beep to
   * concentrate must not take the band's countdown away.
   */
  silentToOperator?: boolean
  /**
   * Play only the copies of the Outputs with this delay — one moment's worth of
   * the sound. Omitted plays every destination, which is what a sound nobody can
   * schedule ahead (a Cue reacting to a Next just pressed) has to do.
   */
  delayMs?: number
}

export function createRoutedSound(
  url: string,
  destinations: readonly SoundDestination[],
  createElement: AudioElementFactory,
  volume = 1,
): RoutedSound {
  let clips: RoutedClip[] = []
  let current: SoundDestination[] = []
  let currentVolume = volume

  function sync(next: readonly SoundDestination[]): void {
    // A copy exists only while an Output wants it: another preloaded element per
    // Cue is not free, and a phone only ever has one.
    while (clips.length > next.length) {
      clips.pop()?.release()
      current.pop()
    }
    next.forEach((destination, index) => {
      const clip = clips[index]
      // Whether a copy may fall back to the default device is decided when its
      // element is made, so a destination that changes from Output 1's to another
      // Output's is rebuilt rather than re-pointed. It happens when Output 1 stops
      // carrying the sound, and re-pointing would leave the band's copy able to
      // land in the operator's ear.
      if (clip && current[index]?.primary === destination.primary) {
        clip.route(destination.sinkId)
        current[index] = destination
        return
      }
      clip?.release()
      const fresh = createRoutedClip(url, destination.sinkId, createElement, !destination.primary)
      fresh.setVolume(currentVolume)
      clips[index] = fresh
      current[index] = destination
    })
  }

  sync(destinations)

  return {
    get clips() {
      return clips
    },
    get destinations() {
      return current
    },
    play(options = {}) {
      const { silentToOperator = false, delayMs } = options
      // In order, so Output 1's copy — the one that must not be dropped — starts
      // first. The copies after it are never awaited: another listener must not be
      // able to delay or fail the sound the operator is listening for.
      clips.forEach((clip, index) => {
        const destination = current[index]
        if (!destination) return
        if (delayMs !== undefined && destination.delayMs !== delayMs) return
        if (destination.primary && silentToOperator) return
        clip.play()
      })
    },
    setDestinations: sync,
    setVolume(next) {
      currentVolume = next
      for (const clip of clips) clip.setVolume(next)
    },
    release() {
      for (const clip of clips) clip.release()
      clips = []
      current = []
    },
  }
}
