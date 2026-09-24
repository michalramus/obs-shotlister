/**
 * What an item of a Rundown points at, whichever Kind it belongs to.
 *
 * A Shot names a Camera and a Call names a Part, and both live in one table
 * with both columns kept across a conversion. So every view — the operator's
 * shot list, the timeline, the Phone view — needs the same three answers: which
 * column this Kind reads, whether the item is assigned, and what to draw for it.
 *
 * Each of those had grown its own copy, which is how the timeline and the Phone
 * view came to disagree about the colour of an out-of-scope Part. They resolve
 * through here instead.
 */

import type { Camera, Part, RundownKind, Shot } from './types'

/**
 * A Camera or a Part, reduced to what a view needs of it.
 *
 * The two are modelled the same way on purpose — a Part is the Voice-over
 * counterpart of a Camera — so one shape serves both and no view has to branch
 * on Kind once it holds one of these.
 */
export interface ItemTarget {
  id: string
  number: number
  /** Short form for a badge: `CAM1` for a Camera, the number for a Part. */
  badge: string
  name: string
  color: string
}

/** Shown when an item's target for its Kind is missing or out of scope. */
export const UNASSIGNED_COLOR = '#555'

export function cameraTarget(camera: Camera): ItemTarget {
  return {
    id: camera.id,
    number: camera.number,
    badge: `CAM${camera.number}`,
    name: camera.name,
    color: camera.color,
  }
}

export function partTarget(part: Part): ItemTarget {
  return {
    id: part.id,
    number: part.number,
    badge: String(part.number),
    name: part.name,
    color: part.color,
  }
}

/** Everything a Rundown of this Kind can assign to, in number order. */
export function targetsOf(kind: RundownKind, cameras: Camera[], parts: Part[]): ItemTarget[] {
  const targets = kind === 'voice' ? parts.map(partTarget) : cameras.map(cameraTarget)
  return targets.slice().sort((a, b) => a.number - b.number)
}

/**
 * The id this item is assigned to under its Rundown's Kind.
 *
 * The other column may well be filled — both survive a conversion — and reading
 * it would put a Camera on air during a Voice-over Rundown.
 */
export function targetIdOf(item: Shot, kind: RundownKind): string | null {
  return kind === 'voice' ? item.partId : item.cameraId
}

/** True when the item has no target for its Rundown's Kind. */
export function isUnassigned(item: Shot, kind: RundownKind): boolean {
  return targetIdOf(item, kind) === null
}

/**
 * What one item displays as, or `undefined` when nothing resolves.
 *
 * Undefined covers two different facts the caller has to tell apart: the item
 * is unassigned, or it points at a Part outside this Rundown's scope. The
 * second is still a real assignment (ADR 0006) — only its name and colour are
 * unavailable here — so use {@link isUnassigned} to decide which happened
 * rather than treating a missing target as an unassigned one.
 */
export function targetOf(
  item: Shot,
  kind: RundownKind,
  targets: ReadonlyMap<string, ItemTarget>,
): ItemTarget | undefined {
  const id = targetIdOf(item, kind)
  return id === null ? undefined : targets.get(id)
}

/** Indexes targets by id, which is how every view looks them up per row. */
export function targetsById(targets: ItemTarget[]): Map<string, ItemTarget> {
  return new Map(targets.map((t) => [t.id, t]))
}

/** What to call the thing this Kind assigns, for prompts and refusals. */
export function targetNoun(kind: RundownKind): 'Part' | 'Camera' {
  return kind === 'voice' ? 'Part' : 'Camera'
}
