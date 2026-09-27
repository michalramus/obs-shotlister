import { describe, it, expect } from 'vitest'
import type { AudioOutput } from '../ipc-contract'
import { createCuePlayer, createPhoneCuePlayer, CUES } from './cue-player'
import { fakeAudioWorld, type FakeAudioWorld } from './fake-audio.fixture'

const BASE = 'media://audio'
const BEEP = `${BASE}/beep.opus`

function output(over: Partial<AudioOutput> = {}): AudioOutput {
  return { enabled: true, sinkId: null, delayMs: 0, carries: 'both', ...over }
}

/**
 * The operator's player, pointed at their own speakers and at a second Output.
 *
 * @param second Overrides for Output 2; `null` switches it off.
 */
async function operatorPlayer(
  world: FakeAudioWorld,
  second: Partial<AudioOutput> | null = { sinkId: 'shotlister-out' },
) {
  const player = createCuePlayer(BASE, world.create)
  player.setOutputs([
    output({ sinkId: 'speakers' }),
    second === null ? output({ enabled: false }) : output(second),
  ])
  await world.landRoutes()
  return player
}

describe('createCuePlayer', () => {
  it('holds every Cue open before a Cue is ever due', () => {
    const world = fakeAudioWorld()
    createCuePlayer(BASE, world.create)

    // Fetching and decoding at the first beep would cost exactly that beep.
    expect(world.elements.map((audio) => audio.src)).toEqual(
      CUES.map((cue) => `${BASE}/${cue}.opus`),
    )
    expect(world.elements.every((audio) => audio.plays === 0)).toBe(true)
  })

  it("plays a Cue on the operator's device and on the second Output", async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world)

    player.play('beep')

    const [own, copy] = world.for(BEEP)
    expect(own.routes.at(-1)).toBe('speakers')
    expect(copy.routes.at(-1)).toBe('shotlister-out')
    expect([own.plays, copy.plays]).toEqual([1, 1])
  })

  it("plays a Cue once when both Outputs name the operator's own device", async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world, { sinkId: 'speakers' })

    player.play('beep')

    expect(world.for(BEEP)).toHaveLength(1)
    expect(world.for(BEEP)[0].plays).toBe(1)
  })

  it("keeps a fresh second copy muted until its routing lands", async () => {
    const world = fakeAudioWorld()
    const player = createCuePlayer(BASE, world.create)

    player.setOutputs([output({ sinkId: 'speakers' }), output({ sinkId: 'shotlister-out' })])
    const [, copy] = world.for(BEEP)
    player.play('beep')

    // `setSinkId` is async: unmuted, this first Cue would sound on the default
    // device — in the operator's ear, doubled.
    expect(copy.muted).toBe(true)

    await world.landRoutes()

    expect(copy.muted).toBe(false)
  })

  it("mutes a Cue on the operator's device only", async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world)

    player.play('beep', { silentToOperator: true })

    // Their mute button is about their ears; muting the beep to concentrate must
    // not take the band's countdown away.
    const [own, copy] = world.for(BEEP)
    expect(own.plays).toBe(0)
    expect(copy.plays).toBe(1)
    expect(copy.audible).toBe(true)
  })

  it('re-routes the whole pool when the devices change, not at the next play', async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world, null)

    player.setOutputs([output({ sinkId: 'headphones' }), output({ enabled: false })])

    // Every Cue is already on the new device before one is due: switching on the
    // way to a beep would put that beep on the old device, which is the one beep
    // the operator changed the setting to move.
    expect(world.elements).toHaveLength(CUES.length)
    expect(world.elements.every((audio) => audio.routes.at(-1) === 'headphones')).toBe(true)
    expect(world.elements.every((audio) => audio.plays === 0)).toBe(true)

    player.play('beep')

    expect(world.for(BEEP)[0].routes).toEqual(['', 'speakers', 'headphones'])
  })

  it('sets the volume on both Outputs', async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world)

    player.setVolume(0.25)

    expect(world.for(BEEP).map((audio) => audio.volume)).toEqual([0.25, 0.25])
  })

  it('plays only the Output whose moment is due', async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world, { sinkId: 'shotlister-out', delayMs: 400 })

    player.play('beep', { delayMs: 400 })

    const [own, copy] = world.for(BEEP)
    expect([own.plays, copy.plays]).toEqual([0, 1])

    player.play('beep', { delayMs: 0 })

    expect([own.plays, copy.plays]).toEqual([1, 1])
  })

  it('plays every Output for a Cue nobody could schedule ahead', async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world, { sinkId: 'shotlister-out', delayMs: 400 })

    // A beep reacting to a Next just pressed has no moment to be early for.
    player.play('beep-low')

    expect(world.for(`${BASE}/beep-low.opus`).map((audio) => audio.plays)).toEqual([1, 1])
  })

  it('reports one moment per distinct delay, earliest first', async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world, { sinkId: 'shotlister-out', delayMs: 400 })

    expect(player.cueDelaysMs()).toEqual([400, 0])
  })

  it('plays nothing when no Output carries Cues', async () => {
    const world = fakeAudioWorld()
    const player = createCuePlayer(BASE, world.create)

    player.setOutputs([output({ carries: 'voice' }), output({ enabled: false })])
    player.play('beep')

    // An operator who gave the Cues no Output chose silence; the pool is empty and
    // there is nothing to report as due.
    expect(player.cueDelaysMs()).toEqual([])
    expect(world.for(BEEP).every((audio) => audio.plays === 0)).toBe(true)
  })

  it('rebuilds a Cue after dispose rather than falling silent', async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world, null)

    player.dispose()
    player.play('beep')

    // A remount asks for the same Cues again, and a released element is cheaper to
    // remake than a silent countdown is to explain.
    const rebuilt = world.for(BEEP)
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0].plays).toBe(1)
    expect(rebuilt[0].routes.at(-1)).toBe('speakers')
  })
})

describe('createPhoneCuePlayer', () => {
  it('has no way to name an Output', () => {
    const world = fakeAudioWorld()
    const player = createPhoneCuePlayer(BASE, world.create)

    // A camera operator's handset must never be routed anywhere but its own
    // speaker, so it is not handed the method that would name an Output.
    expect('setOutputs' in player).toBe(false)
  })

  it('is one local Output with no delay, so the trigger fires once', () => {
    const world = fakeAudioWorld()
    const player = createPhoneCuePlayer(BASE, world.create)

    expect(player.cueDelaysMs()).toEqual([0])
  })

  it('plays a Cue on the handset and nowhere else', () => {
    const world = fakeAudioWorld()
    const player = createPhoneCuePlayer(BASE, world.create)

    player.setVolume(0.5)
    player.play('beep')

    const clips = world.for(BEEP)
    expect(clips).toHaveLength(1)
    expect(clips[0].plays).toBe(1)
    expect(clips[0].volume).toBe(0.5)
    expect(clips[0].routes).toEqual([''])
  })
})
