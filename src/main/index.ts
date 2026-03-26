import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { join } from 'path'
import { readFileSync, createReadStream, promises as fsPromises } from 'fs'
import { extname } from 'path'
import { Readable } from 'stream'
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
import { listRundowns, createRundown, renameRundown, deleteRundown, reorderRundowns, setRundownFolder } from './ipc/rundowns'
import { listShots, createShot, updateShot, deleteShot, reorderShots, splitShot } from './ipc/shots'
import type { CreateShotInput, UpdateShotInput, SplitShotInput } from './ipc/shots'
import { getLiveState, getLiveQueue, startLive, stopLive, nextShot, skipNext, restartLive, setActiveRundown, setActiveProject, clearLiveState } from './ipc/live'
import { getCameraById } from './ipc/projects'
import { parseResolveCSV, confirmResolveImport } from './ipc/resolve-import'
import type { ConfirmImportInput } from './ipc/resolve-import'
import { createOBSClient } from './obs/client'
import type { OBSConnectionStatus } from './obs/client'
import { getObsSettings, saveObsSettings, getObsEnabled, setObsEnabled, getOscSettings, saveOscSettings } from './ipc/settings'
import { startOscServer, stopOscServer } from './osc/server'
import {
  listTransitionMappings,
  upsertTransitionMapping,
  deleteTransitionMapping,
  resolveTransition,
} from './ipc/transitions'
import type { TransitionMapping } from './ipc/transitions'
import { listMarkers, upsertMarker, deleteMarker } from './ipc/markers'
import type { UpsertMarkerInput } from './ipc/markers'
import {
  exportProject as exportProjectData,
  exportRundown as exportRundownData,
  exportDatabase as exportDatabaseData,
  importProject as importProjectData,
  importRundown as importRundownData,
  importDatabase as importDatabaseData,
} from './ipc/exportimport'

// Must be called before app is ready — allows media:// URLs in the renderer
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true } },
])

const obsClient = createOBSClient()
let obsAutoReconnect = false
let obsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let currentUiMode: 'edit' | 'live' = 'edit'

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

// --- OBS validation ----------------------------------------------------------

export interface OBSValidateResult {
  studioModeEnabled: boolean
  missingScenes: string[]
  missingTransitions: string[]
}

async function runOBSValidation(database: ReturnType<typeof getDatabase>): Promise<OBSValidateResult | null> {
  if (obsClient.status !== 'connected') return null
  const liveState = getLiveState(database)
  const [studioModeEnabled, scenes, transitions] = await Promise.all([
    obsClient.getStudioModeEnabled(),
    obsClient.getSceneList(),
    obsClient.getTransitionList(),
  ])

  // Check camera scene mappings for active project
  const missingScenes: string[] = []
  if (liveState.projectId) {
    const cameras = listCameras(database, liveState.projectId)
    for (const cam of cameras) {
      if (cam.obsScene && !scenes.includes(cam.obsScene)) {
        missingScenes.push(cam.obsScene)
      }
    }
  }

  // Check transition names used in active rundown shots
  const missingTransitions: string[] = []
  if (liveState.rundownId) {
    const shots = listShots(database, liveState.rundownId)
    const uniqueTransitions = new Set(
      shots
        .filter((s) => s.transitionName != null)
        .map((s) => resolveTransition(database, s.transitionName!)),
    )
    for (const t of uniqueTransitions) {
      if (!transitions.includes(t)) {
        missingTransitions.push(t)
      }
    }
  }

  return { studioModeEnabled, missingScenes, missingTransitions }
}

function sendValidationResult(result: OBSValidateResult | null): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('obs:validationResult', result)
}

function runValidation(database: ReturnType<typeof getDatabase>): void {
  runOBSValidation(database).then(sendValidationResult).catch((err: unknown) => {
    console.error('[OBS] validation error:', err)
  })
}

// --- OSC helpers -------------------------------------------------------------

