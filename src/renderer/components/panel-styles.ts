import type React from 'react'

// ---------------------------------------------------------------------------
// Panel styles
//
// Every modal in this folder — Cameras, Parts, OBS, OSC, Voice & audio — grew
// its own `const s = {…}` block, and nineteen keys ended up repeated three to
// five times over. Duplicated style is only cosmetic until a component is
// duplicated with it: the palette strip was copied byte-for-byte between two
// panels precisely because its styles were already there, and one bug then
// needed fixing twice.
//
// A panel still keeps the keys only it draws. What lives here is what more than
// one of them draws, so a change to the shared chrome is one edit.
// ---------------------------------------------------------------------------

/** What a panel picks for itself: the card is the same, its size is not. */
export interface PanelSize {
  width: string
  maxHeight: string
  gap: string
}

export const ps = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  } satisfies React.CSSProperties,

  /** The modal card. Width and height are the panel's own business. */
  panel: (size: PanelSize): React.CSSProperties => ({
    background: '#1e1e1e',
    borderRadius: '10px',
    border: '1px solid #444',
    padding: '28px',
    maxWidth: '95vw',
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    ...size,
  }),

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  title: {
    margin: 0,
    fontSize: '17px',
    fontWeight: 600,
    color: '#fff',
  } satisfies React.CSSProperties,

  sectionTitle: {
    margin: '0 0 10px',
    fontSize: '13px',
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } satisfies React.CSSProperties,

  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#aaa',
    fontSize: '20px',
    cursor: 'pointer',
    lineHeight: 1,
    padding: '4px 8px',
  } satisfies React.CSSProperties,

  label: {
    fontSize: '12px',
    color: '#888',
    marginBottom: '4px',
    display: 'block',
  } satisfies React.CSSProperties,

  /** A field standing on its own in a form. */
  input: {
    padding: '8px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#fff',
    width: '100%',
    boxSizing: 'border-box' as const,
  } satisfies React.CSSProperties,

  /** The same field inside a table row, where the padding has to give way. */
  cellInput: {
    padding: '5px 8px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#fff',
    width: '100%',
    boxSizing: 'border-box' as const,
  } satisfies React.CSSProperties,

  numberInput: {
    padding: '5px 8px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#fff',
    width: '56px',
    boxSizing: 'border-box' as const,
  } satisfies React.CSSProperties,

  select: {
    padding: '5px 8px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#fff',
    width: '100%',
    boxSizing: 'border-box' as const,
  } satisfies React.CSSProperties,

  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '14px',
  } satisfies React.CSSProperties,

  th: {
    textAlign: 'left' as const,
    padding: '6px 8px',
    color: '#888',
    fontWeight: 500,
    borderBottom: '1px solid #333',
    fontSize: '12px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } satisfies React.CSSProperties,

  td: {
    padding: '6px 8px',
    verticalAlign: 'middle' as const,
    borderBottom: '1px solid #2a2a2a',
    color: '#ddd',
  } satisfies React.CSSProperties,

  errorText: {
    color: '#e74c3c',
    fontSize: '13px',
    margin: 0,
  } satisfies React.CSSProperties,

  iconBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    fontSize: '16px',
    padding: '4px',
    borderRadius: '4px',
  } satisfies React.CSSProperties,

  addBtn: {
    padding: '7px 14px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px dashed #555',
    background: 'none',
    color: '#aaa',
    cursor: 'pointer',
    alignSelf: 'flex-start' as const,
  } satisfies React.CSSProperties,

  cancelBtn: {
    padding: '6px 14px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#3a3a3a',
    color: '#ccc',
    cursor: 'pointer',
  } satisfies React.CSSProperties,

  dangerBtn: {
    padding: '6px 14px',
    fontSize: '14px',
    borderRadius: '4px',
    border: 'none',
    background: '#c0392b',
    color: '#fff',
    cursor: 'pointer',
  } satisfies React.CSSProperties,

  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    fontSize: '14px',
    color: '#ccc',
  } satisfies React.CSSProperties,

  toggleTrack: (on: boolean): React.CSSProperties => ({
    width: '44px',
    height: '24px',
    borderRadius: '12px',
    background: on ? '#27ae60' : '#555',
    border: 'none',
    cursor: 'pointer',
    position: 'relative',
    flexShrink: 0,
    transition: 'background 0.2s',
  }),

  toggleThumb: (on: boolean): React.CSSProperties => ({
    position: 'absolute',
    top: '2px',
    left: on ? '22px' : '2px',
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    background: '#fff',
    transition: 'left 0.15s',
  }),

  // --- A dialog stacked on top of a panel ---

  confirmOverlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1100,
  } satisfies React.CSSProperties,

  confirmDialog: {
    background: '#2a2a2a',
    borderRadius: '8px',
    padding: '24px',
    minWidth: '320px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
    border: '1px solid #444',
  } satisfies React.CSSProperties,

  confirmTitle: {
    margin: 0,
    fontSize: '15px',
    fontWeight: 600,
    color: '#fff',
  } satisfies React.CSSProperties,

  confirmBody: {
    margin: 0,
    color: '#ccc',
    fontSize: '14px',
  } satisfies React.CSSProperties,

  /** The buttons at the foot of a dialog. */
  buttonRow: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
  } satisfies React.CSSProperties,
}
