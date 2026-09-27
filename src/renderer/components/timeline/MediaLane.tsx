/**
 * The Reference media lane: the waveform, its load state, and the drag that
 * aligns it to the Rundown.
 *
 * Memoised because this is the lane that matters most while a 4K reference cut is
 * playing — the waveform is a single SVG path spanning the whole media duration,
 * and reconciling it ten times a second bought nothing: the path only changes when
 * the peaks or the zoom do.
 *
 * Hover state lives here rather than in the parent. It used to be a `useState` one
 * level up, so moving the pointer across this lane re-rendered the entire
 * timeline to show a filename.
 */

import React, { useState } from 'react'
import { pxAtMs } from '../../timeline/coordinates'

interface MediaLaneProps {
  media: { filePath: string; offsetMs: number } | null
  /** Offset being previewed by a drag in progress, if any. */
  offsetOverrideMs: number | null
  zoomPxPerSec: number
  width: number
  height: number
  waveformPath: string
  waveformSvgWidth: number
  /** Null while peaks are still being produced. */
  waveformData: number[] | null
  /** Why there is no waveform, or null when nothing went wrong. */
  waveformError: string | null
  mediaFileNotFound: boolean
  onTrackMouseDown: (e: React.MouseEvent) => void
  onImportMedia: () => void
  onClearMedia: () => void
  /**
   * Whether a Live session is running. Attaching or clearing Reference media
   * changes the Rundown, so neither is offered during one — same contract as the
   * Lyrics and Marker Tracks. Dragging the offset is refused by the grab adapter.
   */
  running: boolean
}

const overlayText: React.CSSProperties = {
  position: 'absolute',
  left: '8px',
  top: '50%',
  transform: 'translateY(-50%)',
  fontSize: '10px',
  fontFamily: 'monospace',
  pointerEvents: 'none',
}

function MediaLaneImpl({
  media,
  offsetOverrideMs,
  zoomPxPerSec,
  width,
  height,
  waveformPath,
  waveformSvgWidth,
  waveformData,
  waveformError,
  mediaFileNotFound,
  onTrackMouseDown,
  onImportMedia,
  onClearMedia,
  running,
}: MediaLaneProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const offsetPx = pxAtMs(offsetOverrideMs ?? media?.offsetMs ?? 0, zoomPxPerSec)

  return (
    <div
      style={{
        height,
        width,
        background: '#0d0d0d',
        position: 'relative',
        borderTop: '1px solid #2a2a2a',
        overflow: 'hidden',
        cursor: media ? 'grab' : 'default',
        userSelect: 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={media ? onTrackMouseDown : undefined}
      onDoubleClick={!media && !running ? onImportMedia : undefined}
    >
      {!media && !running && (
        <span style={{ ...overlayText, color: '#333' }}>
          Double-click or use &apos;Import media&apos; to add a reference track
        </span>
      )}

      {media && (
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
            <span style={{ ...overlayText, color: '#e67e22' }}>
              Media file not found — relink or clear
            </span>
          ) : waveformError !== null ? (
            <span style={{ ...overlayText, color: '#e74c3c' }}>
              {`No waveform: ${waveformError}`}
            </span>
          ) : waveformData === null ? (
            <span style={{ ...overlayText, color: '#555' }}>Loading waveform...</span>
          ) : (
            <svg width={waveformSvgWidth} height={height} style={{ display: 'block' }}>
              <path d={waveformPath} fill="rgba(39,174,96,0.7)" />
            </svg>
          )}

          {/* Filename + clear overlay */}
          {hovered && (
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
                {media.filePath.split('/').pop() ?? media.filePath}
              </span>
              {!running && (
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
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const MediaLane = React.memo(MediaLaneImpl)