interface LiveStateRow {
  live_shot_id: string | null
  started_at: number | null
  running: number
}

interface ShotTransitionRow {
  transition_ms: number
}

function isOscInTransition(db: ReturnType<typeof getDatabase>): boolean {
  try {
    const row = db.prepare('SELECT live_shot_id, started_at, running FROM live_state WHERE id = 1').get() as LiveStateRow | undefined
    if (!row || !row.running || !row.live_shot_id || row.started_at === null) return false
    const shot = db.prepare('SELECT transition_ms FROM shots WHERE id = ?').get(row.live_shot_id) as ShotTransitionRow | undefined
    if (!shot || shot.transition_ms <= 0) return false
    return (Date.now() - row.started_at) < shot.transition_ms
  } catch (err) {
    console.error('[osc] isOscInTransition error:', err)
    return false
  }
}

function handleOscNext(): void {
  if (currentUiMode !== 'live') return
  try {
    const db = getDatabase()
    if (isOscInTransition(db)) return
    const { state, hiddenShotId } = nextShot(db)
    broadcastLiveState(state)
    if (hiddenShotId && _io) broadcastShotHidden(_io, hiddenShotId)
    switchOBSScenes(state, db).catch(console.error)
  } catch (err) {
    console.error('[osc] next error:', err)
  }
}

