import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import {
  editPlayheadMs,
  livePlayheadMs,
  isOverrunning,
  mediaTimeSecFor,
  shouldCommit,
} from '../timeline/playhead-clock'
import {
  lyricRange,
  lyricBlocks,
  lyricAtMs,
  resizeLyric,
  overlappingLyric,
  isUnassigned,
  announcementProblemsByCallId,
  type AnnouncementSettings,
  type AnnouncementProblem,
} from '../timeline/lyrics'
import { useAppStore } from '../store'

/**
 * What each badge means, in the words an operator can act on.
 *
 * `phrase-only` is the one worth spelling out: it is not a failure the show will
 * make obvious. The name is spoken, the Announcement sounds like it worked, and
 * the band simply never hears a count.
 */
const ANNOUNCEMENT_PROBLEM_TITLE: Record<AnnouncementProblem, string> = {
  dropped: 'too short for its announcement; nothing will be spoken',
  'phrase-only': 'too short for a countdown; only the name will be spoken, with no numbers',
}

/**
 * Red for silence, amber for a name with no count.
 *
 * Both are loud on purpose. These warnings mark Calls that are *short*, which
 * are the narrowest blocks on the timeline — the place a subtle mark is least
 * likely to be seen, and the mark most worth seeing.
 */
const ANNOUNCEMENT_PROBLEM_COLOR: Record<AnnouncementProblem, string> = {
  dropped: '#e74c3c',
  'phrase-only': '#f1c40f',
}

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
  onUpdateMarker: (id: string, positionMs: number) => void
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

interface DragState {
  shotA: Shot
  shotB: Shot
  startX: number
  origDurA: number
  origDurB: number
}

interface MarkerDragState {
  markerId: string
  startX: number
  origPositionMs: number
}

