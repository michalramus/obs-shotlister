/**
 * The time ruler.
 *
 * Extracted and memoised because it is the largest thing on the timeline and the
 * least interesting: an hour-long Rundown is 727 tick divs plus 121 labels, more
 * than a third of the timeline's DOM, and none of it depends on the playhead. Left
 * inline, React reconciled all of it on every playback commit for nothing.
 *
 * Ticks are supplied already computed so this component has no opinion about
 * spacing and no reason to re-render while the playhead moves.
 */

import React from 'react'

export interface Tick {
  px: number
  major: boolean
  label?: string
}

interface RulerLaneProps {
  ticks: Tick[]
  width: number
  height: number
}

function RulerLaneImpl({ ticks, width, height }: RulerLaneProps): React.JSX.Element {
  return (
    <div
      style={{
        height,
        width,
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
  )
}

export const RulerLane = React.memo(RulerLaneImpl)
