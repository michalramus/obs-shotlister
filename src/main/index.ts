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
import { getLiveState, startLive, stopLive, nextShot, skipNext, restartLive, setActiveRundown, setActiveProject } from './ipc/live'
import { getCameraById } from './ipc/projects'
import { parseResolveCSV, confirmResolveImport } from './ipc/resolve-import'
import type { ConfirmImportInput } from './ipc/resolve-import'

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
  ipcMain.handle('shots:list', (_event, payload: { rundownId: string }) =>
    listShots(db, payload.rundownId),
  )

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
    return state
  })

  ipcMain.handle('live:stop', () => {
    const state = stopLive(db)
    broadcastLiveState(state)
    return state
  })

  ipcMain.handle('live:next', () => {
    const state = nextShot(db)
    broadcastLiveState(state)
    return state
  })

  ipcMain.handle('live:skip-next', () => {
    const state = skipNext(db)
    broadcastLiveState(state)
    return state
  })

  ipcMain.handle('live:restart', () => {
    const state = restartLive(db)
    broadcastLiveState(state)
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
}

// ---------------------------------------------------------------------------
// Socket.io broadcast helpers
// ---------------------------------------------------------------------------

import type { LiveState } from './ipc/live'
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
    skippedIds: state.skippedIds,
  })
  _io.emit('state:playback', { running: state.running })
}

function broadcastRundown(): void {
  if (_io && _db) broadcastRundownState(_io, _db)
}

app.whenReady().then(() => {
  _db = getDatabase()
  registerIpcHandlers()
  const io = startServer(_db)
  if (io) setSocketServer(io)
  createWindow()

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
