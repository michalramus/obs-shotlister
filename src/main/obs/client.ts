import OBSWebSocket from 'obs-websocket-js'

export type OBSConnectionStatus = 'disconnected' | 'connecting' | 'connected'

export interface OBSClient {
  status: OBSConnectionStatus
  connect: (url: string, password?: string) => Promise<void>
  disconnect: () => void
  setCurrentProgramScene: (sceneName: string) => Promise<void>
  setCurrentPreviewScene: (sceneName: string) => Promise<void>
  getSceneList: () => Promise<string[]>
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
        setStatus('disconnected')
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
    onStatusChange(cb: (status: OBSConnectionStatus) => void): void {
      listeners.push(cb)
    },
  }
}
