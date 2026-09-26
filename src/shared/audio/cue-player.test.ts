import { describe, it, expect } from 'vitest'
import { createCuePlayer, createPhoneCuePlayer, CUES } from './cue-player'
import { fakeAudioWorld, type FakeAudioWorld } from './fake-audio.fixture'

const BASE = 'media://audio'
const BEEP = `${BASE}/beep.opus`

/** The operator's player, already pointed at their speakers and an Intercom output. */
async function operatorPlayer(world: FakeAudioWorld, intercom: string | null = 'shotlister-out') {
  const player = createCuePlayer(BASE, world.create)
  player.setSinks({ cue: 'speakers', intercom })
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

  it("plays a Cue on the operator's device and on the Intercom output", async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world)

    player.play('beep')

    const [own, copy] = world.for(BEEP)
    expect(own.routes.at(-1)).toBe('speakers')
    expect(copy.routes.at(-1)).toBe('shotlister-out')
    expect([own.plays, copy.plays]).toEqual([1, 1])
  })

  it("plays a Cue once when the Intercom output is the operator's own device", async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world, 'speakers')

    player.play('beep')

    expect(world.for(BEEP)).toHaveLength(1)
    expect(world.for(BEEP)[0].plays).toBe(1)
  })

  it('keeps a fresh intercom copy muted until its routing lands', async () => {
    const world = fakeAudioWorld()
    const player = createCuePlayer(BASE, world.create)

    player.setSinks({ cue: 'speakers', intercom: 'shotlister-out' })
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

    player.play('beep', true)

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

    player.setSinks({ cue: 'headphones', intercom: null })

    // Every Cue is already on the new device before one is due: switching on the
    // way to a beep would put that beep on the old device, which is the one beep
    // the operator changed the setting to move.
    expect(world.elements).toHaveLength(CUES.length)
    expect(world.elements.every((audio) => audio.routes.at(-1) === 'headphones')).toBe(true)
    expect(world.elements.every((audio) => audio.plays === 0)).toBe(true)

    player.play('beep')

    expect(world.for(BEEP)[0].routes).toEqual(['', 'speakers', 'headphones'])
  })

  it('sets the volume on both devices', async () => {
    const world = fakeAudioWorld()
    const player = await operatorPlayer(world)

    player.setVolume(0.25)

    expect(world.for(BEEP).map((audio) => audio.volume)).toEqual([0.25, 0.25])
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
  it('has no way to name an Intercom output', () => {
    const world = fakeAudioWorld()
    const player = createPhoneCuePlayer(BASE, world.create)

    // A camera operator's handset must never become an Intercom output, so it is
    // not handed the method that would name one.
    expect('setSinks' in player).toBe(false)
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
