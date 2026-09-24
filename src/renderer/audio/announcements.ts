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

export function createAnnouncementPlayer(getSinkId: () => string | null): AnnouncementPlayer {
  let timers: ReturnType<typeof setTimeout>[] = []
  let playing: RoutableAudio[] = []

  function cancel(): void {
    for (const timer of timers) clearTimeout(timer)
    timers = []
    for (const audio of playing) {
      audio.pause()
      // Releases the decoder immediately rather than at the next GC; a show can
      // cut off hundreds of these.
      audio.src = ''
    }
    playing = []
  }

  function speak(url: string): void {
    const audio = new Audio(url) as RoutableAudio
    playing.push(audio)

    const start = (): void => {
      audio.play().catch((err: unknown) => {
        // A clip that will not play must not take the Live advance with it.
        console.error('[announce] playback failed:', err)
      })
    }

    const sinkId = getSinkId()
    if (sinkId && typeof audio.setSinkId === 'function') {
      // Route first, then play: starting on the default device and switching
      // mid-clip would put the first syllables on the operator's speakers.
      audio.setSinkId(sinkId).then(start, (err: unknown) => {
        console.error('[announce] output device unavailable, using default:', err)
        start()
      })
    } else {
      start()
    }
  }

  return {
    play(plan) {
      cancel()
      if (!plan) return

      for (const clip of plan.clips) {
        // A clip due now is played now rather than through a zero timer, so the
        // first syllable is not pushed into the next frame.
        if (clip.atMs <= 0) {
          speak(clip.url)
          continue
        }
        timers.push(setTimeout(() => speak(clip.url), clip.atMs))
      }
    },

    dispose: cancel,
  }
}
