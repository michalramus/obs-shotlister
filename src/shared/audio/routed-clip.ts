/**
 * Getting one sound onto the devices it has to be heard on.
 *
 * Both players in the app — the Cue player and the Announcement player — face the
 * same three facts about Chromium's output routing, and each used to solve them
 * its own way, which is why the Intercom output had to be built twice and why two
 * later fixes only landed on one side:
 *
 * - `setSinkId` is async, so a device is opened *ahead* of the sound, never at it;
 * - the Intercom output duplicates rather than moves, so one sound is as many
 *   elements as it has destinations;
 * - a duplicate that misses its device must go silent rather than fall back onto
 *   the operator's own speakers, where it would be heard twice.
 *
 * This module owns all three. Which sound plays at which moment is the callers'
 * business and stays with them.
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

/**
 * The devices one sound is heard on. `null` is the system default.
 *
 * @param primary The device this sound's own setting names.
 * @param intercom The Intercom output, or `null` when it is off or unchosen.
 */
export interface SoundSinks {
  primary: string | null
  intercom: string | null
}

/**
 * The devices to play a sound on, primary first.
 *
 * The Intercom output duplicates rather than moves: a Cue or an Announcement is
 * played again on the loopback device an intercom client records, while the
 * operator keeps hearing it on their own. That makes "the device for this sound"
 * a list everywhere audio is played, and this is the one place that decides what
 * is in it.
 */
export function outputTargets(
  primary: string | null,
  intercom: string | null,
): readonly (string | null)[] {
  // The same device twice is two elements playing the same clip into one output:
  // audibly a stutter, not a duplicate. It happens the moment somebody points
  // the Announcement selector at the Virtual output and then switches the
  // Intercom output on as well, which is a reasonable thing to try.
  if (intercom === null || intercom === primary) return [primary]
  return [primary, intercom]
}

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
 * @param duplicate True for the Intercom output's copy, which is held to a
 *   stricter rule than the operator's own: it is heard on its device or nowhere.
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
    if (typeof audio.setSinkId !== 'function') return
    // '' is how the API says "system default". Passing it matters: clips are
    // pooled and keep whichever sink they were last given, so without this,
    // choosing System default leaves them on the old device until a restart.
    routed = audio.setSinkId(next ?? '').then(
      () => {
        if (duplicate) audio.muted = false
      },
      (err: unknown) => {
        if (duplicate) {
          // The Intercom output's copy is a copy. Played on the operator's own
          // device by mistake it is every sound heard twice in their ear, so it
          // is muted instead: the element stays pooled and starts sounding again
          // the moment the device comes back.
          audio.muted = true
          console.error('[audio] intercom output unavailable, muting its copy:', err)
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
 * One sound and every device it is heard on: the operator's own, plus the
 * Intercom output's copy.
 *
 * Separate elements per device rather than one element retargeted per sound:
 * `setSinkId` is async and a beep is 200ms, so a retargeted element would still
 * be opening the device when the sound was due.
 */
export interface RoutedSound {
  /**
   * The clips, primary first. Exposed for a caller that has to gate each copy
   * separately; playing all of them is what {@link RoutedSound.play} is for.
   */
  readonly clips: readonly RoutedClip[]
  /**
   * Plays on every device.
   *
   * @param silentToOperator Silences the operator's own copy only. Their mute
   *   button is about their ears: the Cue Tray is not silenced by it either, and
   *   the intercom is another listener, not a speaker on this desk. Muting the
   *   beep to concentrate must not take the band's countdown away.
   */
  play: (silentToOperator?: boolean) => void
  /** Re-points the existing elements, adding or dropping the intercom copy. */
  setSinks: (sinks: SoundSinks) => void
  setVolume: (volume: number) => void
  /** Releases every element. */
  release: () => void
}

export function createRoutedSound(
  url: string,
  sinks: SoundSinks,
  createElement: AudioElementFactory,
  volume = 1,
): RoutedSound {
  let clips: RoutedClip[] = []
  let currentVolume = volume

  function sync(next: SoundSinks): void {
    const targets = outputTargets(next.primary, next.intercom)
    // The Intercom output's copy exists only while there is an intercom to feed:
    // another preloaded element per Cue is not free, and a phone never has one.
    while (clips.length > targets.length) clips.pop()?.release()
    targets.forEach((target, index) => {
      const clip = clips[index]
      if (clip) {
        clip.route(target)
        return
      }
      const fresh = createRoutedClip(url, target, createElement, index > 0)
      fresh.setVolume(currentVolume)
      clips.push(fresh)
    })
  }

  sync(sinks)

  return {
    get clips() {
      return clips
    },
    play(silentToOperator = false) {
      // In order, so the operator's own copy — index 0, the one that must not be
      // dropped — starts first. The copies after it are never awaited: the
      // intercom must not be able to delay or fail the sound they listen for.
      clips.forEach((clip, index) => {
        if (index === 0 && silentToOperator) return
        clip.play()
      })
    },
    setSinks: sync,
    setVolume(next) {
      currentVolume = next
      for (const clip of clips) clip.setVolume(next)
    },
    release() {
      for (const clip of clips) clip.release()
      clips = []
    },
  }
}