interface MediaDragState {
  startX: number
  origOffset: number
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
  phraseDurationMsByPartId = {},
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
  const [mediaHovered, setMediaHovered] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; shotId: string } | null>(
    null,
  )
  const [flash, setFlash] = useState(false)
  const [currentScrollLeft, setCurrentScrollLeft] = useState(0)
  const [waveformError, setWaveformError] = useState(false)
  const [mediaFileNotFound, setMediaFileNotFound] = useState(false)
  const [containerWidth, setContainerWidth] = useState(800)
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
  const isAutoScrollingRef = useRef(false)
  const dragStateRef = useRef<DragState | null>(null)
  const markerDragStateRef = useRef<MarkerDragState | null>(null)
  const mediaDragStateRef = useRef<MediaDragState | null>(null)
  const zoomRef = useRef(zoomPxPerSec)
  const playStartRef = useRef<{ wallMs: number; headMs: number } | null>(null)
  const liveRafRef = useRef<number | null>(null)
  const editRafRef = useRef<number | null>(null)
  const overviewRef = useRef<HTMLDivElement>(null)
  const extendDragRef = useRef<{ startX: number; origDur: number } | null>(null)
  const playheadMsRef = useRef(playheadMs)
  const onAddMarkerRef = useRef(onAddMarker)
  const onLabelEditRef = useRef(onLabelEdit)
  const selectedShotIdRef = useRef(selectedShotId)
  const isFirstLiveRef = useRef(true)
  const isFirstSelectedRef = useRef(true)
  const prevAutoShotIdRef = useRef<string | null>(null)
  const audioPlayRef = useRef<HTMLAudioElement | null>(null)
  const pendingDragClearRef = useRef(false)
  const rundownMediaRef = useRef(rundownMedia)
  const totalMsRef = useRef(0)
  const totalPxRef = useRef(0)
  const playheadTimeElRef = useRef<HTMLSpanElement>(null)
  const overviewPlayheadElRef = useRef<HTMLDivElement>(null)
  const viewportRectElRef = useRef<HTMLDivElement>(null)
  const lastPlayheadCommitRef = useRef(0)
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
    seekMediaToMs(playheadMs)
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
      setWaveformError(false)
      setMediaFileNotFound(false)
      return
    }
    setWaveformError(false)
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
      }

      try {
        // Stream the bytes through the media:// protocol rather than pulling the
        // whole file across IPC — a multi-GB video would otherwise be structured-
        // cloned into the renderer and copied again before decoding.
        const response = await fetch(toMediaUrl(rundownMedia!.filePath))
        if (!response.ok) {
          if (!cancelled) setWaveformError(true)
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
          if (!cancelled) setWaveformError(true)
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
          peaks.push(max)
        }
        if (!cancelled) setWaveformData(peaks)
      } catch (err) {
        console.error('[TimelineEditor] waveform decode error:', err)
        if (!cancelled) setWaveformError(true)
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

  const totalMs = totalDurationMs(shots)
  const totalPx = Math.max(pxAtMs(totalMs, zoomPxPerSec), 300)
  totalMsRef.current = totalMs
  totalPxRef.current = totalPx

  /** Moves the playhead in response to a discrete interaction (click, drag, key). */
  function setPlayhead(ms: number): void {
    playheadMsRef.current = ms
    setPlayheadMs(ms)
  }

  /** Paints playhead-dependent DOM directly, bypassing React. */
  function paintPlayhead(ms: number): void {
    playheadMsRef.current = ms
    if (playheadTimeElRef.current) playheadTimeElRef.current.textContent = formatPlayhead(ms)
    const marker = overviewPlayheadElRef.current
    if (marker && totalMsRef.current > 0) {
      const ow = overviewRef.current?.clientWidth ?? 300
      marker.style.left = `${(ms / totalMsRef.current) * ow}px`
    }
  }

  /** Advances the playhead from a RAF tick: paint every frame, commit state rarely. */
  function advancePlayhead(ms: number): void {
    paintPlayhead(ms)
    autoScroll(ms)
    const nowMs = performance.now()
    if (shouldCommit(nowMs, lastPlayheadCommitRef.current, PLAYHEAD_COMMIT_INTERVAL_MS)) {
      lastPlayheadCommitRef.current = nowMs
      setPlayheadMs(ms)
    }
  }

  /** Keeps the overview viewport rect in sync without a React render. */
  function paintViewportRect(scrollLeft: number): void {
    const rect = viewportRectElRef.current
    const scroller = scrollContainerRef.current
    if (!rect || !scroller || totalPxRef.current <= 0) return
    const ow = overviewRef.current?.clientWidth ?? 300
    const vpLeft = (scrollLeft / totalPxRef.current) * ow
    const vpRight = Math.min(ow, vpLeft + (scroller.clientWidth / totalPxRef.current) * ow)
    rect.style.left = `${vpLeft}px`
    rect.style.width = `${Math.max(4, vpRight - vpLeft)}px`
  }

  /** Pushes the last painted position into React state when playback stops. */
  function commitPlayhead(): void {
    lastPlayheadCommitRef.current = 0
    setPlayheadMs(playheadMsRef.current)
  }

  // Edit-mode RAF loop
  useEffect(() => {
    if (!isPlaying || running) {
      if (editRafRef.current !== null) {
        cancelAnimationFrame(editRafRef.current)
        editRafRef.current = null
      }
      return
    }
    // currentTime is already synced by the stopped-state useEffect.
    // Reset wallMs to now so elapsed starts from when play() is actually called.
    if (playStartRef.current) playStartRef.current.wallMs = performance.now()
    const vid = getMediaEl()
    console.log(
      '[TimelineEditor] play() on:',
      vid?.nodeName,
      vid?.src,
      'readyState:',
      vid?.readyState,
      'currentTime:',
      vid?.currentTime,
    )
    if (vid) {
      void vid.play().catch((err: unknown) => {
        console.error('[TimelineEditor] play() failed:', err)
      })
    }
    function tick(): void {
      const origin = playStartRef.current
      if (!origin) return
      const vid = getMediaEl()
      const newMs = editPlayheadMs({
        origin,
        nowMs: performance.now(),
        media:
          vid && rundownMedia
            ? { currentTimeSec: vid.currentTime, offsetMs: rundownMedia.offsetMs }
            : null,
        totalMs,
      })
      advancePlayhead(newMs)
      if (newMs >= totalMs) {
        commitPlayhead()
        setIsPlaying(false)
        vid?.pause()
        return
      }
      editRafRef.current = requestAnimationFrame(tick)
    }
    editRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (editRafRef.current !== null) {
        cancelAnimationFrame(editRafRef.current)
        editRafRef.current = null
      }
      commitPlayhead()
    }
  }, [isPlaying, running, totalMs, zoomPxPerSec, rundownMedia]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live-mode RAF loop
  useEffect(() => {
    if (!running || liveIndex === null || startedAt === null) {
      if (liveRafRef.current !== null) {
        cancelAnimationFrame(liveRafRef.current)
        liveRafRef.current = null
      }
      return
    }
    // Constant for the whole shot — computing it per frame allocated a slice
    // and re-summed every preceding shot 60 times a second.
    const startMs = shotStartMs(shots, liveIndex)
    const shotDurationMs = shots[liveIndex]?.durationMs ?? 0

    function tick(): void {
      const elapsedMs = Date.now() - startedAt!
      const position = { shotStartMs: startMs, shotDurationMs, elapsedMs }
      const newMs = livePlayheadMs(position)
      // An overrunning shot holds the playhead; stop dragging the view with it.
      if (isOverrunning(position)) {
        paintPlayhead(newMs)
      } else {
        advancePlayhead(newMs)
      }
      liveRafRef.current = requestAnimationFrame(tick)
    }
    liveRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (liveRafRef.current !== null) {
        cancelAnimationFrame(liveRafRef.current)
        liveRafRef.current = null
      }
      commitPlayhead()
    }
  }, [running, liveIndex, startedAt, zoomPxPerSec]) // eslint-disable-line react-hooks/exhaustive-deps

  // When liveIndex changes, scroll to the new shot's start position
  useEffect(() => {
    if (!running || liveIndex === null) return
    autoScroll(shotStartMs(shots, liveIndex))
  }, [liveIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll sync for overview
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    function onScroll(): void {
      if (!el) return
      const sl = el.scrollLeft
      // Auto-scroll fires this every frame; autoScroll() already painted the rect.
      if (isAutoScrollingRef.current) return
      setCurrentScrollLeft(sl)
      if (
        !isPlayingRef.current &&
        !runningRef.current &&
        !dragStateRef.current &&
        !markerDragStateRef.current &&
        !mediaDragStateRef.current
      ) {
        const ms = Math.max(0, msAtPx(sl, zoomRef.current))
        setPlayhead(ms)
        // Seek media directly — bypasses React render cycle for immediate response
        const media = rundownMediaRef.current
        const vid = (mediaVideoRef?.current as HTMLVideoElement | null) ?? audioPlayRef.current
        if (media && vid) {
          vid.currentTime = mediaTimeSecFor(ms, media.offsetMs)
        }
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth)
    })
    ro.observe(el)
    setContainerWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    function onWheel(e: WheelEvent): void {
      if (isPlayingRef.current || runningRef.current) e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  function autoScroll(ms: number): void {
    if (!isPlayingRef.current && !runningRef.current) return
    const el = scrollContainerRef.current
    if (!el) return
    isAutoScrollingRef.current = true
    el.scrollLeft = pxAtMs(ms, zoomRef.current)
    paintViewportRect(el.scrollLeft)
    setTimeout(() => {
      isAutoScrollingRef.current = false
    }, 0)
  }

  function getMediaEl(): HTMLVideoElement | HTMLAudioElement | null {
    return (mediaVideoRef.current as HTMLVideoElement | null) ?? audioPlayRef.current
  }

  function seekMediaToMs(ms: number): void {
    if (!rundownMedia) return
    const vid = getMediaEl()
    if (!vid) return
    vid.currentTime = mediaTimeSecFor(ms, rundownMedia.offsetMs)
  }

  function zoomIn(): void {
    setZoomPxPerSec((z) => Math.min(2000, Math.round(z * 1.4)))
  }
  function zoomOut(): void {
    setZoomPxPerSec((z) => Math.max(5, Math.round(z / 1.4)))
  }

  function movePlayhead(deltaMs: number): void {
    const n = Math.max(0, Math.min(playheadMsRef.current + deltaMs, totalMs))
    setPlayhead(n)
    autoScroll(n)
    if (!isPlayingRef.current) seekMediaToMs(n)
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return

      if (e.code === 'Space' && !running) {
        e.preventDefault()
        setIsPlaying((prev) => {
          if (!prev) {
            playStartRef.current = { wallMs: performance.now(), headMs: playheadMsRef.current }
            // RAF effect handles seek + play()
          } else {
            getMediaEl()?.pause()
            seekMediaToMs(playheadMsRef.current)
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
        onAddMarkerRef.current?.(playheadMsRef.current)
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
          selectedShotIdRef.current ?? shotIdAtMs(shotsRef.current, playheadMsRef.current)
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
    const clamped = timelinePosMs(e.clientX, rect.left, zoomPxPerSec, totalMs)
    setPlayhead(clamped)
    autoScroll(clamped)
    if (!isPlayingRef.current) seekMediaToMs(clamped)
  }

  function handleBlockClick(e: React.MouseEvent, shotId: string): void {
    e.stopPropagation()
    onShotClick(shotId)
  }

  function handleCamButtonClick(camera: Camera): void {
    let accumulated = 0
    for (const shot of shotsRef.current) {
      const shotStart = accumulated
      const shotEnd = accumulated + shot.durationMs
      if (playheadMsRef.current >= shotStart && playheadMsRef.current < shotEnd) {
        const atMs = playheadMsRef.current - shotStart
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
    let accumulated = 0
    for (const shot of shotsRef.current) {
      const shotEnd = accumulated + shot.durationMs
      if (playheadMsRef.current >= accumulated && playheadMsRef.current < shotEnd) {
        // Rounded before the comparison: a playhead a fraction of a millisecond
        // into a Call would otherwise take the split branch and then round to
        // 0, which splitShot rejects outright.
        const atMs = Math.round(playheadMsRef.current - accumulated)
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
    const ms = Math.round(playheadMsRef.current)
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
    const ms = Math.round(playheadMsRef.current)
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

    let latest: { startMs: number; endMs: number } | null = null

    const onMove = (ev: MouseEvent): void => {
      const ms = timelinePosMs(ev.clientX, laneLeft, zoomPxPerSec, Number.MAX_SAFE_INTEGER)
      const next = resizeLyric(lyricsRef.current, id, edge, ms)
      if (next === null) return
      latest = next
      // Shown immediately, saved once: a write per mousemove would be a
      // transaction per pixel, and the store rejects overlaps anyway.
      setLyricDragOverride({ id, ...next })
    }

    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setLyricDragOverride(null)
      if (latest === null) return
      const existing = lyricsRef.current.find((l) => l.id === id)
      if (existing === undefined) return
      void saveLyric({ id, ...latest, text: existing.text })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function deleteLyric(id: string): void {
    removeLyric(id).catch((err: unknown) => console.error('[TimelineEditor] deleteLyric:', err))
    if (selectedLyricId === id) setSelectedLyricId(null)
  }

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

  function handleBoundaryMouseDown(e: React.MouseEvent, shotA: Shot, shotB: Shot): void {
    e.preventDefault()
    e.stopPropagation()
    dragStateRef.current = {
      shotA,
      shotB,
      startX: e.clientX,
      origDurA: shotA.durationMs,
      origDurB: shotB.durationMs,
    }

    function onMouseMove(ev: MouseEvent): void {
      const ds = dragStateRef.current
      if (!ds) return
      const rawDeltaMs = msAtPx(ev.clientX - ds.startX, zoomRef.current)
      const newDurA = Math.max(1000, ds.origDurA + rawDeltaMs)
      const maxDurA = ds.origDurA + ds.origDurB - 1000
      const clampedDurA = Math.min(maxDurA, newDurA)
      const newDurB = Math.max(1000, ds.origDurA + ds.origDurB - clampedDurA)
      setDragOverride({ [ds.shotA.id]: clampedDurA, [ds.shotB.id]: newDurB })
    }

    function onMouseUp(ev: MouseEvent): void {
      const ds = dragStateRef.current
      if (ds) {
        const rawDeltaMs = msAtPx(ev.clientX - ds.startX, zoomRef.current)
        const newDurA = Math.max(
          1000,
          Math.min(ds.origDurA + ds.origDurB - 1000, ds.origDurA + rawDeltaMs),
        )
        const newDurB = Math.max(1000, ds.origDurA + ds.origDurB - newDurA)
        onResizeShots(ds.shotA.id, newDurA, ds.shotB.id, newDurB)
        // Keep dragOverride at final values until shots prop updates from IPC
        setDragOverride({ [ds.shotA.id]: newDurA, [ds.shotB.id]: newDurB })
        pendingDragClearRef.current = true
        dragStateRef.current = null
      } else {
        setDragOverride({})
      }
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
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
    e.preventDefault()
    e.stopPropagation()
    markerDragStateRef.current = {
      markerId: marker.id,
      startX: e.clientX,
      origPositionMs: marker.positionMs,
    }

    function onMouseMove(ev: MouseEvent): void {
      const ds = markerDragStateRef.current
      if (!ds) return
      const deltaMs = msAtPx(ev.clientX - ds.startX, zoomRef.current)
      const newPositionMs = Math.max(0, Math.round(ds.origPositionMs + deltaMs))
      setMarkerDragOverride({ [ds.markerId]: newPositionMs })
    }

    function onMouseUp(ev: MouseEvent): void {
      const ds = markerDragStateRef.current
      if (ds) {
        const deltaMs = msAtPx(ev.clientX - ds.startX, zoomRef.current)
        const newPositionMs = Math.max(0, Math.round(ds.origPositionMs + deltaMs))
        onUpdateMarker(ds.markerId, newPositionMs)
        markerDragStateRef.current = null
      }
      setMarkerDragOverride({})
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  function handleMarkerLabelClick(e: React.MouseEvent, marker: Marker): void {
    e.stopPropagation()
    setEditingMarkerId(marker.id)
    setEditingMarkerLabel(marker.label ?? '')
  }

  function handleMarkerLabelSave(marker: Marker): void {
    const trimmed = editingMarkerLabel.trim() || null
    if (trimmed !== marker.label) {
      onUpdateMarker(marker.id, markerDragOverride[marker.id] ?? marker.positionMs)
      window.api.markers
        .upsert({
          id: marker.id,
          rundownId: marker.rundownId,
          positionMs: marker.positionMs,
          label: trimmed,
        })
        .catch((err: unknown) => console.error('[TimelineEditor] label save:', err))
    }
    setEditingMarkerId(null)
  }

  function handleMediaTrackMouseDown(e: React.MouseEvent): void {
    if (!rundownMedia) return
    e.preventDefault()
    e.stopPropagation()
    mediaDragStateRef.current = {
      startX: e.clientX,
      origOffset: rundownMedia.offsetMs,
    }

    function onMouseMove(ev: MouseEvent): void {
      const ds = mediaDragStateRef.current
      if (!ds) return
      const newOffset = ds.origOffset + msAtPx(ev.clientX - ds.startX, zoomRef.current)
      setMediaOffsetOverride(newOffset)
    }

    function onMouseUp(ev: MouseEvent): void {
      const ds = mediaDragStateRef.current
      if (ds) {
        const newOffset = ds.origOffset + msAtPx(ev.clientX - ds.startX, zoomRef.current)
        onUpdateMediaOffset(Math.round(newOffset))
        mediaDragStateRef.current = null
      }
      setMediaOffsetOverride(null)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  function handlePlayheadDragMouseDown(e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const origMs = playheadMs
    const startX = e.clientX
    function onMM(ev: MouseEvent): void {
      const deltaMs = msAtPx(ev.clientX - startX, zoomRef.current)
      const newMs = Math.max(0, Math.min(origMs + deltaMs, totalMs))
      setPlayhead(newMs)
      autoScroll(newMs)
      if (!isPlayingRef.current) seekMediaToMs(newMs)
    }
    function onMU(): void {
      window.removeEventListener('mousemove', onMM)
      window.removeEventListener('mouseup', onMU)
    }
    window.addEventListener('mousemove', onMM)
    window.addEventListener('mouseup', onMU)
  }

  // Build tick marks for ruler
  const ticks: { px: number; major: boolean; label?: string }[] = []
  const minorIntervalMs = 5000
  const majorIntervalMs = 30000
  const endMs = totalMs + majorIntervalMs
  for (let ms = 0; ms <= endMs; ms += minorIntervalMs) {
    const px = pxAtMs(ms, zoomPxPerSec)
    const major = ms % majorIntervalMs === 0
    ticks.push({ px, major, label: major ? formatTime(ms) : undefined })
  }

  const targetById = targetsById(targetsOf(rundownKind, cameras, partsInScope))

  const UNASSIGNED_COLOR = '#3a3a3a'

  /**
   * How an item paints: a Call reads its Part exactly as a Shot reads its
   * Camera, so the lane never has to know which Kind it is showing beyond this.
   * An unassigned item is drawn as its own thing rather than in a default
   * colour, because a Live session refuses to start on one and the operator
   * should see that here rather than when they press start.
   */
  function itemTarget(shot: Shot): { color: string; label: string; title: string } {
    const noun = targetNoun(rundownKind)
    if (isUnassigned(shot, rundownKind)) {
      return {
        color: UNASSIGNED_COLOR,
        label: `No ${noun.toLowerCase()}`,
        title: `No ${noun} assigned — a Live session will refuse to start`,
      }
    }

    const target = targetOf(shot, rundownKind, targetById)
    // Resolving to nothing here does not mean unassigned — that was ruled out
    // above. It is a Part outside this Rundown's scope, which is still a real
    // assignment (ADR 0006); only its name and colour are unavailable.
    if (!target) {
      return {
        color: '#666',
        label: noun,
        title: `${noun} from another scope (${shot.durationMs}ms)`,
      }
    }
    return {
      color: target.color,
      label: isVoice ? target.name : target.badge,
      title: `${target.name} (${shot.durationMs}ms)`,
    }
  }

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
  const lyricsForLane =
    lyricDragOverride === null
      ? lyrics
      : lyrics.map((l) =>
          l.id === lyricDragOverride.id
            ? { ...l, startMs: lyricDragOverride.startMs, endMs: lyricDragOverride.endMs }
            : l,
        )
  const lyricLane = lyricBlocks(lyricsForLane, zoomPxPerSec)
  // The whole point of the lane: which line is being sung right now. The playhead
  // is committed to state at PLAYHEAD_COMMIT_INTERVAL_MS, so this lags by at most
  // that — far below the length of a sung line.
  const currentLyricId = lyricAtMs(lyrics, playheadMs)?.id ?? null

  // Shot left offsets, honouring any resize drag in progress
  const shotOffsets = shotStartOffsetsMs(shots, dragOverride).map((ms) => pxAtMs(ms, zoomPxPerSec))

  const sortedCameras = [...cameras].sort((a, b) => a.number - b.number)

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
              seekMediaToMs(playheadMsRef.current)
            } else {
              playStartRef.current = { wallMs: performance.now(), headMs: playheadMs }
              setIsPlaying(true)
              // RAF effect handles seek + play()
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
          <div
            style={{
              height: RULER_HEIGHT,
              width: totalPx,
              background: '#1a1a1a',
              position: 'relative',
              flexShrink: 0,
            }}
          >
            {ticks.map((tick) => (
              <div
                key={tick.px}
                style={{
                  position: 'absolute',
                  left: tick.px,
                  top: 0,
                  height: '100%',
                  width: '1px',
                  background: '#444',
                }}
              >
                {tick.label !== undefined && (
                  <span
                    style={{
                      position: 'absolute',
                      top: '2px',
                      left: '2px',
                      fontSize: '9px',
                      color: '#888',
                      whiteSpace: 'nowrap',
                      pointerEvents: 'none',
                    }}
                  >
                    {tick.label}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Row 3: Camera track */}
          <div
            style={{
              height: TRACK_HEIGHT,
              width: totalPx,
              background: '#0d0d0d',
              position: 'relative',
              cursor: 'crosshair',
            }}
            onClick={handleTrackClick}
          >
            {shots.length === 0 ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  color: '#555',
                  fontSize: '12px',
                  pointerEvents: 'none',
                }}
              >
                {isVoice ? 'No calls — create a rundown' : 'No shots — create a rundown'}
              </div>
            ) : (
              shots.map((shot, i) => {
                const target = itemTarget(shot)
                const unassigned = isUnassigned(shot, rundownKind)
                const problem = announcementProblems.get(shot.id)
                const bgColor = target.color
                const leftPx = shotOffsets[i]
                const effectiveDuration = dragOverride[shot.id] ?? shot.durationMs
                const widthPx = pxAtMs(effectiveDuration, zoomPxPerSec)
                const isLive = liveIndex !== null && shots[liveIndex]?.id === shot.id

                // Transition triangle
                const hasTransition = shot.transitionName !== null && shot.transitionMs > 0
                const triWidthPx = hasTransition ? pxAtMs(shot.transitionMs, zoomPxPerSec) : 0

                // Boundary handle (rendered after each shot except the last)
                const nextShot = shots[i + 1]
                const boundaryLeftPx = leftPx + widthPx

                return (
                  <React.Fragment key={shot.id}>
                    {/* Shot block */}
                    <div
                      style={{
                        position: 'absolute',
                        left: leftPx,
                        top: 0,
                        width: widthPx,
                        height: TRACK_HEIGHT,
                        background: unassigned
                          ? `repeating-linear-gradient(45deg, ${UNASSIGNED_COLOR}, ${UNASSIGNED_COLOR} 6px, #2c2c2c 6px, #2c2c2c 12px)`
                          : bgColor,
                        // Ringed in the warning colour, so a Call too short to
                        // announce is obvious at any width — including the
                        // sliver-wide blocks these warnings are always about.
                        // Stacked with the live ring rather than replacing it:
                        // the item going out is never the thing to hide.
                        boxShadow:
                          [
                            isLive ? 'inset 0 0 0 2px white' : null,
                            problem !== undefined
                              ? `inset 0 0 0 ${isLive ? '4px' : '2px'} ${ANNOUNCEMENT_PROBLEM_COLOR[problem]}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(', ') || undefined,
                        overflow: 'hidden',
                        cursor: 'pointer',
                        userSelect: 'none',
                        border: unassigned ? '1px dashed #e67e22' : '1px solid rgba(0,0,0,0.5)',
                        boxSizing: 'border-box' as const,
                      }}
                      onClick={(e) => handleBlockClick(e, shot.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setContextMenu({ x: e.clientX, y: e.clientY, shotId: shot.id })
                      }}
                      title={
                        problem === undefined
                          ? target.title
                          : `${target.title} — ${ANNOUNCEMENT_PROBLEM_TITLE[problem]}`
                      }
                    >
                      {/*
                        Outside the label, and outside its width gate: the label
                        is hidden below 20px and a Call this warning fires on is
                        routinely narrower than that. Absolute, so it overhangs a
                        block too small to contain it rather than vanishing.
                      */}
                      {problem !== undefined && (
                        <div
                          title={ANNOUNCEMENT_PROBLEM_TITLE[problem]}
                          style={{
                            position: 'absolute',
                            top: '-1px',
                            left: '-1px',
                            minWidth: '14px',
                            height: '14px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: ANNOUNCEMENT_PROBLEM_COLOR[problem],
                            color: '#000',
                            fontSize: '10px',
                            fontWeight: 700,
                            lineHeight: 1,
                            borderRadius: '0 0 3px 0',
                            pointerEvents: 'none',
                            zIndex: 3,
                          }}
                        >
                          ⚠
                        </div>
                      )}
                      {widthPx > 20 && (
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            overflow: 'hidden',
                            height: '100%',
                            justifyContent: 'center',
                            gap: 1,
                            // Clear of the corner flag when there is one.
                            paddingLeft: problem === undefined ? '4px' : '18px',
                          }}
                        >
                          <strong
                            style={{
                              fontSize: '11px',
                              lineHeight: 1.2,
                              color: unassigned ? '#e67e22' : 'white',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {target.label}
                          </strong>
                          {shot.label && widthPx > 60 && (
                            <span
                              style={{
                                fontSize: '9px',
                                opacity: 0.7,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                lineHeight: 1.2,
                                color: 'white',
                              }}
                            >
                              {shot.label}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Transition triangle overlay */}
                    {hasTransition && triWidthPx > 0 && (
                      <svg
                        style={{
                          position: 'absolute',
                          left: leftPx,
                          top: 0,
                          width: triWidthPx,
                          height: TRACK_HEIGHT,
                          pointerEvents: 'none',
                          zIndex: 5,
                        }}
                      >
                        <polygon
                          points={`0,0 ${triWidthPx},0 0,${TRACK_HEIGHT}`}
                          fill="rgba(255,255,255,0.4)"
                        />
                      </svg>
                    )}

                    {/* Boundary drag handle between this shot and the next */}
                    {nextShot !== undefined && (
                      <div
                        style={{
                          position: 'absolute',
                          left: boundaryLeftPx - 4,
                          top: 0,
                          width: 8,
                          height: TRACK_HEIGHT,
                          cursor: 'ew-resize',
                          background: 'transparent',
                          zIndex: 10,
                        }}
                        onMouseDown={(e) => handleBoundaryMouseDown(e, shot, nextShot)}
                        onMouseEnter={(e) => {
                          const el = e.currentTarget as HTMLDivElement
                          el.style.background = 'rgba(255,255,255,0.2)'
                        }}
                        onMouseLeave={(e) => {
                          const el = e.currentTarget as HTMLDivElement
                          el.style.background = 'transparent'
                        }}
                      />
                    )}
                  </React.Fragment>
                )
              })
            )}

            {/* Extend last shot drag handle */}
            {shots.length > 0 &&
              (() => {
                const lastShot = shots[shots.length - 1]
                const lastOffset = shotOffsets[shots.length - 1]
                const lastDur = dragOverride[lastShot.id] ?? lastShot.durationMs
                const lastEndPx = lastOffset + pxAtMs(lastDur, zoomPxPerSec)
                return (
                  <div
                    style={{
                      position: 'absolute',
                      left: lastEndPx - 4,
                      top: 0,
                      width: 8,
                      height: TRACK_HEIGHT,
                      cursor: 'ew-resize',
                      background: 'transparent',
                      zIndex: 10,
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget as HTMLDivElement
                      el.style.background = 'rgba(255,255,255,0.3)'
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLDivElement
                      el.style.background = 'transparent'
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      extendDragRef.current = { startX: e.clientX, origDur: lastDur }
                      function onMM(ev: MouseEvent): void {
                        if (!extendDragRef.current) return
                        const deltaMs = msAtPx(
                          ev.clientX - extendDragRef.current.startX,
                          zoomRef.current,
                        )
                        const newDur = Math.max(1000, extendDragRef.current.origDur + deltaMs)
                        setDragOverride({ [lastShot.id]: newDur })
                      }
                      function onMU(ev: MouseEvent): void {
                        if (extendDragRef.current) {
                          const deltaMs = msAtPx(
                            ev.clientX - extendDragRef.current.startX,
                            zoomRef.current,
                          )
                          const newDur = Math.max(1000, extendDragRef.current.origDur + deltaMs)
                          onExtendLastShot(lastShot.id, newDur)
                          extendDragRef.current = null
                        }
                        setDragOverride({})
                        window.removeEventListener('mousemove', onMM)
                        window.removeEventListener('mouseup', onMU)
                      }
                      window.addEventListener('mousemove', onMM)
                      window.addEventListener('mouseup', onMU)
                    }}
                  />
                )
              })()}
          </div>

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
          {(() => {
            const effectiveOffset = mediaOffsetOverride ?? rundownMedia?.offsetMs ?? 0
            const offsetPx = pxAtMs(effectiveOffset, zoomPxPerSec)
            const svgWidth = waveformSvgWidth
            const trackHeightPx = MEDIA_ROW_HEIGHT

            return (
              <div
                style={{
                  height: MEDIA_ROW_HEIGHT,
                  width: totalPx,
                  background: '#0d0d0d',
                  position: 'relative',
                  borderTop: '1px solid #2a2a2a',
                  overflow: 'hidden',
                  cursor: rundownMedia ? 'grab' : 'default',
                  userSelect: 'none',
                }}
                onMouseEnter={() => setMediaHovered(true)}
                onMouseLeave={() => setMediaHovered(false)}
                onMouseDown={rundownMedia ? handleMediaTrackMouseDown : undefined}
                onDoubleClick={!rundownMedia ? onImportMedia : undefined}
              >
                {!rundownMedia && (
                  <span
                    style={{
                      position: 'absolute',
                      left: '8px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: '#333',
                      fontSize: '10px',
                      fontFamily: 'monospace',
                      pointerEvents: 'none',
                    }}
                  >
                    Double-click or use &apos;Import media&apos; to add a reference track
                  </span>
                )}

                {rundownMedia && (
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: '100%',
                      height: '100%',
                      transform: `translateX(${offsetPx}px)`,
                    }}
                  >
                    {mediaFileNotFound ? (
                      <span
                        style={{
                          position: 'absolute',
                          left: '8px',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          color: '#e67e22',
                          fontSize: '10px',
                          fontFamily: 'monospace',
                          pointerEvents: 'none',
                        }}
                      >
                        Media file not found — relink or clear
                      </span>
                    ) : waveformError ? (
                      <span
                        style={{
                          position: 'absolute',
                          left: '8px',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          color: '#e74c3c',
                          fontSize: '10px',
                          fontFamily: 'monospace',
                          pointerEvents: 'none',
                        }}
                      >
                        Failed to load waveform — unsupported format?
                      </span>
                    ) : waveformData === null ? (
                      <span
                        style={{
                          position: 'absolute',
                          left: '8px',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          color: '#555',
                          fontSize: '10px',
                          fontFamily: 'monospace',
                          pointerEvents: 'none',
                        }}
                      >
                        Loading waveform...
                      </span>
                    ) : (
                      <svg width={svgWidth} height={trackHeightPx} style={{ display: 'block' }}>
                        <path d={waveformPath} fill="rgba(39,174,96,0.7)" />
                      </svg>
                    )}

                    {/* Filename + clear overlay */}
                    {mediaHovered && (
                      <div
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '2px 6px',
                          pointerEvents: 'none',
                        }}
                      >
                        <span
                          style={{
                            color: '#888',
                            fontSize: '9px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: '200px',
                          }}
                        >
                          {rundownMedia.filePath.split('/').pop() ?? rundownMedia.filePath}
                        </span>
                        <button
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#888',
                            fontSize: '9px',
                            cursor: 'pointer',
                            padding: '0 2px',
                            pointerEvents: 'all',
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            onClearMedia()
                          }}
                          title="Remove media track"
                        >
                          × Clear
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })()}

          {/* Spacer: ensures the timeline can scroll far enough right for the playhead to reach the end of the last clip */}
          <div style={{ width: totalPx + Math.max(0, containerWidth), height: 0, flexShrink: 0 }} />
        </div>
        {/* end content wrapper */}
      </div>

      {/* Row 6: Mini overview */}
      <div
        ref={overviewRef}
        style={{
          height: OVERVIEW_HEIGHT,
          background: '#111',
          flexShrink: 0,
          position: 'relative',
          borderTop: '1px solid #333',
          cursor: 'pointer',
          overflow: 'hidden',
        }}
        onClick={(e) => {
          const ow = overviewRef.current?.clientWidth ?? 1
          const containerWidth = scrollContainerRef.current?.clientWidth ?? 0
          const targetScrollLeft =
            ((e.clientX - (overviewRef.current?.getBoundingClientRect().left ?? 0)) / ow) *
              totalPx -
            containerWidth / 2
          if (scrollContainerRef.current) {
            const el2 = scrollContainerRef.current
            isAutoScrollingRef.current = true
            el2.scrollLeft = Math.max(0, targetScrollLeft)
            setTimeout(() => {
              isAutoScrollingRef.current = false
            }, 0)
          }
        }}
      >
        {/* Shot blocks in overview */}
        {shots.map((shot, i) => {
          const ow = overviewRef.current?.clientWidth ?? 300
          const left = (shotOffsets[i] / totalPx) * ow
          const width =
            pxAtMs(dragOverride[shot.id] ?? shot.durationMs, zoomPxPerSec) * (ow / totalPx)
          return (
            <div
              key={shot.id}
              style={{
                position: 'absolute',
                left,
                top: 0,
                width: Math.max(1, width),
                height: OVERVIEW_HEIGHT,
                background: itemTarget(shot).color,
              }}
            />
          )
        })}

        {/* Playhead line in overview */}
        {totalMs > 0 && (
          <div
            ref={overviewPlayheadElRef}
            style={{
              position: 'absolute',
              left: (playheadMs / totalMs) * (overviewRef.current?.clientWidth ?? 300),
              top: 0,
              width: 1,
              height: OVERVIEW_HEIGHT,
              background: '#e74c3c',
              pointerEvents: 'none',
              zIndex: 5,
            }}
          />
        )}

        {/* Viewport rect */}
        {totalPx > 0 &&
          (() => {
            const ow = overviewRef.current?.clientWidth ?? 300
            const containerWidth = scrollContainerRef.current?.clientWidth ?? 200
            const vpLeft = (currentScrollLeft / totalPx) * ow
            const vpRight = Math.min(ow, vpLeft + (containerWidth / totalPx) * ow)
            const vpWidth = Math.max(4, vpRight - vpLeft)
            return (
              <div
                ref={viewportRectElRef}
                style={{
                  position: 'absolute',
                  left: vpLeft,
                  top: 0,
                  width: vpWidth,
                  height: OVERVIEW_HEIGHT,
                  border: '2px solid white',
                  background: 'rgba(255,255,255,0.1)',
                  boxSizing: 'border-box',
                  cursor: 'ew-resize',
                  zIndex: 10,
                }}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  const startX = e.clientX
                  const origScroll = scrollContainerRef.current?.scrollLeft ?? 0
                  const ow2 = overviewRef.current?.clientWidth ?? 300
                  function onMM(ev: MouseEvent): void {
                    const delta = ev.clientX - startX
                    if (scrollContainerRef.current) {
                      scrollContainerRef.current.scrollLeft = Math.max(
                        0,
                        origScroll + (delta * totalPx) / ow2,
                      )
                    }
                  }
                  function onMU(): void {
                    window.removeEventListener('mousemove', onMM)
                    window.removeEventListener('mouseup', onMU)
                  }
                  window.addEventListener('mousemove', onMM)
                  window.addEventListener('mouseup', onMU)
                }}
              />
            )
          })()}
      </div>

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
