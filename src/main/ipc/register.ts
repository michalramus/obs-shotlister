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
 * Pushes to the operator window. There is only ever one, and a push before it
 * exists is a no-op rather than an error — nothing is listening yet.
 */
export function pushToWindow<C extends IpcPushChannel>(
  channel: C,
  payload: IpcPushPayload<C>,
): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload)
}
