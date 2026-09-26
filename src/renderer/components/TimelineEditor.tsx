import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Shot, Camera, Marker, Part, Lyric } from '../../shared/types'
import { toMediaUrl } from '../../shared/media-url'
import {
  timelinePosMs,
  msAtPx,
  shotIdAtMs,
  totalDurationMs,
  shotStartOffsetsMs,
  shotStartMs,
  pxAtMs,
} from '../timeline/coordinates'
import { usePlaybackProbe } from '../timeline/playback-probe'
import { describeDecodeFailure } from '../timeline/waveform-error'
import { RulerLane } from './timeline/RulerLane'
import { OverviewBar } from './timeline/OverviewBar'
import { ItemLane, type ItemLaneHandlers } from './timeline/ItemLane'
import { MediaLane } from './timeline/MediaLane'
import { createPlayhead, type Playhead } from '../timeline/playhead'
import {
  alignReferenceMedia,
  extendLastItem,
  moveMarker,
  resizeLyric,
  resizeShotPair,
  scrubPlayhead,
  type GrabSample,
  type GrabSpec,
} from '../timeline/grab'
import {
  lyricRange,
  lyricBlocks,
  lyricAtMs,
  overlappingLyric,
  isUnassigned,
  announcementProblemsByCallId,
  type AnnouncementSettings,
  type AnnouncementProblem,
} from '../timeline/lyrics'
import { useAppStore } from '../store'

/**
 * The default for the optional `phraseDurationMsByPartId` prop.
 *
 * Module-level on purpose. Written as `= {}` in the destructuring it was a fresh
 * object on every render, which invalidated the memo that derives Announcement
 * problems from it, which produced a new Map, which defeated the memo on the item
 * lane — so the largest lane on the timeline re-rendered on every playback commit
 * despite being memoised.
 */
const NO_PHRASE_DURATIONS: Record<string, number> = {}

/** The strip's summary, or null when every Call announces properly. */
export function announcementProblemLabel(
  problems: ReadonlyMap<string, AnnouncementProblem>,
): string | null {
  let dropped = 0
  let phraseOnly = 0
  for (const shape of problems.values()) {
    if (shape === 'dropped') dropped++
    else phraseOnly++
  }
  if (dropped === 0 && phraseOnly === 0) return null

  const parts: string[] = []
  if (dropped > 0) parts.push(`${dropped} silent`)
  if (phraseOnly > 0) parts.push(`${phraseOnly} with no countdown`)
  const total = dropped + phraseOnly
  return `${total} ${total === 1 ? 'call is' : 'calls are'} too short: ${parts.join(', ')}`
}
import {
  ADD_PART_KEY,
  AddPartDialog,
  PartButtonBar,
  PartPicker,
  partForKey,
} from './PartsConfigPanel'
import { targetNoun, targetOf, targetsById, targetsOf } from '../../shared/rundown-item'
import type { DeleteShotMode } from '../../shared/ipc-contract'

interface TimelineEditorProps {
  shots: Shot[]
  cameras: Camera[]
  liveIndex: number | null
  running: boolean
  startedAt: number | null
  markers: Marker[]
  onShotClick: (shotId: string) => void
  onSplitShot: (shotId: string, atMs: number, newCameraId: string) => void
  onResizeShots: (
    shotAId: string,
    newDurationA: number,
    shotBId: string,
    newDurationB: number,
  ) => void
  onExtendLastShot: (shotId: string, newDurationMs: number) => void
  onAddMarker: (positionMs: number) => void
  onUpdateMarker: (id: string, positionMs: number, label?: string | null) => void
  onDeleteMarker: (id: string) => void
  rundownMedia: { filePath: string; offsetMs: number } | null
  onImportMedia: () => void
  onUpdateMediaOffset: (offsetMs: number) => void
  onClearMedia: () => void
  /** `mode` defaults to 'extend': the neighbouring shot absorbs the deleted time. */
  onDeleteShot: (shotId: string, mode?: DeleteShotMode) => void
  onChangeShotCamera: (shotId: string, cameraId: string) => void
  mediaVideoRef: React.RefObject<HTMLVideoElement | null>
  selectedShotId: string | null
  onLabelEdit: (shotId: string) => void
  /**
   * Duration of each Part's rendered phrase clip, by Part id, so Edit mode can
   * badge a Call too short to announce the one after it.
   *
   * Empty by default: the renderer has no clip durations of its own, and a badge
   * on a guessed duration would be worse than no badge at all. Hand it the cache
   * index once the render plumbing reaches the renderer.
   */
  phraseDurationMsByPartId?: Record<string, number>
  /**
   * Countdown, placement and path delay for the active Project.
   *
   * Needed to say what an Announcement will sound like rather than only whether
   * it happens at all: a Call can be long enough for the name and still too
   * short for a single number, and which numbers are even in play is a setting.
   * Absent means nothing is badged — a guess here is worse than silence.
   */
  announcementSettings?: AnnouncementSettings
}

const TRACK_HEIGHT = 50
const RULER_HEIGHT = 20
const TOOLBAR_HEIGHT = 36
const LYRICS_ROW_HEIGHT = 34
const MARKER_ROW_HEIGHT = 30
const MEDIA_ROW_HEIGHT = 60
const CAM_BUTTONS_HEIGHT = 48
const OVERVIEW_HEIGHT = 24
const PLAYHEAD_FIXED_PX = 120

// Waveform is a rough visual guide, so decode it at a low sample rate and cap the
// number of peaks: at 40/s an hour-long file produced 144k buckets (and 144k SVG
// nodes). The cap keeps a full feature film under ~20k points.
const WAVEFORM_SAMPLE_RATE = 8000
const PEAKS_PER_SECOND = 40
const MAX_WAVEFORM_BUCKETS = 20000

/**
 * Identifies the settings the peaks were produced with, so cached peaks from an
 * older release are not drawn at the wrong resolution after these change.
 */
const WAVEFORM_VERSION = `v1:${WAVEFORM_SAMPLE_RATE}:${PEAKS_PER_SECOND}:${MAX_WAVEFORM_BUCKETS}`

/**
 * Peaks are amplitudes drawn into a 60px-tall lane, so a thousandth is already far
 * below anything visible — and full float precision made a cached entry three
 * times larger for nothing. Rounded at the source rather than on the way into the
 * cache, so the freshly decoded and cached lanes are drawn from identical numbers.
 */
function roundPeak(value: number): number {
  return Math.round(value * 1000) / 1000
}

// During playback the playhead moves every frame, but only its own readout and the
// overview marker change. Those are painted directly; React state is committed at
// this interval so playhead-dependent effects still run without a 60fps re-render
// of the whole timeline.
const PLAYHEAD_COMMIT_INTERVAL_MS = 100

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

function formatPlayhead(ms: number): string {
  return `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, '0')}`
}

/**
 * Renders the peak envelope as one filled path. Emitting a <rect> per peak meant
 * tens of thousands of SVG nodes rebuilt on every render; this is a single node,
 * downsampled to at most one point per horizontal pixel.
 */
function buildWaveformPath(peaks: number[] | null, width: number, halfHeight: number): string {
  if (peaks === null || peaks.length === 0 || width <= 0) return ''
  const points = Math.max(1, Math.min(peaks.length, Math.ceil(width)))
  const step = peaks.length / points
  const top: string[] = []
  const bottom: string[] = []
  for (let i = 0; i < points; i++) {
    const from = Math.floor(i * step)
    const to = Math.min(peaks.length, Math.max(from + 1, Math.floor((i + 1) * step)))
    let max = 0
    for (let j = from; j < to; j++) max = Math.max(max, peaks[j])
    const x = ((i / points) * width).toFixed(2)
    const y = max * halfHeight
    top.push(`${x},${(halfHeight - y).toFixed(2)}`)
    bottom.push(`${x},${(halfHeight + y).toFixed(2)}`)
  }
  bottom.reverse()
  return `M${top.join('L')}L${bottom.join('L')}Z`
}

/** A line being typed: its range is already fixed, its text is not. */
interface LyricDraft {
  /** The line being re-worded, or null while a new line is being authored. */
  id: string | null
  startMs: number
  endMs: number
  text: string
}

/**
 * A grab strip on one edge of a Lyric.
 *
 * Wider than it looks: a 3px target is unhittable at this zoom, so the strip
 * is 7px and straddles the border, with only the inner sliver painted.
 */
function LyricEdgeHandle({
  side,
  onDown,
}: {
  side: 'start' | 'end'
  onDown: (e: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div
      role="presentation"
      onMouseDown={onDown}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      title={side === 'start' ? 'Drag the in point' : 'Drag the out point'}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        [side === 'start' ? 'left' : 'right']: -3,
        width: 7,
        cursor: 'ew-resize',
        background:
          side === 'start'
            ? 'linear-gradient(to right, transparent 0 2px, #5dade2 2px 5px, transparent 5px)'
            : 'linear-gradient(to left, transparent 0 2px, #5dade2 2px 5px, transparent 5px)',
      }}
    />
  )
}

