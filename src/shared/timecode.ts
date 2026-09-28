/**
 * Resolve timecode, parsed in one place.
 *
 * The import dialog previews what a CSV will produce and the main process then
 * writes it, and the two used to parse timecode separately — the preview
 * returning null where the writer threw. A drop-frame timecode therefore
 * previewed as an unflagged raw string, passed the "Import 42 shots" button,
 * and then threw inside the transaction, rolling the whole import back with
 * nothing on screen to say why.
 */

/** Parses HH:MM:SS:FF to milliseconds, throwing on anything malformed. */
export function parseTimecode(timecode: string, fps: number): number {
  const ms = tryParseTimecode(timecode, fps)
  if (ms === null) {
    if (!Number.isFinite(fps) || fps <= 0) throw new Error(`Invalid fps: ${fps}`)
    throw new Error(`Invalid timecode: "${timecode}". Expected HH:MM:SS:FF`)
  }
  return ms
}

/**
 * The same parse, reporting failure as null.
 *
 * What the preview needs: one bad row should mark that row, not abort the
 * table. Drop-frame timecode (`00:00:05;12`) fails here, which is the point —
 * it is exactly what the writer would refuse.
 */
export function tryParseTimecode(timecode: string, fps: number): number | null {
  if (!Number.isFinite(fps) || fps <= 0) return null
  const parts = timecode.split(':')
  if (parts.length !== 4) return null

  const nums = parts.map((p) => (/^\d+$/.test(p.trim()) ? Number.parseInt(p, 10) : NaN))
  if (nums.some((n) => Number.isNaN(n))) return null

  const [hh, mm, ss, ff] = nums as [number, number, number, number]
  return (hh * 3600 + mm * 60 + ss) * 1000 + Math.round((ff / fps) * 1000)
}
