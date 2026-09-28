import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync, createReadStream, promises as fsPromises } from 'fs'
import { extname } from 'path'
import { fromMediaUrl } from '../shared/media-url'
import { toWebStream } from './media-stream'
import { createWaveformCache } from './waveform-cache'
import { startServer } from './server'
import { createVirtualSinkManager, loopbackHints } from './audio/virtual-sink'
import { registerIpcHandler, pushToWindow, refuseWhileLive, setLiveGuard } from './ipc/register'
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
  renameFolder,
  deleteFolder,
} from './ipc/rundowns'
import {
  listParts,
  listPartsInScope,
  upsertPart,
  deletePart,
  promotePart,
  setPartsColor,
} from './ipc/parts'
import { listLyrics, upsertLyric, deleteLyric } from './ipc/lyrics'
import { listShots, createShot, updateShot, deleteShot, reorderShots, splitShot } from './ipc/shots'
import { createLiveSession } from './live/session'
import type { LiveSession } from './live/session'
import { createLiveControl } from './live/control'
import type { LiveControl } from './live/control'
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
  migrateAudioDevices,
  saveAudioDevices,
} from './ipc/settings'
import { clipsDir } from './speech/cache'
import { createFileClipStore } from './speech/clip-store'
import { createPiperSynthesiser, downloadedVoicesDir } from './speech/engine'
import { ensureVoice } from './speech/voices'
import { createRenderService } from './speech/service'
import type { RenderService } from './speech/service'
import { phraseDurations } from './ipc/speech'
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

/**
 * Chunk size for streaming Reference media to the renderer.
 *
 * Every chunk is one turn of the main-process event loop and one copy in
 * `toWebStream`, on the same thread that serves IPC, OBS and SQLite. At the
 * default 64KB a 4K file turns the loop a few hundred times a second for no
 * benefit — Chromium buffers far ahead of playback either way.
 */
const MEDIA_CHUNK_BYTES = 1024 * 1024

// Must be called before app is ready — allows media:// URLs in the renderer
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true },
  },
])

const obsClient = createOBSClient()

// The loopback device the Intercom output duplicates into. Created here on Linux
// and only looked for elsewhere (ADR 0008) — either way before a show, never
// during one.
const virtualSink = createVirtualSinkManager()

// Created once the database is open, in app.whenReady().
let live: LiveSession
let obs: OBSSwitcher
let publish: ChangePublisher
let control: LiveControl
let render: RenderService
let obsAutoReconnect = false
let obsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let currentUiMode: 'edit' | 'live' = 'edit'

// Peaks live beside the rest of this operator's state, not in the project
// database: they are derived from a file on this machine. See waveform-cache.ts.
const waveformCache = createWaveformCache(app.getPath('userData'))

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

// --- OSC adapters ------------------------------------------------------------
//
// The pedal is a transport, not a second opinion: what Next and Skip mean lives
// in live/control.ts. These only decide whether the press reaches it at all.

function handleOscNext(): void {
  if (currentUiMode !== 'live') return
  try {
    // The pedal mirrors the space bar, so a press with nothing running starts
    // the Rundown instead of reporting that there is nothing to advance.
    control.next({ startIfStopped: true })
  } catch (err) {
    console.error('[osc] next error:', err)
  }
}

