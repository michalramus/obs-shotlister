import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Shot, Camera, Marker } from '../../shared/types'

interface TimelineEditorProps {
  shots: Shot[]
  cameras: Camera[]
  liveIndex: number | null
  running: boolean
  startedAt: number | null
  markers: Marker[]
  onShotClick: (shotId: string) => void
  onSplitShot: (shotId: string, atMs: number, newCameraId: string) => void
  onResizeShots: (shotAId: string, newDurationA: number, shotBId: string, newDurationB: number) => void
  onExtendLastShot: (shotId: string, newDurationMs: number) => void
  onAddMarker: (positionMs: number) => void
  onUpdateMarker: (id: string, positionMs: number) => void
  onDeleteMarker: (id: string) => void
  rundownMedia: { filePath: string; offsetMs: number } | null
  onImportMedia: () => void
  onUpdateMediaOffset: (offsetMs: number) => void
  onClearMedia: () => void
  onDeleteShot: (shotId: string) => void
  onChangeShotCamera: (shotId: string, cameraId: string) => void
  mediaVideoRef: React.RefObject<HTMLVideoElement | null>
}

const TRACK_HEIGHT = 50
const RULER_HEIGHT = 20
const TOOLBAR_HEIGHT = 36
const MARKER_ROW_HEIGHT = 30
const MEDIA_ROW_HEIGHT = 60
const CAM_BUTTONS_HEIGHT = 48
const OVERVIEW_HEIGHT = 24
const PLAYHEAD_FIXED_PX = 120

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