function handleOscSkip(): void {
  if (currentUiMode !== 'live') return
  try {
    const db = getDatabase()
    if (isOscInTransition(db)) return
    const { state, hiddenShotId } = skipNext(db)
    broadcastLiveState(state)
    if (hiddenShotId && _io) broadcastShotHidden(_io, hiddenShotId)
    switchOBSPreview(state, db).catch(console.error)
  } catch (err) {
    console.error('[osc] skip error:', err)
  }
}

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

  ipcMain.handle('rundowns:reorder', (_e, { ids }: { ids: string[] }) => {
    reorderRundowns(db, ids)
  })

  ipcMain.handle('rundowns:setFolder', (_e, { id, folder }: { id: string; folder: string | null }) => {
    return setRundownFolder(db, id, folder)
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

  ipcMain.handle('shots:split', (_e, payload: SplitShotInput) => {
    const result = splitShot(db, payload)
    broadcastRundown()
    return result
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
    const { state, hiddenShotId } = nextShot(db)
    broadcastLiveState(state)
    if (hiddenShotId && _io) broadcastShotHidden(_io, hiddenShotId)
    switchOBSScenes(state, db).catch(console.error)
    return state
  })

  ipcMain.handle('live:skip-next', () => {
    const { state, hiddenShotId } = skipNext(db)
    broadcastLiveState(state)
    if (hiddenShotId && _io) broadcastShotHidden(_io, hiddenShotId)
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
    try { return await obsClient.getTransitionList() } catch (err) { console.error('[OBS] getTransitionList:', err); return [] }
  })

  ipcMain.handle('obs:getScenes', async () => {
    try { return await obsClient.getSceneList() } catch (err) { console.error('[OBS] getSceneList:', err); return [] }
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

  ipcMain.handle('obs:validate', async () => {
    try {
      return await runOBSValidation(db)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })

  ipcMain.handle('obs:transitions:list', (): TransitionMapping[] => {
    try {
      return listTransitionMappings(db)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })

  ipcMain.handle(
    'obs:transitions:upsert',
    (_event, payload: { logicalName: string; obsTransitionName: string }) => {
      try {
        upsertTransitionMapping(db, payload.logicalName, payload.obsTransitionName)
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err))
      }
    },
  )

  ipcMain.handle('obs:transitions:delete', (_event, payload: { logicalName: string }) => {
    try {
      deleteTransitionMapping(db, payload.logicalName)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })

  // Markers
  ipcMain.handle('markers:list', (_e, payload: { rundownId: string }) => listMarkers(db, payload.rundownId))
  ipcMain.handle('markers:upsert', (_e, payload: UpsertMarkerInput) => upsertMarker(db, payload))
  ipcMain.handle('markers:delete', (_e, payload: { id: string }) => deleteMarker(db, payload.id))

  // Rundown media
  ipcMain.handle('rundown:media:get', (_e, payload: { rundownId: string }) => {
    const filePath = (db.prepare("SELECT value FROM settings WHERE key = ?").get(`rundown_media_path_${payload.rundownId}`) as { value: string } | undefined)?.value ?? null
    const offsetStr = (db.prepare("SELECT value FROM settings WHERE key = ?").get(`rundown_media_offset_${payload.rundownId}`) as { value: string } | undefined)?.value ?? '0'
    return { filePath, offsetMs: parseInt(offsetStr, 10) }
  })

  ipcMain.handle('rundown:media:save', (_e, payload: { rundownId: string; filePath: string; offsetMs: number }) => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`rundown_media_path_${payload.rundownId}`, payload.filePath)
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`rundown_media_offset_${payload.rundownId}`, String(payload.offsetMs))
  })

  ipcMain.handle('rundown:media:clear', (_e, payload: { rundownId: string }) => {
    db.prepare("DELETE FROM settings WHERE key = ?").run(`rundown_media_path_${payload.rundownId}`)
    db.prepare("DELETE FROM settings WHERE key = ?").run(`rundown_media_offset_${payload.rundownId}`)
  })

  ipcMain.handle('media:read-file', (_e, filePath: string) => {
    return readFileSync(filePath)
  })

  ipcMain.handle('rundown:media:open-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Audio/Video', extensions: ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'mp4', 'mov', 'webm', 'avi', 'mkv'] },
      ],
    })
    return result
  })

  // OSC
  ipcMain.handle('osc:settings:get', () => getOscSettings(db))
  ipcMain.handle('osc:settings:save', (_e: Electron.IpcMainInvokeEvent, payload: { enabled: boolean; port: number }) => {
    saveOscSettings(db, payload.enabled, payload.port)
    if (payload.enabled) {
      startOscServer(payload.port, { next: handleOscNext, skip: handleOscSkip })
    } else {
      stopOscServer()
    }
  })

  // UI mode
  ipcMain.handle('ui:setMode', (_e: Electron.IpcMainInvokeEvent, mode: 'edit' | 'live') => {
    currentUiMode = mode
  })

  // Assets
  ipcMain.handle('assets:audioDir', () => {
    return join(app.getAppPath(), 'resources', 'audio')
  })

  // Export / Import
  ipcMain.handle('export:project', async (_e, { projectId }: { projectId: string }) => {
    const data = exportProjectData(getDatabase(), projectId)
    const result = await dialog.showSaveDialog({
      defaultPath: 'project.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return
    await fsPromises.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf-8')
  })

  ipcMain.handle('export:rundown', async (_e, { rundownId }: { rundownId: string }) => {
    const data = exportRundownData(getDatabase(), rundownId)
    const result = await dialog.showSaveDialog({
      defaultPath: 'rundown.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return
    await fsPromises.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf-8')
  })

  ipcMain.handle('export:database', async () => {
    const data = exportDatabaseData(getDatabase())
    const result = await dialog.showSaveDialog({
      defaultPath: 'obs-queuer-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return
    await fsPromises.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf-8')
  })

  ipcMain.handle('import:project', async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const raw = await fsPromises.readFile(result.filePaths[0], 'utf-8')
    const data = JSON.parse(raw)
    const newProjectId = importProjectData(getDatabase(), data)
    broadcastRundownState(getDatabase(), _io)
    return newProjectId
  })

  ipcMain.handle('import:rundown', async (_e, { projectId }: { projectId: string }) => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const raw = await fsPromises.readFile(result.filePaths[0], 'utf-8')
    const data = JSON.parse(raw)
    const newRundownId = importRundownData(getDatabase(), projectId, data)
    broadcastRundownState(getDatabase(), _io)
    return newRundownId
  })

  ipcMain.handle('import:database', async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return false
    const raw = await fsPromises.readFile(result.filePaths[0], 'utf-8')
    const data = JSON.parse(raw)
    importDatabaseData(getDatabase(), data)
    broadcastRundownState(getDatabase(), _io)
    return true
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

  const resolvedName = resolveTransition(database, liveShot.transitionName ?? 'cut')
  const transitionMs = liveShot.transitionMs ?? 0

  // 1+2. Configure transition, then trigger studio mode transition (preview→program)
  if (liveCamera?.obsScene) {
    try {
      await obsClient.setCurrentSceneTransition(resolvedName, transitionMs)
    } catch (e: unknown) { console.error('[OBS] setTransition:', e) }
    try {
      await obsClient.triggerStudioModeTransition()
    } catch (e: unknown) { console.error('[OBS] program:', e) }
  }

  // 3. Wait for transition to finish + 50ms buffer before touching preview
  await new Promise<void>((resolve) => setTimeout(resolve, transitionMs + 50))

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
import { broadcastRundownState, broadcastShotHidden } from './server/socket'

let _io: SocketServer | null = null
let _db: ReturnType<typeof getDatabase> | null = null

export function setSocketServer(io: SocketServer): void {
  _io = io
}

function broadcastLiveState(state: LiveState): void {
  if (!_io) return
  _io.emit('state:live', {
    liveIndex: state.liveIndex,
    elapsedMs: state.startedAt !== null ? Date.now() - state.startedAt : null,
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
  // Serve local media files via media:// protocol (avoids cross-origin issues in dev mode)
  protocol.handle('media', async (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname)
    let stat: Awaited<ReturnType<typeof fsPromises.stat>>
    try {
      stat = await fsPromises.stat(filePath)
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const fileSize = stat.size
    const ext = extname(filePath).toLowerCase().slice(1)
    const mimeTypes: Record<string, string> = {
      mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
      mkv: 'video/x-matroska', avi: 'video/x-msvideo',
      mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
      ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
    }
    const contentType = mimeTypes[ext] ?? 'application/octet-stream'
    const rangeHeader = request.headers.get('range')

    if (!rangeHeader) {
      return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, {
        headers: {
          'Content-Length': fileSize.toString(),
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
        },
      })
    }

    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
    if (!match) return new Response('Bad Range', { status: 400 })

    const start = parseInt(match[1], 10)
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
    const chunkSize = end - start + 1

    return new Response(Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize.toString(),
        'Content-Type': contentType,
      },
    })
  })

  _db = getDatabase()
  clearLiveState(_db)
  registerIpcHandlers()
  const audioDir = join(app.getAppPath(), 'resources', 'audio')
  const io = startServer(_db, audioDir)
  if (io) setSocketServer(io)
  createWindow()

  if (getObsEnabled(_db)) {
    obsAutoReconnect = true
    const { url, password } = getObsSettings(_db)
    obsClient.connect(url, password || undefined).catch(() => {})
  }

  const oscSettings = getOscSettings(_db)
  if (oscSettings.enabled) {
    startOscServer(oscSettings.port, { next: handleOscNext, skip: handleOscSkip })
  }

  // Subscribe to OBS WebSocket events for auto-validation
  const validationEvents = [
    'StudioModeStateChanged',
    'SceneCreated',
    'SceneRemoved',
    'SceneNameChanged',
    'SceneTransitionCreated',
    'SceneTransitionRemoved',
  ]
  for (const event of validationEvents) {
    obsClient.onOBSEvent(event, () => {
      if (_db) runValidation(_db)
    })
  }

  obsClient.onStatusChange((status: OBSConnectionStatus) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('obs:status', { status })
    if (status === 'connected' && _db) {
      runValidation(_db)
    }
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

app.on('will-quit', () => {
  stopOscServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
