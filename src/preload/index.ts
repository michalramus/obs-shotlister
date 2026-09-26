// Preload script — runs in the renderer before page content loads.
// Exposes the typed API surface to the renderer via contextBridge.
//
// No channel is named here at all: `buildApi` walks the contract's surface, and
// `request` and `subscribe` take each channel's payload and result from the
// contract. A channel added to the contract appears here without an edit.

import { contextBridge, ipcRenderer } from 'electron'
import { buildApi } from './build-api'
import type {
  IpcChannel,
  IpcPayload,
  IpcPushChannel,
  IpcPushPayload,
  Request,
  Subscribe,
} from '../shared/ipc-contract'

function request<C extends IpcChannel>(channel: C): Request<C> {
  return ((payload?: IpcPayload<C>) => ipcRenderer.invoke(channel, payload)) as Request<C>
}

function subscribe<C extends IpcPushChannel>(channel: C): Subscribe<C> {
  return (cb: (payload: IpcPushPayload<C>) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: IpcPushPayload<C>): void =>
      cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  }
}

contextBridge.exposeInMainWorld('api', buildApi({ request, subscribe }))
