/**
 * Turning "this Call is next" into the clips that say so.
 *
 * `scheduleAnnouncement` decides *placement* and nothing else — it is pure and
 * knows nothing about Parts, settings or the cache. Somebody still has to look
 * up the Part behind a Call, resolve the Project's Voice, connector and
 * countdown, and find the rendered clip for each piece of text. That lookup is
 * this module, kept out of the Live session so the session stays about the Live
 * queue and this stays testable against an in-memory database.
 *
 * Nothing here plays audio, touches Electron or synthesises anything: a Live
 * session only ever plays clips that already exist (ADR 0005). A clip that was
 * never rendered is simply absent from the schedule input, which is why a
 * missing render warns rather than blocks — the show runs, it is just quieter.
 */

import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { Shot } from '../../shared/types'
import type { AnnouncementPlan, AnnouncementRoute } from '../../shared/ipc-contract'
import { type AnnouncementClip, scheduleAnnouncement } from '../../shared/announcement'
import { ENGINE_ID, clipHash, partClipHash } from '../../shared/render-plan'
import { numberTexts } from '../../shared/number-text'
import { targetIdOf } from '../../shared/rundown-item'
import { toMediaUrl } from '../../shared/media-url'
import { soundDelaysMs } from '../../shared/audio/outputs'
import { getAudioDevices, getEffectiveVoiceSettings } from '../ipc/settings'
import { getPart } from '../ipc/parts'

import { CLIP_EXTENSION } from '../speech/cache'

export interface AnnouncementBuilder {
  /**
   * The Announcement to speak before `call`, or `null` when there is nothing to
   * say — no Part, nothing rendered, no Output carrying Announcements, or no room
   * left before the Call starts.
   *
   * `leadMs` is how long the operator's plan says is left before `call` goes
   * live; cue times come back relative to now, so the caller issues the plan
   * immediately.
   */
  planFor: (call: Shot, leadMs: number) => AnnouncementPlan | null
}

interface ClipRow {
  duration_ms: number
}

/**
 * @param clipsDir Where rendered clips live, normally `<userData>/speech`. Passed
 * in rather than resolved here so this module never imports Electron and tests
 * can point it anywhere.
 */
export function createAnnouncementBuilder(
  db: Database.Database,
  clipsDir: string,
): AnnouncementBuilder {
  const clipByHash = (hash: string): AnnouncementClip | null => {
    const row = db.prepare('SELECT duration_ms FROM speech_clips WHERE hash = ?').get(hash) as
      | ClipRow
      | undefined
    if (!row) return null
    // The renderer loads clips over the custom protocol; a file:// URL would be
    // blocked and a bare path would not resolve at all.
    return {
      url: toMediaUrl(join(clipsDir, `${hash}${CLIP_EXTENSION}`)),
      durationMs: row.duration_ms,
    }
  }

  return {
    planFor(call, leadMs) {
      try {
        // An unassigned Call cannot be announced. A Live session refuses to
        // start on one, so this only ever sees a Rundown edited underneath it.
        // The target is resolved for the Voice-over Kind rather than read off
        // `partId` directly, so this asks the same question every other reader
        // does.
        const partId = targetIdOf(call, 'voice')
        if (!partId) return null

        const part = getPart(db, partId)
        if (!part) return null

        const settings = getEffectiveVoiceSettings(db, part.projectId)

        // The same text and the same hash the renderer wrote under: a renamed
        // Part misses here and its Announcement is dropped, which is exactly
        // what "stale" means — better silent than speaking the old name.
        const phrase = clipByHash(partClipHash(part, settings))

        const texts = numberTexts()
        const numbers = new Map<number, AnnouncementClip>()
        for (const n of settings.countdown) {
          const text = texts.get(n)
          if (!text) continue
          const clip = clipByHash(clipHash(text, settings.voice, ENGINE_ID))
          if (clip) numbers.set(n, clip)
        }

        // One route per distinct delay among the Outputs that carry Announcements
        // — usually one, at most two. Scheduling once at the largest delay and
        // offsetting the copies would be simpler, but the filtering that drops a
        // clip with no room left runs against that largest delay, so an Output
        // with more room would silently lose a countdown number it had time for.
        // The cost of doing it properly is one extra pass over five durations.
        const routes: AnnouncementRoute[] = []
        for (const outputDelayMs of soundDelaysMs(getAudioDevices(db).outputs, 'voice')) {
          const route = scheduleAnnouncement({
            leadMs,
            phrase,
            numbers,
            countdown: settings.countdown,
            placement: settings.placement,
            outputDelayMs,
          })
          if (route) routes.push(route)
        }

        // Nothing to say on any route: `null` rather than an empty plan, so the
        // caller's "a plan arriving cuts off what is speaking" stays one rule.
        return routes.length > 0 ? { callId: call.id, routes } : null
      } catch (err) {
        // A show keeps running even when speech does not: a broken lookup must
        // never be able to abort the Next that asked for it.
        console.error('[announce] failed to build plan for call', call.id, err)
        return null
      }
    },
  }
}
