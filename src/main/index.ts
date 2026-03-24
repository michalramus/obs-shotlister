import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import { startServer } from './server'
import { getDatabase } from './db/index'
import {
  listProjects,
  createProject,
  renameProject,
  deleteProject,
  listCameras,
  upsertCamera,
  deleteCamera,
} from './ipc/projects'
import type { CameraUpsertInput } from './ipc/projects'
import { listRundowns, createRundown, renameRundown, deleteRundown } from './ipc/rundowns'
import { listShots, createShot, updateShot, deleteShot, reorderShots } from './ipc/shots'
import type { CreateShotInput, UpdateShotInput } from './ipc/shots'
import { getLiveState, getLiveQueue, startLive, stopLive, nextShot, skipNext, restartLive, setActiveRundown, setActiveProject, clearLiveState } from './ipc/live'
import { getCameraById } from './ipc/projects'
import { parseResolveCSV, confirmResolveImport } from './ipc/resolve-import'
import type { ConfirmImportInput } from './ipc/resolve-import'
import { createOBSClient } from './obs/client'
import type { OBSConnectionStatus } from './obs/client'
import { getObsSettings, saveObsSettings, getObsEnabled, setObsEnabled } from './ipc/settings'

const obsClient = createOBSClient()
let obsAutoReconnect = false
let obsReconnectTimer: ReturnType<typeof setTimeout> | null = null

// --- Global error handlers ---------------------------------------------------
// These must never crash the process — log and continue.

process.on('uncaughtException', (err: Error) => {
  // TODO: replace with structured logger when logger utility is added
  // eslint-disable-next-line no-console
  console.error('[uncaughtException]', err)
})

process.on('unhandledRejection', (reason: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason)
})

// --- App lifecycle -----------------------------------------------------------

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
    },
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// --- IPC handlers ------------------------------------------------------------

