import { app, BrowserWindow, dialog, protocol } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync, createReadStream, promises as fsPromises } from 'fs'
import { extname } from 'path'
import { Readable } from 'stream'
import { fromMediaUrl } from '../shared/media-url'
import { startServer } from './server'
import { registerIpcHandler, pushToWindow } from './ipc/register'
import type {
  CameraUpsertInput,
  CreateShotInput,
  UpdateShotInput,
  SplitShotInput,
  DeleteShotMode,
  ConfirmImportInput,
  OBSConnectionStatus,
  OBSValidateResult,
  TransitionMapping,
  LiveState,
} from '../shared/ipc-contract'
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
import {
  listRundowns,
  createRundown,
  renameRundown,
  deleteRundown,
  reorderRundowns,
  setRundownFolder,
} from './ipc/rundowns'
import { listShots, createShot, updateShot, deleteShot, reorderShots, splitShot } from './ipc/shots'
import {
  getLiveState,
  getLiveQueue,
  getLiveProgress,
  startLive,
  stopLive,
  nextShot,
  skipNext,
  restartLive,
  setActiveRundown,
  setActiveProject,
  clearLiveState,
} from './ipc/live'
import { getCameraById } from './ipc/projects'
import { parseResolveCSV, confirmResolveImport } from './ipc/resolve-import'
import { createOBSClient } from './obs/client'
import { runOBSValidation } from './obs/validation'
import {
  getObsSettings,
  saveObsSettings,
  getObsEnabled,
  setObsEnabled,
  getOscSettings,
  saveOscSettings,
  getPreviewFirst,
  savePreviewFirst,
} from './ipc/settings'
import { startOscServer, stopOscServer } from './osc/server'
import {
  listTransitionMappings,
  upsertTransitionMapping,
  deleteTransitionMapping,
  resolveTransitionFull,
} from './ipc/transitions'
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
  {
    scheme: 'media',
    privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true },
  },
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

function sendValidationResult(result: OBSValidateResult | null): void {
  pushToWindow('obs:validationResult', result)
}

function runValidation(database: ReturnType<typeof getDatabase>): void {
  runOBSValidation(database, obsClient)
    .then(sendValidationResult)
    .catch((err: unknown) => {
      console.error('[OBS] validation error:', err)
    })
}

// --- OSC helpers -------------------------------------------------------------

interface ShotTransitionRow {
  transition_ms: number
}

function isOscInTransition(db: ReturnType<typeof getDatabase>): boolean {
  try {
    // Live progress lives in memory only — live_state has no progress columns.
    const { liveShotId, startedAt, running } = getLiveProgress()
    if (!running || !liveShotId || startedAt === null) return false
    const shot = db.prepare('SELECT transition_ms FROM shots WHERE id = ?').get(liveShotId) as
      | ShotTransitionRow
      | undefined
    if (!shot || shot.transition_ms <= 0) return false
    return Date.now() - startedAt < shot.transition_ms
  } catch (err) {
    console.error('[osc] isOscInTransition error:', err)
    return false
  }
}

