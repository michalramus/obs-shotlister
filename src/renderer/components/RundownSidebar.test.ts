import { describe, it, expect } from 'vitest'
import {
  visibleFolderNames,
  foldersFromRundowns,
  dedupeFolders,
  type LocalFolder,
} from './RundownSidebar'
import type { Rundown } from '../../shared/types'

function rundown(id: string, projectId: string, folder: string | null): Rundown {
  return { id, projectId, name: id, createdAt: 0, orderIndex: 0, folder }
}

describe('foldersFromRundowns', () => {
  it('tags each folder with its own rundown project', () => {
    expect(
      foldersFromRundowns([rundown('r1', 'p1', 'Day 1'), rundown('r2', 'p2', 'Day 2')]),
    ).toEqual([
      { projectId: 'p1', name: 'Day 1' },
      { projectId: 'p2', name: 'Day 2' },
    ])
  })

  it('ignores ungrouped rundowns', () => {
    expect(foldersFromRundowns([rundown('r1', 'p1', null)])).toEqual([])
  })
})

describe('dedupeFolders', () => {
  it('keeps same-named folders from different projects apart', () => {
    const folders: LocalFolder[] = [
      { projectId: 'p1', name: 'Day 1' },
      { projectId: 'p2', name: 'Day 1' },
      { projectId: 'p1', name: 'Day 1' },
    ]
    expect(dedupeFolders(folders)).toEqual([
      { projectId: 'p1', name: 'Day 1' },
      { projectId: 'p2', name: 'Day 1' },
    ])
  })
})

describe('visibleFolderNames', () => {
  it('shows folders derived from the active project rundowns', () => {
    const rundowns = [rundown('r1', 'p1', 'Interviews'), rundown('r2', 'p1', 'B-roll')]
    expect(visibleFolderNames([], rundowns, 'p1')).toEqual(['Interviews', 'B-roll'])
  })

  it('shows empty folders created for the active project', () => {
    const local: LocalFolder[] = [{ projectId: 'p1', name: 'Empty' }]
    expect(visibleFolderNames(local, [], 'p1')).toEqual(['Empty'])
  })

  it('hides empty folders belonging to another project', () => {
    // Regression: switching project used to leave the previous project's folders
    // in the sidebar, because local folders were accumulated untagged.
    const local: LocalFolder[] = [
      { projectId: 'p1', name: 'Old project folder' },
      { projectId: 'p2', name: 'New project folder' },
    ]
    expect(visibleFolderNames(local, [], 'p2')).toEqual(['New project folder'])
  })

  it('hides folders from another project even when rundowns lag behind the switch', () => {
    // While loadRundowns() is in flight, `rundowns` still holds the old project.
    const stale = [rundown('r1', 'p1', 'Old project folder')]
    expect(visibleFolderNames([], stale, 'p2')).toEqual([])
  })

  it('does not collapse same-named folders across projects', () => {
    const local: LocalFolder[] = [
      { projectId: 'p1', name: 'Day 1' },
      { projectId: 'p2', name: 'Day 1' },
    ]
    expect(visibleFolderNames(local, [], 'p1')).toEqual(['Day 1'])
    expect(visibleFolderNames(local, [], 'p2')).toEqual(['Day 1'])
  })

  it('returns nothing when no project is active', () => {
    expect(visibleFolderNames([{ projectId: 'p1', name: 'Day 1' }], [], null)).toEqual([])
  })
})