function handleOscSkip(): void {
  if (currentUiMode !== 'live') return
  try {
    control.skipNext()
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
      // Announcements are scheduled with `setTimeout` in the renderer, and
      // Chromium throttles timers in a window it thinks nobody is looking at —
      // to once a second, and harder when the window is fully occluded. An
      // operator who minimises this window, or drags OBS over it, during a show
      // would get every countdown number late by up to a second. Nothing here
      // is idle background work; the window is running the show.
      backgroundThrottling: false,
    },
  })

  // A load failure leaves an empty frame on screen. Silence there reads as a
  // hung app, so it is reported rather than logged and forgotten.
  const loaded = process.env['ELECTRON_RENDERER_URL']
    ? win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    : win.loadFile(join(__dirname, '../renderer/index.html'))
  loaded.catch((err: unknown) => {
    console.error('[window] failed to load the operator UI:', err)
    dialog.showErrorBox(
      'Shotlister could not start',
      `The operator interface failed to load.\n\n${err instanceof Error ? err.message : String(err)}`,
    )
  })
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

  registerIpcHandler('projects:delete', (payload: { id: string }) => deleteProject(db, payload.id))

  registerIpcHandler('cameras:list', (payload: { projectId: string }) =>
    listCameras(db, payload.projectId),
  )

  // Cameras are in the payload phones render, so a rename or a colour change
  // that is not published leaves every phone showing the old name and the old
  // filter pills until some unrelated change happens to broadcast.
  registerIpcHandler('cameras:upsert', (payload: CameraUpsertInput) => {
    const camera = upsertCamera(db, payload)
    publish.rundownChanged()
    return camera
  })

  registerIpcHandler('cameras:delete', (payload: { id: string }) => {
    deleteCamera(db, payload.id)
    publish.rundownChanged()
  })

  // Rundowns
  registerIpcHandler('rundowns:list', (payload: { projectId: string }) =>
    listRundowns(db, payload.projectId),
  )

  registerIpcHandler('rundowns:create', (payload: { projectId: string; name: string }) => {
    const rundown = createRundown(db, payload.projectId, payload.name)
    publish.rundownChanged()
    return rundown
  })

  registerIpcHandler(
    'rundowns:rename',
    refuseWhileLive('rename a Rundown', (payload: { id: string; name: string }) => {
      const rundown = renameRundown(db, payload.id, payload.name)
      publish.rundownChanged()
      return rundown
    }),
  )

  registerIpcHandler(
    'rundowns:delete',
    refuseWhileLive('delete a Rundown', (payload: { id: string }) => {
      deleteRundown(db, payload.id)
      publish.rundownChanged()
    }),
  )

  // Switching the selection mid-show left the in-memory queue on the old
  // Rundown: phones redrew the new Rundown's items with the old position marked
  // live, and the next Next found no matching Shot, so OBS stopped switching
  // for the rest of the night.
  registerIpcHandler(
    'rundowns:setActive',
    refuseWhileLive('change the active Rundown', (payload: { rundownId: string | null }) => {
      control.openRundown(payload.rundownId)
    }),
  )

  registerIpcHandler(
    'rundowns:reorder',
    refuseWhileLive('reorder Rundowns', ({ ids }: { ids: string[] }) => {
      reorderRundowns(db, ids)
    }),
  )

  registerIpcHandler(
    'rundowns:setFolder',
    ({ id, folder }: { id: string; folder: string | null }) => {
      return setRundownFolder(db, id, folder)
    },
  )

  registerIpcHandler(
    'rundowns:setKind',
    refuseWhileLive('convert a Rundown', ({ id, kind }: { id: string; kind: RundownKind }) => {
      const rundown = setRundownKind(db, id, kind)
      // The Kind changes which target column the item Track reads, so phones and
      // the Cue Tray have to be told even though no item row moved.
      publish.rundownChanged()
      return rundown
    }),
  )

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

  registerIpcHandler(
    'rundowns:deleteFolder',
    ({ projectId, folder }: { projectId: string; folder: string }) => {
      deleteFolder(db, projectId, folder)
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
    // A new or renamed Part is exactly what turns audio stale, so this is where
    // auto-render earns its keep.
    render.scheduleAutoRender(payload.projectId)
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

  registerIpcHandler('voice:settings:save', (payload: GlobalVoiceSettings) => {
    saveGlobalVoiceSettings(db, payload)
    // The Voice is part of every clip's content address, so a global change
    // turns every Part in every Project stale at once — the same reason the
    // per-Project save queues a render.
    for (const project of listProjects(db)) render.scheduleAutoRender(project.id)
  })

  registerIpcHandler('voice:project:get', ({ projectId }: { projectId: string }) =>
    getProjectVoiceSettings(db, projectId),
  )

  registerIpcHandler(
    'voice:project:save',
    ({ projectId, settings }: { projectId: string; settings: ProjectVoiceSettings }) => {
      saveProjectVoiceSettings(db, projectId, settings)
      // Voice and connector are both part of a clip's content address, so a
      // change here restates every phrase the Project speaks.
      render.scheduleAutoRender(projectId)
    },
  )

  registerIpcHandler('voice:effective', ({ projectId }: { projectId: string | null }) =>
    getEffectiveVoiceSettings(db, projectId),
  )

  registerIpcHandler('audio:devices:get', () => getAudioDevices(db))

  registerIpcHandler('audio:devices:save', (payload: AudioDeviceSettings) => {
    saveAudioDevices(db, payload)
    // Nothing is created here any more. An Output names a device; it cannot say
    // that the device is a loopback one, so there is no longer a setting whose
    // switching on means "make me a Virtual output". It is made at start where
    // the platform allows it, and on demand from the panel's own button.
  })

  registerIpcHandler('audio:virtual:state', () => virtualSink.state())

  registerIpcHandler('audio:virtual:ensure', () => virtualSink.ensure())

  registerIpcHandler('audio:virtual:hints', () => [...loopbackHints(process.platform)])

  // Announcement rendering
  registerIpcHandler('speech:renderSummary', ({ projectId }: { projectId: string }) =>
    render.status(projectId),
  )

  registerIpcHandler('speech:render', ({ projectId }: { projectId: string }) =>
    render.renderMissing(projectId),
  )

  registerIpcHandler('speech:phraseDurations', ({ projectId }: { projectId: string }) =>
    phraseDurations(db, projectId),
  )

  registerIpcHandler('speech:cleanOrphans', ({ projectId }: { projectId: string }) =>
    render.cleanOrphans(projectId),
  )

  registerIpcHandler('speech:deleteProjectClips', ({ projectId }: { projectId: string }) =>
    render.deleteProjectClips(projectId),
  )

  registerIpcHandler('speech:projectClipStats', () => render.clipStats())

  registerIpcHandler('project:setActive', (payload: { projectId: string | null }) => {
    live.setActiveProject(payload.projectId)
    // The Project the operator just opened is the one whose missing audio
    // matters now, and it may never have been rendered at all.
    if (payload.projectId !== null) render.scheduleAutoRender(payload.projectId)
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

  registerIpcHandler(
    'shots:create',
    refuseWhileLive('add an item', (payload: CreateShotInput) => {
      const shot = createShot(db, payload)
      publish.rundownChanged()
      return shot
    }),
  )

  registerIpcHandler(
    'shots:update',
    refuseWhileLive('edit an item', (payload: UpdateShotInput) => {
      const shot = updateShot(db, payload)
      publish.rundownChanged()
      return shot
    }),
  )

  registerIpcHandler(
    'shots:delete',
    refuseWhileLive('delete an item', (payload: { id: string; mode?: DeleteShotMode }) => {
      deleteShot(db, payload.id, payload.mode)
      publish.rundownChanged()
    }),
  )

  registerIpcHandler(
    'shots:reorder',
    refuseWhileLive('reorder items', (payload: { ids: string[] }) => {
      reorderShots(db, payload.ids)
      publish.rundownChanged()
    }),
  )

  registerIpcHandler('shots:split', (payload: SplitShotInput) => {
    const result = splitShot(db, payload)
    publish.rundownChanged()
    return result
  })

  // Live controls
  registerIpcHandler('live:get', () => live.getState())

  registerIpcHandler('live:start', (payload: { rundownId: string }) => control.start(payload))

  registerIpcHandler('live:stop', () => control.stop())

  registerIpcHandler('live:next', () => control.next())

  registerIpcHandler('live:skip-next', () => control.skipNext())

  registerIpcHandler('live:restart', () => control.restart())

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

  registerIpcHandler(
    'shots:import-csv:confirm',
    // A replace-mode import rebuilds the Rundown's Shots wholesale. Without the
    // broadcast, phones keep rendering the deleted ones indefinitely.
    refuseWhileLive('import a shot list', (payload: ConfirmImportInput) => {
      const result = confirmResolveImport(db, payload)
      publish.rundownChanged()
      return result
    }),
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
    (payload: { logicalName: string; obsTransitionName: string }) => {
      try {
        upsertTransitionMapping(db, payload.logicalName, payload.obsTransitionName)
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

  registerIpcHandler('media:peaks:get', (payload: { filePath: string; version: string }) =>
    waveformCache.get(payload.filePath, payload.version),
  )

  registerIpcHandler(
    'media:peaks:put',
    (payload: { filePath: string; version: string; peaks: number[]; durationMs: number }) =>
      waveformCache.put(payload.filePath, payload.version, {
        peaks: payload.peaks,
        durationMs: payload.durationMs,
      }),
  )

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
  registerIpcHandler('osc:settings:save', (payload: { enabled: boolean; port: number }) => {
    saveOscSettings(db, payload.enabled, payload.port)
    if (payload.enabled) {
      startOscServer(payload.port, { next: handleOscNext, skip: handleOscSkip })
    } else {
      stopOscServer()
    }
  })

  // Preview-first preference (persisted to DB so OSC can read it)
  registerIpcHandler('live:getPreviewFirst', () => getPreviewFirst(db))
  registerIpcHandler('live:savePreviewFirst', (value: boolean) => savePreviewFirst(db, value))

  // UI mode
  registerIpcHandler('ui:setMode', (mode: 'edit' | 'live') => {
    currentUiMode = mode
  })

  registerIpcHandler('app:openDataDir', async () => {
    const dir = app.getPath('userData')
    // `openPath` reports a failure as a message rather than by throwing, so the
    // one way this goes wrong would otherwise be silent.
    const problem = await shell.openPath(dir)
    if (problem) throw new Error(`Could not open ${dir}: ${problem}`)
    return dir
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

app
  .whenReady()
  .then(() => {
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
        return new Response(
          toWebStream(createReadStream(filePath, { highWaterMark: MEDIA_CHUNK_BYTES })),
          {
            headers: {
              'Content-Length': fileSize.toString(),
              'Content-Type': contentType,
              'Accept-Ranges': 'bytes',
            },
          },
        )
      }

      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
      if (!match) return new Response('Bad Range', { status: 400 })

      const start = parseInt(match[1], 10)
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
      const chunkSize = end - start + 1

      return new Response(
        toWebStream(createReadStream(filePath, { start, end, highWaterMark: MEDIA_CHUNK_BYTES })),
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
    // Before anything reads the audio settings, and long before a Live session can
    // exist: the reader falls back to the old keys anyway, so this is only here to
    // make the two Outputs real and to log once what became of an older install's
    // fixed destinations.
    migrateAudioDevices(_db)
    live = createLiveSession(_db, {
      // Speech plays in the renderer, which is the only side with an
      // output-device API — and the only side the operator can route to a
      // virtual cable. The main process just says what to play and when.
      onAnnouncement: (plan) => pushToWindow('live:announcement-push', plan),
      // Under userData rather than in the app bundle: the cache is per-operator
      // and grows as Parts are named, and a packaged app's resources are read-only.
      clipsDir: clipsDir(app.getPath('userData')),
    })
    obs = createOBSSwitcher(_db, obsClient, live)
    const userDataDir = app.getPath('userData')
    // The one place the three sides of rendering are bolted together: the cache on
    // disk, Piper, and the Voice download. Everything above this line takes them as
    // arguments, which is what keeps Electron out of the render policy.
    const clipStore = createFileClipStore(userDataDir)
    render = createRenderService({
      db: _db,
      clips: clipStore,
      synthesise: createPiperSynthesiser({ clips: clipStore, userDataDir }),
      installVoice: async (voice, onDownload) => {
        await ensureVoice(voice, { voicesDir: downloadedVoicesDir(userDataDir), onDownload })
      },
      isLive: () => live.getState().running,
      onStatus: (status) => pushToWindow('speech:renderSummary-push', status),
    })
    // Every guarded handler reads the session through this, at call time
    // rather than registration time, so the session can be created here and
    // the handlers registered further down.
    setLiveGuard(() => live.getState().running)
    publish = createChangePublisher(_db, live, () => _io)
    control = createLiveControl({
      session: live,
      obs,
      publish,
      abortRender: () => render?.abortRender(),
      // Read per call rather than captured: the operator can toggle Preview-first
      // between two Rundowns without anything being rewired.
      previewFirst: () => getPreviewFirst(getDatabase()),
    })
    live.clear()
    // App start is one of the only two moments the cache may be touched (ADR
    // 0005). Deliberately not awaited: a slow sweep must not hold up the window,
    // and a failed one is a disk-space problem, never a reason not to start.
    // Before the sweep, and for the same reason it is safe here: app start is one
    // of the two moments the cache may be touched. A clip whose length was lost to
    // an interrupted render has to be measured before anything counts it as
    // rendered, or it stays on disk unusable for good.
    render
      .backfillDurations()
      .then(() => render?.sweepOrphans())
      // Auto-rendering means "nothing should stay unrendered", so start-up is one
      // of its triggers: a Project left half-rendered by a closed app, or one
      // imported since, is exactly the case the operator turned this on for.
      // After the repair, so a clip whose duration was just recovered is not
      // synthesised a second time.
      .then(() => {
        if (!_db) return
        for (const project of listProjects(_db)) render?.scheduleAutoRender(project.id)
      })
      .catch((err: unknown) => console.error('[speech] cache repair on start failed:', err))
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

    // The Virtual output is a device, and a device has to exist before an Output
    // can be pointed at it. Made at start so it is there while the operator sets
    // the show up, not first asked for when a Cue is already due. Unconditional
    // now that no setting says "I want an intercom": creation is idempotent, it is
    // a no-op off Linux, and the sink this process loaded is unloaded at quit
    // (ADR 0008). Not awaited — nothing downstream waits on it.
    virtualSink.ensure().catch((err: unknown) => {
      console.error('[audio] could not create the virtual output on start:', err)
    })

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
        obsReconnectTimer = setTimeout(() => {
          obsReconnectTimer = null
          if (!obsAutoReconnect || obsClient.status !== 'disconnected') return
          void (async () => {
            try {
              // Inside the try: a throw here used to reject the timer callback
              // with the retry already cleared and the status already
              // 'disconnected', so no transition could ever re-arm the loop.
              const { url, password } = getObsSettings(_db!)
              await obsClient.connect(url, password || undefined)
            } catch {
              // ConnectionClosed will fire again → schedules next retry
            }
          })()
        }, 5000)
      }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
  // Startup is one long stretch of setup, and a throw anywhere in it aborts
  // every step after the failure — no window, no OBS, no OSC, no server —
  // leaving only an [unhandledRejection] line. A launch that produces nothing
  // at all is the hardest fault to diagnose from a venue, so it is reported.
  .catch((err: unknown) => {
    console.error('[startup] failed:', err)
    dialog.showErrorBox(
      'Shotlister could not start',
      `${err instanceof Error ? err.message : String(err)}\n\n` +
        'The application did not finish starting up. Check the logs for details.',
    )
  })

app.on('will-quit', () => {
  stopOscServer()
})

// The other permitted moment. `before-quit` rather than `will-quit` because the
// sweep is async and `will-quit` does not wait; a sweep that does not finish
// before the process goes is simply retried at the next start.
app.on('before-quit', () => {
  render?.sweepOrphans().catch((err: unknown) => {
    console.error('[speech] sweep on quit failed:', err)
  })
  // Here rather than in `will-quit` for the same reason: the unload is async and
  // `will-quit` does not wait. A sink that outlives a hard kill is harmless — it
  // is silent, the next start reuses it, and the audio server drops it at logout.
  virtualSink.remove().catch((err: unknown) => {
    console.error('[audio] removing the virtual output failed:', err)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
