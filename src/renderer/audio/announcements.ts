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
 * 0005) and this only schedules and plays.
 *
 * Deliberately untested, per the issue's testing decisions: it does nothing but
 * drive timers and audio elements, and everything worth asserting on was
 * decided upstream in the pure scheduler.
 */

import type { AnnouncementPlan } from '../../shared/ipc-contract'

/** `setSinkId` is not in the DOM lib but is what Chromium exposes. */
type RoutableAudio = HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> }

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
  audio: RoutableAudio
  /** Settles once the clip can play through without stalling, or cannot load. */
  ready: Promise<void>
  cancelled: boolean
}

/**
 * @param required When true, a clip that cannot reach `sinkId` is dropped instead
 *   of falling back to the default device. The Intercom output's copy is a *copy*:
 *   played on the operator's speakers by mistake it is a doubled word in their
 *   ear, which is worse than the intercom being silent and sounds like a bug in
 *   the Announcement itself.
 */
function prepare(url: string, sinkId: string | null, required = false): PreparedClip {
  const audio = new Audio() as RoutableAudio
  const clip: PreparedClip = { audio, ready: Promise.resolve(), cancelled: false }

  const buffered = new Promise<void>((resolve) => {
    // `canplaythrough` rather than `canplay`: these clips are under a second,
    // so "enough to start" and "all of it" are the same fetch, and waiting for
    // the whole thing removes any chance of a stall mid-word.
    audio.addEventListener('canplaythrough', () => resolve(), { once: true })
    // A clip that fails to load must not leave its cue waiting forever. Let it
    // through and let `play()` report the real error.
    audio.addEventListener('error', () => resolve(), { once: true })
  })

  audio.preload = 'auto'
  audio.src = url
  audio.load()

  // Routed here rather than just before playing: switching sink opens a stream
  // on the new device, and paying for that at the cue costs the head of the clip.
  const routed =
    sinkId !== null && typeof audio.setSinkId === 'function'
      ? audio.setSinkId(sinkId).catch((err: unknown) => {
          if (required) {
            clip.cancelled = true
            console.error('[announce] intercom output unavailable, dropping its copy:', err)
            return
          }
          console.error('[announce] output device unavailable, using default:', err)
        })
      : Promise.resolve()

  clip.ready = Promise.all([buffered, routed]).then(() => undefined)
  return clip
}

/**
 * @param getSinkIds Every device this Announcement is to be heard on, primary
 *   first. More than one when the Intercom output is on: the same clips are
 *   played again on the loopback device an intercom client records, so the band
 *   hears the Announcement without it being taken away from the operator.
 */
export function createAnnouncementPlayer(
  getSinkIds: () => readonly (string | null)[],
): AnnouncementPlayer {
  let timers: ReturnType<typeof setTimeout>[] = []
  let prepared: PreparedClip[] = []

  function cancel(): void {
    for (const timer of timers) clearTimeout(timer)
    timers = []
    for (const clip of prepared) {
      // Checked by anything still waiting on `ready`, which resolves when the
      // cleared source raises its error event.
      clip.cancelled = true
      clip.audio.pause()
      // Releases the decoder immediately rather than at the next GC; a show can
      // cut off hundreds of these.
      clip.audio.src = ''
    }
    prepared = []
  }

  function speak(clip: PreparedClip): void {
    const start = (): void => {
      if (clip.cancelled) return
      clip.audio.play().catch((err: unknown) => {
        // A clip that will not play must not take the Live advance with it.
        console.error('[announce] playback failed:', err)
      })
    }
    // Normally already settled, so this costs a microtask. When it is not —
    // a cold disk, a plan pushed with almost no lead — waiting still beats
    // starting: an element told to play before it has data drops the head of
    // the clip, which is the whole problem this avoids.
    clip.ready.then(start, start)
  }

  return {
    play(plan) {
      cancel()
      if (!plan) return

      const sinkIds = getSinkIds()
      for (const scheduled of plan.clips) {
        // One element per destination. They are separate elements rather than one
        // element moved between devices because `setSinkId` is async and a clip
        // is under a second: by the time the second device opened, the word would
        // be over.
        const copies = sinkIds.map((sinkId, index) => prepare(scheduled.url, sinkId, index > 0))
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
