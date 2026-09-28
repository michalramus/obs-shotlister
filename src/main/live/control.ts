/**
 * What the operator's Live intents mean.
 *
 * Start, Stop, Next, Skip and Restart each carry rules that have nothing to do
 * with *where* the intent came from: whether a Next lands inside a Transition,
 * who has to be told afterwards, whether OBS cuts or comes up from preview.
 * Those rules used to be restated at every entry point — the space bar, the IPC
 * handlers and the OSC pedal — and the copies had drifted: the pedal ignored the
 * Transition guard on Skip, the IPC handlers ignored it entirely, and the space
 * bar brought a Live session up straight to program while the other two came up
 * from preview. Three answers to one question is three chances to be wrong on
 * show night.
 *
 * So this module owns the answers and the entry points own nothing but their
 * transport. `session`, `obs` and `publish` are passed in rather than reached
 * for, which is also what keeps this testable: nothing here imports Electron.
 */

import type { LiveState } from '../../shared/ipc-contract'
import type { LiveSession } from './session'
import type { OBSSwitcher } from '../obs/switcher'
import type { ChangePublisher } from '../publisher'

export interface LiveControl {
  /**
   * Opens a Rundown: makes it the active one and tells everyone, then — when
   * Preview-first is on — loads its first Shot's scene into OBS preview so the
   * operator can see what Start will bring up. With the setting off, opening a
   * Rundown does not touch OBS at all.
   *
   * This is the only thing Preview-first governs. A Voice-over Rundown never
   * reaches OBS, so `cueRundownStart` finds no scene and does nothing.
   */
  openRundown: (rundownId: string | null) => void
  /**
   * Puts the active Rundown on air, always coming up from preview.
   * `rundownId` defaults to the active one.
   *
   * Start does not consult the Preview-first setting: `startFromPreview` arms
   * preview itself when nothing armed it, so the transition is the same shape
   * whether or not the opening Shot was cued when the Rundown was opened. That
   * setting governs only what happens on opening a Rundown.
   */
  start: (opts?: { rundownId?: string }) => LiveState
  stop: () => LiveState
  /**
   * `startIfStopped` makes a Next with nothing running start the Rundown, which
   * is how the OSC pedal mirrors the space bar. Without it a Next while stopped
   * is an error, as the operator window expects.
   */
  next: (opts?: { startIfStopped?: boolean }) => LiveState
  skipNext: () => LiveState
  restart: () => LiveState
}

export interface LiveControlDeps {
  session: LiveSession
  obs: OBSSwitcher
  publish: ChangePublisher
  /**
   * Reads the stored Preview-first setting, which decides whether opening a
   * Rundown cues its first Shot into preview.
   */
  previewFirst: () => boolean
  /**
   * Stops a render batch already in flight. ADR 0005: nothing synthesises while
   * a show runs. The render service refuses to *start* during a session, but a
   * batch already running kept spawning Piper on the machine driving OBS.
   */
  abortRender?: () => void
}

export function createLiveControl(deps: LiveControlDeps): LiveControl {
  const { session, obs, publish, previewFirst, abortRender } = deps

  /**
   * An OBS that is unreachable, misconfigured or mid-restart must never take the
   * Live queue down with it: the operator can still run the show off the phones
   * and switch by hand. So every switcher call is fired and its failure logged.
   */
  function drive(work: Promise<void>): void {
    work.catch(console.error)
  }

  const control: LiveControl = {
    openRundown(rundownId) {
      session.setActiveRundown(rundownId)
      publish.rundownChanged()
      if (rundownId && previewFirst()) drive(obs.cueRundownStart(rundownId))
    },

    start(opts = {}) {
      abortRender?.()
      const rundownId = opts.rundownId ?? session.getState().rundownId
      if (!rundownId) throw new Error('Cannot start: no active rundown')

      const state = session.start(rundownId)
      publish.liveStateChanged(state)
      // The queue was just filled, so every Shot's Hidden flag changed — a
      // position alone does not tell phones that (ADR 0003).
      publish.rundownChanged()

      drive(obs.startFromPreview())
      return state
    },

    stop() {
      const state = session.stop()
      publish.liveStateChanged(state)
      publish.rundownChanged()
      return state
    },

    next(opts = {}) {
      const before = session.getState()

      if (!before.running && opts.startIfStopped) {
        // Nothing loaded is not a mistake worth reporting: a pedal press before
        // the operator has opened a Rundown should do nothing at all.
        if (!before.rundownId) return before
        return control.start()
      }

      // A Next inside the incoming Shot's Transition is dropped rather than
      // queued. Two Shots resolving within one Transition is a double-cut on
      // air, and a pedal that bounces or an operator leaning on the space bar
      // is exactly how that happens.
      if (session.isInTransition()) return before

      const { state, hiddenShotId } = session.next()
      publish.liveStateChanged(state)
      // Next past the last Shot ends the Live session and empties the Live
      // queue, so the Hidden flags phones are holding are no longer the ones the
      // queue has (ADR 0003). `liveStateChanged` carries only the position.
      if (!state.running) publish.rundownChanged()
      if (hiddenShotId) publish.shotHidden(hiddenShotId)
      drive(obs.takeLiveShot())
      return state
    },

    skipNext() {
      // Guarded like Next, and for the same reason: a Skip during a Transition
      // drops the Shot the operator is still watching come up, which reads as
      // the pedal having eaten two items.
      if (session.isInTransition()) return session.getState()

      const { state, hiddenShotId } = session.skipNext()
      publish.liveStateChanged(state)
      if (hiddenShotId) publish.shotHidden(hiddenShotId)
      drive(obs.cueNextShot())
      return state
    },

    restart() {
      const state = session.restart()
      publish.liveStateChanged(state)
      // Restart refills the queue with every Shot visible again — the same
      // reason Start publishes it.
      publish.rundownChanged()
      drive(obs.takeLiveShot())
      return state
    },
  }

  return control
}
