// Makes `window.api` visible to the renderer. The surface itself is declared
// once in the IPC contract — nothing is restated here.

import type { ElectronApi } from '../shared/ipc-contract'

declare global {
  interface Window {
    api: ElectronApi
  }
}
