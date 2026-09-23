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
  PartScope,
  PartUpsertInput,
  LyricUpsertInput,
  GlobalVoiceSettings,
  ProjectVoiceSettings,
  AudioDeviceSettings,
} from '../shared/ipc-contract'
import type { RundownKind } from '../shared/types'
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
  setRundownKind,
  unassignedItemCount,
} from './ipc/rundowns'
import {
  listParts,
  listPartsInScope,
  upsertPart,
  deletePart,
  promotePart,
  setPartsColor,
  renameFolder,
} from './ipc/parts'
import { listLyrics, upsertLyric, deleteLyric } from './ipc/lyrics'
import { listShots, createShot, updateShot, deleteShot, reorderShots, splitShot } from './ipc/shots'
import { createLiveSession } from './live/session'
import type { LiveSession } from './live/session'
import { createOBSSwitcher } from './obs/switcher'
import type { OBSSwitcher } from './obs/switcher'
import { createChangePublisher } from './publisher'
import type { ChangePublisher } from './publisher'
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
  getGlobalVoiceSettings,
  saveGlobalVoiceSettings,
  getProjectVoiceSettings,
  saveProjectVoiceSettings,
  getEffectiveVoiceSettings,
  getAudioDevices,
  saveAudioDevices,
} from './ipc/settings'
import { startOscServer, stopOscServer } from './osc/server'
import {
  listTransitionMappings,
  upsertTransitionMapping,
  deleteTransitionMapping,
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

// Created once the database is open, in app.whenReady().
let live: LiveSession
let obs: OBSSwitcher
let publish: ChangePublisher
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
  runOBSValidation(database, obsClient, live)
    .then(sendValidationResult)
    .catch((err: unknown) => {
      console.error('[OBS] validation error:', err)
    })
}

// --- OSC helpers -------------------------------------------------------------

function handleOscNext(): void {
  if (currentUiMode !== 'live') return
  try {
    const db = getDatabase()
    const liveState = live.getState()

    if (!liveState.running) {
      // Mirror space bar: start the rundown if one is active and not yet running
      if (!liveState.rundownId) return
      const previewFirst = getPreviewFirst(db)
      const state = live.start(liveState.rundownId)
      publish.liveStateChanged(state)
      publish.rundownChanged()
      if (previewFirst) {
        obs.startFromPreview().catch(console.error)
      } else {
        obs.takeLiveShot().catch(console.error)
      }
      return
    }

    if (live.isInTransition()) return
    const { state, hiddenShotId } = live.next()
    publish.liveStateChanged(state)
    if (!state.running) publish.rundownChanged()
    if (hiddenShotId) publish.shotHidden(hiddenShotId)
    obs.takeLiveShot().catch(console.error)
  } catch (err) {
    console.error('[osc] next error:', err)
  }
}