function registerIpcHandlers(): void {
  const db = getDatabase()

  // Projects
  ipcMain.handle('projects:list', () => listProjects(db))

  ipcMain.handle('projects:create', (_event, payload: { name: string }) =>
    createProject(db, payload.name),
  )

  ipcMain.handle('projects:rename', (_event, payload: { id: string; name: string }) =>
    renameProject(db, payload.id, payload.name),
  )

  ipcMain.handle('projects:delete', (_event, payload: { id: string }) =>
    deleteProject(db, payload.id),
  )

  ipcMain.handle('cameras:list', (_event, payload: { projectId: string }) =>
    listCameras(db, payload.projectId),
  )

  ipcMain.handle('cameras:upsert', (_event, payload: CameraUpsertInput) =>
    upsertCamera(db, payload),
  )

  ipcMain.handle('cameras:delete', (_event, payload: { id: string }) =>
    deleteCamera(db, payload.id),
  )

  // Rundowns
  ipcMain.handle('rundowns:list', (_event, payload: { projectId: string }) =>
    listRundowns(db, payload.projectId),
  )

  ipcMain.handle('rundowns:create', (_event, payload: { projectId: string; name: string }) => {
    const rundown = createRundown(db, payload.projectId, payload.name)
    broadcastRundown()
    return rundown
  })

  ipcMain.handle('rundowns:rename', (_event, payload: { id: string; name: string }) => {
    const rundown = renameRundown(db, payload.id, payload.name)
    broadcastRundown()
    return rundown
  })

  ipcMain.handle('rundowns:delete', (_event, payload: { id: string }) => {
    deleteRundown(db, payload.id)
    broadcastRundown()
  })

  ipcMain.handle('rundowns:setActive', (_event, payload: { rundownId: string | null }) => {
    setActiveRundown(db, payload.rundownId)
    broadcastRundown()
  })

  ipcMain.handle('project:setActive', (_event, payload: { projectId: string | null }) => {
    setActiveProject(db, payload.projectId)
    broadcastRundown()
  })

  // Shots
  ipcMain.handle('shots:list', (_event, payload: { rundownId: string }) => {
    const queue = getLiveQueue()
    if (queue.length > 0) {
      const hiddenIds = new Set(queue.filter((s) => s.hidden).map((s) => s.id))
      return listShots(db, payload.rundownId).map((s) => ({ ...s, hidden: hiddenIds.has(s.id) }))
    }
    return listShots(db, payload.rundownId)
  })

  ipcMain.handle('shots:create', (_event, payload: CreateShotInput) => {
    const shot = createShot(db, payload)
    broadcastRundown()
    return shot
  })

  ipcMain.handle('shots:update', (_event, payload: UpdateShotInput) => {
    const shot = updateShot(db, payload)
    broadcastRundown()
    return shot
  })

  ipcMain.handle('shots:delete', (_event, payload: { id: string }) => {
    deleteShot(db, payload.id)
    broadcastRundown()
  })

  ipcMain.handle('shots:reorder', (_event, payload: { ids: string[] }) => {
    reorderShots(db, payload.ids)
    broadcastRundown()
  })

  // Live controls
  ipcMain.handle('live:get', () => getLiveState(db))

  ipcMain.handle('live:start', (_event, payload: { rundownId: string }) => {
    const state = startLive(db, payload.rundownId)
    broadcastLiveState(state)
    broadcastRundown()
    switchOBSScenes(state, db).catch(console.error)
    return state
  })

  ipcMain.handle('live:stop', () => {
    const state = stopLive(db)
    broadcastLiveState(state)
    broadcastRundown()
    return state
  })

  ipcMain.handle('live:next', () => {
    const state = nextShot(db)
    broadcastLiveState(state)
    broadcastRundown()
    switchOBSScenes(state, db).catch(console.error)
    return state
  })

  ipcMain.handle('live:skip-next', () => {
    const state = skipNext(db)
    broadcastLiveState(state)
    broadcastRundown()
    switchOBSPreview(state, db).catch(console.error)
    return state
  })

  ipcMain.handle('live:restart', () => {
    const state = restartLive(db)
    broadcastLiveState(state)
    switchOBSScenes(state, db).catch(console.error)
    return state
  })

  // DaVinci Resolve CSV import
  ipcMain.handle('shots:import-csv:parse', async (_event, payload: { filePath: string }) => {
    const content = readFileSync(payload.filePath, 'utf-8')
    return parseResolveCSV(content)
  })

  ipcMain.handle(
    'shots:import-csv:open-dialog',
    async (_event) => {
      const result = await dialog.showOpenDialog({
        filters: [{ name: 'CSV', extensions: ['csv'] }],
        properties: ['openFile'],
      })
      return result
    },
  )

  ipcMain.handle('shots:import-csv:confirm', (_event, payload: ConfirmImportInput) =>
    confirmResolveImport(db, payload),
  )

  // OBS
  ipcMain.handle('obs:settings:get', () => getObsSettings(db))

  ipcMain.handle('obs:settings:save', (_event, payload: { url: string; password: string }) => {
    saveObsSettings(db, payload.url, payload.password)
  })

  ipcMain.handle('obs:connect', async () => {
    const settings = getObsSettings(db)
    try {
      await obsClient.connect(settings.url, settings.password)
      obsAutoReconnect = true
    } catch (err) {
      throw new Error(err instanceof Error ? (err.message || 'Connection failed') : String(err))
    }
  })

  ipcMain.handle('obs:disconnect', () => {
    obsAutoReconnect = false
    if (obsReconnectTimer) { clearTimeout(obsReconnectTimer); obsReconnectTimer = null }
    obsClient.disconnect()
  })

  ipcMain.handle('obs:status', () => ({ status: obsClient.status }))

  ipcMain.handle('obs:getEnabled', () => getObsEnabled(db))

  ipcMain.handle('obs:setEnabled', (_e, enabled: boolean) => {
    setObsEnabled(db, enabled)
    if (enabled) {
      obsAutoReconnect = true
      const { url, password } = getObsSettings(db)
      obsClient.connect(url, password || undefined).catch(() => {})
    } else {
      obsAutoReconnect = false
      if (obsReconnectTimer) { clearTimeout(obsReconnectTimer); obsReconnectTimer = null }
      obsClient.disconnect()
    }
  })

  ipcMain.handle('obs:getTransitions', async () => {
    try { return await obsClient.getTransitionList() } catch { return [] }
  })

  ipcMain.handle('obs:getScenes', async () => {
    try { return await obsClient.getSceneList() } catch { return [] }
  })

  ipcMain.handle('obs:checkScenes', async () => {
    const liveState = getLiveState(db)
    if (!liveState.projectId) return { allMapped: false, missing: [] }
    const cameras = listCameras(db, liveState.projectId)
    const camerasWithScene = cameras.filter((c) => c.obsScene)
    if (obsClient.status !== 'connected') {
      return { allMapped: camerasWithScene.length === cameras.length, missing: [] }
    }
    const scenes = await obsClient.getSceneList()
    const missing = camerasWithScene
      .filter((c) => !scenes.includes(c.obsScene!))
      .map((c) => c.obsScene!)
    return {
      allMapped: camerasWithScene.length === cameras.length && missing.length === 0,
      missing,
    }
  })
}

// ---------------------------------------------------------------------------
// OBS scene switching helpers
// ---------------------------------------------------------------------------

import type { LiveState } from './ipc/live'