function handleOscNext(): void {
  if (currentUiMode !== 'live') return
  try {
    const db = getDatabase()
    const liveState = getLiveState(db)

    if (!liveState.running) {
      // Mirror space bar: start the rundown if one is active and not yet running
      if (!liveState.rundownId) return
      const previewFirst = getPreviewFirst(db)
      const state = startLive(db, liveState.rundownId)
      broadcastLiveState(state)
      broadcastRundown()
      if (previewFirst) {
        startWithPreviewFirst(state, db).catch(console.error)
      } else {
        switchOBSScenes(state, db).catch(console.error)
      }
      return
    }

    if (isOscInTransition(db)) return
    const { state, hiddenShotId } = nextShot(db)
    broadcastLiveState(state)
    if (!state.running) broadcastRundown()
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
    const { state, hiddenShotId } = skipNext(db)
    broadcastLiveState(state)
    if (hiddenShotId) {
      if (_io) broadcastShotHidden(_io, hiddenShotId)
      broadcastShotHiddenToRenderer(hiddenShotId)
    }
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
  registerIpcHandler('projects:list', () => listProjects(db))

  registerIpcHandler('projects:create', (payload: { name: string }) =>
    createProject(db, payload.name),
  )

  registerIpcHandler('projects:rename', (payload: { id: string; name: string }) =>
    renameProject(db, payload.id, payload.name),
  )

  registerIpcHandler('projects:delete', (payload: { id: string }) =>
    deleteProject(db, payload.id),
  )

  registerIpcHandler('cameras:list', (payload: { projectId: string }) =>
    listCameras(db, payload.projectId),
  )

  registerIpcHandler('cameras:upsert', (payload: CameraUpsertInput) =>
    upsertCamera(db, payload),
  )

  registerIpcHandler('cameras:delete', (payload: { id: string }) =>
    deleteCamera(db, payload.id),
  )

  // Rundowns
  registerIpcHandler('rundowns:list', (payload: { projectId: string }) =>
    listRundowns(db, payload.projectId),
  )

  registerIpcHandler('rundowns:create', (payload: { projectId: string; name: string }) => {
    const rundown = createRundown(db, payload.projectId, payload.name)
    broadcastRundown()
    return rundown
  })

  registerIpcHandler('rundowns:rename', (payload: { id: string; name: string }) => {
    const rundown = renameRundown(db, payload.id, payload.name)
    broadcastRundown()
    return rundown
  })

  registerIpcHandler('rundowns:delete', (payload: { id: string }) => {
    deleteRundown(db, payload.id)
    broadcastRundown()
  })

  registerIpcHandler('rundowns:setActive', (payload: { rundownId: string | null }) => {
    setActiveRundown(db, payload.rundownId)
    broadcastRundown()
    if (payload.rundownId) {
      setOBSPreviewForRundownOpen(db, payload.rundownId).catch((e: unknown) =>
        console.error('[OBS] previewOnOpen:', e),
      )
    }
  })

  registerIpcHandler('rundowns:reorder', ({ ids }: { ids: string[] }) => {
    reorderRundowns(db, ids)
  })

  registerIpcHandler(
    'rundowns:setFolder',
    ({ id, folder }: { id: string; folder: string | null }) => {
      return setRundownFolder(db, id, folder)
    },
  )

  registerIpcHandler('project:setActive', (payload: { projectId: string | null }) => {
    setActiveProject(db, payload.projectId)
    broadcastRundown()
  })

  // Shots
  registerIpcHandler('shots:list', (payload: { rundownId: string }) => {
    const queue = getLiveQueue()
    if (queue.length > 0) {
      const hiddenIds = new Set(queue.filter((s) => s.hidden).map((s) => s.id))
      return listShots(db, payload.rundownId).map((s) => ({ ...s, hidden: hiddenIds.has(s.id) }))
    }
    return listShots(db, payload.rundownId)
  })

  registerIpcHandler('shots:create', (payload: CreateShotInput) => {
    const shot = createShot(db, payload)
    broadcastRundown()
    return shot
  })

  registerIpcHandler('shots:update', (payload: UpdateShotInput) => {
    const shot = updateShot(db, payload)
    broadcastRundown()
    return shot
  })

  registerIpcHandler('shots:delete', (payload: { id: string; mode?: DeleteShotMode }) => {
    deleteShot(db, payload.id, payload.mode)
    broadcastRundown()
  })

  registerIpcHandler('shots:reorder', (payload: { ids: string[] }) => {
    reorderShots(db, payload.ids)
    broadcastRundown()
  })

  registerIpcHandler('shots:split', (payload: SplitShotInput) => {
    const result = splitShot(db, payload)
    broadcastRundown()
    return result
  })

  // Live controls
  registerIpcHandler('live:get', () => getLiveState(db))

  registerIpcHandler('live:start', (payload: { rundownId: string; previewFirst?: boolean }) => {
    const state = startLive(db, payload.rundownId)
    broadcastLiveState(state)
    broadcastRundown()
    if (payload.previewFirst) {
      startWithPreviewFirst(state, db).catch(console.error)
    } else {
      switchOBSScenes(state, db).catch(console.error)
    }
    return state
  })

  registerIpcHandler('live:stop', () => {
    const state = stopLive(db)
    broadcastLiveState(state)
    broadcastRundown()
    return state
  })

  registerIpcHandler('live:next', () => {
    const { state, hiddenShotId } = nextShot(db)
    broadcastLiveState(state)
    if (hiddenShotId && _io) broadcastShotHidden(_io, hiddenShotId)
    switchOBSScenes(state, db).catch(console.error)
    return state
  })

  registerIpcHandler('live:skip-next', () => {
    const { state, hiddenShotId } = skipNext(db)
    broadcastLiveState(state)
    if (hiddenShotId && _io) broadcastShotHidden(_io, hiddenShotId)
    switchOBSPreview(state, db).catch(console.error)
    return state
  })

  registerIpcHandler('live:restart', () => {
    const state = restartLive(db)
    broadcastLiveState(state)
    switchOBSScenes(state, db).catch(console.error)
    return state
  })

  // DaVinci Resolve CSV import
  registerIpcHandler('shots:import-csv:parse', async (payload: { filePath: string }) => {
    const content = readFileSync(payload.filePath, 'utf-8')
    return parseResolveCSV(content)
  })

  registerIpcHandler('shots:import-csv:open-dialog', async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    })
    return result
  })

  registerIpcHandler('shots:import-csv:confirm', (payload: ConfirmImportInput) =>
    confirmResolveImport(db, payload),
  )

  // OBS
  registerIpcHandler('obs:settings:get', () => getObsSettings(db))

  registerIpcHandler('obs:settings:save', (payload: { url: string; password: string }) => {
    saveObsSettings(db, payload.url, payload.password)
  })

  registerIpcHandler('obs:connect', async () => {
    const settings = getObsSettings(db)
    try {
      await obsClient.connect(settings.url, settings.password)
      obsAutoReconnect = true
    } catch (err) {
      throw new Error(err instanceof Error ? err.message || 'Connection failed' : String(err))
    }
  })

  registerIpcHandler('obs:disconnect', () => {
    obsAutoReconnect = false
    if (obsReconnectTimer) {
      clearTimeout(obsReconnectTimer)
      obsReconnectTimer = null
    }
    obsClient.disconnect()
  })

  registerIpcHandler('obs:status', () => ({ status: obsClient.status }))

  registerIpcHandler('obs:getEnabled', () => getObsEnabled(db))

  registerIpcHandler('obs:setEnabled', (enabled: boolean) => {
    setObsEnabled(db, enabled)
    if (enabled) {
      obsAutoReconnect = true
      const { url, password } = getObsSettings(db)
      obsClient.connect(url, password || undefined).catch(() => {})
    } else {
      obsAutoReconnect = false
      if (obsReconnectTimer) {
        clearTimeout(obsReconnectTimer)
        obsReconnectTimer = null
      }
      obsClient.disconnect()
    }
  })

  registerIpcHandler('obs:getTransitions', async () => {
    try {
      return await obsClient.getTransitionList()
    } catch (err) {
      console.error('[OBS] getTransitionList:', err)
      return []
    }
  })

  registerIpcHandler('obs:getScenes', async () => {
    try {
      return await obsClient.getSceneList()
    } catch (err) {
      console.error('[OBS] getSceneList:', err)
      return []
    }
  })

  registerIpcHandler('obs:checkScenes', async () => {
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

  registerIpcHandler('obs:validate', async () => {
    try {
      return await runOBSValidation(db, obsClient)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })

  registerIpcHandler('obs:transitions:list', (): TransitionMapping[] => {
    try {
      return listTransitionMappings(db)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })

  registerIpcHandler(
    'obs:transitions:upsert',
    (
      payload: { logicalName: string; obsTransitionName: string; constLengthMs?: number | null },
    ) => {
      try {
        upsertTransitionMapping(
          db,
          payload.logicalName,
          payload.obsTransitionName,
          payload.constLengthMs ?? null,
        )
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err))
      }
    },
  )

  registerIpcHandler('obs:transitions:delete', (payload: { logicalName: string }) => {
    try {
      deleteTransitionMapping(db, payload.logicalName)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })

  // Markers
  registerIpcHandler('markers:list', (payload: { rundownId: string }) =>
    listMarkers(db, payload.rundownId),
  )
  registerIpcHandler('markers:upsert', (payload: UpsertMarkerInput) => upsertMarker(db, payload))
  registerIpcHandler('markers:delete', (payload: { id: string }) => deleteMarker(db, payload.id))

  // Rundown media
  registerIpcHandler('rundown:media:get', (payload: { rundownId: string }) => {
    const filePath =
      (
        db
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get(`rundown_media_path_${payload.rundownId}`) as { value: string } | undefined
      )?.value ?? null
    const offsetStr =
      (
        db
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get(`rundown_media_offset_${payload.rundownId}`) as { value: string } | undefined
      )?.value ?? '0'
    return { filePath, offsetMs: parseInt(offsetStr, 10) }
  })

  registerIpcHandler(
    'rundown:media:save',
    (payload: { rundownId: string; filePath: string; offsetMs: number }) => {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(`rundown_media_path_${payload.rundownId}`, payload.filePath)
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(`rundown_media_offset_${payload.rundownId}`, String(payload.offsetMs))
    },
  )

  registerIpcHandler('rundown:media:clear', (payload: { rundownId: string }) => {
    db.prepare('DELETE FROM settings WHERE key = ?').run(`rundown_media_path_${payload.rundownId}`)
    db.prepare('DELETE FROM settings WHERE key = ?').run(
      `rundown_media_offset_${payload.rundownId}`,
    )
  })

  registerIpcHandler('media:file-exists', (filePath: string) => {
    try {
      return existsSync(filePath)
    } catch {
      return false
    }
  })

  registerIpcHandler('rundown:media:open-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: 'Audio/Video',
          extensions: [
            'mp3',
            'wav',
            'aac',
            'ogg',
            'flac',
            'm4a',
            'mp4',
            'mov',
            'webm',
            'avi',
            'mkv',
          ],
        },
      ],
    })
    return result
  })

  // OSC
  registerIpcHandler('osc:settings:get', () => getOscSettings(db))
  registerIpcHandler(
    'osc:settings:save',
    (payload: { enabled: boolean; port: number }) => {
      saveOscSettings(db, payload.enabled, payload.port)
      if (payload.enabled) {
        startOscServer(payload.port, { next: handleOscNext, skip: handleOscSkip })
      } else {
        stopOscServer()
      }
    },
  )

  // Preview-first preference (persisted to DB so OSC can read it)
  registerIpcHandler('live:getPreviewFirst', () => getPreviewFirst(db))
  registerIpcHandler('live:savePreviewFirst', (value: boolean) => savePreviewFirst(db, value))

  // UI mode
  registerIpcHandler('ui:setMode', (mode: 'edit' | 'live') => {
    currentUiMode = mode
  })

  // Assets
  registerIpcHandler('assets:audioDir', () => {
    return app.isPackaged
      ? join(process.resourcesPath, 'audio')
      : join(app.getAppPath(), 'resources', 'audio')
  })

  // Export / Import
  registerIpcHandler('export:project', async ({ projectId }: { projectId: string }) => {
    const data = exportProjectData(getDatabase(), projectId)
    const result = await dialog.showSaveDialog({
      defaultPath: 'project.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return
    await fsPromises.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf-8')
  })

  registerIpcHandler('export:rundown', async ({ rundownId }: { rundownId: string }) => {
    const data = exportRundownData(getDatabase(), rundownId)
    const result = await dialog.showSaveDialog({
      defaultPath: 'rundown.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return
    await fsPromises.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf-8')
  })

  registerIpcHandler('export:database', async () => {
    const data = exportDatabaseData(getDatabase())
    const result = await dialog.showSaveDialog({
      defaultPath: 'obs-queuer-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return
    await fsPromises.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf-8')
  })

  registerIpcHandler('import:project', async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const raw = await fsPromises.readFile(result.filePaths[0], 'utf-8')
    const data = JSON.parse(raw)
    const newProjectId = importProjectData(getDatabase(), data)
    broadcastRundown()
    return newProjectId
  })

  registerIpcHandler('import:rundown', async ({ projectId }: { projectId: string }) => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const raw = await fsPromises.readFile(result.filePaths[0], 'utf-8')
    const data = JSON.parse(raw)
    const newRundownId = importRundownData(getDatabase(), projectId, data)
    broadcastRundown()
    return newRundownId
  })

  registerIpcHandler('import:database', async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return false
    const raw = await fsPromises.readFile(result.filePaths[0], 'utf-8')
    const data = JSON.parse(raw)
    importDatabaseData(getDatabase(), data)
    broadcastRundown()
    return true
  })
}

// ---------------------------------------------------------------------------
// OBS scene switching helpers
// ---------------------------------------------------------------------------


async function startWithPreviewFirst(
  state: LiveState,
  database: ReturnType<typeof getDatabase>,
): Promise<void> {
  if (obsClient.status !== 'connected') {
    console.warn('[OBS] startWithPreviewFirst: not connected, falling back to switchOBSScenes')
    return switchOBSScenes(state, database)
  }
  if (!state.running || state.liveIndex === null || !state.rundownId) return

  const allShots = listShots(database, state.rundownId)
  const firstShot = allShots[0]
  if (!firstShot) return

  const firstCamera = getCameraById(database, firstShot.cameraId)
  if (!firstCamera?.obsScene) {
    console.warn('[OBS] startWithPreviewFirst: first shot camera has no obsScene, falling back')
    return switchOBSScenes(state, database)
  }

  // 1. SetPreview to first shot's camera
  console.log('[OBS] startWithPreviewFirst: setPreview ->', firstCamera.obsScene)
  await obsClient.setCurrentPreviewScene(firstCamera.obsScene)

  // 2. Wait 50ms
  await new Promise<void>((resolve) => setTimeout(resolve, 50))

  // 3. setTransition: null = cut (duration 0), explicit name uses its own duration
  const effectiveTransitionMs = firstShot.transitionMs ?? 0
  const transitionLogical = firstShot.transitionName ?? 'cut'
  const { obsName, constLengthMs } = resolveTransitionFull(database, transitionLogical)
  const duration = transitionLogical === 'cut' || constLengthMs !== null ? 0 : effectiveTransitionMs
  console.log('[OBS] startWithPreviewFirst: setTransition ->', obsName, duration)
  try {
    await obsClient.setCurrentSceneTransition(obsName, duration)
  } catch (e: unknown) {
    console.error('[OBS] setTransition:', obsName, e)
  }

  // 4. Execute transition
  console.log('[OBS] startWithPreviewFirst: triggerTransition')
  try {
    await obsClient.triggerStudioModeTransition()
  } catch (e: unknown) {
    console.error('[OBS] triggerTransition:', e)
  }

  // 5. Wait for transition + buffer, then set preview to next shot
  await new Promise<void>((resolve) => setTimeout(resolve, effectiveTransitionMs + 50))

  const queue = getLiveQueue()
  const hiddenIds = new Set(queue.filter((s) => s.hidden).map((s) => s.id))
  const nextVisibleShot = allShots.slice(1).find((s) => !hiddenIds.has(s.id))
  if (nextVisibleShot) {
    const nextCamera = getCameraById(database, nextVisibleShot.cameraId)
    if (nextCamera?.obsScene) {
      obsClient
        .setCurrentPreviewScene(nextCamera.obsScene)
        .catch((e: unknown) => console.error('[OBS] preview next:', e))
    }
  }
}

async function switchOBSScenes(
  state: LiveState,
  database: ReturnType<typeof getDatabase>,
): Promise<void> {
  if (
    obsClient.status !== 'connected' ||
    !state.running ||
    state.liveIndex === null ||
    !state.rundownId
  )
    return

  // Resolve live shot by ID (safe against index/order_index misalignment)
  const queue = getLiveQueue()
  const liveShotId = queue[state.liveIndex]?.id
  if (!liveShotId) return

  const allShots = listShots(database, state.rundownId)
  const liveShotIdx = allShots.findIndex((s) => s.id === liveShotId)
  if (liveShotIdx === -1) return

  const liveShot = allShots[liveShotIdx]
  const liveCamera = getCameraById(database, liveShot.cameraId)

  const effectiveTransitionMs = liveShot.transitionMs ?? 0

  // 1+2. Configure transition then trigger studio mode transition
  // null transitionName = cut (duration 0); explicit name overrides with its own duration
  if (liveCamera?.obsScene) {
    const transitionLogical = liveShot.transitionName ?? 'cut'
    const { obsName, constLengthMs } = resolveTransitionFull(database, transitionLogical)
    const duration =
      transitionLogical === 'cut' || constLengthMs !== null ? 0 : effectiveTransitionMs
    try {
      await obsClient.setCurrentSceneTransition(obsName, duration)
    } catch (e: unknown) {
      console.error('[OBS] setTransition: attempted name:', obsName, e)
    }
    try {
      await obsClient.triggerStudioModeTransition()
    } catch (e: unknown) {
      console.error('[OBS] program:', e)
    }
  }

  // 3. Wait for transition to finish + 50ms buffer before touching preview
  await new Promise<void>((resolve) => setTimeout(resolve, effectiveTransitionMs + 50))

  // 4. Set next camera to preview
  const hiddenIds = new Set(queue.filter((s) => s.hidden).map((s) => s.id))
  const nextVisibleShot = allShots.slice(liveShotIdx + 1).find((s) => !hiddenIds.has(s.id))
  if (nextVisibleShot) {
    const nextCamera = getCameraById(database, nextVisibleShot.cameraId)
    if (nextCamera?.obsScene) {
      obsClient
        .setCurrentPreviewScene(nextCamera.obsScene)
        .catch((e: unknown) => console.error('[OBS] preview:', e))
    }
  }
}

async function setOBSPreviewForRundownOpen(
  database: ReturnType<typeof getDatabase>,
  rundownId: string,
): Promise<void> {
  if (obsClient.status !== 'connected') return
  const allShots = listShots(database, rundownId)
  const firstShot = allShots[0]
  if (!firstShot) return
  const camera = getCameraById(database, firstShot.cameraId)
  if (camera?.obsScene) {
    await obsClient.setCurrentPreviewScene(camera.obsScene)
  }
}

async function switchOBSPreview(
  state: LiveState,
  database: ReturnType<typeof getDatabase>,
): Promise<void> {
  if (
    obsClient.status !== 'connected' ||
    !state.running ||
    state.liveIndex === null ||
    !state.rundownId
  )
    return

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
      obsClient
        .setCurrentPreviewScene(nextCamera.obsScene)
        .catch((e: unknown) => console.error('[OBS] preview:', e))
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
  pushToWindow('live:state-push', state)
}

function broadcastShotHiddenToRenderer(shotId: string): void {
  pushToWindow('live:shot-hidden-push', shotId)
}

function broadcastRundown(): void {
  if (!_io || !_db) return
  const queue = getLiveQueue()
  if (queue.length > 0) {
    const state = getLiveState(_db)
    if (state.rundownId) {
      const hiddenIds = new Set(queue.filter((s) => s.hidden).map((s) => s.id))
      const shotsWithHidden = listShots(_db, state.rundownId).map((s) => ({
        ...s,
        hidden: hiddenIds.has(s.id),
      }))
      broadcastRundownState(_io, _db, shotsWithHidden)
      return
    }
  }
  broadcastRundownState(_io, _db)
}

app.whenReady().then(() => {
  // Serve local media files via media:// protocol (avoids cross-origin issues in dev mode)
  protocol.handle('media', async (request) => {
    const filePath = fromMediaUrl(request.url)
    let stat: Awaited<ReturnType<typeof fsPromises.stat>>
    try {
      stat = await fsPromises.stat(filePath)
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const fileSize = stat.size
    const ext = extname(filePath).toLowerCase().slice(1)
    const mimeTypes: Record<string, string> = {
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
      mkv: 'video/x-matroska',
      avi: 'video/x-msvideo',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      aac: 'audio/aac',
      ogg: 'audio/ogg',
      opus: 'audio/ogg; codecs=opus',
      flac: 'audio/flac',
      m4a: 'audio/mp4',
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

    return new Response(
      Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream,
      {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize.toString(),
          'Content-Type': contentType,
        },
      },
    )
  })

  _db = getDatabase()
  clearLiveState(_db)
  registerIpcHandlers()
  const audioDir = app.isPackaged
    ? join(process.resourcesPath, 'audio')
    : join(app.getAppPath(), 'resources', 'audio')
  const io = startServer(_db, audioDir, (message) => {
    pushToWindow('server:error', message)
  })
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
    pushToWindow('obs:status', { status })
    if (status === 'connected' && _db) {
      // A retry may still be pending from before this connection succeeded.
      if (obsReconnectTimer) {
        clearTimeout(obsReconnectTimer)
        obsReconnectTimer = null
      }
      runValidation(_db)
    }
    if (status === 'disconnected' && obsAutoReconnect) {
      // A flapping connection fires this repeatedly — keep exactly one retry pending.
      if (obsReconnectTimer) clearTimeout(obsReconnectTimer)
      obsReconnectTimer = setTimeout(async () => {
        obsReconnectTimer = null
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
