/**
 * Playing an Announcement in the renderer.
 *
 * The main process decides *what* to speak and *when* (see
 * src/main/live/announcer.ts); this plays it. Playback lives here because the
 * renderer is the only side with an output-device API, and routing
 * Announcements to a virtual cable feeding Mumble — while the operator keeps
 * their own countdown Cues on their own speakers — is the whole point of the
 * feature. ADR 0003 constrains who owns *state*, not who owns audio output.
 *
 * Nothing is ever synthesised here: every clip already exists on disk (ADR
 * 0005) and this only schedules and plays. How a clip reaches a device — and how
 * each Output gets its copy — is src/shared/audio/routed-clip.ts, shared with the
 * Cue player.
 *
 * Deliberately untested, per the issue's testing decisions: what is left here is
 * timers, and everything worth asserting on was decided upstream in the pure
 * scheduler or below in the routed clip.
 */

import type { AnnouncementPlan } from '../../shared/ipc-contract'
import {
  createAudioElement,
  createRoutedSound,
  type RoutedClip,
  type SoundDestination,
} from '../../shared/audio/routed-clip'

export interface AnnouncementPlayer {
  /**
   * Speaks a plan, cutting off whatever is still speaking. `null` cancels
   * without starting anything.
   *
   * Announcements are never queued: a new one always wins, because the band
   * must hear the most imminent instruction and never a stale one.
   */
  play: (plan: AnnouncementPlan | null) => void
  /** Cancels everything pending. Call on unmount. */
  dispose: () => void
}

/**
 * One clip, fetched, decoded and routed before its cue rather than at it.
 *
 * Preparing early is not an optimisation, it is the difference between hearing
 * the word and hearing most of it. Three things have to happen before a clip
 * can make a sound: the file comes over the `media://` protocol, Chromium
 * decodes it, and the output device opens a stream. Started at the moment the
 * clip is due, all three delay the first sample — and Piper's clips begin
 * speaking at sample zero, with no leading silence to spend. A number clip runs
 * about 200ms in total, so a fifth of a second of setup is most of the word:
 * "trzy" arrives as "czy", "gitara" as "itara".
 *
 * A plan is pushed when its Call becomes next, seconds ahead of the first clip,
 * so there is ample time to do all of it up front.
 */
interface PreparedClip {
  clip: RoutedClip
  /** Settles once the clip can play through without stalling, or cannot load. */
  ready: Promise<void>
  cancelled: boolean
}

/**
 * Every copy of one scheduled clip: one per Output that carries Announcements.
 *
 * The routed clip decides which device each opens; the waiting-to-be-loaded part
 * is this module's, because only an Announcement is played once, cold, at an
 * exact moment.
 */
function prepare(url: string, destinations: readonly SoundDestination[]): PreparedClip[] {
  const sound = createRoutedSound(url, destinations, createAudioElement)
  return sound.clips.map((clip) => {
    const buffered = new Promise<void>((resolve) => {
      // `canplaythrough` rather than `canplay`: these clips are under a second,
      // so "enough to start" and "all of it" are the same fetch, and waiting for
      // the whole thing removes any chance of a stall mid-word.
      clip.audio.addEventListener('canplaythrough', () => resolve(), { once: true })
      // A clip that fails to load must not leave its cue waiting forever. Let it
      // through and let `play()` report the real error.
      clip.audio.addEventListener('error', () => resolve(), { once: true })
    })
    return {
      clip,
      // The routing is waited on alongside the bytes, so opening the device is
      // paid for here and not at the cue, where it would cost the head of the clip.
      ready: Promise.all([buffered, clip.routed]).then(() => undefined),
      cancelled: false,
    }
  })
}

/**
 * @param getDestinations The destinations this Announcement is to be heard on —
 *   every enabled Output carrying Announcements — read at the moment a plan
 *   arrives rather than held, so a device changed between shows takes effect
 *   without rebuilding the player.
 */
export function createAnnouncementPlayer(
  getDestinations: () => readonly SoundDestination[],
): AnnouncementPlayer {
  let timers: ReturnType<typeof setTimeout>[] = []
  let prepared: PreparedClip[] = []

  function cancel(): void {
    for (const timer of timers) clearTimeout(timer)
    timers = []
    for (const copy of prepared) {
      // Checked by anything still waiting on `ready`, which resolves when the
      // released source raises its error event.
      copy.cancelled = true
      copy.clip.release()
    }
    prepared = []
  }

  function speak(copy: PreparedClip): void {
    const start = (): void => {
      if (copy.cancelled) return
      copy.clip.play()
    }
    // Normally already settled, so this costs a microtask. When it is not —
    // a cold disk, a plan pushed with almost no lead — waiting still beats
    // starting: an element told to play before it has data drops the head of
    // the clip, which is the whole problem this avoids.
    copy.ready.then(start, start)
  }

  return {
    play(plan) {
      cancel()
      if (!plan) return

      const destinations = getDestinations()
      for (const scheduled of plan.clips) {
        const copies = prepare(scheduled.url, destinations)
        prepared.push(...copies)

        // A clip due now is played now rather than through a zero timer, so the
        // first syllable is not pushed into the next frame.
        if (scheduled.atMs <= 0) {
          for (const copy of copies) speak(copy)
          continue
        }
        timers.push(
          setTimeout(() => {
            for (const copy of copies) speak(copy)
          }, scheduled.atMs),
        )
      }
    },

    dispose: cancel,
  }
}