function formatPlayhead(ms: number): string {
  return `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, '0')}`
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
}: TimelineEditorProps): React.JSX.Element {
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; shotId: string } | null>(null)
  const [flash, setFlash] = useState(false)
  const [currentScrollLeft, setCurrentScrollLeft] = useState(0)
  const [waveformError, setWaveformError] = useState(false)
  const [containerWidth, setContainerWidth] = useState(800)

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
  const isFirstLiveRef = useRef(true)
  const audioPlayRef = useRef<HTMLAudioElement | null>(null)
  const pendingDragClearRef = useRef(false)

  // Keep zoomRef in sync
  useEffect(() => {
    zoomRef.current = zoomPxPerSec
  }, [zoomPxPerSec])

  // Persist zoom
  useEffect(() => {
    localStorage.setItem('obs-queuer-timeline-zoom', String(zoomPxPerSec))
  }, [zoomPxPerSec])

  // Keep playheadMsRef in sync
  useEffect(() => {
    playheadMsRef.current = playheadMs
  }, [playheadMs])

  // Keep onAddMarkerRef in sync
  useEffect(() => {
    onAddMarkerRef.current = onAddMarker
  }, [onAddMarker])

  // Keep isPlayingRef and runningRef in sync
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying])
  useEffect(() => { runningRef.current = running }, [running])

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

  // Decode waveform when media file changes
  useEffect(() => {
    if (!rundownMedia?.filePath) {
      setWaveformData(null)
      setMediaDurationMs(0)
      setWaveformError(false)
      return
    }
    setWaveformError(false)
    let cancelled = false

    // Create audio playback element immediately (before waveform decode) so play() is ready
    const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.avi', '.mkv']
    const isVideoFile = VIDEO_EXTS.some((ext) => rundownMedia.filePath.toLowerCase().endsWith(ext))
    if (!isVideoFile) {
      audioPlayRef.current?.pause()
      const audioSrc = 'media://localhost' + rundownMedia.filePath
      console.log('[TimelineEditor] creating audio element:', audioSrc)
      const audio = new Audio(audioSrc)
      audio.preload = 'auto'
      audioPlayRef.current = audio
    }

    async function decode(): Promise<void> {
      try {
        const buf = await window.api.mediaReadFile(rundownMedia!.filePath)
        // Save a copy of raw bytes BEFORE decodeAudioData detaches the ArrayBuffer
        const srcBuffer: ArrayBuffer = buf instanceof ArrayBuffer
          ? buf
          : (buf as Buffer).buffer.slice(
              (buf as Buffer).byteOffset,
              (buf as Buffer).byteOffset + (buf as Buffer).byteLength,
            )
        // Give decodeAudioData its own copy (it will consume/detach it)
        const arrayBufferForDecode = srcBuffer.slice(0)
        const audioCtx = new AudioContext()
        let audioBuffer: AudioBuffer
        try {
          audioBuffer = await audioCtx.decodeAudioData(arrayBufferForDecode)
        } catch (decodeErr) {
          console.error('[TimelineEditor] decodeAudioData error:', decodeErr)
          await audioCtx.close()
          if (!cancelled) setWaveformError(true)
          return
        }
        await audioCtx.close()
        if (cancelled) return

        setMediaDurationMs(audioBuffer.duration * 1000)

        const channelData = audioBuffer.getChannelData(0)
        const totalSamples = channelData.length
        const numBuckets = Math.ceil(audioBuffer.duration * 40)
        const bucketSize = Math.floor(totalSamples / numBuckets)
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

  const totalMs = shots.reduce((sum, s) => sum + s.durationMs, 0)
  const totalPx = Math.max((totalMs / 1000) * zoomPxPerSec, 300)

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
    console.log('[TimelineEditor] play() on:', vid?.nodeName, vid?.src, 'readyState:', vid?.readyState, 'currentTime:', vid?.currentTime)
    if (vid) {
      void vid.play().catch((err: unknown) => { console.error('[TimelineEditor] play() failed:', err) })
    }
    function tick(): void {
      let newMs: number
      const vid = getMediaEl()
      if (vid && rundownMedia) {
        const mediaTimeMs = vid.currentTime * 1000 + rundownMedia.offsetMs
        if (mediaTimeMs >= 0) {
          // Media is past its start offset — its clock is the source of truth (zero drift)
          newMs = Math.min(mediaTimeMs, totalMs)
        } else {
          // Playhead is before media start — fall back to wall clock
          if (!playStartRef.current) return
          newMs = Math.min(
            playStartRef.current.headMs + (performance.now() - playStartRef.current.wallMs),
            totalMs,
          )
        }
      } else if (playStartRef.current) {
        // No media — wall clock
        newMs = Math.min(
          playStartRef.current.headMs + (performance.now() - playStartRef.current.wallMs),
          totalMs,
        )
      } else {
        return
      }
      setPlayheadMs(newMs)
      autoScroll(newMs)
      if (newMs >= totalMs) {
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
    function tick(): void {
      const shotStartMs = shots.slice(0, liveIndex!).reduce((s, sh) => s + sh.durationMs, 0)
      const elapsed = Date.now() - startedAt!
      const newMs = Math.min(shotStartMs + elapsed, totalMs)
      setPlayheadMs(newMs)
      autoScroll(newMs)
      liveRafRef.current = requestAnimationFrame(tick)
    }
    liveRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (liveRafRef.current !== null) {
        cancelAnimationFrame(liveRafRef.current)
        liveRafRef.current = null
      }
    }
  }, [running, liveIndex, startedAt, zoomPxPerSec]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll sync for overview
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    function onScroll(): void {
      const sl = el.scrollLeft
      setCurrentScrollLeft(sl)
      if (!isAutoScrollingRef.current && !isPlayingRef.current && !runningRef.current
          && !dragStateRef.current && !markerDragStateRef.current && !mediaDragStateRef.current) {
        setPlayheadMs(Math.max(0, (sl / zoomRef.current) * 1000))
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => { setContainerWidth(el.clientWidth) })
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
    el.scrollLeft = (ms / 1000) * zoomRef.current
    setTimeout(() => { isAutoScrollingRef.current = false }, 0)
  }

  function getMediaEl(): HTMLVideoElement | HTMLAudioElement | null {
    return (mediaVideoRef.current as HTMLVideoElement | null) ?? audioPlayRef.current
  }

  function seekMediaToMs(ms: number): void {
    if (!rundownMedia) return
    const vid = getMediaEl()
    if (!vid) return
    const mediaTime = (ms - rundownMedia.offsetMs) / 1000
    vid.currentTime = Math.max(0, mediaTime)
  }

  function zoomIn(): void {
    setZoomPxPerSec((z) => Math.min(2000, Math.round(z * 1.4)))
  }
  function zoomOut(): void {
    setZoomPxPerSec((z) => Math.max(5, Math.round(z / 1.4)))
  }

  function movePlayhead(deltaMs: number): void {
    const n = Math.max(0, Math.min(playheadMsRef.current + deltaMs, totalMs))
    setPlayheadMs(n)
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
      const num = parseInt(e.key, 10)
      if (num >= 1 && num <= 9 && !running) {
        const sortedCamsLocal = [...cameras].sort((a, b) => a.number - b.number)
        const cam = sortedCamsLocal[num - 1]
        if (cam) handleCamButtonClick(cam)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const scrollLeft = scrollContainerRef.current?.scrollLeft ?? 0
    const contentPx = clickX + scrollLeft - PLAYHEAD_FIXED_PX
    const ms = (contentPx / zoomPxPerSec) * 1000
    const clamped = Math.max(0, Math.min(ms, totalMs))
    setPlayheadMs(clamped)
    autoScroll(clamped)
    if (!isPlayingRef.current) seekMediaToMs(clamped)
  }

  function handleBlockClick(e: React.MouseEvent, shotId: string): void {
    e.stopPropagation()
    onShotClick(shotId)
  }

  function handleCamButtonClick(camera: Camera): void {
    let accumulated = 0
    for (const shot of shots) {
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
      const rawDeltaMs = ((ev.clientX - ds.startX) / zoomRef.current) * 1000
      const newDurA = Math.max(1000, ds.origDurA + rawDeltaMs)
      const maxDurA = ds.origDurA + ds.origDurB - 1000
      const clampedDurA = Math.min(maxDurA, newDurA)
      const newDurB = Math.max(1000, ds.origDurA + ds.origDurB - clampedDurA)
      setDragOverride({ [ds.shotA.id]: clampedDurA, [ds.shotB.id]: newDurB })
    }

    function onMouseUp(ev: MouseEvent): void {
      const ds = dragStateRef.current
      if (ds) {
        const rawDeltaMs = ((ev.clientX - ds.startX) / zoomRef.current) * 1000
        const newDurA = Math.max(1000, Math.min(ds.origDurA + ds.origDurB - 1000, ds.origDurA + rawDeltaMs))
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
    const scrollLeft = scrollContainerRef.current?.scrollLeft ?? 0
    const contentPx = e.clientX - rect.left + scrollLeft - PLAYHEAD_FIXED_PX
    const posMs = Math.round((contentPx / zoomPxPerSec) * 1000)
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
      const deltaMs = ((ev.clientX - ds.startX) / zoomRef.current) * 1000
      const newPositionMs = Math.max(0, Math.round(ds.origPositionMs + deltaMs))
      setMarkerDragOverride({ [ds.markerId]: newPositionMs })
    }

    function onMouseUp(ev: MouseEvent): void {
      const ds = markerDragStateRef.current
      if (ds) {
        const deltaMs = ((ev.clientX - ds.startX) / zoomRef.current) * 1000
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
        .upsert({ id: marker.id, rundownId: marker.rundownId, positionMs: marker.positionMs, label: trimmed })
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
      const newOffset = ds.origOffset + ((ev.clientX - ds.startX) / zoomRef.current) * 1000
      setMediaOffsetOverride(newOffset)
    }

    function onMouseUp(ev: MouseEvent): void {
      const ds = mediaDragStateRef.current
      if (ds) {
        const newOffset = ds.origOffset + ((ev.clientX - ds.startX) / zoomRef.current) * 1000
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
      const deltaMs = ((ev.clientX - startX) / zoomRef.current) * 1000
      const newMs = Math.max(0, Math.min(origMs + deltaMs, totalMs))
      setPlayheadMs(newMs)
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
    const px = (ms / 1000) * zoomPxPerSec
    const major = ms % majorIntervalMs === 0
    ticks.push({ px, major, label: major ? formatTime(ms) : undefined })
  }

  // Camera lookup map
  const cameraMap = new Map(cameras.map((c) => [c.id, c]))

  // Compute shot left offsets using dragOverride durations
  const shotOffsets: number[] = []
  let acc = 0
  for (const shot of shots) {
    shotOffsets.push((acc / 1000) * zoomPxPerSec)
    acc += dragOverride[shot.id] ?? shot.durationMs
  }

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
        height: `${TOOLBAR_HEIGHT + RULER_HEIGHT + TRACK_HEIGHT + MARKER_ROW_HEIGHT + MEDIA_ROW_HEIGHT + CAM_BUTTONS_HEIGHT + OVERVIEW_HEIGHT}px`,
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
              height: RULER_HEIGHT + TRACK_HEIGHT + MARKER_ROW_HEIGHT,
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
              No shots — create a rundown
            </div>
          ) : (
            shots.map((shot, i) => {
              const cam = cameraMap.get(shot.cameraId)
              const bgColor = cam?.color ?? '#555'
              const leftPx = shotOffsets[i]
              const effectiveDuration = dragOverride[shot.id] ?? shot.durationMs
              const widthPx = (effectiveDuration / 1000) * zoomPxPerSec
              const isLive = liveIndex !== null && shots[liveIndex]?.id === shot.id

              // Transition triangle
              const hasTransition = shot.transitionName !== null && shot.transitionMs > 0
              const triWidthPx = hasTransition ? (shot.transitionMs / 1000) * zoomPxPerSec : 0

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
                      background: bgColor,
                      boxShadow: isLive ? 'inset 0 0 0 2px white' : undefined,
                      overflow: 'hidden',
                      cursor: 'pointer',
                      userSelect: 'none',
                      border: '1px solid rgba(0,0,0,0.5)',
                      boxSizing: 'border-box' as const,
                    }}
                    onClick={(e) => handleBlockClick(e, shot.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setContextMenu({ x: e.clientX, y: e.clientY, shotId: shot.id })
                    }}
                    title={cam ? `${cam.name} (${shot.durationMs}ms)` : shot.id}
                  >
                    {widthPx > 20 && (
                      <span
                        style={{
                          color: 'white',
                          fontSize: '11px',
                          paddingLeft: '4px',
                          lineHeight: `${TRACK_HEIGHT}px`,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          display: 'block',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {cam ? `${cam.number}` : '?'}
                      </span>
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
              const lastEndPx = lastOffset + (lastDur / 1000) * zoomPxPerSec
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
                      const deltaMs =
                        ((ev.clientX - extendDragRef.current.startX) / zoomRef.current) * 1000
                      const newDur = Math.max(1000, extendDragRef.current.origDur + deltaMs)
                      setDragOverride({ [lastShot.id]: newDur })
                    }
                    function onMU(ev: MouseEvent): void {
                      if (extendDragRef.current) {
                        const deltaMs =
                          ((ev.clientX - extendDragRef.current.startX) / zoomRef.current) * 1000
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
            const leftPx = (effectivePositionMs / 1000) * zoomPxPerSec
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
          const offsetPx = (effectiveOffset / 1000) * zoomPxPerSec
          const svgWidth = (mediaDurationMs / 1000) * zoomPxPerSec
          const trackHeightPx = MEDIA_ROW_HEIGHT
          const halfHeight = trackHeightPx / 2

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
                  {waveformError ? (
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
                      {waveformData.map((peak, i) => {
                        const x = (i / waveformData.length) * svgWidth
                        const barWidth = Math.max(1, svgWidth / waveformData.length)
                        const barHeight = peak * halfHeight * 2
                        return (
                          <rect
                            key={i}
                            x={x}
                            y={halfHeight - barHeight / 2}
                            width={barWidth}
                            height={barHeight}
                            fill="rgba(39,174,96,0.7)"
                          />
                        )
                      })}
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
        </div>{/* end content wrapper */}
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
            setTimeout(() => { isAutoScrollingRef.current = false }, 0)
          }
        }}
      >
        {/* Shot blocks in overview */}
        {shots.map((shot, i) => {
          const cam = cameraMap.get(shot.cameraId)
          const ow = overviewRef.current?.clientWidth ?? 300
          const left = (shotOffsets[i] / totalPx) * ow
          const width =
            ((dragOverride[shot.id] ?? shot.durationMs) / 1000) * zoomPxPerSec * (ow / totalPx)
          return (
            <div
              key={shot.id}
              style={{
                position: 'absolute',
                left,
                top: 0,
                width: Math.max(1, width),
                height: OVERVIEW_HEIGHT,
                background: cam?.color ?? '#555',
              }}
            />
          )
        })}

        {/* Playhead line in overview */}
        {totalMs > 0 && (
          <div
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

      {/* Row 7: Camera buttons */}
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
        {sortedCameras.map((cam) => (
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
        {sortedCameras.length === 0 && (
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
          <div
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
              onDeleteShot(contextMenu.shotId)
              setContextMenu(null)
            }}
          >
            Delete shot
          </div>
          <div style={{ borderTop: '1px solid #333', padding: '4px 0' }}>
            <div style={{ padding: '2px 12px', fontSize: '11px', color: '#888' }}>
              Change camera:
            </div>
            {sortedCameras.map((cam) => (
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
    </div>
  )
}
