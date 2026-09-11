/**
 * Default colour palette for cameras.
 *
 * Cameras are identified by colour at a glance — on the timeline, in the shot
 * list, and on the phone badges — so the palette is ordered to keep adjacent
 * picks far apart in hue. Every entry is light enough to read against the dark
 * UI background and against white badge text.
 */
export const CAMERA_PALETTE: readonly string[] = [
  '#e74c3c', // red
  '#3498db', // blue
  '#2ecc71', // green
  '#f39c12', // amber
  '#9b59b6', // purple
  '#1abc9c', // teal
  '#e67e22', // orange
  '#4a90d9', // sky
  '#f1c40f', // yellow
  '#e91e63', // pink
  '#27ae60', // emerald
  '#5c6bc0', // indigo
  '#d35400', // pumpkin
  '#00bcd4', // cyan
  '#8bc34a', // light green
  '#8e44ad', // dark purple
  '#2980b9', // dark blue
  '#ff6b81', // rose
  '#c0ca33', // citron
  '#607d8b', // blue grey
  '#e8590c', // dark orange
  '#795548', // brown
  '#95a5a6', // grey
  '#bdc3c7', // silver
]

/**
 * The colour to assign to the next new camera: the first palette entry not
 * already taken in this project, so colours stay distinct while any remain.
 *
 * Once every entry is in use the palette wraps, which is why this can repeat a
 * colour rather than failing — a project with more than
 * {@link CAMERA_PALETTE}.length cameras is expected to have duplicates.
 */
export function nextCameraColor(existing: ReadonlyArray<{ color: string }>): string {
  const taken = new Set(existing.map((c) => c.color.trim().toLowerCase()))
  const unused = CAMERA_PALETTE.find((color) => !taken.has(color.toLowerCase()))
  return unused ?? CAMERA_PALETTE[existing.length % CAMERA_PALETTE.length]
}
