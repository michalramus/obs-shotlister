import { describe, it, expect, vi, afterEach } from 'vitest'
import { outputTargets, createRoutedClip, createRoutedSound } from './routed-clip'
import { fakeAudioWorld } from './fake-audio.fixture'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Routing failures are reported, and the report is not what is under test. */
function silenceErrors(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('outputTargets', () => {
  it('plays on one device when the intercom is off', () => {
    expect(outputTargets('speakers', null)).toEqual(['speakers'])
    expect(outputTargets(null, null)).toEqual([null])
  })

  it('adds the intercom as a second destination, primary first', () => {
    // Primary first matters: it is the copy that must not be dropped, and the
    // players treat every copy after the first as expendable.
    expect(outputTargets('speakers', 'shotlister-out')).toEqual(['speakers', 'shotlister-out'])
    expect(outputTargets(null, 'shotlister-out')).toEqual([null, 'shotlister-out'])
  })

  it('does not play the same device twice', () => {
    // Pointing the sound's own selector at the Virtual output and then switching
    // the intercom on as well is a reasonable thing to try, and two elements into
    // one device is a stutter rather than a duplicate.
    expect(outputTargets('shotlister-out', 'shotlister-out')).toEqual(['shotlister-out'])
  })
})

describe('createRoutedClip', () => {
  it('opens the device when the clip is made, not when it is played', () => {
    const world = fakeAudioWorld()
    createRoutedClip('beep.opus', 'speakers', world.create)

    expect(world.elements[0].routes).toEqual(['speakers'])
    expect(world.elements[0].plays).toBe(0)
  })

  it('asks for the system default by name, so a pooled clip leaves its old device', () => {
    const world = fakeAudioWorld()
    const clip = createRoutedClip('beep.opus', null, world.create)

    clip.route('speakers')
    clip.route(null)

    expect(world.elements[0].routes).toEqual(['', 'speakers', ''])
  })

  it('keeps a duplicate muted until its routing lands', async () => {
    const world = fakeAudioWorld()
    createRoutedClip('beep.opus', 'shotlister-out', world.create, true)
    const copy = world.elements[0]

    expect(copy.muted).toBe(true)

    await copy.landRoutes()

    expect(copy.muted).toBe(false)
  })

  it('leaves a duplicate muted when its device never opens', async () => {
    silenceErrors()
    const world = fakeAudioWorld()
    createRoutedClip('beep.opus', 'shotlister-out', world.create, true)
    const copy = world.elements[0]

    await copy.failRoutes()

    // Heard on the operator's speakers by mistake it would be every sound twice
    // in their ear, which is worse than the intercom being silent.
    expect(copy.muted).toBe(true)
  })

  it("keeps the operator's own clip audible when its device is gone", async () => {
    silenceErrors()
    const world = fakeAudioWorld()
    const clip = createRoutedClip('beep.opus', 'unplugged', world.create)
    const own = world.elements[0]

    await own.failRoutes()
    clip.play()

    // The wrong speakers beat no speakers: the countdown is why they are looking
    // at the screen.
    expect(own.muted).toBe(false)
    expect(own.plays).toBe(1)
  })

  it('plays from the top every time', () => {
    const world = fakeAudioWorld()
    const clip = createRoutedClip('beep.opus', null, world.create)
    world.elements[0].currentTime = 0.2

    clip.play()

    expect(world.elements[0].currentTime).toBe(0)
    expect(world.elements[0].plays).toBe(1)
  })
})

describe('createRoutedSound', () => {
  const url = 'beep.opus'

  it("plays on the operator's own device and on the Intercom output", async () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(
      url,
      { primary: 'speakers', intercom: 'shotlister-out' },
      world.create,
    )
    await world.landRoutes()

    sound.play()

    const [own, copy] = world.for(url)
    expect(own.routes).toEqual(['speakers'])
    expect(copy.routes).toEqual(['shotlister-out'])
    expect([own.plays, copy.plays]).toEqual([1, 1])
    expect([own.audible, copy.audible]).toEqual([true, true])
  })

  it('plays once when both destinations name the same device', () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(
      url,
      { primary: 'shotlister-out', intercom: 'shotlister-out' },
      world.create,
    )

    sound.play()

    // One element, played once: two into one device is a stutter, not a duplicate.
    expect(world.for(url)).toHaveLength(1)
    expect(world.for(url)[0].plays).toBe(1)
  })

  it("silences the operator's copy only, never the intercom's", async () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(
      url,
      { primary: 'speakers', intercom: 'shotlister-out' },
      world.create,
    )
    await world.landRoutes()

    sound.play(true)

    const [own, copy] = world.for(url)
    expect(own.plays).toBe(0)
    expect(copy.plays).toBe(1)
    expect(copy.audible).toBe(true)
  })

  it('re-routes the same elements when the devices change', () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(
      url,
      { primary: 'speakers', intercom: 'shotlister-out' },
      world.create,
    )

    sound.setSinks({ primary: 'headphones', intercom: 'shotlister-out' })

    // The elements are pooled: a new one would have to fetch and decode before it
    // could sound, and the next beep may be 200ms away.
    expect(world.elements).toHaveLength(2)
    expect(world.elements[0].routes).toEqual(['speakers', 'headphones'])
    expect(world.elements[1].routes).toEqual(['shotlister-out', 'shotlister-out'])
  })

  it('drops the intercom copy when the Intercom output is switched off', async () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(
      url,
      { primary: 'speakers', intercom: 'shotlister-out' },
      world.create,
    )
    await world.landRoutes()
    const copy = world.elements[1]

    sound.setSinks({ primary: 'speakers', intercom: null })
    sound.play()

    expect(copy.pauses).toBe(1)
    expect(copy.plays).toBe(0)
    expect(world.elements[0].plays).toBe(1)
  })

  it('sets the volume on every device, including a copy added later', () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(url, { primary: 'speakers', intercom: null }, world.create)

    sound.setVolume(0.5)
    sound.setSinks({ primary: 'speakers', intercom: 'shotlister-out' })

    expect(world.elements.map((audio) => audio.volume)).toEqual([0.5, 0.5])
  })
})
