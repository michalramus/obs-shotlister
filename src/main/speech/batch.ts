/**
 * Rendering a list of clips, and telling one bad clip from a dead engine.
 *
 * The batch *policy* lives here, away from Piper: what to do when an item
 * fails, when to stop, what to report as it goes. It reaches nothing — no
 * child process, no filesystem, no Electron — because it is handed a
 * {@link Synthesiser} and does nothing but drive it. That is the seam: the
 * stop-on-fatal rule below is the difference between one clear line in the log
 * and sixty-one copies of it, and it is worth proving without spawning Piper
 * sixty-one times to do so.
 *
 * Nothing in here may run during a Live session (ADR 0005). The caller enforces
 * that; see `speech/service`.
 */

import type { RenderPlanItem } from '../../shared/render-plan'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface SynthesisedClip {
  hash: string
  durationMs: number
}

/**
 * Turns one planned clip into audio in the cache.
 *
 * The one function the whole Piper side is behind. It must not report a clip
 * until the bytes are readable at its hash — the caller writes the duration to
 * the database the moment it hears about a clip, and a row is a promise that a
 * file exists.
 */
export type Synthesiser = (item: RenderPlanItem) => Promise<SynthesisedClip>

/**
 * Marks a failure as "the engine cannot run at all", as opposed to "this one
 * clip did not render".
 *
 * The difference matters to a batch: one bad clip is worth skipping past, but
 * an engine that cannot be executed will fail identically for all sixty-one,
 * and logging that sixty-one times buries the one line that explains it.
 */
export class EngineUnusableError extends Error {
  readonly engineUnusable = true
}

export function isEngineUnusable(error: unknown): boolean {
  return error instanceof EngineUnusableError
}

/**
 * Names the clip that failed, without losing whether the engine can run at all.
 *
 * The naming used to be done with a plain `new Error`, which quietly downgraded
 * every spawn failure: `runPiper` reports EBADARCH and EACCES as unusable, the
 * rewrap made them ordinary, and `renderAll` then carried on to the next clip.
 * The mislabelled-arm64 case — the one with a whole paragraph of advice written
 * for it — printed that paragraph sixty-one times.
 */
export function renderFailure(item: { text: string; voice: string }, error: unknown): Error {
  const message = `rendering "${item.text}" (${item.voice}): ${messageOf(error)}`
  return isEngineUnusable(error) ? new EngineUnusableError(message) : new Error(message)
}

export interface RenderFailure {
  item: RenderPlanItem
  message: string
}

export interface RenderProgress {
  /** Items attempted so far, successes and failures alike. */
  completed: number
  total: number
  item: RenderPlanItem
  /**
   * The clip, once it is on disk. Reported per item rather than only in the
   * final result so the caller can persist each duration as it lands — a batch
   * of sixty clips takes minutes, and a render interrupted halfway must not
   * leave audio on disk that nothing knows the length of.
   */
  clip?: SynthesisedClip
  /** Present when this item failed. */
  error?: string
}

export interface RenderAllResult {
  rendered: SynthesisedClip[]
  failed: RenderFailure[]
  /** True when the caller cancelled before every item was attempted. */
  aborted: boolean
  /**
   * Set when the batch stopped because the engine itself cannot run, rather
   * than because individual clips failed. The remaining items were not tried.
   */
  engineFailure?: string
}

export interface RenderAllOptions {
  /** Stops the batch between items. The synthesiser cancels its own work. */
  signal?: AbortSignal
}

/**
 * Renders a list of clips one at a time.
 *
 * Sequential on purpose: this runs on the machine that is about to drive a
 * show, and a parallel render of sixty number clips would peg every core of the
 * operator's laptop minutes before doors.
 *
 * One bad item never takes the batch with it. The operator asked to render
 * everything missing; sixty-one clips and one clear failure is a far better
 * outcome than nothing and a stack trace.
 */
export async function renderAll(
  items: readonly RenderPlanItem[],
  synthesise: Synthesiser,
  onProgress?: (progress: RenderProgress) => void,
  opts: RenderAllOptions = {},
): Promise<RenderAllResult> {
  const rendered: SynthesisedClip[] = []
  const failed: RenderFailure[] = []
  let aborted = false
  let engineFailure: string | undefined

  const report = (progress: RenderProgress): void => {
    // A listener that throws is the caller's bug, not a reason to abandon the
    // clips still to render.
    try {
      onProgress?.(progress)
    } catch {
      /* ignored */
    }
  }

  for (const item of items) {
    if (opts.signal?.aborted) {
      aborted = true
      break
    }
    let error: string | undefined
    let fatal = false
    let clip: SynthesisedClip | undefined
    try {
      clip = await synthesise(item)
      rendered.push(clip)
    } catch (caught) {
      error = messageOf(caught)
      fatal = isEngineUnusable(caught)
      failed.push({ item, message: error })
    }
    report({ completed: rendered.length + failed.length, total: items.length, item, clip, error })

    // Nothing else in this batch can succeed, and repeating the same message
    // for every remaining clip hides it rather than emphasising it.
    if (fatal) {
      engineFailure = error
      break
    }
  }

  return { rendered, failed, aborted, engineFailure }
}
