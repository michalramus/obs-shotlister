import React from 'react'
import { CAMERA_PALETTE } from '../../shared/camera-palette'

// ---------------------------------------------------------------------------
// Colour picking
//
// A Camera's colour and a Part's colour are picked exactly the same way and were
// drawn by two byte-identical copies of this file's contents. One copy is the
// point: a swatch is a button, and a button commits nothing on blur, so the bug
// where a palette pick was never saved existed twice over. It is fixed once here
// and once in `useDraftRow`, which is what a picked colour reaches.
// ---------------------------------------------------------------------------

const cs = {
  colorCell: {
    position: 'relative' as const,
    display: 'inline-block',
  } satisfies React.CSSProperties,

  colorSwatch: {
    display: 'inline-block',
    width: '28px',
    height: '28px',
    borderRadius: '4px',
    border: '2px solid #555',
    cursor: 'pointer',
    verticalAlign: 'middle',
  } satisfies React.CSSProperties,

  // The OS picker is the real control; the swatch above is what it looks like.
  colorInput: {
    position: 'absolute' as const,
    opacity: 0,
    width: '28px',
    height: '28px',
    cursor: 'pointer',
    top: 0,
    left: 0,
  } satisfies React.CSSProperties,

  paletteStrip: {
    display: 'grid',
    gridTemplateColumns: 'repeat(12, 1fr)',
    gap: '2px',
    marginTop: '4px',
    width: '132px',
  } satisfies React.CSSProperties,

  paletteSwatch: {
    width: '9px',
    height: '9px',
    borderRadius: '2px',
    border: '1px solid rgba(0,0,0,0.4)',
    padding: 0,
    cursor: 'pointer',
  } satisfies React.CSSProperties,
}

export interface ColorSwatchProps {
  /** The colour shown, or null for "not chosen yet". */
  value: string | null
  label: string
  /** What the swatch says on hover when nothing is chosen. */
  emptyTitle?: string
  onChange: (color: string) => void
  /** Commits a colour dragged out of the OS picker, where a row commits on blur. */
  onBlur?: () => void
  disabled?: boolean
}

/** The current colour, with the OS picker hidden behind it. */
export function ColorSwatch({
  value,
  label,
  emptyTitle,
  onChange,
  onBlur,
  disabled,
}: ColorSwatchProps): React.JSX.Element {
  return (
    <div style={cs.colorCell}>
      <div
        style={{ ...cs.colorSwatch, background: value ?? 'transparent' }}
        title={value ?? emptyTitle}
      />
      <input
        type="color"
        style={cs.colorInput}
        value={value ?? '#000000'}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={disabled}
      />
    </div>
  )
}

export interface PaletteStripProps {
  selected: string
  onPick: (color: string) => void
  disabled?: boolean
}

/** The default palette as clickable swatches, so it is reachable without the OS picker. */
export function PaletteStrip({ selected, onPick, disabled }: PaletteStripProps): React.JSX.Element {
  return (
    <div style={cs.paletteStrip} role="group" aria-label="Palette colors">
      {CAMERA_PALETTE.map((c) => {
        const isSelected = c.toLowerCase() === selected.trim().toLowerCase()
        return (
          <button
            key={c}
            type="button"
            title={c}
            aria-label={c}
            aria-pressed={isSelected}
            disabled={disabled}
            onClick={() => onPick(c)}
            style={{
              ...cs.paletteSwatch,
              background: c,
              outline: isSelected ? '2px solid #fff' : 'none',
              outlineOffset: isSelected ? '1px' : undefined,
            }}
          />
        )
      })}
    </div>
  )
}
