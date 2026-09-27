/**
 * The Lyrics Track: one block per Lyric, the pending In mark, and the input the
 * line is typed into.
 *
 * Memoised for the same reason as the other lanes: a Rundown's worth of sung
 * lines is a block, two edge handles and a delete button each, and none of it
 * moves while the playhead does — only which line is current, which is one prop.
 *
 * Presentational, and deliberately so. The lane knows pixels; every rule about
 * what In and Out mean lives in `timeline/lyric-authoring`, and the geometry
 * arrives already computed so this component has no opinion about zoom and no
 * reason to re-render when it changes for any other reason.
 *
 * Hover is the exception, held here rather than one level up: as a `useState` in
 * the parent, running the pointer along the lane re-rendered the whole timeline
 * to show two edge handles.
 */

import React, { useState } from 'react'
import type { LyricBlock } from '../../timeline/lyrics'

/** The draft, with its geometry already resolved by the caller. */
export interface LyricDraftBox {
  text: string
  leftPx: number
  widthPx: number
}

export interface LyricsLaneHandlers {
  /** The lane's background: drops the selection and places the Playhead. */
  onLaneClick: (e: React.MouseEvent<HTMLDivElement>) => void
  onSelect: (id: string) => void
  /** Double-click: re-word an existing line. */
  onReword: (id: string) => void
  onDelete: (id: string) => void
  onEdgeMouseDown: (e: React.MouseEvent, id: string, edge: 'start' | 'end') => void
  onDraftChange: (text: string) => void
  onDraftCommit: () => void
  onDraftCancel: () => void
}

interface LyricsLaneProps {
  blocks: LyricBlock[]
  selectedId: string | null
  /** The line the Playhead is inside: the whole point of the lane. */
  currentId: string | null
  draft: LyricDraftBox | null
  /** Where an In point waiting for its Out sits, or null when none does. */
  pendingInLeftPx: number | null
  width: number
  height: number
  /**
   * Edge handles and the delete button are hidden during a Live session: nothing
   * here is editable. Re-wording is refused by the caller for the same reason.
   */
  running: boolean
  handlers: LyricsLaneHandlers
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

function LyricsLaneImpl({
  blocks,
  selectedId,
  currentId,
  draft,
  pendingInLeftPx,
  width,
  height,
  running,
  handlers,
}: LyricsLaneProps): React.JSX.Element {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  return (
    <div
      // The coordinate frame for an edge drag: the pointer routinely leaves the
      // block it is resizing, so the adapter measures against the lane.
      data-lyrics-lane=""
      style={{
        height,
        width,
        background: '#141414',
        position: 'relative',
        borderTop: '1px solid #2a2a2a',
        cursor: 'crosshair',
        overflow: 'hidden',
      }}
      onClick={handlers.onLaneClick}
    >
      {blocks.map((block) => {
        const isSelected = selectedId === block.id
        const isHovered = hoveredId === block.id
        const isCurrent = currentId === block.id
        return (
          <div
            key={block.id}
            style={{
              position: 'absolute',
              left: block.leftPx,
              top: 3,
              width: block.widthPx,
              height: height - 6,
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
            onMouseEnter={() => setHoveredId(block.id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={(e) => {
              e.stopPropagation()
              handlers.onSelect(block.id)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              handlers.onReword(block.id)
            }}
          >
            {block.text}
            {(isHovered || isSelected) && !running && (
              <>
                <LyricEdgeHandle
                  side="start"
                  onDown={(e) => handlers.onEdgeMouseDown(e, block.id, 'start')}
                />
                <LyricEdgeHandle
                  side="end"
                  onDown={(e) => handlers.onEdgeMouseDown(e, block.id, 'end')}
                />
              </>
            )}
            {isHovered && !running && (
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
                  handlers.onDelete(block.id)
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
      {pendingInLeftPx !== null && draft === null && (
        <div
          style={{
            position: 'absolute',
            left: pendingInLeftPx,
            top: 0,
            width: '2px',
            height,
            borderLeft: '2px dashed #5dade2',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Typing the line, once its in and out points are fixed */}
      {draft !== null && (
        <input
          autoFocus
          value={draft.text}
          onChange={(e) => handlers.onDraftChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') handlers.onDraftCommit()
            if (e.key === 'Escape') handlers.onDraftCancel()
          }}
          placeholder="line of lyrics"
          style={{
            position: 'absolute',
            left: draft.leftPx,
            top: 3,
            width: draft.widthPx,
            height: height - 6,
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

      {blocks.length === 0 && draft === null && (
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
  )
}

export const LyricsLane = React.memo(LyricsLaneImpl)
