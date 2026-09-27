import { describe, it, expect } from 'vitest'
import {
  COUNTDOWN_MAX,
  COUNTDOWN_MIN,
  deviceLabel,
  deviceOptions,
  effectiveSetting,
  formatCountdown,
  parseCountdownInput,
  summarizeRenderStates,
  visibleRenderRows,
  RENDER_ROWS_COLLAPSED,
  parseDelayInput,
  renderingHeadline,
  markLoopbackDevices,
  suggestLoopbackDevice,
  LOOPBACK_SUFFIX,
  OUTPUT_CARRIES_LABEL,
  OUTPUT_CARRIES_ORDER,
  describeOutputDelay,
  outputWith,
  virtualOutputGuidanceIndex,
  toggleProjectSelection,
  summarizeClipSelection,
  describeClipSelection,
  deleteClipsConfirmation,
  describeClipDeletion,
  CONFIRM_NAMED_PROJECTS,
} from './VoiceSettingsPanel'
import { OUTPUT_DELAY_MAX_MS, OUTPUT_DELAY_MIN_MS } from '../../shared/audio/outputs'
import type {
  AudioDeviceSettings,
  AudioOutput,
  PartRenderState,
  ProjectClipStats,
  RenderState,
} from '../../shared/ipc-contract'

function part(name: string, state: RenderState): PartRenderState {
  return { partId: `id-${name}`, name, state }
}

describe('parseCountdownInput', () => {
  it('reads a plain comma-separated list', () => {
    const parsed = parseCountdownInput('10,5,3,2,1')
    expect(parsed).toEqual({ ok: true, countdown: [10, 5, 3, 2, 1] })
  })

  it('tolerates whitespace around every entry', () => {
    const parsed = parseCountdownInput('  10 ,  5 , 1  ')
    expect(parsed).toEqual({ ok: true, countdown: [10, 5, 1] })
  })

  it('normalises to largest-first, the order it is spoken in', () => {
    const parsed = parseCountdownInput('1,3,10')
    expect(parsed).toEqual({ ok: true, countdown: [10, 3, 1] })
  })

  it('accepts the ends of the rendered range', () => {
    expect(parseCountdownInput(`${COUNTDOWN_MIN}, ${COUNTDOWN_MAX}`)).toEqual({
      ok: true,
      countdown: [COUNTDOWN_MAX, COUNTDOWN_MIN],
    })
  })

  it('rejects a number above the rendered range rather than dropping it', () => {
    // Nothing is rendered past 60, so a silently kept 61 would simply be silent.
    const parsed = parseCountdownInput('61, 5')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('61')
  })

  it('rejects zero and negatives', () => {
    expect(parseCountdownInput('10, 0').ok).toBe(false)
    expect(parseCountdownInput('-5').ok).toBe(false)
  })

  it('rejects a fractional number', () => {
    const parsed = parseCountdownInput('10, 2.5')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('2.5')
  })

  it('rejects a non-numeric entry, naming it', () => {
    const parsed = parseCountdownInput('10, five')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('five')
  })

  it('rejects an empty string', () => {
    const parsed = parseCountdownInput('   ')
    expect(parsed.ok).toBe(false)
  })

  it('rejects a stray comma rather than reading past it', () => {
    expect(parseCountdownInput('10,,5').ok).toBe(false)
    expect(parseCountdownInput('10,5,').ok).toBe(false)
  })

  it('rejects a duplicate, which would ask for one second twice', () => {
    const parsed = parseCountdownInput('10, 5, 5, 1')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('5')
  })
})

describe('formatCountdown', () => {
  it('round-trips through the parser', () => {
    const parsed = parseCountdownInput('1, 2, 3')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(formatCountdown(parsed.countdown)).toBe('3, 2, 1')
  })
})

describe('effectiveSetting', () => {
  it('follows the global value when nothing overrides it', () => {
    expect(effectiveSetting('flush', null)).toEqual({ value: 'flush', source: 'global' })
  })

  it('prefers the override', () => {
    expect(effectiveSetting('flush', 'immediate')).toEqual({
      value: 'immediate',
      source: 'project',
    })
  })

  it('treats an override equal to the global value as an override still', () => {
    // The distinction is load-bearing: an explicit override keeps its value
    // when the global one later changes.
    expect(effectiveSetting('flush', 'flush').source).toBe('project')
  })

  it('carries arrays and other non-scalars', () => {
    expect(effectiveSetting([10, 5, 1], null).value).toEqual([10, 5, 1])
    expect(effectiveSetting([10, 5, 1], [3, 1]).value).toEqual([3, 1])
  })
})

