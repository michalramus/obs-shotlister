/**
 * The mini overview strip under the timeline.
 *
 * One div per Shot, plus the viewport rect and the playhead marker. Memoised for
 * the same reason as the ruler: on a 150-Shot Rundown that is 150 nodes React was
 * reconciling on every playback commit, and none of them move while the playhead
 * does.
 *
 * The playhead marker is the exception, and it is deliberately not driven from
 * props: `paintPlayhead` writes its `left` directly every frame, so rendering a
 * position here as well would overwrite a fresh value with a stale one ten times a
 * second. The parent repaints it whenever the geometry behind it changes.
 */

import React, { useEffect, useRef } from 'react'
import { pxAtMs } from '../../timeline/coordinates'
import type { Shot } from '../../../shared/types'

export interface ItemTarget {
  color: string
  label: string
  title: string
}

interface OverviewBarProps {
  shots: Shot[]
  /** Pixel offset of each Shot on the full-width timeline, index-aligned. */
  shotOffsets: number[]
  dragOverride: Record<string, number>
  itemTargets: Map<string, ItemTarget>
  zoomPxPerSec: number
  totalPx: number
  totalMs: number
  overviewWidth: number
  scrollerWidth: number
  scrollLeft: number
  height: number
  overviewRef: React.RefObject<HTMLDivElement>
  playheadElRef: React.MutableRefObject<HTMLDivElement | null>
  viewportRectElRef: React.MutableRefObject<HTMLDivElement | null>
  /** Scrolls the timeline so `scrollLeftPx` is at the left edge. */
  onScrollTo: (scrollLeftPx: number) => void
  /** Current scroll position, read at drag start without going through a render. */
  readScrollLeft: () => number
}

function OverviewBarImpl({
  shots,
  shotOffsets,
  dragOverride,
  itemTargets,
  zoomPxPerSec,
  totalPx,
  totalMs,
  overviewWidth,
  scrollerWidth,
  scrollLeft,
  height,
  overviewRef,
  playheadElRef,
  viewportRectElRef,
  onScrollTo,
  readScrollLeft,
}: OverviewBarProps): React.JSX.Element {
  /**
   * Ends the viewport-rect drag, whoever ends it.
   *
   * Its window listeners used to be removed by their own `mouseup` and by nothing
   * else, so a release the window never heard — the pointer let go over another
   * window, focus lost to a dialog, this component unmounted mid-drag — left the
   * view following the bare pointer with no button held. Held in a ref because the
   * teardown is built inside the handler and has to be reachable from outside it.
   */
  const endDragRef = useRef<(() => void) | null>(null)
  useEffect(() => () => endDragRef.current?.(), [])

  return (
    <div
      ref={overviewRef}
      style={{
        height,
        background: '#111',
        flexShrink: 0,
        position: 'relative',
        borderTop: '1px solid #333',
        cursor: 'pointer',
        overflow: 'hidden',
      }}
      onClick={(e) => {
        const ow = overviewRef.current?.clientWidth ?? 1
        const left = overviewRef.current?.getBoundingClientRect().left ?? 0
        onScrollTo(((e.clientX - left) / ow) * totalPx - scrollerWidth / 2)
      }}
    >
      {/* Shot blocks in overview */}
      {shots.map((shot, i) => {
        const left = (shotOffsets[i] / totalPx) * overviewWidth
        const width =
          pxAtMs(dragOverride[shot.id] ?? shot.durationMs, zoomPxPerSec) * (overviewWidth / totalPx)
        return (
          <div
            key={shot.id}
            style={{
              position: 'absolute',
              left,
              top: 0,
              width: Math.max(1, width),
              height,
              background: itemTargets.get(shot.id)?.color ?? '#3a3a3a',
            }}
          />
        )
      })}

      {/* Playhead line in overview — position owned by paintPlayhead, not by React. */}
      {totalMs > 0 && (
        <div
          ref={playheadElRef}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 1,
            height,
            background: '#e74c3c',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />
      )}

      {/* Viewport rect */}
      {totalPx > 0 &&
        (() => {
          const vpLeft = (scrollLeft / totalPx) * overviewWidth
          const vpRight = Math.min(
            overviewWidth,
            vpLeft + (scrollerWidth / totalPx) * overviewWidth,
          )
          return (
            <div
              ref={viewportRectElRef}
              style={{
                position: 'absolute',
                left: vpLeft,
                top: 0,
                width: Math.max(4, vpRight - vpLeft),
                height,
                border: '2px solid white',
                background: 'rgba(255,255,255,0.1)',
                boxSizing: 'border-box',
                cursor: 'ew-resize',
                zIndex: 10,
              }}
              // The rect sits inside the strip's "centre the viewport on the
              // pointer" handler, and stopping `mousedown` does not stop the
              // `click` the browser synthesises on release. Dragging the rect
              // therefore ended with the view jumping back to wherever the pointer
              // happened to let go — about half a viewport, every time.
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => {
                e.stopPropagation()
                // Whatever a previous drag left behind, in case one survived.
                endDragRef.current?.()
                const startX = e.clientX
                const origScroll = readScrollLeft()
                const ow = overviewRef.current?.clientWidth ?? 300
                function onMM(ev: MouseEvent): void {
                  // No pointer capture to lean on, so the button state is the only
                  // evidence a release happened out of earshot: a move with nothing
                  // held is the pointer coming back from wherever it was let go.
                  if (ev.buttons === 0) {
                    end()
                    return
                  }
                  onScrollTo(origScroll + ((ev.clientX - startX) * totalPx) / ow)
                }
                function end(): void {
                  endDragRef.current = null
                  window.removeEventListener('mousemove', onMM)
                  window.removeEventListener('mouseup', end)
                  window.removeEventListener('blur', end)
                }
                endDragRef.current = end
                window.addEventListener('mousemove', onMM)
                window.addEventListener('mouseup', end)
                // Focus leaving the window — a native drag, an OS dialog — takes
                // the mouseup with it.
                window.addEventListener('blur', end)
              }}
            />
          )
        })()}
    </div>
  )
}

export const OverviewBar = React.memo(OverviewBarImpl)
