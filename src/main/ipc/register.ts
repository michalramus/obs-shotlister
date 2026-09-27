/**
 * Typed wrappers over Electron's IPC primitives.
 *
 * Every channel goes through here, so the channel name, its payload and its
 * result are all checked against {@link IpcContract}. Registering an unknown
 * channel, returning the wrong shape, or pushing a payload the renderer does not
 * expect are all compile errors rather than runtime surprises.
 */

import { ipcMain, BrowserWindow } from 'electron'
import type {
  IpcChannel,
  IpcPayload,
  IpcResult,
  IpcPushChannel,
  IpcPushPayload,
} from '../../shared/ipc-contract'

/** Registers the handler for one request channel. */
export function registerIpcHandler<C extends IpcChannel>(
  channel: C,
  handler: (payload: IpcPayload<C>) => IpcResult<C> | Promise<IpcResult<C>>,
): void {
  ipcMain.handle(channel, (_event, payload: IpcPayload<C>) => handler(payload))
}

/**
 * Whether a Live session is running. Set once, at startup.
 *
 * A module-level hook rather than a parameter because {@link refuseWhileLive}
 * wraps handlers registered across a dozen call sites, and threading the
 * session through every one of them is what made the guards easy to forget in
 * the first place.
 */
let isLive: () => boolean = () => false

export function setLiveGuard(predicate: () => boolean): void {
  isLive = predicate
}

/**
 * Refuses a handler while a Live session is running.
 *
 * Live mode is meant to change nothing durable — ADR 0001, and the project's
 * own rule that live mode must not touch the database. Every write path was
 * supposed to check, around forty did, and the handful that did not were
 * invisible until a show: deleting the running Rundown blanked every phone,
 * switching it mid-show pointed the phones at another Rundown's items while
 * OBS silently stopped switching, and renaming or converting it republished
 * the change to the band.
 *
 * The guard lives here, at the one chokepoint every surface goes through — the
 * operator window, the phone UI and the OSC pedal alike — so a new write path
 * has to opt out rather than remember to opt in.
 */
export function refuseWhileLive<P, R>(what: string, handler: (payload: P) => R): (payload: P) => R {
  return (payload: P) => {
    if (isLive()) {
      throw new Error(`Cannot ${what} while a Live session is running. Stop the show first.`)
    }
    return handler(payload)
  }
}

/**
 * Pushes to the operator window. There is only ever one, and a push before it
 * exists is a no-op rather than an error — nothing is listening yet.
 */
export function pushToWindow<C extends IpcPushChannel>(
  channel: C,
  payload: IpcPushPayload<C>,
): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload)
}