describe('summarizeRenderStates', () => {
  it('reports an empty project', () => {
    const summary = summarizeRenderStates([])
    expect(summary).toMatchObject({ total: 0, unrendered: 0 })
    expect(summary.headline).toBe('No parts in this project yet.')
  })

  it('reports everything rendered', () => {
    const summary = summarizeRenderStates([part('gitara', 'rendered'), part('refren', 'rendered')])
    expect(summary).toMatchObject({ total: 2, rendered: 2, stale: 0, missing: 0, unrendered: 0 })
    expect(summary.headline).toBe('All 2 parts are rendered.')
  })

  it('says "part is" for a single rendered part', () => {
    expect(summarizeRenderStates([part('gitara', 'rendered')]).headline).toBe(
      'All 1 part is rendered.',
    )
  })

  it('counts stale and missing apart, because they mean different things', () => {
    const summary = summarizeRenderStates([
      part('gitara', 'rendered'),
      part('wokal 1', 'stale'),
      part('wokal 2', 'missing'),
      part('refren', 'missing'),
    ])
    expect(summary).toMatchObject({ total: 4, rendered: 1, stale: 1, missing: 2, unrendered: 3 })
    expect(summary.headline).toBe('1 of 4 rendered - 1 stale, 2 never rendered.')
  })

  it('counts stale towards unrendered', () => {
    expect(summarizeRenderStates([part('gitara', 'stale')]).unrendered).toBe(1)
  })
})

describe('deviceLabel', () => {
  it('uses the reported label when there is one', () => {
    expect(deviceLabel({ deviceId: 'abc', label: 'CABLE Input (VB-Audio)' })).toBe(
      'CABLE Input (VB-Audio)',
    )
  })

  it('falls back to the id when permission hides the label', () => {
    // Blank rows would be unpickable; the id at least distinguishes them.
    expect(deviceLabel({ deviceId: '0123456789abcdef', label: '' })).toBe(
      'Unnamed output (01234567)',
    )
  })

  it('names the well-known ids rather than showing them raw', () => {
    expect(deviceLabel({ deviceId: 'default', label: '' })).toBe('System default output')
    expect(deviceLabel({ deviceId: 'communications', label: '  ' })).toBe('Communications output')
  })
})

describe('deviceOptions', () => {
  it('always offers the system default first, as the empty value', () => {
    const options = deviceOptions([{ deviceId: 'a', label: 'Speakers' }], null)
    expect(options[0]).toEqual({ deviceId: '', label: 'System default' })
    expect(options[1]).toEqual({ deviceId: 'a', label: 'Speakers' })
  })

  it('keeps a saved device that is not plugged in visible', () => {
    const options = deviceOptions([{ deviceId: 'a', label: 'Speakers' }], 'unplugged-cable')
    expect(options.map((o) => o.deviceId)).toEqual(['', 'a', 'unplugged-cable'])
    expect(options[2].label).toContain('Not connected')
  })

  it('does not duplicate a selected device that is present', () => {
    const options = deviceOptions([{ deviceId: 'a', label: 'Speakers' }], 'a')
    expect(options.map((o) => o.deviceId)).toEqual(['', 'a'])
  })
})

describe('parseDelayInput', () => {
  it('reads a plain number of milliseconds', () => {
    expect(parseDelayInput('350')).toEqual({ ok: true, delayMs: 350 })
  })

  it('treats an empty field as no delay', () => {
    expect(parseDelayInput('')).toEqual({ ok: true, delayMs: 0 })
    expect(parseDelayInput('   ')).toEqual({ ok: true, delayMs: 0 })
  })

  it('accepts a negative delay, for a path that runs ahead', () => {
    expect(parseDelayInput('-120')).toEqual({ ok: true, delayMs: -120 })
  })

  it('rounds a fractional millisecond rather than rejecting it', () => {
    expect(parseDelayInput('350.4')).toEqual({ ok: true, delayMs: 350 })
  })

  it('rejects anything that is not a number', () => {
    const result = parseDelayInput('soon')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('not a number')
  })

  it('rejects a delay long enough to mute every Announcement', () => {
    expect(parseDelayInput(String(OUTPUT_DELAY_MAX_MS + 1)).ok).toBe(false)
    expect(parseDelayInput(String(OUTPUT_DELAY_MIN_MS - 1)).ok).toBe(false)
  })

  it('accepts the bounds themselves', () => {
    expect(parseDelayInput(String(OUTPUT_DELAY_MAX_MS)).ok).toBe(true)
    expect(parseDelayInput(String(OUTPUT_DELAY_MIN_MS)).ok).toBe(true)
  })
})

