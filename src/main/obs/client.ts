import OBSWebSocketLib from 'obs-websocket-js'
import type { OBSConnectionStatus } from '../../shared/ipc-contract'
// obs-websocket-js is ESM; when bundled as CJS by electron-vite the default
// export is wrapped, so the actual constructor may be on .default.
const OBSWebSocket =
  (OBSWebSocketLib as unknown as { default: typeof OBSWebSocketLib }).default ?? OBSWebSocketLib

export interface OBSClient {
  status: OBSConnectionStatus
  connect: (url: string, password?: string) => Promise<void>
  disconnect: () => void
  setCurrentPreviewScene: (sceneName: string) => Promise<void>
  getSceneList: () => Promise<string[]>
  getTransitionList: () => Promise<string[]>
  setCurrentSceneTransition: (name: string, durationMs: number) => Promise<void>
  triggerStudioModeTransition: () => Promise<void>
  getStudioModeEnabled: () => Promise<boolean>
  onStatusChange: (cb: (status: OBSConnectionStatus) => void) => void
  onOBSEvent: (event: string, cb: (...args: unknown[]) => void) => void
}

export function createOBSClient(): OBSClient {
  const obs = new OBSWebSocket()
  let status: OBSConnectionStatus = 'disconnected'
  const listeners: Array<(s: OBSConnectionStatus) => void> = []

  function setStatus(s: OBSConnectionStatus): void {
    status = s
    // Isolated: this runs inside obs-websocket-js's own emitter, so a listener
    // that throws would abort the rest of the fan-out — including the
    // reconnect scheduling — and surface as an uncaughtException from inside
    // the library.
    listeners.forEach((cb) => {
      try {
        cb(s)
      } catch (err) {
        console.error('[obs] status listener threw:', err)
      }
    })
  }

  obs.on('ConnectionClosed', () => setStatus('disconnected'))

  return {
    get status(): OBSConnectionStatus {
      return status
    },
    async connect(url: string, password?: string): Promise<void> {
      setStatus('connecting')
      try {
        await obs.connect(url, password)
        setStatus('connected')
      } catch (err) {
        // ConnectionClosed event will also fire — only set status if not already disconnected
        if (status !== 'disconnected') setStatus('disconnected')
        throw err
      }
    },
    disconnect(): void {
      // Fire-and-forget by design: ConnectionClosed drives setStatus, and
      // callers do not wait for the socket to finish closing.
      obs.disconnect().catch((err: unknown) => console.error('[obs] disconnect error:', err))
    },
    async setCurrentPreviewScene(sceneName: string): Promise<void> {
      await obs.call('SetCurrentPreviewScene', { sceneName })
    },
    async getSceneList(): Promise<string[]> {
      const res = await obs.call('GetSceneList')
      return (res.scenes as Array<{ sceneName: string }>).map((s) => s.sceneName)
    },
    async getTransitionList(): Promise<string[]> {
      const res = await obs.call('GetSceneTransitionList')
      return (res.transitions as Array<{ transitionName: string }>).map((t) => t.transitionName)
    },
    async setCurrentSceneTransition(name: string, durationMs: number): Promise<void> {
      await obs.call('SetCurrentSceneTransition', { transitionName: name })
      if (durationMs > 0) {
        await obs.call('SetCurrentSceneTransitionDuration', { transitionDuration: durationMs })
      }
    },
    async triggerStudioModeTransition(): Promise<void> {
      await obs.call('TriggerStudioModeTransition')
    },
    async getStudioModeEnabled(): Promise<boolean> {
      const r = await obs.call('GetStudioModeEnabled')
      return r.studioModeEnabled
    },
    onStatusChange(cb: (status: OBSConnectionStatus) => void): void {
      listeners.push(cb)
    },
    onOBSEvent(event: string, cb: (...args: unknown[]) => void): void {
      obs.on(event as Parameters<typeof obs.on>[0], cb as never)
    },
  }
}
