// Preload script — runs in the renderer before page content loads.
// Exposes a typed API surface to the renderer via contextBridge.
// Kept empty until IPC channels are defined.

import { contextBridge } from 'electron'

// Placeholder — expand when IPC channels are defined
contextBridge.exposeInMainWorld('api', {})