describe('renderingHeadline', () => {
  it('counts the clips so a slow batch does not read as a hang', () => {
    expect(renderingHeadline({ completed: 7, total: 62 })).toBe('Rendering 7/62...')
  })

  it('falls back to the bare word before the first progress arrives', () => {
    expect(renderingHeadline(undefined)).toBe('Rendering...')
  })

  it('does not offer "0/0" for a batch with nothing in it', () => {
    expect(renderingHeadline({ completed: 0, total: 0 })).toBe('Rendering...')
  })
})

describe('renderingHeadline — stages', () => {
  it('says what it is doing when that is not synthesis', () => {
    expect(
      renderingHeadline({ completed: 0, total: 62, stage: 'Installing voice pl_PL-bass-high' }),
    ).toBe('Installing voice pl_PL-bass-high...')
  })

  it('goes back to the count once the stage is over', () => {
    expect(renderingHeadline({ completed: 3, total: 62 })).toBe('Rendering 3/62...')
  })
})

describe('markLoopbackDevices', () => {
  const devices = [
    { deviceId: 'a', label: 'MacBook Pro Speakers' },
    { deviceId: 'b', label: 'BlackHole 2ch' },
    { deviceId: 'c', label: 'Shotlister Out' },
  ]

  it('marks the devices a platform hint matches, case insensitively', () => {
    const marked = markLoopbackDevices(devices, ['blackhole'])
    expect(marked.map((d) => d.label)).toEqual([
      'MacBook Pro Speakers',
      `BlackHole 2ch${LOOPBACK_SUFFIX}`,
      'Shotlister Out',
    ])
  })

  it('leaves every device selectable, marked or not', () => {
    // The mark is a hint. An operator whose cable is called something else must
    // still be able to choose it.
    const marked = markLoopbackDevices(devices, ['shotlister out'])
    expect(marked).toHaveLength(devices.length)
    expect(marked.map((d) => d.deviceId)).toEqual(['a', 'b', 'c'])
  })

  it('marks nothing when the platform has no hints, and ignores an empty one', () => {
    expect(markLoopbackDevices(devices, [])).toEqual(devices)
    // An empty hint is a substring of every label; it must not mark them all.
    expect(markLoopbackDevices(devices, [''])).toEqual(devices)
  })
})

describe('suggestLoopbackDevice', () => {
  it('offers the first marked device', () => {
    const marked = markLoopbackDevices(
      [
        { deviceId: 'a', label: 'Speakers' },
        { deviceId: 'b', label: 'CABLE Input (VB-Audio Virtual Cable)' },
      ],
      ['cable input'],
    )
    expect(suggestLoopbackDevice(marked)?.deviceId).toBe('b')
  })

  it('offers nothing when no device looks like a loopback', () => {
    expect(suggestLoopbackDevice([{ deviceId: 'a', label: 'Speakers' }])).toBeNull()
  })
})

describe('OUTPUT_CARRIES_LABEL', () => {
  it('names the sound rather than the stored word', () => {
    // "voice" is what the code calls the kind; in front of an operator it would
    // read as a microphone rather than as the spoken part names.
    expect(OUTPUT_CARRIES_LABEL.voice).toBe('Announcements')
    expect(OUTPUT_CARRIES_LABEL.cues).toBe('Countdown and beeps')
    expect(OUTPUT_CARRIES_LABEL.both).toBe('Both')
  })

  it('offers every choice exactly once, widest first', () => {
    expect([...OUTPUT_CARRIES_ORDER]).toEqual(['both', 'voice', 'cues'])
    expect(new Set(OUTPUT_CARRIES_ORDER).size).toBe(Object.keys(OUTPUT_CARRIES_LABEL).length)
  })
})

describe('describeOutputDelay', () => {
  it('says a positive delay plays things early, which is the whole point', () => {
    // The sign is the one thing an operator can get backwards, and getting it
    // backwards doubles the error.
    const text = describeOutputDelay(400)
    expect(text).toContain('400 ms')
    expect(text).toContain('early')
  })

  it('says a negative delay plays things late', () => {
    const text = describeOutputDelay(-120)
    expect(text).toContain('120 ms')
    expect(text).toContain('late')
    expect(text).not.toContain('-120')
  })

  it('describes no delay without naming a number of milliseconds', () => {
    expect(describeOutputDelay(0)).not.toMatch(/\dms|\d ms/)
  })
})

