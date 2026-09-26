/**
 * IPC handler logic for shot CRUD and reorder operations.
 *
 * Nothing here knows what a row looks like: the `shots` table is owned by
 * src/main/db/rundown-items.ts, and these functions only translate an IPC
 * payload into a call on it. What is left is the policy the operator's actions
 * imply — where a new item lands, what a split inherits.
 *
 * Each function accepts a Database instance so it can be tested with an
 * in-memory database without requiring an Electron context.
 *
 * IPC registration (ipcMain.handle) happens in src/main/index.ts.
 */

import Database from 'better-sqlite3'
import type { Shot } from '../../shared/types'
import type {
  CreateShotInput,
  UpdateShotInput,
  SplitShotInput,
  DeleteShotMode,
} from '../../shared/ipc-contract'
import {
  deleteItem,
  getItem,
  insertItem,
  listItems,
  reorderItems,
  shiftOrderAfter,
  updateItem,
} from '../db/rundown-items'

export function listShots(db: Database.Database, rundownId: string): Shot[] {
  return listItems(db, rundownId)
}

export function createShot(db: Database.Database, input: CreateShotInput): Shot {
  // No orderIndex: a created item goes to the end of the Rundown.
  return insertItem(db, input)
}

export function updateShot(db: Database.Database, input: UpdateShotInput): Shot {
  // `input` carries its own id, which updateItem ignores as a patch field —
  // absent-vs-null is decided there, for every writer at once.
  return updateItem(db, input.id, input)
}

export function deleteShot(
  db: Database.Database,
  id: string,
  mode: DeleteShotMode = 'extend',
): void {
  deleteItem(db, id, mode)
}

export function reorderShots(db: Database.Database, ids: string[]): void {
  reorderItems(db, ids)
}

export function splitShot(
  db: Database.Database,
  input: SplitShotInput,
): { first: Shot; second: Shot } {
  const existing = getItem(db, input.shotId)
  if (!existing) throw new Error(`Shot not found: ${input.shotId}`)
  if (input.atMs <= 0 || input.atMs >= existing.durationMs) {
    throw new Error(`Invalid split position: ${input.atMs} (shot duration: ${existing.durationMs})`)
  }

  let first!: Shot
  let second!: Shot
  db.transaction(() => {
    shiftOrderAfter(db, existing.rundownId, existing.orderIndex)
    first = updateItem(db, input.shotId, { durationMs: input.atMs })
    // The half that is split off inherits whichever target the caller did not
    // name, so splitting a Call in a Voice-over Rundown does not silently
    // produce an item with no Part — which a Live session would then refuse to
    // start on. It starts on a cut with no label: the Transition belongs to the
    // item being transitioned into, and the first half keeps it.
    second = insertItem(db, {
      rundownId: existing.rundownId,
      cameraId: input.newCameraId ?? existing.cameraId,
      partId: input.newPartId ?? existing.partId,
      durationMs: existing.durationMs - input.atMs,
      label: null,
      orderIndex: existing.orderIndex + 1,
      transitionName: null,
      transitionMs: 0,
    })
  })()

  return { first, second }
}
