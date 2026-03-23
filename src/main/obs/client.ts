// Stub for the obs-websocket client.
// This will be expanded when OBS integration is implemented.

export type OBSConnectionStatus = 'disconnected' | 'connecting' | 'connected'

export interface OBSClient {
  status: OBSConnectionStatus
  connect: (url: string, password?: string) => Promise<void>
  disconnect: () => void
}

export function createOBSClient(): OBSClient {
  let status: OBSConnectionStatus = 'disconnected'

  return {
    get status(): OBSConnectionStatus {
      return status
    },
    async connect(_url: string, _password?: string): Promise<void> {
      status = 'connecting'
      // TODO: implement obs-websocket-js connection
    },
    disconnect(): void {
      status = 'disconnected'
    },
  }
}