export function TimelineEditor({
  shots,
  cameras,
  liveIndex,
  running,
  startedAt,
  markers,
  onShotClick,
  onSplitShot,
  onResizeShots,
  onExtendLastShot,
  onAddMarker,
  onUpdateMarker,
  onDeleteMarker,
  rundownMedia,
  onImportMedia,
  onUpdateMediaOffset,
  onClearMedia,
  onDeleteShot,
  onChangeShotCamera,
  mediaVideoRef,
  selectedShotId,
  onLabelEdit,
  phraseDurationMsByPartId = NO_PHRASE_DURATIONS,
  announcementSettings,
}: TimelineEditorProps): React.JSX.Element {
  // Parts, Lyrics and the Rundown's Kind are read from the store rather than
  // taken as props: everything above passes one shared `timelineProps` object to
  // whichever timeline slot is on screen, and threading three more Voice-over
  // concerns through it would widen that object for every caller. The item and
  // Marker props stay as they are.
  const lyrics = useAppStore((s) => s.lyrics)
  const upsertLyric = useAppStore((s) => s.upsertLyric)
  const removeLyric = useAppStore((s) => s.removeLyric)
  const partsInScope = useAppStore((s) => s.partsInScope)
  const editShot = useAppStore((s) => s.editShot)
  const splitShot = useAppStore((s) => s.splitShot)
  const activeRundownId = useAppStore((s) => s.activeRundownId)
  const rundownKind = useAppStore(
    (s) => s.rundowns.find((r) => r.id === s.activeRundownId)?.kind ?? 'camera',
  )
  const isVoice = rundownKind === 'voice'

  const [zoomPxPerSec, setZoomPxPerSec] = useState<number>(() => {
    const saved = localStorage.getItem('obs-queuer-timeline-zoom')
    return saved ? Math.max(5, Math.min(2000, parseFloat(saved))) : 80
  })
  const [playheadMs, setPlayheadMs] = useState(0)
  const [dragOverride, setDragOverride] = useState<Record<string, number>>({})
  const [markerDragOverride, setMarkerDragOverride] = useState<Record<string, number>>({})
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null)
  const [editingMarkerLabel, setEditingMarkerLabel] = useState('')
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null)
  const [waveformData, setWaveformData] = useState<number[] | null>(null)
  const [mediaDurationMs, setMediaDurationMs] = useState<number>(0)
  const [mediaOffsetOverride, setMediaOffsetOverride] = useState<number | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; shotId: string } | null>(
    null,
  )
  const [flash, setFlash] = useState(false)
  const [currentScrollLeft, setCurrentScrollLeft] = useState(0)
  const [waveformError, setWaveformError] = useState<string | null>(null)
  const [mediaFileNotFound, setMediaFileNotFound] = useState(false)
  const [containerWidth, setContainerWidth] = useState(800)
  const [overviewWidth, setOverviewWidth] = useState(300)
  const [lyricInMs, setLyricInMs] = useState<number | null>(null)
  const [lyricDraft, setLyricDraft] = useState<LyricDraft | null>(null)
  const [selectedLyricId, setSelectedLyricId] = useState<string | null>(null)
  const [hoveredLyricId, setHoveredLyricId] = useState<string | null>(null)
  const [lyricError, setLyricError] = useState<string | null>(null)
  /** The edge being dragged, shown before it is saved. */
  const [lyricDragOverride, setLyricDragOverride] = useState<{
    id: string
    startMs: number
    endMs: number
  } | null>(null)
  const [partPickerOpen, setPartPickerOpen] = useState(false)
  const [addPartOpen, setAddPartOpen] = useState(false)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isPlayingRef = useRef(isPlaying)
  const runningRef = useRef(running)
  /**
   * True while a grab that owns the Playhead is under way.
   *
   * Was three separate drag-state refs — boundary, Marker, Reference media — read
   * together in one place and nowhere else. `beginGrab` closes over each grab's
   * world now, so all the refs were still doing was answering this question.
   */
  const grabOwnsPlayheadRef = useRef(false)
  const zoomRef = useRef(zoomPxPerSec)
  const overviewRef = useRef<HTMLDivElement>(null)
  const onAddMarkerRef = useRef(onAddMarker)
  const onLabelEditRef = useRef(onLabelEdit)
  const selectedShotIdRef = useRef(selectedShotId)
  const isFirstLiveRef = useRef(true)
  const isFirstSelectedRef = useRef(true)
  const prevAutoShotIdRef = useRef<string | null>(null)
  const audioPlayRef = useRef<HTMLAudioElement | null>(null)
  const pendingDragClearRef = useRef(false)
  const rundownMediaRef = useRef(rundownMedia)
  const playheadTimeElRef = useRef<HTMLSpanElement>(null)
  const overviewPlayheadElRef = useRef<HTMLDivElement>(null)
  const viewportRectElRef = useRef<HTMLDivElement>(null)
  const shotsRef = useRef(shots)
  const camerasRef = useRef(cameras)
  // The key handler is bound once; N must stay free in a Camera Rundown.
  const isVoiceRef = useRef(false)
  // The drag handlers live on window and outlive the render that made them.
  const lyricsRef = useRef<Lyric[]>([])
  // The keyboard effect is bound once and never re-bound, so the handlers it
  // reaches for are republished every render through this ref rather than
  // captured in its closure.
  const keyActionsRef = useRef({
    setLyricIn: (): void => {},
    setLyricOut: (): void => {},
    openAddPart: (): void => {},
    /** True when the key named a Part and was spent assigning it. */
    assignPartByKey: (_key: string): boolean => false,
  })

  // Keep zoomRef in sync
  useEffect(() => {
    zoomRef.current = zoomPxPerSec
  }, [zoomPxPerSec])

  // Persist zoom
  useEffect(() => {
    localStorage.setItem('obs-queuer-timeline-zoom', String(zoomPxPerSec))
  }, [zoomPxPerSec])

  // Keep onAddMarkerRef in sync
  useEffect(() => {
    onAddMarkerRef.current = onAddMarker
  }, [onAddMarker])

  // Keep onLabelEditRef and selectedShotIdRef in sync
  useEffect(() => {
    onLabelEditRef.current = onLabelEdit
  }, [onLabelEdit])
  useEffect(() => {
    selectedShotIdRef.current = selectedShotId
  }, [selectedShotId])

  // Keep isPlayingRef and runningRef in sync
  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])
  useEffect(() => {
    runningRef.current = running
  }, [running])
  useEffect(() => {
    rundownMediaRef.current = rundownMedia
  }, [rundownMedia])
  useEffect(() => {
    shotsRef.current = shots
  }, [shots])
  useEffect(() => {
    camerasRef.current = cameras
  }, [cameras])
  useEffect(() => {
    isVoiceRef.current = isVoice
  }, [isVoice])
  useEffect(() => {
    lyricsRef.current = lyrics
  }, [lyrics])

  // Sync media currentTime to playhead while stopped
  useEffect(() => {
    if (isPlaying || running) return
    playhead.seekMedia(playheadMs)
  }, [playheadMs, isPlaying, running]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clear dragOverride only after shots prop has updated from IPC response
  useEffect(() => {
    if (pendingDragClearRef.current) {
      pendingDragClearRef.current = false
      setDragOverride({})
    }
  }, [shots])

  useEffect(() => {
    if (running) {
      setIsPlaying(false)
      if (mediaVideoRef.current) mediaVideoRef.current.pause()
      if (audioPlayRef.current) audioPlayRef.current.pause()
    }
  }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  // Inject scrollbar-hide CSS
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = `
      @keyframes pulse-live { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
      .timeline-scroll::-webkit-scrollbar { display: none }
      .timeline-scroll { scrollbar-width: none; }
    `
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  }, [])

  // Flash on liveIndex change
  useEffect(() => {
    if (isFirstLiveRef.current) {
      isFirstLiveRef.current = false
      return
    }
    if (liveIndex === null) return
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 350)
    return () => clearTimeout(t)
  }, [liveIndex])

  // Flash on selectedShotId change (edit mode clip selection)
  useEffect(() => {
    if (isFirstSelectedRef.current) {
      isFirstSelectedRef.current = false
      return
    }
    if (selectedShotId === null) return
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 350)
    return () => clearTimeout(t)
  }, [selectedShotId])

  // Auto-select shot under playhead during edit-mode playback.
  // Keyed on the shot the playhead is inside rather than on playheadMs, so this
  // re-runs when the playhead crosses a boundary instead of on every commit.
  const shotIdUnderPlayhead = shotIdAtMs(shots, playheadMs)
  useEffect(() => {
    if (!isPlaying || running) return
    if (shotIdUnderPlayhead !== null && shotIdUnderPlayhead !== prevAutoShotIdRef.current) {
      prevAutoShotIdRef.current = shotIdUnderPlayhead
      onShotClick(shotIdUnderPlayhead)
    }
  }, [shotIdUnderPlayhead, isPlaying, running, onShotClick])

  // Decode waveform when media file changes
  useEffect(() => {
    if (!rundownMedia?.filePath) {
      setWaveformData(null)
      setMediaDurationMs(0)
      setWaveformError(null)
      setMediaFileNotFound(false)
      return
    }
    setWaveformError(null)
    setMediaFileNotFound(false)
    let cancelled = false

    async function decode(): Promise<void> {
      // Check file exists before attempting to load
      const exists = await window.api.mediaFileExists(rundownMedia!.filePath)
      if (!exists) {
        if (!cancelled) setMediaFileNotFound(true)
        return
      }

      // Create audio playback element immediately (before waveform decode) so play() is ready
      const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.avi', '.mkv']
      const isVideoFile = VIDEO_EXTS.some((ext) =>
        rundownMedia!.filePath.toLowerCase().endsWith(ext),
      )
      if (!isVideoFile) {
        audioPlayRef.current?.pause()
        const audioSrc = toMediaUrl(rundownMedia!.filePath)
        const audio = new Audio(audioSrc)
        audio.preload = 'auto'
        audioPlayRef.current = audio
        // This element is created after the transport effect has already run for
        // this file, so if playback is underway nothing else will start it.
        if (isPlayingRef.current && !runningRef.current) playhead.playEdit()
      }

      // Peaks remembered from a previous load of this exact file. Decoding is the
      // expensive part — the whole container buffered and decoded — so a hit here
      // is the difference between a multi-second freeze and an instant lane.
      try {
        const cached = await window.api.mediaPeaks.get({
          filePath: rundownMedia!.filePath,
          version: WAVEFORM_VERSION,
        })
        if (cancelled) return
        if (cached) {
          setMediaDurationMs(cached.durationMs)
          setWaveformData(cached.peaks)
          return
        }
      } catch (err) {
        // A cache miss and a broken cache must look the same: carry on and decode.
        console.error('[TimelineEditor] peaks cache read failed:', err)
        if (cancelled) return
      }

      try {
        // Stream the bytes through the media:// protocol rather than pulling the
        // whole file across IPC — a multi-GB video would otherwise be structured-
        // cloned into the renderer and copied again before decoding.
        const response = await fetch(toMediaUrl(rundownMedia!.filePath))
        if (!response.ok) {
          if (!cancelled) setWaveformError(`could not be read (HTTP ${response.status})`)
          return
        }
        const arrayBufferForDecode = await response.arrayBuffer()
        if (cancelled) return

        // Decoding through an OfflineAudioContext resamples to its sample rate,
        // so we decode at WAVEFORM_SAMPLE_RATE instead of the file's full rate.
        const audioCtx = new OfflineAudioContext(1, 1, WAVEFORM_SAMPLE_RATE)
        let audioBuffer: AudioBuffer
        try {
          audioBuffer = await audioCtx.decodeAudioData(arrayBufferForDecode)
        } catch (decodeErr) {
          console.error('[TimelineEditor] decodeAudioData error:', decodeErr)
          // The only failure that really does mean the format: the bytes arrived
          // and Chromium would not decode them.
          if (!cancelled) setWaveformError(describeDecodeFailure(decodeErr))
          return
        }
        if (cancelled) return

        setMediaDurationMs(audioBuffer.duration * 1000)

        const channelData = audioBuffer.getChannelData(0)
        const totalSamples = channelData.length
        const numBuckets = Math.max(
          1,
          Math.min(Math.ceil(audioBuffer.duration * PEAKS_PER_SECOND), MAX_WAVEFORM_BUCKETS),
        )
        const bucketSize = Math.max(1, Math.floor(totalSamples / numBuckets))
        const peaks: number[] = []
        for (let i = 0; i < numBuckets; i++) {
          let max = 0
          for (let j = i * bucketSize; j < Math.min((i + 1) * bucketSize, totalSamples); j++) {
            max = Math.max(max, Math.abs(channelData[j]))
          }
          peaks.push(roundPeak(max))
        }
        if (cancelled) return
        setWaveformData(peaks)
        // Remember them so the next load of this file skips all of the above.
        void window.api.mediaPeaks
          .put({
            filePath: rundownMedia!.filePath,
            version: WAVEFORM_VERSION,
            peaks,
            durationMs: audioBuffer.duration * 1000,
          })
          .catch((err: unknown) => {
            console.error('[TimelineEditor] peaks cache write failed:', err)
          })
      } catch (err) {
        console.error('[TimelineEditor] waveform decode error:', err)
        if (!cancelled) setWaveformError(describeDecodeFailure(err))
      }
    }
    void decode()
    return () => {
      cancelled = true
      if (audioPlayRef.current) {
        audioPlayRef.current.pause()
        audioPlayRef.current = null
      }
    }
  }, [rundownMedia?.filePath]) // eslint-disable-line react-hooks/exhaustive-deps

  const waveformSvgWidth = pxAtMs(mediaDurationMs, zoomPxPerSec)
  const waveformPath = useMemo(
    () => buildWaveformPath(waveformData, waveformSvgWidth, MEDIA_ROW_HEIGHT / 2),
    [waveformData, waveformSvgWidth],
  )

  // Off unless switched on from the console; see playback-probe.ts. Counting in
  // the render body is deliberate — it is the only place that sees every render —
  // so under StrictMode's double render in dev the rate reads 2x.
  const probe = usePlaybackProbe(isPlaying, getMediaEl)
  probe.countRender()

  /**
   * Where the playhead is, what moves it, and when it paints rather than commits.
   *
   * Built once and fed the values that change through `setGeometry` and
   * `setWidths`, never rebuilt: the loop inside it has to survive a zoom step, a
   * Shot edit and Reference media appearing mid-playback without restarting or
   * moving its origin, and rebuilding it is exactly what used to break that.
   * `isPlaying` stays here — a glyph, several disabled buttons and two effects
   * read it — and everything else about the playhead lives in playhead.ts.
   */
  const playheadRef = useRef<Playhead | null>(null)
  if (playheadRef.current === null) {
    playheadRef.current = createPlayhead({
      now: () => performance.now(),
      scheduleFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
      targets: {
        readout: () => playheadTimeElRef.current,
        overviewMarker: () => overviewPlayheadElRef.current,
        viewportRect: () => viewportRectElRef.current,
        scroller: () => scrollContainerRef.current,
      },
      media: {
        currentTimeSec: () => getMediaEl()?.currentTime ?? null,
        // Null unless there is both a file on the timeline and an element playing
        // it: a media clock the module can see but not drive would freeze the
        // playhead at the offset.
        offsetMs: () =>
          getMediaEl() !== null && rundownMediaRef.current !== null
            ? rundownMediaRef.current.offsetMs
            : null,
        play: () => {
          const el = getMediaEl()
          if (!el) return
          void el.play().catch((err: unknown) => {
            console.error('[TimelineEditor] play() failed:', err)
          })
        },
        pause: () => {
          getMediaEl()?.pause()
        },
        seekSec: (sec) => {
          const el = getMediaEl()
          if (el) el.currentTime = sec
        },
      },
      formatPosition: formatPlayhead,
      onCommitPosition: setPlayheadMs,
      onCommitScrollLeft: setCurrentScrollLeft,
      onEditEnded: () => setIsPlaying(false),
      onFrame: () => probe.countFrame(),
      commitIntervalMs: PLAYHEAD_COMMIT_INTERVAL_MS,
    })
  }
  const playhead = playheadRef.current

  const totalMs = useMemo(() => totalDurationMs(shots), [shots])
  const totalPx = useMemo(
    () => Math.max(pxAtMs(totalMs, zoomPxPerSec), 300),
    [totalMs, zoomPxPerSec],
  )
  // Mirrored into the playhead so its per-frame path never measures anything.
  playhead.setGeometry({ totalMs, totalPx, zoomPxPerSec })

  // Edit-mode transport. Deps are only what starts and stops playback: everything
  // the loop reads that can change while it runs comes through the mirrors above,
  // because re-running this effect would cancel the loop and reset its origin on
  // every zoom step and every Shot edit.
  //
  // Pausing on stop is `stopEdit`'s job through the media port; the `running`
  // effect pauses on going live.
  useEffect(() => {
    if (!isPlaying || running) return
    playhead.playEdit()
    return () => playhead.stopEdit()
  }, [isPlaying, running]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Starts Reference media that appeared or changed while playback was underway.
   *
   * Deliberately a second effect: putting the media path in the transport effect's
   * deps would restart the loop, and `playEdit` on an already-running loop only
   * re-issues `play()`. It has to be told, though — `editPlayheadMs` treats a media
   * clock as authoritative the moment one exists, so media attached mid-playback
   * hands it a clock sitting at zero and, with nothing starting that element, the
   * playhead freezes at the media offset.
   *
   * Keyed on the path rather than on `rundownMedia`, so dragging the offset — which
   * changes the object on every mousemove — does not touch playback.
   */
  useEffect(() => {
    if (!isPlaying || running) return
    playhead.playEdit()
  }, [rundownMedia?.filePath, isPlaying, running]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live-mode loop. One run per live Shot.
  useEffect(() => {
    if (!running || liveIndex === null || startedAt === null) return
    // The Shot's start and duration are resolved here rather than per frame:
    // computing the start in the tick allocated a slice and re-summed every
    // preceding Shot 60 times a second.
    playhead.runLive({
      startMs: shotStartMs(shots, liveIndex),
      durationMs: shots[liveIndex]?.durationMs ?? 0,
      startedAt,
    })
    return () => playhead.stopLive()
    // `zoomPxPerSec` and `totalMs` are deliberately absent for the same reason as
    // above: the loop reads both through the mirrors, and listing them here would
    // restart it on every zoom step during a Live session.
  }, [running, liveIndex, startedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // When liveIndex changes, scroll to the new shot's start position
  useEffect(() => {
    if (!running || liveIndex === null) return
    playhead.bringIntoView(shotStartMs(shots, liveIndex))
  }, [liveIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll sync for the overview. Whether an event is the operator's or the echo
  // of our own auto-scroll is the playhead's call; all this decides is whether the
  // operator's scroll is allowed to drag the playhead, which it is not while
  // something else owns it.
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    function onScroll(): void {
      if (!el) return
      const ownsPlayhead = isPlayingRef.current || runningRef.current || grabOwnsPlayheadRef.current
      playhead.handleScroll(el.scrollLeft, !ownsPlayhead)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // `playhead` is built once and never replaced, so listing it re-runs nothing.
  }, [playhead])

  useLayoutEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const overview = overviewRef.current

    // The single place either width is read. Everything else — the playhead's
    // per-frame paint path and the render body alike — uses these mirrors.
    function measure(): void {
      if (el) {
        playhead.setWidths({ scrollerPx: el.clientWidth })
        setContainerWidth(el.clientWidth)
      }
      if (overview) {
        playhead.setWidths({ overviewPx: overview.clientWidth })
        setOverviewWidth(overview.clientWidth)
      }
    }

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (overview) ro.observe(overview)
    measure()
    return () => ro.disconnect()
  }, [playhead])

  // The overview marker's position is painted, not rendered, so React will not
  // reposition it when the geometry it is derived from changes. Repaint on the
  // two inputs that matter, and on mount.
  useEffect(() => {
    playhead.repaint()
  }, [totalMs, overviewWidth]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    function onWheel(e: WheelEvent): void {
      if (isPlayingRef.current || runningRef.current) e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  /** Scrolls the timeline, clamped at zero. Stable, so the overview can memoise. */
  const scrollTimelineTo = useCallback((scrollLeftPx: number): void => {
    const el = scrollContainerRef.current
    if (el) el.scrollLeft = Math.max(0, scrollLeftPx)
  }, [])

  const readScrollLeft = useCallback((): number => scrollContainerRef.current?.scrollLeft ?? 0, [])

  function getMediaEl(): HTMLVideoElement | HTMLAudioElement | null {
    return (mediaVideoRef.current as HTMLVideoElement | null) ?? audioPlayRef.current
  }

  function zoomIn(): void {
    setZoomPxPerSec((z) => Math.min(2000, Math.round(z * 1.4)))
  }
  function zoomOut(): void {
    setZoomPxPerSec((z) => Math.max(5, Math.round(z / 1.4)))
  }

  /**
   * Puts the Playhead somewhere for a discrete interaction: a click, an arrow key,
   * a scrub. Seeking the Reference media is skipped while playback owns it, which
   * would otherwise fight the loop for the media's clock.
   */
  function placePlayhead(ms: number): void {
    playhead.moveTo(ms)
    if (!isPlayingRef.current) playhead.seekMedia(ms)
  }

  function movePlayhead(deltaMs: number): void {
    placePlayhead(scrubPlayhead({ origMs: playhead.positionMs(), totalMs }, deltaMs).positionMs)
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return

      if (e.code === 'Space' && !running) {
        e.preventDefault()
        setIsPlaying((prev) => {
          // Only stopping is handled here. Starting is the transport effect's
          // job: `playEdit` takes the playback origin there, at the moment the
          // loop actually begins, rather than leaving a stamp here to go stale.
          if (prev) {
            getMediaEl()?.pause()
            playhead.seekMedia(playhead.positionMs())
          }
          return !prev
        })
      }
      if (e.code === 'ArrowLeft') {
        e.preventDefault()
        movePlayhead(e.shiftKey ? -10000 : -1000)
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault()
        movePlayhead(e.shiftKey ? 10000 : 1000)
      }
      if (e.code === 'KeyM' && !running) {
        onAddMarkerRef.current?.(playhead.positionMs())
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        zoomIn()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault()
        zoomOut()
      }
      // Lyrics are authored in both Kinds, so In and Out cannot use I and O:
      // those two letters are Part assignment keys in a Voice-over Rundown.
      if (e.key === '[' && !running) {
        e.preventDefault()
        keyActionsRef.current.setLyricIn()
      }
      if (e.key === ']' && !running) {
        e.preventDefault()
        keyActionsRef.current.setLyricOut()
      }
      // Naming a Part mid-authoring, without leaving the timeline. Claimed
      // only in a Voice-over Rundown — `openAddPart` is a no-op otherwise — so
      // a Camera Rundown keeps N free.
      // Modified keys belong to the OS and the browser. The Part keymap claims
      // q w e r t y u i o p, so without this Cmd+Q, Cmd+W, Cmd+R, Cmd+T and
      // Cmd+P each split the Call under the playhead on their way to quitting,
      // closing, reloading or printing.
      const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey

      if (plainKey && e.key.toLowerCase() === ADD_PART_KEY && !running && isVoiceRef.current) {
        e.preventDefault()
        keyActionsRef.current.openAddPart()
      }

      if (plainKey && !running) {
        if (isVoiceRef.current) {
          // A Voice-over Rundown has no Cameras to fall back to. An unmapped
          // key — 5 with three Parts in scope, or anything at all right after a
          // conversion — is inert rather than stamping a Camera on a Call.
          keyActionsRef.current.assignPartByKey(e.key)
        } else {
          const num = parseInt(e.key, 10)
          if (num >= 1 && num <= 9) {
            const cam = camerasRef.current.find((c) => c.number === num)
            if (cam) handleCamButtonClick(cam)
          }
        }
      }
      if ((e.key === 'l' || e.key === 'L') && !running) {
        e.preventDefault()
        // Use selected shot, or fall back to shot under playhead
        const shotId =
          selectedShotIdRef.current ?? shotIdAtMs(shotsRef.current, playhead.positionMs())
        if (shotId) {
          // Stop playback so the label input can retain focus
          setIsPlaying((prev) => {
            if (prev) getMediaEl()?.pause()
            return false
          })
          onShotClick(shotId)
          onLabelEditRef.current?.(shotId)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    placePlayhead(timelinePosMs(e.clientX, rect.left, zoomPxPerSec, totalMs))
  }

  function handleBlockClick(e: React.MouseEvent, shotId: string): void {
    e.stopPropagation()
    onShotClick(shotId)
  }

  function handleCamButtonClick(camera: Camera): void {
    const positionMs = playhead.positionMs()
    let accumulated = 0
    for (const shot of shotsRef.current) {
      const shotStart = accumulated
      const shotEnd = accumulated + shot.durationMs
      if (positionMs >= shotStart && positionMs < shotEnd) {
        const atMs = positionMs - shotStart
        onSplitShot(shot.id, atMs, camera.id)
        return
      }
      accumulated = shotEnd
    }
  }

  /**
   * Splits at the playhead and points what follows at a Part.
   *
   * Deliberately the same two moves the Camera buttons make — split, or retarget
   * when the playhead is already on a boundary — with `partId` in place of
   * `cameraId`. Everything else about a Call, resizing and reordering included,
   * is the Shot code path untouched.
   */
  function assignPartAtPlayhead(part: Part): void {
    const positionMs = playhead.positionMs()
    let accumulated = 0
    for (const shot of shotsRef.current) {
      const shotEnd = accumulated + shot.durationMs
      if (positionMs >= accumulated && positionMs < shotEnd) {
        // Rounded before the comparison: a playhead a fraction of a millisecond
        // into a Call would otherwise take the split branch and then round to
        // 0, which splitShot rejects outright.
        const atMs = Math.round(positionMs - accumulated)
        const assigned =
          atMs <= 0
            ? editShot({ id: shot.id, partId: part.id })
            : splitShot(shot.id, atMs, { newPartId: part.id })
        assigned.catch((err: unknown) => console.error('[TimelineEditor] assign part:', err))
        return
      }
      accumulated = shotEnd
    }
  }

  /**
   * Writes a line, reporting a refusal instead of swallowing it.
   *
   * The overlap check runs here too even though the store refuses overlaps: the
   * local copy already knows which line is in the way, and naming it is more use
   * to the operator than the round trip's "overlaps an existing line".
   */
  async function saveLyric(input: LyricDraft): Promise<boolean> {
    if (activeRundownId === null) return false
    const clash = overlappingLyric(lyrics, input, input.id)
    if (clash !== null) {
      setLyricError(`Overlaps “${clash.text}”`)
      return false
    }
    try {
      await upsertLyric({
        ...(input.id !== null ? { id: input.id } : {}),
        rundownId: activeRundownId,
        startMs: input.startMs,
        endMs: input.endMs,
        text: input.text,
      })
      setLyricError(null)
      return true
    } catch (err: unknown) {
      setLyricError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  /**
   * Set In: moves the selected line's start, or opens a new line at the playhead.
   *
   * One key does both because the authoring loop is the same either way — put the
   * playhead where the line begins and press In — and the operator should not
   * have to know whether they are correcting or creating.
   */
  function setLyricIn(): void {
    const ms = Math.round(playhead.positionMs())
    const selected = lyrics.find((l) => l.id === selectedLyricId)
    if (selected !== undefined) {
      const range = lyricRange(ms, selected.endMs)
      if (range === null) {
        setLyricError('That would leave the line no length')
        return
      }
      void saveLyric({ id: selected.id, ...range, text: selected.text })
      return
    }
    setLyricError(null)
    setLyricInMs(ms)
  }

  /** Set Out: closes the selected line, or the line being authored. */
  function setLyricOut(): void {
    const ms = Math.round(playhead.positionMs())
    const selected = lyrics.find((l) => l.id === selectedLyricId)
    if (selected !== undefined) {
      const range = lyricRange(selected.startMs, ms)
      if (range === null) {
        setLyricError('That would leave the line no length')
        return
      }
      void saveLyric({ id: selected.id, ...range, text: selected.text })
      return
    }
    if (lyricInMs === null) {
      setLyricError('Set an In point first')
      return
    }
    const range = lyricRange(lyricInMs, ms)
    if (range === null) {
      setLyricError('Set the Out point away from the In point')
      return
    }
    const clash = overlappingLyric(lyrics, range)
    if (clash !== null) {
      setLyricError(`Overlaps “${clash.text}”`)
      return
    }
    setLyricError(null)
    setLyricDraft({ id: null, ...range, text: '' })
  }

  /** Commits the typed line, keeping the draft on screen if it is refused. */
  function commitLyricDraft(): void {
    const draft = lyricDraft
    if (draft === null) return
    const text = draft.text.trim()
    if (text === '') {
      setLyricError('A line needs some text')
      return
    }
    void saveLyric({ ...draft, text }).then((saved) => {
      if (!saved) return
      setLyricDraft(null)
      setLyricInMs(null)
      setSelectedLyricId(null)
    })
  }

  /**
   * Drags one edge of a Lyric.
   *
   * The lane element is the coordinate frame, not the block: the pointer
   * routinely leaves the block it is resizing, and measuring against the block
   * would make the line chase the cursor.
   */
  function beginLyricResize(e: React.MouseEvent, id: string, edge: 'start' | 'end'): void {
    e.stopPropagation()
    e.preventDefault()
    const lane = (e.currentTarget as HTMLElement).closest('[data-lyrics-lane]')
    if (!(lane instanceof HTMLElement)) return
    const laneLeft = lane.getBoundingClientRect().left

    setSelectedLyricId(id)
    setLyricError(null)

    beginGrab(e, {
      resolve: (sample) =>
        resizeLyric(
          lyricsRef.current,
          id,
          edge,
          timelinePosMs(sample.clientX, laneLeft, zoomRef.current, Number.MAX_SAFE_INTEGER),
        ),
      // Shown immediately, saved once: a write per mousemove would be a
      // transaction per pixel, and the store rejects overlaps anyway.
      preview: (next) => setLyricDragOverride({ id, ...next }),
      // Commit what the last move showed, and nothing at all if there was none: a
      // bare click on an edge handle must not write.
      commitOn: 'move',
      commit: (next) => {
        const existing = lyricsRef.current.find((l) => l.id === id)
        if (existing === undefined) return
        void saveLyric({ id, ...next, text: existing.text })
      },
      end: () => setLyricDragOverride(null),
    })
  }

  function deleteLyric(id: string): void {
    removeLyric(id).catch((err: unknown) => console.error('[TimelineEditor] deleteLyric:', err))
    if (selectedLyricId === id) setSelectedLyricId(null)
  }

  // Stable identity so ItemLane can memoise, current logic through a ref so no
  // dependency list has to be kept in step with handlers that close over most of
  // this component. Same pattern as keyActionsRef below.
  const itemLaneCallbacksRef = useRef<ItemLaneHandlers>({
    onTrackClick: () => {},
    onBlockClick: () => {},
    onOpenContextMenu: () => {},
    onBoundaryMouseDown: () => {},
    onExtendMouseDown: () => {},
  })
  itemLaneCallbacksRef.current = {
    onTrackClick: (e) => handleTrackClick(e as React.MouseEvent<HTMLDivElement>),
    onBlockClick: (e, shotId) => handleBlockClick(e, shotId),
    onOpenContextMenu: (x, y, shotId) => setContextMenu({ x, y, shotId }),
    onBoundaryMouseDown: (e, shot, nextShot) => handleBoundaryMouseDown(e, shot, nextShot),
    onExtendMouseDown: (e, shot, durationMs) => handleExtendMouseDown(e, shot, durationMs),
  }
  const itemLaneHandlers = useMemo<ItemLaneHandlers>(
    () => ({
      onTrackClick: (e) => itemLaneCallbacksRef.current.onTrackClick(e),
      onBlockClick: (e, shotId) => itemLaneCallbacksRef.current.onBlockClick(e, shotId),
      onOpenContextMenu: (x, y, shotId) =>
        itemLaneCallbacksRef.current.onOpenContextMenu(x, y, shotId),
      onBoundaryMouseDown: (e, shot, nextShot) =>
        itemLaneCallbacksRef.current.onBoundaryMouseDown(e, shot, nextShot),
      onExtendMouseDown: (e, shot, durationMs) =>
        itemLaneCallbacksRef.current.onExtendMouseDown(e, shot, durationMs),
    }),
    [],
  )

  const mediaLaneCallbacksRef = useRef({
    onTrackMouseDown: (_e: React.MouseEvent) => {},
    onImportMedia: () => {},
    onClearMedia: () => {},
  })
  mediaLaneCallbacksRef.current = {
    onTrackMouseDown: (e) => handleMediaTrackMouseDown(e as React.MouseEvent<HTMLDivElement>),
    onImportMedia,
    onClearMedia,
  }
  const mediaLaneHandlers = useMemo(
    () => ({
      onTrackMouseDown: (e: React.MouseEvent) => mediaLaneCallbacksRef.current.onTrackMouseDown(e),
      onImportMedia: () => mediaLaneCallbacksRef.current.onImportMedia(),
      onClearMedia: () => mediaLaneCallbacksRef.current.onClearMedia(),
    }),
    [],
  )

  keyActionsRef.current = {
    setLyricIn,
    setLyricOut,
    openAddPart: () => {
      if (isVoice) setAddPartOpen(true)
    },
    assignPartByKey: (key) => {
      if (!isVoice) return false
      const part = partForKey(key, partsInScope)
      if (part === null) return false
      assignPartAtPlayhead(part)
      return true
    },
  }

  /**
   * The one place on the timeline where a pointer becomes a drag.
   *
   * Six interactions — the boundary between two Shots, the last item's trailing
   * edge, a Marker, the Reference media offset, the Playhead and a Lyric edge —
   * each installed their own `mousedown` → window `mousemove` → window `mouseup`
   * sequence, and each re-derived the same conversion and clamped it inline. This
   * is that sequence once; what each grab actually means is a resolver in
   * `timeline/grab`, and nothing below here touches a `MouseEvent` or a listener.
   *
   * Release is treated as one more pointer reading, so the clamp that drew the
   * preview is the same call that produces the committed value. That is the point:
   * the boundary drag used to clamp twice, in two spellings, and they disagreed.
   */
  function beginGrab<P>(e: React.MouseEvent, spec: GrabSpec<P>): void {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    if (spec.ownsPlayhead === true) grabOwnsPlayheadRef.current = true

    let latest: P | null = null

    function sample(ev: MouseEvent): GrabSample {
      return { deltaMs: msAtPx(ev.clientX - startX, zoomRef.current), clientX: ev.clientX }
    }

    function onMouseMove(ev: MouseEvent): void {
      const next = spec.resolve(sample(ev))
      if (next === null) return
      latest = next
      spec.preview(next)
    }

    function onMouseUp(ev: MouseEvent): void {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      grabOwnsPlayheadRef.current = false
      if (spec.commit !== undefined) {
        const committed = spec.commitOn === 'move' ? latest : spec.resolve(sample(ev))
        if (committed !== null) spec.commit(committed)
      }
      spec.end?.()
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  /** Lengthens the final Shot past its current end. Committed on mouse-up. */
  function handleExtendMouseDown(
    e: React.MouseEvent,
    lastShot: Shot,
    currentDurationMs: number,
  ): void {
    beginGrab(e, {
      resolve: ({ deltaMs }) => extendLastItem({ origDurationMs: currentDurationMs }, deltaMs),
      preview: ({ durationMs }) => setDragOverride({ [lastShot.id]: durationMs }),
      commit: ({ durationMs }) => onExtendLastShot(lastShot.id, durationMs),
      // Unlike the boundary drag, the override goes straight away rather than being
      // held until the new `shots` arrive: only one Shot changed, so there is no
      // neighbour for it to disagree with on the way through.
      end: () => setDragOverride({}),
    })
  }

  function handleBoundaryMouseDown(e: React.MouseEvent, shotA: Shot, shotB: Shot): void {
    const grab = { origDurationAMs: shotA.durationMs, origDurationBMs: shotB.durationMs }
    beginGrab(e, {
      resolve: ({ deltaMs }) => resizeShotPair(grab, deltaMs),
      preview: ({ durationAMs, durationBMs }) =>
        setDragOverride({ [shotA.id]: durationAMs, [shotB.id]: durationBMs }),
      commit: ({ durationAMs, durationBMs }) => {
        onResizeShots(shotA.id, durationAMs, shotB.id, durationBMs)
        // Hold the override at the committed values until the new `shots` come
        // back from IPC: clearing it here would flash the old geometry.
        setDragOverride({ [shotA.id]: durationAMs, [shotB.id]: durationBMs })
        pendingDragClearRef.current = true
      },
      ownsPlayhead: true,
    })
  }

  function handleMarkerTrackDblClick(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    // Markers may sit past the last shot, so they are not clamped to totalMs.
    const posMs = Math.round(
      timelinePosMs(e.clientX, rect.left, zoomPxPerSec, Number.MAX_SAFE_INTEGER),
    )
    onAddMarker(posMs)
  }

  function handleMarkerMouseDown(e: React.MouseEvent, marker: Marker): void {
    const grab = { origPositionMs: marker.positionMs }
    beginGrab(e, {
      // No ceiling, deliberately: see `moveMarker`. A Marker may be dragged past
      // the last Shot, which the Playhead scrub may not.
      resolve: ({ deltaMs }) => moveMarker(grab, deltaMs),
      preview: ({ positionMs }) => setMarkerDragOverride({ [marker.id]: positionMs }),
      commit: ({ positionMs }) => onUpdateMarker(marker.id, positionMs),
      end: () => setMarkerDragOverride({}),
      ownsPlayhead: true,
    })
  }

  function handleMarkerLabelClick(e: React.MouseEvent, marker: Marker): void {
    e.stopPropagation()
    setEditingMarkerId(marker.id)
    setEditingMarkerLabel(marker.label ?? '')
  }

  function handleMarkerLabelSave(marker: Marker): void {
    const trimmed = editingMarkerLabel.trim() || null
    // One write, through the one Marker seam: a second write straight to
    // `window.api` raced this one and carried the pre-drag position, so labelling
    // a Marker just after dragging it could put the Marker back where it was.
    if (trimmed !== marker.label) {
      onUpdateMarker(marker.id, markerDragOverride[marker.id] ?? marker.positionMs, trimmed)
    }
    setEditingMarkerId(null)
  }

  function handleMediaTrackMouseDown(e: React.MouseEvent): void {
    if (!rundownMedia) return
    const grab = { origOffsetMs: rundownMedia.offsetMs }
    beginGrab(e, {
      resolve: ({ deltaMs }) => alignReferenceMedia(grab, deltaMs),
      preview: ({ offsetMs }) => setMediaOffsetOverride(offsetMs),
      commit: ({ offsetMs }) => onUpdateMediaOffset(offsetMs),
      end: () => setMediaOffsetOverride(null),
      ownsPlayhead: true,
    })
  }

  function handlePlayheadDragMouseDown(e: React.MouseEvent): void {
    const grab = { origMs: playheadMs, totalMs }
    beginGrab(e, {
      resolve: ({ deltaMs }) => scrubPlayhead(grab, deltaMs),
      // The odd one out in two ways, both deliberate. There is nothing to commit —
      // the Playhead is not stored — and the preview is the move: the resolver says
      // where, and the Playhead module is what gets told, so it can seek the
      // Reference media and pull the view along as it does for every other jump.
      preview: ({ positionMs }) => placePlayhead(positionMs),
    })
  }

  // Tick marks for the ruler. An hour-long Rundown is 727 of these, and they
  // depend on nothing that changes while the playhead moves.
  const ticks = useMemo(() => {
    const out: { px: number; major: boolean; label?: string }[] = []
    const minorIntervalMs = 5000
    const majorIntervalMs = 30000
    const endMs = totalMs + majorIntervalMs
    for (let ms = 0; ms <= endMs; ms += minorIntervalMs) {
      const px = pxAtMs(ms, zoomPxPerSec)
      const major = ms % majorIntervalMs === 0
      out.push({ px, major, label: major ? formatTime(ms) : undefined })
    }
    return out
  }, [totalMs, zoomPxPerSec])

  const targetById = useMemo(
    () => targetsById(targetsOf(rundownKind, cameras, partsInScope)),
    [rundownKind, cameras, partsInScope],
  )

  const UNASSIGNED_COLOR = '#3a3a3a'

  /**
   * How an item paints: a Call reads its Part exactly as a Shot reads its
   * Camera, so the lane never has to know which Kind it is showing beyond this.
   * An unassigned item is drawn as its own thing rather than in a default
   * colour, because a Live session refuses to start on one and the operator
   * should see that here rather than when they press start.
   */
  const itemTargets = useMemo(() => {
    const noun = targetNoun(rundownKind)
    const byId = new Map<string, { color: string; label: string; title: string }>()
    for (const shot of shots) {
      if (isUnassigned(shot, rundownKind)) {
        byId.set(shot.id, {
          color: UNASSIGNED_COLOR,
          label: `No ${noun.toLowerCase()}`,
          title: `No ${noun} assigned — a Live session will refuse to start`,
        })
        continue
      }

      const target = targetOf(shot, rundownKind, targetById)
      // Resolving to nothing here does not mean unassigned — that was ruled out
      // above. It is a Part outside this Rundown's scope, which is still a real
      // assignment (ADR 0006); only its name and colour are unavailable.
      if (!target) {
        byId.set(shot.id, {
          color: '#666',
          label: noun,
          title: `${noun} from another scope (${shot.durationMs}ms)`,
        })
        continue
      }
      byId.set(shot.id, {
        color: target.color,
        label: isVoice ? target.name : target.badge,
        title: `${target.name} (${shot.durationMs}ms)`,
      })
    }
    return byId
  }, [shots, rundownKind, targetById, isVoice])

  const announcementProblems = useMemo(
    () =>
      isVoice && announcementSettings
        ? announcementProblemsByCallId(
            shots,
            (partId) => phraseDurationMsByPartId[partId] ?? null,
            announcementSettings,
          )
        : new Map<string, AnnouncementProblem>(),
    [isVoice, shots, phraseDurationMsByPartId, announcementSettings],
  )

  const announcementProblemSummary = useMemo(
    () => announcementProblemLabel(announcementProblems),
    [announcementProblems],
  )

  // The dragged line is drawn where the pointer is, not where it is stored.
  const lyricsForLane = useMemo(
    () =>
      lyricDragOverride === null
        ? lyrics
        : lyrics.map((l) =>
            l.id === lyricDragOverride.id
              ? { ...l, startMs: lyricDragOverride.startMs, endMs: lyricDragOverride.endMs }
              : l,
          ),
    [lyrics, lyricDragOverride],
  )
  const lyricLane = useMemo(
    () => lyricBlocks(lyricsForLane, zoomPxPerSec),
    [lyricsForLane, zoomPxPerSec],
  )
  // The whole point of the lane: which line is being sung right now. The playhead
  // is committed to state at PLAYHEAD_COMMIT_INTERVAL_MS, so this lags by at most
  // that — far below the length of a sung line.
  const currentLyricId = lyricAtMs(lyrics, playheadMs)?.id ?? null

  // Shot left offsets, honouring any resize drag in progress
  const shotOffsets = useMemo(
    () => shotStartOffsetsMs(shots, dragOverride).map((ms) => pxAtMs(ms, zoomPxPerSec)),
    [shots, dragOverride, zoomPxPerSec],
  )

  const sortedCameras = useMemo(() => [...cameras].sort((a, b) => a.number - b.number), [cameras])

  const btnStyle: React.CSSProperties = {
    background: '#333',
    border: '1px solid #444',
    borderRadius: '3px',
    color: '#ccc',
    fontSize: '14px',
    width: '24px',
    height: '22px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  }

  return (
    <div
      style={{
        background: '#1a1a1a',
        borderTop: '1px solid #2a2a2a',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        height: `${TOOLBAR_HEIGHT + RULER_HEIGHT + TRACK_HEIGHT + LYRICS_ROW_HEIGHT + MARKER_ROW_HEIGHT + MEDIA_ROW_HEIGHT + CAM_BUTTONS_HEIGHT + OVERVIEW_HEIGHT}px`,
        overflow: 'hidden',
      }}
      onClick={() => setContextMenu(null)}
    >
      {/* Row 1: Toolbar */}
      <div
        style={{
          height: TOOLBAR_HEIGHT,
          background: flash ? '#555' : '#252525',
          transition: 'background 0.35s ease-out',
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          gap: '6px',
          flexShrink: 0,
          borderBottom: '1px solid #333',
        }}
      >
        {/* Play/Pause */}
        <button
          style={{ ...btnStyle, width: '28px', opacity: running ? 0.4 : 1 }}
          disabled={running}
          onClick={() => {
            if (isPlaying) {
              setIsPlaying(false)
              getMediaEl()?.pause()
              playhead.seekMedia(playhead.positionMs())
            } else {
              // The transport effect takes the origin and starts the media.
              setIsPlaying(true)
            }
          }}
          title="Play/Pause (Space)"
        >
          {isPlaying ? '⏸' : '▶'}
        </button>

        {/* Step back/forward */}
        <button style={btnStyle} onClick={() => movePlayhead(-1000)} title="Step back 1s (←)">
          ◀
        </button>
        <button style={btnStyle} onClick={() => movePlayhead(1000)} title="Step forward 1s (→)">
          ▶
        </button>

        {/* Playhead time */}
        <span
          ref={playheadTimeElRef}
          style={{
            color: '#ccc',
            fontSize: '11px',
            fontFamily: 'monospace',
            minWidth: '48px',
            textAlign: 'center',
          }}
        >
          {formatPlayhead(playheadMs)}
        </span>

        {/* Zoom out */}
        <button style={btnStyle} onClick={zoomOut} title="Zoom out (Ctrl/Cmd -)">
          −
        </button>
        {/* Zoom in */}
        <button style={btnStyle} onClick={zoomIn} title="Zoom in (Ctrl/Cmd +)">
          +
        </button>
        <span style={{ color: '#888', fontSize: '11px', minWidth: '52px', textAlign: 'center' }}>
          {zoomPxPerSec}px/s
        </span>
        {/* Lyrics authoring: set In, play, set Out, type the line */}
        <button
          style={{
            ...btnStyle,
            width: 'auto',
            padding: '0 6px',
            opacity: running ? 0.4 : 1,
            color: lyricInMs !== null ? '#5dade2' : '#ccc',
          }}
          disabled={running}
          onClick={setLyricIn}
          title="Lyric In point at the playhead ([)"
        >
          In [
        </button>
        <button
          style={{ ...btnStyle, width: 'auto', padding: '0 6px', opacity: running ? 0.4 : 1 }}
          disabled={running}
          onClick={setLyricOut}
          title="Lyric Out point at the playhead (])"
        >
          Out ]
        </button>
        {lyricError !== null && (
          <span
            style={{ color: '#e74c3c', fontSize: '11px', cursor: 'pointer' }}
            title="Click to dismiss"
            onClick={() => setLyricError(null)}
          >
            {lyricError}
          </span>
        )}
        {/*
          The layer that cannot be missed. Ringing the blocks is only useful to
          someone already looking at them, and a Rundown can be long enough that
          the short Call is scrolled off screen entirely. Clicking selects the
          first one and scrolls it into view.
        */}
        {announcementProblemSummary !== null && (
          <button
            style={{
              background: '#7a2f28',
              border: '1px solid #e74c3c',
              borderRadius: '3px',
              color: '#ffb4ab',
              fontSize: '11px',
              padding: '2px 8px',
              cursor: 'pointer',
              whiteSpace: 'nowrap' as const,
            }}
            title="Jump to the first call whose announcement will not fit"
            onClick={() => {
              const first = shots.find((shot) => announcementProblems.has(shot.id))
              if (first) onShotClick(first.id)
            }}
          >
            ⚠ {announcementProblemSummary}
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button
          style={{
            background: 'none',
            border: '1px solid #444',
            borderRadius: '3px',
            color: '#aaa',
            fontSize: '11px',
            padding: '2px 8px',
            cursor: 'pointer',
          }}
          title="Import reference media file"
          onClick={onImportMedia}
        >
          Import media
        </button>
      </div>

      {/* Scrollable area: ruler + camera track + marker track + media track */}
      <div
        ref={scrollContainerRef}
        className="timeline-scroll"
        style={{
          overflowX: 'auto',
          overflowY: 'hidden',
          flexShrink: 0,
          position: 'relative',
        }}
      >
        {/* Fixed playhead line — at PLAYHEAD_FIXED_PX from left of the outer scrollable div */}
        <div
          style={{
            position: 'sticky',
            left: PLAYHEAD_FIXED_PX,
            top: 0,
            width: 0,
            height: 0,
            pointerEvents: 'none',
            zIndex: 50,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: '2px',
              height: RULER_HEIGHT + TRACK_HEIGHT + LYRICS_ROW_HEIGHT + MARKER_ROW_HEIGHT,
              background: '#e74c3c',
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* Playhead drag triangle */}
        <div
          style={{
            position: 'sticky',
            left: PLAYHEAD_FIXED_PX - 6,
            top: 0,
            width: 0,
            height: 0,
            zIndex: 51,
          }}
        >
          <svg
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 12,
              height: 10,
              cursor: 'grab',
              pointerEvents: 'all',
            }}
            onMouseDown={handlePlayheadDragMouseDown}
          >
            <polygon points="6,10 0,0 12,0" fill="#e74c3c" />
          </svg>
        </div>

        {/* Explicit width = totalPx + containerWidth so max scrollLeft = totalPx (playhead reaches end) */}
        <div style={{ paddingLeft: PLAYHEAD_FIXED_PX, width: totalPx + containerWidth }}>
          {/* Row 2: Time ruler */}
          <RulerLane ticks={ticks} width={totalPx} height={RULER_HEIGHT} />

          {/* Row 3: Camera track */}
          <ItemLane
            shots={shots}
            shotOffsets={shotOffsets}
            dragOverride={dragOverride}
            itemTargets={itemTargets}
            announcementProblems={announcementProblems}
            rundownKind={rundownKind}
            isVoice={isVoice}
            liveIndex={liveIndex}
            zoomPxPerSec={zoomPxPerSec}
            width={totalPx}
            height={TRACK_HEIGHT}
            unassignedColor={UNASSIGNED_COLOR}
            handlers={itemLaneHandlers}
          />

          {/* Row 3b: Lyrics track — the second and only other Track, in both Kinds */}
          <div
            data-lyrics-lane=""
            style={{
              height: LYRICS_ROW_HEIGHT,
              width: totalPx,
              background: '#141414',
              position: 'relative',
              borderTop: '1px solid #2a2a2a',
              cursor: 'crosshair',
              overflow: 'hidden',
            }}
            onClick={(e) => {
              setSelectedLyricId(null)
              handleTrackClick(e)
            }}
          >
            {lyricLane.map((block) => {
              const isSelected = selectedLyricId === block.id
              const isHovered = hoveredLyricId === block.id
              const isCurrent = currentLyricId === block.id
              return (
                <div
                  key={block.id}
                  style={{
                    position: 'absolute',
                    left: block.leftPx,
                    top: 3,
                    width: block.widthPx,
                    height: LYRICS_ROW_HEIGHT - 6,
                    background: isSelected ? '#2e5c8a' : isCurrent ? '#27435f' : '#243447',
                    border: `1px solid ${isSelected || isCurrent ? '#5dade2' : '#31506e'}`,
                    borderRadius: '2px',
                    boxSizing: 'border-box',
                    color: isCurrent ? '#fff' : '#d6e6f5',
                    fontSize: '10px',
                    // Two lines rather than one: a sung line rarely fits the
                    // width its own timing gives it, and an ellipsis hides the
                    // half of the lyric the operator is trying to read.
                    lineHeight: '11px',
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 2,
                    wordBreak: 'break-word',
                    whiteSpace: 'normal',
                    padding: '2px 6px',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                  title={`${block.text} — click to select, double-click to re-word`}
                  onMouseEnter={() => setHoveredLyricId(block.id)}
                  onMouseLeave={() => setHoveredLyricId(null)}
                  onClick={(e) => {
                    e.stopPropagation()
                    setLyricError(null)
                    setSelectedLyricId(isSelected ? null : block.id)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    const existing = lyrics.find((l) => l.id === block.id)
                    if (existing === undefined) return
                    setSelectedLyricId(existing.id)
                    setLyricDraft({
                      id: existing.id,
                      startMs: existing.startMs,
                      endMs: existing.endMs,
                      text: existing.text,
                    })
                  }}
                >
                  {block.text}
                  {(isHovered || isSelected) && !running && (
                    <>
                      <LyricEdgeHandle
                        side="start"
                        onDown={(e) => beginLyricResize(e, block.id, 'start')}
                      />
                      <LyricEdgeHandle
                        side="end"
                        onDown={(e) => beginLyricResize(e, block.id, 'end')}
                      />
                    </>
                  )}
                  {isHovered && (
                    <button
                      style={{
                        position: 'absolute',
                        right: 0,
                        top: 0,
                        background: 'rgba(0,0,0,0.5)',
                        border: 'none',
                        color: '#e74c3c',
                        fontSize: '10px',
                        lineHeight: 1,
                        padding: '2px 4px',
                        cursor: 'pointer',
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteLyric(block.id)
                      }}
                      title="Delete line"
                    >
                      ×
                    </button>
                  )}
                </div>
              )
            })}

            {/* Pending In point: the line has a start but no end yet */}
            {lyricInMs !== null && lyricDraft === null && (
              <div
                style={{
                  position: 'absolute',
                  left: pxAtMs(lyricInMs, zoomPxPerSec),
                  top: 0,
                  width: '2px',
                  height: LYRICS_ROW_HEIGHT,
                  borderLeft: '2px dashed #5dade2',
                  pointerEvents: 'none',
                }}
              />
            )}

            {/* Typing the line, once its in and out points are fixed */}
            {lyricDraft !== null && (
              <input
                autoFocus
                value={lyricDraft.text}
                onChange={(e) => setLyricDraft({ ...lyricDraft, text: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') commitLyricDraft()
                  if (e.key === 'Escape') {
                    setLyricDraft(null)
                    setLyricError(null)
                  }
                }}
                placeholder="line of lyrics"
                style={{
                  position: 'absolute',
                  left: pxAtMs(lyricDraft.startMs, zoomPxPerSec),
                  top: 3,
                  width: Math.max(120, pxAtMs(lyricDraft.endMs - lyricDraft.startMs, zoomPxPerSec)),
                  height: LYRICS_ROW_HEIGHT - 6,
                  background: '#1b2a3a',
                  border: '1px solid #5dade2',
                  color: '#d6e6f5',
                  fontSize: '10px',
                  padding: '0 4px',
                  boxSizing: 'border-box',
                  zIndex: 20,
                }}
              />
            )}

            {lyrics.length === 0 && lyricDraft === null && (
              <span
                style={{
                  position: 'absolute',
                  left: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: '#444',
                  fontSize: '10px',
                  fontFamily: 'monospace',
                  pointerEvents: 'none',
                }}
              >
                Lyrics — set In [ , play, set Out ] , type the line
              </span>
            )}
          </div>

          {/* Row 4: Marker track */}
          <div
            style={{
              height: MARKER_ROW_HEIGHT,
              width: totalPx,
              background: '#1e1e1e',
              position: 'relative',
              borderTop: '1px solid #2a2a2a',
              cursor: 'crosshair',
            }}
            onDoubleClick={handleMarkerTrackDblClick}
          >
            {markers.map((marker) => {
              const effectivePositionMs = markerDragOverride[marker.id] ?? marker.positionMs
              const leftPx = pxAtMs(effectivePositionMs, zoomPxPerSec)
              const isEditing = editingMarkerId === marker.id
              const isHovered = hoveredMarkerId === marker.id

              return (
                <div
                  key={marker.id}
                  style={{
                    position: 'absolute',
                    left: leftPx,
                    top: 0,
                    height: MARKER_ROW_HEIGHT,
                    width: 1,
                    zIndex: 10,
                  }}
                  onMouseEnter={() => setHoveredMarkerId(marker.id)}
                  onMouseLeave={() => setHoveredMarkerId(null)}
                >
                  {/* Dotted vertical line */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: '2px',
                      height: MARKER_ROW_HEIGHT,
                      borderLeft: '2px dashed #f39c12',
                      cursor: 'ew-resize',
                    }}
                    onMouseDown={(e) => handleMarkerMouseDown(e, marker)}
                  />

                  {/* Label / inline edit */}
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editingMarkerLabel}
                      onChange={(e) => setEditingMarkerLabel(e.target.value)}
                      onBlur={() => handleMarkerLabelSave(marker)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleMarkerLabelSave(marker)
                        if (e.key === 'Escape') setEditingMarkerId(null)
                      }}
                      style={{
                        position: 'absolute',
                        left: '4px',
                        top: '2px',
                        width: '80px',
                        fontSize: '9px',
                        background: '#2a2a2a',
                        border: '1px solid #f39c12',
                        color: '#f39c12',
                        padding: '1px 2px',
                        zIndex: 20,
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      style={{
                        position: 'absolute',
                        left: '4px',
                        top: '2px',
                        fontSize: '9px',
                        color: '#f39c12',
                        whiteSpace: 'nowrap',
                        cursor: 'text',
                        userSelect: 'none',
                      }}
                      onClick={(e) => handleMarkerLabelClick(e, marker)}
                    >
                      {marker.label ?? ''}
                    </span>
                  )}

                  {/* Delete button on hover */}
                  {isHovered && !isEditing && (
                    <button
                      style={{
                        position: 'absolute',
                        left: '4px',
                        top: '14px',
                        fontSize: '9px',
                        background: 'none',
                        border: 'none',
                        color: '#f39c12',
                        cursor: 'pointer',
                        padding: 0,
                        lineHeight: 1,
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        onDeleteMarker(marker.id)
                      }}
                      title="Delete marker"
                    >
                      ×
                    </button>
                  )}
                </div>
              )
            })}

            {markers.length === 0 && (
              <span
                style={{
                  position: 'absolute',
                  left: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: '#444',
                  fontSize: '10px',
                  fontFamily: 'monospace',
                  pointerEvents: 'none',
                }}
              >
                double-click to add marker
              </span>
            )}
          </div>

          {/* Row 5: Media track */}
          <MediaLane
            media={rundownMedia}
            offsetOverrideMs={mediaOffsetOverride}
            zoomPxPerSec={zoomPxPerSec}
            width={totalPx}
            height={MEDIA_ROW_HEIGHT}
            waveformPath={waveformPath}
            waveformSvgWidth={waveformSvgWidth}
            waveformData={waveformData}
            waveformError={waveformError}
            mediaFileNotFound={mediaFileNotFound}
            onTrackMouseDown={mediaLaneHandlers.onTrackMouseDown}
            onImportMedia={mediaLaneHandlers.onImportMedia}
            onClearMedia={mediaLaneHandlers.onClearMedia}
          />

          {/* Spacer: ensures the timeline can scroll far enough right for the playhead to reach the end of the last clip */}
          <div style={{ width: totalPx + Math.max(0, containerWidth), height: 0, flexShrink: 0 }} />
        </div>
        {/* end content wrapper */}
      </div>

      {/* Row 6: Mini overview */}
      <OverviewBar
        shots={shots}
        shotOffsets={shotOffsets}
        dragOverride={dragOverride}
        itemTargets={itemTargets}
        zoomPxPerSec={zoomPxPerSec}
        totalPx={totalPx}
        totalMs={totalMs}
        overviewWidth={overviewWidth}
        scrollerWidth={containerWidth}
        scrollLeft={currentScrollLeft}
        height={OVERVIEW_HEIGHT}
        overviewRef={overviewRef}
        playheadElRef={overviewPlayheadElRef}
        viewportRectElRef={viewportRectElRef}
        onScrollTo={scrollTimelineTo}
        readScrollLeft={readScrollLeft}
      />

      {/* Row 7: assignment buttons — Cameras, or Parts in a Voice-over Rundown */}
      <div
        style={{
          height: CAM_BUTTONS_HEIGHT,
          background: '#252525',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          gap: '6px',
          borderTop: '1px solid #2a2a2a',
          overflowX: 'auto',
        }}
      >
        {isVoice && (
          <>
            <PartButtonBar
              parts={partsInScope}
              onAssign={assignPartAtPlayhead}
              activePartId={shots.find((s) => s.id === selectedShotId)?.partId ?? null}
              disabled={running}
              onAddNew={() => setAddPartOpen(true)}
            />
            <button
              style={{
                background: 'none',
                border: '1px solid #555',
                borderRadius: '3px',
                color: '#ccc',
                fontSize: '13px',
                padding: '6px 14px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              title="Find a part by name"
              onClick={() => setPartPickerOpen(true)}
            >
              Find part…
            </button>
          </>
        )}
        {!isVoice &&
          sortedCameras.map((cam) => (
            <button
              key={cam.id}
              style={{
                background: 'none',
                border: '1px solid #555',
                borderRadius: '3px',
                color: '#ccc',
                fontSize: '13px',
                padding: '6px 14px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                whiteSpace: 'nowrap',
              }}
              title={`Split at playhead and assign CAM${cam.number} ${cam.name}`}
              onClick={() => handleCamButtonClick(cam)}
            >
              <span
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  background: cam.color,
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
              + CAM{cam.number} {cam.name}
            </button>
          ))}
        {!isVoice && sortedCameras.length === 0 && (
          <span style={{ color: '#444', fontSize: '11px' }}>No cameras configured</span>
        )}
      </div>

      {/* Context menu */}
      {contextMenu !== null && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            background: '#2a2a2a',
            border: '1px solid #444',
            borderRadius: '4px',
            zIndex: 1000,
            minWidth: '140px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}
          onMouseLeave={() => setContextMenu(null)}
        >
          {[
            {
              mode: 'extend' as const,
              label: 'Delete shot',
              hint: 'previous shot absorbs the time',
            },
            {
              mode: 'ripple' as const,
              label: 'Delete and close gap',
              hint: 'later shots move earlier',
            },
          ].map(({ mode, label, hint }) => (
            <div
              key={mode}
              style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '13px', color: '#e74c3c' }}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLDivElement
                el.style.background = '#3a2a2a'
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLDivElement
                el.style.background = 'transparent'
              }}
              onClick={() => {
                onDeleteShot(contextMenu.shotId, mode)
                setContextMenu(null)
              }}
            >
              {label}
              <div style={{ fontSize: '10px', color: '#888', marginTop: 1 }}>{hint}</div>
            </div>
          ))}
          <div style={{ borderTop: '1px solid #333', padding: '4px 0' }}>
            <div style={{ padding: '2px 12px', fontSize: '11px', color: '#888' }}>
              {isVoice ? 'Change part:' : 'Change camera:'}
            </div>
            {isVoice &&
              partsInScope.map((part) => (
                <div
                  key={part.id}
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: '#ddd',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  onMouseEnter={(e) => {
                    const el = e.currentTarget as HTMLDivElement
                    el.style.background = '#3a3a3a'
                  }}
                  onMouseLeave={(e) => {
                    const el = e.currentTarget as HTMLDivElement
                    el.style.background = 'transparent'
                  }}
                  onClick={() => {
                    editShot({ id: contextMenu.shotId, partId: part.id }).catch((err: unknown) =>
                      console.error('[TimelineEditor] changeCallPart:', err),
                    )
                    setContextMenu(null)
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: part.color,
                      display: 'inline-block',
                    }}
                  />
                  {part.number} — {part.name}
                </div>
              ))}
            {!isVoice &&
              sortedCameras.map((cam) => (
                <div
                  key={cam.id}
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: '#ddd',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  onMouseEnter={(e) => {
                    const el = e.currentTarget as HTMLDivElement
                    el.style.background = '#3a3a3a'
                  }}
                  onMouseLeave={(e) => {
                    const el = e.currentTarget as HTMLDivElement
                    el.style.background = 'transparent'
                  }}
                  onClick={() => {
                    onChangeShotCamera(contextMenu.shotId, cam.id)
                    setContextMenu(null)
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: cam.color,
                      display: 'inline-block',
                    }}
                  />
                  CAM{cam.number} — {cam.name}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Type-to-filter picker, for a Part list too long to read off the bar */}
      {partPickerOpen && (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            top: '20%',
            transform: 'translateX(-50%)',
            width: '280px',
            background: '#2a2a2a',
            border: '1px solid #444',
            borderRadius: '4px',
            padding: '10px',
            zIndex: 1000,
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}
        >
          <PartPicker
            parts={partsInScope}
            onPick={(part: Part) => {
              assignPartAtPlayhead(part)
              setPartPickerOpen(false)
            }}
            onCancel={() => setPartPickerOpen(false)}
          />
        </div>
      )}

      {/* A Part named mid-authoring lands on this Rundown and is assigned at once */}
      {addPartOpen && (
        <AddPartDialog
          onCreated={(part: Part) => assignPartAtPlayhead(part)}
          onClose={() => setAddPartOpen(false)}
        />
      )}
    </div>
  )
}