describe('outputWith', () => {
  const settings: AudioDeviceSettings = {
    outputs: [
      { enabled: true, sinkId: 'speakers', delayMs: 0, carries: 'both' },
      { enabled: false, sinkId: null, delayMs: 0, carries: 'voice' },
    ],
  }

  it('changes only the Output named', () => {
    const next = outputWith(settings, 1, { enabled: true, delayMs: 400 })
    expect(next.outputs[1]).toEqual({
      enabled: true,
      sinkId: null,
      delayMs: 400,
      carries: 'voice',
    })
    expect(next.outputs[0]).toEqual(settings.outputs[0])
  })

  it("keeps Output 1 in first place, which is what makes it the operator's own", () => {
    const next = outputWith(settings, 0, { sinkId: 'headphones' })
    expect(next.outputs[0].sinkId).toBe('headphones')
    expect(next.outputs[1]).toEqual(settings.outputs[1])
  })

  it('does not touch the settings it was given', () => {
    outputWith(settings, 0, { sinkId: 'headphones' })
    expect(settings.outputs[0].sinkId).toBe('speakers')
  })
})

describe('virtualOutputGuidanceIndex', () => {
  const marked = markLoopbackDevices(
    [
      { deviceId: 'speakers', label: 'MacBook Pro Speakers' },
      { deviceId: 'cable', label: 'BlackHole 2ch' },
    ],
    ['blackhole'],
  )
  const output = (patch: Partial<AudioOutput> = {}): AudioOutput => ({
    enabled: true,
    sinkId: null,
    delayMs: 0,
    carries: 'both',
    ...patch,
  })

  it('follows the loopback device onto Output 1 when that is where it is', () => {
    const outputs: [AudioOutput, AudioOutput] = [
      output({ sinkId: 'cable' }),
      output({ enabled: false }),
    ]
    expect(virtualOutputGuidanceIndex(outputs, marked)).toBe(0)
  })

  it('prefers Output 2 when both are pointed at a loopback device', () => {
    const outputs: [AudioOutput, AudioOutput] = [
      output({ sinkId: 'cable' }),
      output({ sinkId: 'cable' }),
    ]
    expect(virtualOutputGuidanceIndex(outputs, marked)).toBe(1)
  })

  it('ignores a loopback device on an Output that is switched off', () => {
    // A disabled Output is not a route, so it is not what the guidance is about.
    const outputs: [AudioOutput, AudioOutput] = [
      output({ sinkId: 'cable' }),
      output({ enabled: false, sinkId: 'cable' }),
    ]
    expect(virtualOutputGuidanceIndex(outputs, marked)).toBe(0)
  })

  it('falls back to Output 2, where a second listener is set up', () => {
    // An operator with nothing installed yet still has to be told what to install.
    const outputs: [AudioOutput, AudioOutput] = [output({ sinkId: 'speakers' }), output()]
    expect(virtualOutputGuidanceIndex(outputs, marked)).toBe(1)
  })
})

