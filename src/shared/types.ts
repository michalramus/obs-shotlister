export interface Project {
  id: string
  name: string
  createdAt: number
}

export interface Camera {
  id: string
  projectId: string
  number: number
  name: string
  color: string // hex, e.g. '#e74c3c'
  resolveColor: string | null // Resolve marker color name, e.g. 'Red'
  obsScene: string | null // OBS scene name
}

/**
 * Which sort of item a Rundown is made of. A Camera Rundown holds Shots and
 * drives OBS; a Voice-over Rundown holds Calls and speaks Announcements. Not to
 * be confused with Edit and Live mode, which are views onto either Kind.
 */
export type RundownKind = 'camera' | 'voice'

export interface Rundown {
  id: string
  projectId: string
  name: string
  createdAt: number
  orderIndex: number
  folder: string | null
  kind: RundownKind
}

/**
 * One item of a Rundown: a Shot in a Camera Rundown, a Call in a Voice-over one.
 *
 * Both Kinds share this one shape, and the owning Rundown's Kind decides which
 * target is read — `cameraId` for a Shot, `partId` for a Call. Both are kept
 * across a conversion, so converting a Rundown away from its Kind and back
 * restores the original assignments exactly. An item whose target for the
 * current Kind is null is unassigned, and a Live session refuses to start.
 */
export interface Shot {
  id: string
  rundownId: string
  cameraId: string | null
  partId: string | null
  durationMs: number
  label: string | null
  orderIndex: number
  hidden?: boolean
  transitionName: string | null
  transitionMs: number // 0 = cut / no transition
}

export interface Marker {
  id: string
  rundownId: string
  positionMs: number
  label: string | null
}

/**
 * A named moment of a song within a Project — "gitara", "wokal 1", "refren".
 * The Voice-over counterpart of a Camera: defined once, referenced by many Calls.
 *
 * Scope is additive (ADR 0006). A Part with neither `folder` nor `rundownId` is
 * Project-scoped and visible everywhere; one with a `folder` is visible to that
 * folder's Rundowns; one with a `rundownId` only to that Rundown. A narrower
 * scope can only add Parts, never hide a broader one, so `number` is unique
 * across the whole Project and a Part means the same thing wherever it is seen.
 */
export interface Part {
  id: string
  projectId: string
  number: number
  name: string
  color: string // hex, e.g. '#e74c3c'
  folder: string | null
  rundownId: string | null
}

/**
 * One line of song text on the Lyrics Track, with its own in and out points.
 *
 * Purely an orientation aid for the operator: never spoken, never sent to the
 * Phone view or the Cue Tray. Lines on one Rundown must be disjoint.
 */
export interface Lyric {
  id: string
  rundownId: string
  startMs: number
  endMs: number
  text: string
}