async function switchOBSScenes(state: LiveState, database: ReturnType<typeof getDatabase>): Promise<void> {
  if (obsClient.status !== 'connected' || !state.running || state.liveIndex === null || !state.rundownId) return

  // Resolve live shot by ID (safe against index/order_index misalignment)
  const queue = getLiveQueue()
  const liveShotId = queue[state.liveIndex]?.id
  if (!liveShotId) return

  const allShots = listShots(database, state.rundownId)
  const liveShotIdx = allShots.findIndex((s) => s.id === liveShotId)
  if (liveShotIdx === -1) return

  const liveShot = allShots[liveShotIdx]
  const liveCamera = getCameraById(database, liveShot.cameraId)

  const transitionName = liveShot.transitionName ?? 'Cut'
  const transitionMs = liveShot.transitionMs ?? 0

  // 1+2. Configure transition, then set live camera to program
  if (liveCamera?.obsScene) {
    try {
      await obsClient.setCurrentSceneTransition(transitionName, transitionMs)
    } catch (e: unknown) { console.error('[OBS] setTransition:', e) }
    try {
      await obsClient.setCurrentProgramScene(liveCamera.obsScene)
    } catch (e: unknown) { console.error('[OBS] program:', e) }
  }

  // 3. Wait for transition to finish
  if (transitionMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, transitionMs))
  }

  // 4. Set next camera to preview
  const hiddenIds = new Set(queue.filter((s) => s.hidden).map((s) => s.id))
  const nextVisibleShot = allShots.slice(liveShotIdx + 1).find((s) => !hiddenIds.has(s.id))
  if (nextVisibleShot) {
    const nextCamera = getCameraById(database, nextVisibleShot.cameraId)
    if (nextCamera?.obsScene) {
      obsClient.setCurrentPreviewScene(nextCamera.obsScene).catch((e: unknown) => console.error('[OBS] preview:', e))
    }
  }
}

async function switchOBSPreview(state: LiveState, database: ReturnType<typeof getDatabase>): Promise<void> {
  if (obsClient.status !== 'connected' || !state.running || state.liveIndex === null || !state.rundownId) return

  // Resolve live shot by ID (safe against index/order_index misalignment)
  const queue = getLiveQueue()
  const liveShotId = queue[state.liveIndex]?.id
  if (!liveShotId) return

  const allShots = listShots(database, state.rundownId)
  const liveShotIdx = allShots.findIndex((s) => s.id === liveShotId)
  if (liveShotIdx === -1) return

  const hiddenIds = new Set(queue.filter((s) => s.hidden).map((s) => s.id))
  const nextVisibleShot = allShots.slice(liveShotIdx + 1).find((s) => !hiddenIds.has(s.id))
  if (nextVisibleShot) {
    const nextCamera = getCameraById(database, nextVisibleShot.cameraId)
    if (nextCamera?.obsScene) {
      obsClient.setCurrentPreviewScene(nextCamera.obsScene).catch((e: unknown) => console.error('[OBS] preview:', e))
    }
  }
}

// ---------------------------------------------------------------------------
// Socket.io broadcast helpers
// ---------------------------------------------------------------------------

import type { Server as SocketServer } from 'socket.io'
import { broadcastRundownState } from './server/socket'

let _io: SocketServer | null = null
let _db: ReturnType<typeof getDatabase> | null = null

export function setSocketServer(io: SocketServer): void {
  _io = io
}

function broadcastLiveState(state: LiveState): void {
  if (!_io) return
  _io.emit('state:live', {
    liveIndex: state.liveIndex,
    startedAt: state.startedAt,
  })
  _io.emit('state:playback', { running: state.running })
}

function broadcastRundown(): void {
  if (!_io || !_db) return
  const queue = getLiveQueue()
  if (queue.length > 0) {
    const state = getLiveState(_db)
    if (state.rundownId) {
      const hiddenIds = new Set(queue.filter((s) => s.hidden).map((s) => s.id))
      const shotsWithHidden = listShots(_db, state.rundownId).map((s) => ({ ...s, hidden: hiddenIds.has(s.id) }))
      broadcastRundownState(_io, _db, shotsWithHidden)
      return
    }
  }
  broadcastRundownState(_io, _db)
}

app.whenReady().then(() => {
  _db = getDatabase()
  clearLiveState(_db)
  registerIpcHandlers()
  const io = startServer(_db)
  if (io) setSocketServer(io)
  createWindow()

  if (getObsEnabled(_db)) {
    obsAutoReconnect = true
    const { url, password } = getObsSettings(_db)
    obsClient.connect(url, password || undefined).catch(() => {})
  }

  obsClient.onStatusChange((status: OBSConnectionStatus) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('obs:status', { status })
    if (status === 'disconnected' && obsAutoReconnect) {
      obsReconnectTimer = setTimeout(async () => {
        if (!obsAutoReconnect || obsClient.status !== 'disconnected') return
        const { url, password } = getObsSettings(_db!)
        try {
          await obsClient.connect(url, password || undefined)
        } catch {
          // ConnectionClosed will fire again → schedules next retry
        }
      }, 5000)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
