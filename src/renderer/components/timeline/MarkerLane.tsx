/**
 * The Marker Track: a dashed line per Marker, its label, and the inline edit of
 * that label.
 *
 * The last Track with no lane of its own, which is why typing a Marker label used
 * to reconcile the entire timeline: the half-typed text was a `useState` in
 * TimelineEditor, so every keystroke re-rendered the ruler, both item lanes and
 * the waveform to repaint nine pixels of orange. Hover was the same story — the
 * defect already fixed for the Reference media lane. Both now live here, behind
 * the memo, so neither reaches the timeline at all.
 *
 * Positions are derived here rather than pre-computed by the caller, unlike the
 * Lyrics Track's blocks: a Marker's geometry is one multiplication, and the drag
 * override has to be read a second time anyway when the label is saved.
 */

import React, { useState } from 'react'
import { pxAtMs } from '../../timeline/coordinates'
import type { Marker } from '../../../shared/types'

interface MarkerLaneProps {
  markers: Marker[]
  /** Positions being previewed by a drag in progress, by Marker id. */
  dragOverride: Record<string, number>
  zoomPxPerSec: number
  width: number
  height: number
  onMarkerMouseDown: (e: React.MouseEvent, marker: Marker) => void
  /**
   * The one seam a Marker is written through — position and, optionally, label.
   *
   * There used to be a second write straight to `window.api` beside it, which
   * raced this one and carried the pre-drag position, so labelling a Marker just
   * after dragging it could put the Marker back where it was.
   */
  onUpdateMarker: (id: string, positionMs: number, label?: string | null) => void
  onDeleteMarker: (id: string) => void
  /**
   * Adds a Marker where the lane was double-clicked. The caller resolves the
   * position, deliberately without a ceiling: see below.
   */
  onTrackDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => void
  /**
   * Whether a Live session is running, in which case nothing here is editable:
   * no label edit, no delete, no double-click to add. Same contract as the Lyrics
   * Track's `running`, and for the same reason — the affordance has to go, not
   * just the write, or the operator clicks and watches nothing happen.
   */
  running: boolean
}

function MarkerLaneImpl({
  markers,
  dragOverride,
  zoomPxPerSec,
  width,
  height,
  onMarkerMouseDown,
  onUpdateMarker,
  onDeleteMarker,
  onTrackDoubleClick,
  running,
}: MarkerLaneProps): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  function beginEdit(e: React.MouseEvent, marker: Marker): void {
    e.stopPropagation()
    if (running) return
    setEditingId(marker.id)
    setEditingLabel(marker.label ?? '')
  }

  function saveLabel(marker: Marker): void {
    // An edit already open when the Live session starts is abandoned, not saved.
    if (running) {
      setEditingId(null)
      return
    }
    const trimmed = editingLabel.trim() || null
    // One write, through the one Marker seam, carrying the position the drag left
    // the Marker at rather than the one the props still say.
    if (trimmed !== marker.label) {
      onUpdateMarker(marker.id, dragOverride[marker.id] ?? marker.positionMs, trimmed)
    }
    setEditingId(null)
  }

  return (
    <div
      style={{
        height,
        width,
        background: '#1e1e1e',
        position: 'relative',
        borderTop: '1px solid #2a2a2a',
        cursor: 'crosshair',
      }}
      onDoubleClick={running ? undefined : onTrackDoubleClick}
    >
      {markers.map((marker) => {
        const effectivePositionMs = dragOverride[marker.id] ?? marker.positionMs
        const leftPx = pxAtMs(effectivePositionMs, zoomPxPerSec)
        const isEditing = editingId === marker.id
        const isHovered = hoveredId === marker.id

        return (
          <div
            key={marker.id}
            style={{
              position: 'absolute',
              left: leftPx,
              top: 0,
              height,
              width: 1,
              zIndex: 10,
            }}
            onMouseEnter={() => setHoveredId(marker.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            {/* Dotted vertical line */}
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '2px',
                height,
                borderLeft: '2px dashed #f39c12',
                cursor: running ? 'default' : 'ew-resize',
              }}
              onMouseDown={(e) => onMarkerMouseDown(e, marker)}
            />

            {/* Label / inline edit */}
            {isEditing ? (
              <input
                autoFocus
                value={editingLabel}
                onChange={(e) => setEditingLabel(e.target.value)}
                onBlur={() => saveLabel(marker)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveLabel(marker)
                  if (e.key === 'Escape') setEditingId(null)
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
                  cursor: running ? 'default' : 'text',
                  userSelect: 'none',
                }}
                onClick={(e) => beginEdit(e, marker)}
              >
                {marker.label ?? ''}
              </span>
            )}

            {/* Delete button on hover — never during a Live session */}
            {isHovered && !isEditing && !running && (
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

      {/* The hint is also the only affordance, so it goes while it would be a lie */}
      {markers.length === 0 && !running && (
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
  )
}

export const MarkerLane = React.memo(MarkerLaneImpl)