describe('visibleRenderRows', () => {
  const parts = Array.from({ length: 8 }, (_, i) => part(`p${i}`, 'rendered'))

  it('shows only the first five while collapsed', () => {
    const rows = visibleRenderRows(parts, false)
    expect(rows).toHaveLength(RENDER_ROWS_COLLAPSED)
    expect(rows.map((p) => p.name)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
  })

  it('shows every part once expanded', () => {
    expect(visibleRenderRows(parts, true)).toEqual(parts)
  })

  it('keeps the stored order rather than sorting by render state', () => {
    // The operator recognises the list by its order; the counts in the headline
    // already say how much is unrendered.
    const mixed = [
      part('a', 'rendered'),
      part('b', 'missing'),
      part('c', 'stale'),
      part('d', 'rendered'),
      part('e', 'missing'),
      part('f', 'stale'),
    ]
    expect(visibleRenderRows(mixed, false).map((p) => p.name)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('shows a short list whole either way, so no toggle is needed', () => {
    const few = parts.slice(0, RENDER_ROWS_COLLAPSED)
    expect(visibleRenderRows(few, false)).toEqual(few)
    expect(visibleRenderRows(few, true)).toEqual(few)
  })

  it('handles no parts at all', () => {
    expect(visibleRenderRows([], false)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Deleting recordings, per Project
// ---------------------------------------------------------------------------

function stats(...rows: [string, string, number][]): ProjectClipStats[] {
  return rows.map(([projectId, name, clipCount]) => ({ projectId, name, clipCount }))
}

const THREE = stats(['p1', 'Kolonia', 12], ['p2', 'Oboz', 0], ['p3', 'Zlot', 1])

describe('toggleProjectSelection', () => {
  it('ticks a project that was not picked', () => {
    expect(toggleProjectSelection(['p1'], 'p2')).toEqual(['p1', 'p2'])
  })

  it('unticks one that was', () => {
    expect(toggleProjectSelection(['p1', 'p2'], 'p1')).toEqual(['p2'])
  })

  it('never returns the same project twice', () => {
    const once = toggleProjectSelection([], 'p1')
    expect(toggleProjectSelection(once, 'p1')).toEqual([])
  })
})

describe('summarizeClipSelection', () => {
  it('adds up the exclusive counts of the picked projects only', () => {
    expect(summarizeClipSelection(THREE, ['p1', 'p3'])).toEqual({ projects: 2, clips: 13 })
  })

  it('reports nothing for an empty selection', () => {
    expect(summarizeClipSelection(THREE, [])).toEqual({ projects: 0, clips: 0 })
  })

  it('counts a project with no recordings of its own as a project still', () => {
    // It is a real pick with a real outcome: nothing is freed, and the note has
    // to be able to say so.
    expect(summarizeClipSelection(THREE, ['p2'])).toEqual({ projects: 1, clips: 0 })
  })

  it('ignores a selected project the counts do not mention', () => {
    // A Project deleted while the picker was open must not be counted as zero
    // recordings *and* one project.
    expect(summarizeClipSelection(THREE, ['p1', 'gone'])).toEqual({ projects: 1, clips: 12 })
  })
})

describe('describeClipSelection', () => {
  it('names the scale of what is about to go', () => {
    expect(describeClipSelection(THREE, ['p1', 'p3'])).toBe(
      '13 recordings from 2 projects will be deleted.',
    )
  })

  it('says it in the singular for one project and one recording', () => {
    expect(describeClipSelection(THREE, ['p3'])).toBe('1 recording from 1 project will be deleted.')
  })

  it('says nothing is picked rather than offering "0 recordings"', () => {
    expect(describeClipSelection(THREE, [])).toBe('No project picked.')
  })
})

describe('deleteClipsConfirmation', () => {
  it('names how many recordings from how many projects', () => {
    const text = deleteClipsConfirmation(THREE, ['p1', 'p3'])
    expect(text).toContain('Delete 13 recordings from 2 projects?')
  })

  it('names the projects while there are few enough to read', () => {
    const text = deleteClipsConfirmation(THREE, ['p1', 'p3'])
    expect(text).toContain('Kolonia, Zlot')
  })

  it('falls back to the count once there are too many to name', () => {
    const many = stats(
      ...(Array.from({ length: CONFIRM_NAMED_PROJECTS + 1 }, (_, i) => [
        `p${i}`,
        `Project ${i}`,
        1,
      ]) as [string, string, number][]),
    )
    const text = deleteClipsConfirmation(
      many,
      many.map((row) => row.projectId),
    )
    expect(text).toContain(`from ${CONFIRM_NAMED_PROJECTS + 1} projects?`)
    expect(text).not.toContain('Project 0,')
  })

  it('keeps both standing warnings, which are the reason it is a confirm at all', () => {
    const text = deleteClipsConfirmation(THREE, ['p1'])
    expect(text).toContain('shared with another project are kept')
    expect(text).toContain('missing until you render again')
  })
})

describe('describeClipDeletion', () => {
  it('reports the total the deletions returned, not the total that was picked', () => {
    expect(describeClipDeletion(13, 2)).toBe('Deleted 13 recordings from 2 projects.')
  })

  it('uses the singular for one recording from one project', () => {
    expect(describeClipDeletion(1, 1)).toBe('Deleted 1 recording from 1 project.')
  })

  it('explains a deletion that freed nothing', () => {
    expect(describeClipDeletion(0, 1)).toContain('had no recordings of its own')
    expect(describeClipDeletion(0, 3)).toContain('had no recordings of their own')
  })
})