function handleOscSkip(): void {
  if (currentUiMode !== 'live') return
  try {
    const { state, hiddenShotId } = live.skipNext()
    publish.liveStateChanged(state)
    if (hiddenShotId) {
      publish.shotHidden(hiddenShotId)
    }
    obs.cueNextShot().catch(console.error)
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
    publish.rundownChanged()
    return rundown
  })

  registerIpcHandler('rundowns:rename', (payload: { id: string; name: string }) => {
    const rundown = renameRundown(db, payload.id, payload.name)
    publish.rundownChanged()
    return rundown
  })

  registerIpcHandler('rundowns:delete', (payload: { id: string }) => {
    deleteRundown(db, payload.id)
    publish.rundownChanged()
  })

  registerIpcHandler('rundowns:setActive', (payload: { rundownId: string | null }) => {
    live.setActiveRundown(payload.rundownId)
    publish.rundownChanged()
    if (payload.rundownId) {
      obs.cueRundownStart(payload.rundownId).catch((e: unknown) =>
        console.error('[OBS] cueRundownStart:', e),
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

  registerIpcHandler('rundowns:setKind', ({ id, kind }: { id: string; kind: RundownKind }) => {
    const rundown = setRundownKind(db, id, kind)
    // The Kind changes which target column the item Track reads, so phones and
    // the Cue Tray have to be told even though no item row moved.
    publish.rundownChanged()
    return rundown
  })

  registerIpcHandler('rundowns:unassignedCount', ({ rundownId }: { rundownId: string }) =>
    unassignedItemCount(db, rundownId),
  )

  registerIpcHandler(
    'rundowns:renameFolder',
    ({ projectId, from, to }: { projectId: string; from: string; to: string }) => {
      renameFolder(db, projectId, from, to)
      publish.rundownChanged()
    },
  )

  // Parts
  registerIpcHandler('parts:list', ({ projectId }: { projectId: string }) =>
    listParts(db, projectId),
  )

  registerIpcHandler('parts:listInScope', ({ rundownId }: { rundownId: string }) =>
    listPartsInScope(db, rundownId),
  )

  registerIpcHandler('parts:upsert', (payload: PartUpsertInput) => {
    const part = upsertPart(db, payload)
    // A Part's name and colour are what a Call renders as, so phones need the
    // new list even though no Call itself changed.
    publish.rundownChanged()
    return part
  })

  registerIpcHandler('parts:delete', ({ id }: { id: string }) => {
    deletePart(db, id)
    publish.rundownChanged()
  })

  registerIpcHandler('parts:promote', ({ id, scope }: { id: string; scope: PartScope }) =>
    promotePart(db, id, scope),
  )

  registerIpcHandler('parts:setColor', ({ ids, color }: { ids: string[]; color: string }) => {
    const parts = setPartsColor(db, ids, color)
    publish.rundownChanged()
    return parts
  })

  // Lyrics
  registerIpcHandler('lyrics:list', ({ rundownId }: { rundownId: string }) =>
    listLyrics(db, rundownId),
  )

  registerIpcHandler('lyrics:upsert', (payload: LyricUpsertInput) => upsertLyric(db, payload))

  registerIpcHandler('lyrics:delete', ({ id }: { id: string }) => deleteLyric(db, id))

  // Voice-over settings
  registerIpcHandler('voice:settings:get', () => getGlobalVoiceSettings(db))

  registerIpcHandler('voice:settings:save', (payload: GlobalVoiceSettings) =>
    saveGlobalVoiceSettings(db, payload),
  )

  registerIpcHandler('voice:project:get', ({ projectId }: { projectId: string }) =>
    getProjectVoiceSettings(db, projectId),
  )

  registerIpcHandler(
    'voice:project:save',
    ({ projectId, settings }: { projectId: string; settings: ProjectVoiceSettings }) =>
      saveProjectVoiceSettings(db, projectId, settings),
  )

  registerIpcHandler('voice:effective', ({ projectId }: { projectId: string | null }) =>
    getEffectiveVoiceSettings(db, projectId),
  )

  registerIpcHandler('audio:devices:get', () => getAudioDevices(db))

  registerIpcHandler('audio:devices:save', (payload: AudioDeviceSettings) =>
    saveAudioDevices(db, payload),
  )

  registerIpcHandler('project:setActive', (payload: { projectId: string | null }) => {
    live.setActiveProject(payload.projectId)
    publish.rundownChanged()
  })

  // Shots
  registerIpcHandler('shots:list', (payload: { rundownId: string }) => {
    // The Live queue's hidden flags only apply to the Rundown being run.
    if (payload.rundownId === live.getState().rundownId) {
      return live.getShotsWithHiddenFlags()
    }
    return listShots(db, payload.rundownId)
  })

  registerIpcHandler('shots:create', (payload: CreateShotInput) => {
    const shot = createShot(db, payload)
    publish.rundownChanged()
    return shot
  })

  registerIpcHandler('shots:update', (payload: UpdateShotInput) => {
    const shot = updateShot(db, payload)
    publish.rundownChanged()
    return shot
  })

  registerIpcHandler('shots:delete', (payload: { id: string; mode?: DeleteShotMode }) => {
    deleteShot(db, payload.id, payload.mode)
    publish.rundownChanged()
  })

  registerIpcHandler('shots:reorder', (payload: { ids: string[] }) => {
    reorderShots(db, payload.ids)
    publish.rundownChanged()
  })

  registerIpcHandler('shots:split', (payload: SplitShotInput) => {
    const result = splitShot(db, payload)
    publish.rundownChanged()
    return result
  })

  // Live controls
  registerIpcHandler('live:get', () => live.getState())

  registerIpcHandler('live:start', (payload: { rundownId: string; previewFirst?: boolean }) => {
    const state = live.start(payload.rundownId)
    publish.liveStateChanged(state)
    publish.rundownChanged()
    if (payload.previewFirst) {
      obs.startFromPreview().catch(console.error)
    } else {
      obs.takeLiveShot().catch(console.error)
    }
    return state
  })

  registerIpcHandler('live:stop', () => {
    const state = live.stop()
    publish.liveStateChanged(state)
    publish.rundownChanged()
    return state
  })

  registerIpcHandler('live:next', () => {
    const { state, hiddenShotId } = live.next()
    publish.liveStateChanged(state)
    if (hiddenShotId) publish.shotHidden(hiddenShotId)
    obs.takeLiveShot().catch(console.error)
    return state
  })

  registerIpcHandler('live:skip-next', () => {
    const { state, hiddenShotId } = live.skipNext()
    publish.liveStateChanged(state)
    if (hiddenShotId) publish.shotHidden(hiddenShotId)
    obs.cueNextShot().catch(console.error)
    return state
  })

  registerIpcHandler('live:restart', () => {
    const state = live.restart()
    publish.liveStateChanged(state)
    obs.takeLiveShot().catch(console.error)
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
    const liveState = live.getState()
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
      return await runOBSValidation(db, obsClient, live)
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
      defaultPath: 'shotlister-backup.json',
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
    publish.rundownChanged()
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
    publish.rundownChanged()
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
    publish.rundownChanged()
    return true
  })
}


// ---------------------------------------------------------------------------
// Socket.io broadcast helpers
// ---------------------------------------------------------------------------

import type { Server as SocketServer } from 'socket.io'

let _io: SocketServer | null = null
let _db: ReturnType<typeof getDatabase> | null = null

export function setSocketServer(io: SocketServer): void {
  _io = io
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
  live = createLiveSession(_db)
  obs = createOBSSwitcher(_db, obsClient, live)
  publish = createChangePublisher(_db, live, () => _io)
  live.clear()
  registerIpcHandlers()
  const audioDir = app.isPackaged
    ? join(process.resourcesPath, 'audio')
    : join(app.getAppPath(), 'resources', 'audio')
  const io = startServer(_db, live, audioDir, (message) => {
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
