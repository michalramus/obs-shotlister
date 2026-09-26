import { describe, it, expect } from 'vitest'
import {
  createVirtualSinkManager,
  loopbackHints,
  parseModuleId,
  platformGuidance,
  sinkPresent,
  SINK_NAME,
  type CommandResult,
  type CommandRunner,
} from './virtual-sink'

const SINKS_WITHOUT = [
  '0\talsa_output.pci-0000_00_1f.3.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tRUNNING',
  '1\tbluez_output.AC_12_2F.1\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED',
].join('\n')

const SINKS_WITH = [
  SINKS_WITHOUT,
  `2\t${SINK_NAME}\tPipeWire\tfloat32le 2ch 48000Hz\tIDLE`,
  '',
].join('\n')

/** A runner that answers from a script and records what it was asked. */
function recorder(answers: Record<string, CommandResult>): {
  run: CommandRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const run: CommandRunner = (command, args) => {
    calls.push([command, ...args])
    const key = args[0] ?? ''
    return Promise.resolve(answers[key] ?? { code: 0, stdout: '', stderr: '' })
  }
  return { run, calls }
}

describe('sinkPresent', () => {
  it('finds our sink in pactl short output', () => {
    expect(sinkPresent(SINKS_WITH)).toBe(true)
    expect(sinkPresent(SINKS_WITHOUT)).toBe(false)
    expect(sinkPresent('')).toBe(false)
  })

  it('matches the name whole, not as a prefix', () => {
    // Somebody else's sink. Reusing it would make us unload a device we never
    // created, and playing into it would send the show somewhere unknown.
    const other = `3\t${SINK_NAME}_2\tPipeWire\tfloat32le 2ch 48000Hz\tIDLE`
    expect(sinkPresent(other)).toBe(false)
  })
})

describe('parseModuleId', () => {
  it('reads the index pactl prints on a successful load', () => {
    expect(parseModuleId('37\n')).toBe(37)
    expect(parseModuleId(' 5 ')).toBe(5)
  })

  it('reads anything else as "we own nothing"', () => {
    // An id we cannot trust must not be unloaded later: by then the audio server
    // may have given that index to somebody else's module.
    for (const bad of ['', 'ok\n', 'module 37\n', '-1\n']) {
      expect(parseModuleId(bad)).toBeNull()
    }
  })
})

describe('platformGuidance', () => {
  it('names the device to install per platform', () => {
    expect(platformGuidance('darwin')).toMatch(/BlackHole/)
    expect(platformGuidance('win32')).toMatch(/VB-CABLE/)
    expect(platformGuidance('linux')).toMatch(/PipeWire|PulseAudio/)
  })
})

describe('loopbackHints', () => {
  it('knows what a loopback device is called on each platform', () => {
    expect(loopbackHints('darwin')).toContain('blackhole')
    expect(loopbackHints('win32')).toContain('cable input')
    expect(loopbackHints('linux')).toContain('shotlister out')
  })

  it('has nothing to say about a platform it does not know', () => {
    expect(loopbackHints('aix')).toEqual([])
  })
})

describe('createVirtualSinkManager off Linux', () => {
  for (const platform of ['darwin', 'win32'] as NodeJS.Platform[]) {
    it(`reports ${platform} as not creatable, and never shells out`, async () => {
      const { run, calls } = recorder({})
      const manager = createVirtualSinkManager(run, platform)

      const state = await manager.ensure()

      expect(state.creatable).toBe(false)
      expect(state.present).toBe(false)
      expect(state.guidance).not.toBeNull()
      expect(calls).toEqual([])
    })
  }
})

describe('createVirtualSinkManager on Linux', () => {
  it('loads a null sink when none is there, and reports it created', async () => {
    const { run, calls } = recorder({
      list: { code: 0, stdout: SINKS_WITHOUT, stderr: '' },
      'load-module': { code: 0, stdout: '37\n', stderr: '' },
    })
    const manager = createVirtualSinkManager(run, 'linux')

    const state = await manager.ensure()

    expect(state).toEqual({
      creatable: true,
      present: true,
      label: 'Shotlister Out',
      monitorLabel: 'Monitor of Shotlister Out',
      guidance: null,
    })
    expect(calls[1]).toEqual([
      'pactl',
      'load-module',
      'module-null-sink',
      `sink_name=${SINK_NAME}`,
      'sink_properties=device.description="Shotlister Out"',
    ])
  })

  it('reuses a sink that is already there rather than loading a second', async () => {
    const { run, calls } = recorder({ list: { code: 0, stdout: SINKS_WITH, stderr: '' } })
    const manager = createVirtualSinkManager(run, 'linux')

    const state = await manager.ensure()

    expect(state.present).toBe(true)
    expect(calls.map((c) => c[1])).toEqual(['list'])
  })

  it('unloads only a module it loaded itself', async () => {
    const { run, calls } = recorder({
      list: { code: 0, stdout: SINKS_WITHOUT, stderr: '' },
      'load-module': { code: 0, stdout: '37\n', stderr: '' },
    })
    const manager = createVirtualSinkManager(run, 'linux')

    await manager.ensure()
    await manager.remove()

    expect(calls[2]).toEqual(['pactl', 'unload-module', '37'])
  })

  it('leaves a reused sink alone on the way out', async () => {
    // It was somebody else's before we got here — a crashed run of ours, or an
    // operator's own setup. Either way, removing it is not ours to do.
    const { run, calls } = recorder({ list: { code: 0, stdout: SINKS_WITH, stderr: '' } })
    const manager = createVirtualSinkManager(run, 'linux')

    await manager.ensure()
    await manager.remove()

    expect(calls.some((c) => c[1] === 'unload-module')).toBe(false)
  })

  it('unloads once, even if quit runs twice', async () => {
    // A second unload would hit an index the audio server may have reissued.
    const { run, calls } = recorder({
      list: { code: 0, stdout: SINKS_WITHOUT, stderr: '' },
      'load-module': { code: 0, stdout: '37\n', stderr: '' },
    })
    const manager = createVirtualSinkManager(run, 'linux')

    await manager.ensure()
    await manager.remove()
    await manager.remove()

    expect(calls.filter((c) => c[1] === 'unload-module')).toHaveLength(1)
  })

  it('says pactl is missing rather than failing silently', async () => {
    const { run } = recorder({
      list: { code: 127, stdout: '', stderr: 'spawn pactl ENOENT' },
    })
    const manager = createVirtualSinkManager(run, 'linux')

    const state = await manager.ensure()

    expect(state.creatable).toBe(true)
    expect(state.present).toBe(false)
    expect(state.guidance).toMatch(/pactl/)
  })

  it('passes a load failure through as the reason', async () => {
    const { run } = recorder({
      list: { code: 0, stdout: SINKS_WITHOUT, stderr: '' },
      'load-module': { code: 1, stdout: '', stderr: 'Failure: Module initialization failed\n' },
    })
    const manager = createVirtualSinkManager(run, 'linux')

    const state = await manager.ensure()

    expect(state.present).toBe(false)
    expect(state.guidance).toBe('Failure: Module initialization failed')
  })

  it('reports state without creating anything', async () => {
    const { run, calls } = recorder({ list: { code: 0, stdout: SINKS_WITHOUT, stderr: '' } })
    const manager = createVirtualSinkManager(run, 'linux')

    const state = await manager.state()

    expect(state.present).toBe(false)
    expect(calls.map((c) => c[1])).toEqual(['list'])
  })
})
