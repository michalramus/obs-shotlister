/**
 * The item Track: one block per Shot, or per Call in a Voice-over Rundown.
 *
 * The largest lane by node count — a 150-Shot Rundown is roughly 900 nodes once
 * labels, warning flags, transition triangles and boundary handles are counted —
 * and none of it moves while the playhead does. Memoised so a playback commit
 * reconciles none of it.
 *
 * Handlers arrive as one stable object rather than as separate props: they close
 * over most of the editor's state, so the parent keeps them current through a ref
 * instead of a dependency list. A stale dependency list here would break dragging
 * in ways a type checker cannot see.
 */

import React from 'react'
import { pxAtMs } from '../../timeline/coordinates'
import { isUnassigned } from '../../../shared/rundown-item'
import type { AnnouncementProblem } from '../../timeline/lyrics'
import type { Shot, RundownKind } from '../../../shared/types'
import { ANNOUNCEMENT_PROBLEM_COLOR, ANNOUNCEMENT_PROBLEM_TITLE } from './announcement-problem'
import type { ItemTarget } from './OverviewBar'

export interface ItemLaneHandlers {
  onTrackClick: (e: React.MouseEvent) => void
  onBlockClick: (e: React.MouseEvent, shotId: string) => void
  onOpenContextMenu: (x: number, y: number, shotId: string) => void
  onBoundaryMouseDown: (e: React.MouseEvent, shot: Shot, nextShot: Shot) => void
  /** Begins the drag that lengthens the final Shot past its current end. */
  onExtendMouseDown: (e: React.MouseEvent, shot: Shot, currentDurationMs: number) => void
}

interface ItemLaneProps {
  shots: Shot[]
  shotOffsets: number[]
  dragOverride: Record<string, number>
  itemTargets: Map<string, ItemTarget>
  announcementProblems: ReadonlyMap<string, AnnouncementProblem>
  rundownKind: RundownKind
  isVoice: boolean
  liveIndex: number | null
  zoomPxPerSec: number
  width: number
  height: number
  unassignedColor: string
  handlers: ItemLaneHandlers
}

function ItemLaneImpl({
  shots,
  shotOffsets,
  dragOverride,
  itemTargets,
  announcementProblems,
  rundownKind,
  isVoice,
  liveIndex,
  zoomPxPerSec,
  width,
  height,
  unassignedColor,
  handlers,
}: ItemLaneProps): React.JSX.Element {
  return (
    <div
      style={{
        height,
        width,
        background: '#0d0d0d',
        position: 'relative',
        cursor: 'crosshair',
      }}
      onClick={handlers.onTrackClick}
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
          const target = itemTargets.get(shot.id) ?? {
            color: unassignedColor,
            label: '',
            title: '',
          }
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
                  height,
                  background: unassigned
                    ? `repeating-linear-gradient(45deg, ${unassignedColor}, ${unassignedColor} 6px, #2c2c2c 6px, #2c2c2c 12px)`
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
                onClick={(e) => handlers.onBlockClick(e, shot.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handlers.onOpenContextMenu(e.clientX, e.clientY, shot.id)
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
                      // Must not take the pointer: the block behind it carries the
                      // full tooltip (name, duration *and* the warning), and a flag
                      // that swallowed hover would show only half of it — on
                      // exactly the sliver-wide Calls this warning is about.
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
                    height,
                    pointerEvents: 'none',
                    zIndex: 5,
                  }}
                >
                  <polygon
                    points={`0,0 ${triWidthPx},0 0,${height}`}
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
                    height,
                    cursor: 'ew-resize',
                    background: 'transparent',
                    zIndex: 10,
                  }}
                  onMouseDown={(e) => handlers.onBoundaryMouseDown(e, shot, nextShot)}
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
                height,
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
              onMouseDown={(e) => handlers.onExtendMouseDown(e, lastShot, lastDur)}
            />
          )
        })()}
    </div>
  )
}

export const ItemLane = React.memo(ItemLaneImpl)
