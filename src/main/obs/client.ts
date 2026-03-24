import OBSWebSocketLib from 'obs-websocket-js'
// obs-websocket-js is ESM; when bundled as CJS by electron-vite the default
// export is wrapped, so the actual constructor may be on .default.
const OBSWebSocket = (OBSWebSocketLib as unknown as { default: typeof OBSWebSocketLib }).default ?? OBSWebSocketLib

export type OBSConnectionStatus = 'disconnected' | 'connecting' | 'connected'

export interface OBSClient {
  status: OBSConnectionStatus
  connect: (url: string, password?: string) => Promise<void>
  disconnect: () => void
  setCurrentProgramScene: (sceneName: string) => Promise<void>
  setCurrentPreviewScene: (sceneName: string) => Promise<void>
  getSceneList: () => Promise<string[]>
  getTransitionList: () => Promise<string[]>
  setCurrentSceneTransition: (name: string, durationMs: number) => Promise<void>
  onStatusChange: (cb: (status: OBSConnectionStatus) => void) => void
}

export function createOBSClient(): OBSClient {
  const obs = new OBSWebSocket()
  let status: OBSConnectionStatus = 'disconnected'
  const listeners: Array<(s: OBSConnectionStatus) => void> = []

  function setStatus(s: OBSConnectionStatus): void {
    status = s
    listeners.forEach((cb) => cb(s))
  }

  obs.on('ConnectionClosed', () => setStatus('disconnected'))

  return {
    get status(): OBSConnectionStatus { return status },
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
      obs.disconnect()
      // ConnectionClosed event will fire setStatus('disconnected')
    },
    async setCurrentProgramScene(sceneName: string): Promise<void> {
      await obs.call('SetCurrentProgramScene', { sceneName })
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
      await obs.call('SetCurrentSceneTransitionDuration', { transitionDuration: durationMs })
    },
    onStatusChange(cb: (status: OBSConnectionStatus) => void): void {
      listeners.push(cb)
    },
  }
}
