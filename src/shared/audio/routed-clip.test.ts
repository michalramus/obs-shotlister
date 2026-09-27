import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoutedClip, createRoutedSound, type SoundDestination } from './routed-clip'
import { fakeAudioWorld } from './fake-audio.fixture'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Routing failures are reported, and the report is not what is under test. */
function silenceErrors(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

/** Output 1's copy: the operator's own, and the only one that may fall back. */
function own(sinkId: string | null, delayMs = 0): SoundDestination {
  return { sinkId, delayMs, primary: true }
}

/** Output 2's copy: heard on its device or nowhere. */
function copyTo(sinkId: string | null, delayMs = 0): SoundDestination {
  return { sinkId, delayMs, primary: false }
}

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

  it("keeps another Output's copy muted until its routing lands", async () => {
    const world = fakeAudioWorld()
    createRoutedClip('beep.opus', 'shotlister-out', world.create, true)
    const copy = world.elements[0]

    expect(copy.muted).toBe(true)

    await copy.landRoutes()

    expect(copy.muted).toBe(false)
  })

  it("leaves another Output's copy muted when its device never opens", async () => {
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

  it("plays on the operator's own device and on the second Output", async () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(url, [own('speakers'), copyTo('shotlister-out')], world.create)
    await world.landRoutes()

    sound.play()

    const [operator, copy] = world.for(url)
    expect(operator.routes).toEqual(['speakers'])
    expect(copy.routes).toEqual(['shotlister-out'])
    expect([operator.plays, copy.plays]).toEqual([1, 1])
    expect([operator.audible, copy.audible]).toEqual([true, true])
  })

  it("silences Output 1's copy only, never the other", async () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(url, [own('speakers'), copyTo('shotlister-out')], world.create)
    await world.landRoutes()

    sound.play({ silentToOperator: true })

    const [operator, copy] = world.for(url)
    expect(operator.plays).toBe(0)
    expect(copy.plays).toBe(1)
    expect(copy.audible).toBe(true)
  })

  it('plays one moment at a time when the Outputs have different delays', async () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(
      url,
      [own('speakers', 0), copyTo('shotlister-out', 400)],
      world.create,
    )
    await world.landRoutes()

    sound.play({ delayMs: 400 })

    // The early copy plays 400ms before the one the operator hears: the trigger
    // fires twice, and each play names the moment it is for.
    const [operator, copy] = world.for(url)
    expect([operator.plays, copy.plays]).toEqual([0, 1])

    sound.play({ delayMs: 0 })

    expect([operator.plays, copy.plays]).toEqual([1, 1])
  })

  it('re-routes the same elements when the devices change', () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(url, [own('speakers'), copyTo('shotlister-out')], world.create)

    sound.setDestinations([own('headphones'), copyTo('shotlister-out')])

    // The elements are pooled: a new one would have to fetch and decode before it
    // could sound, and the next beep may be 200ms away.
    expect(world.elements).toHaveLength(2)
    expect(world.elements[0].routes).toEqual(['speakers', 'headphones'])
    expect(world.elements[1].routes).toEqual(['shotlister-out', 'shotlister-out'])
  })

  it('drops the second copy when its Output stops carrying the sound', async () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(url, [own('speakers'), copyTo('shotlister-out')], world.create)
    await world.landRoutes()
    const copy = world.elements[1]

    sound.setDestinations([own('speakers')])
    sound.play()

    expect(copy.pauses).toBe(1)
    expect(copy.plays).toBe(0)
    expect(world.elements[0].plays).toBe(1)
  })

  it("rebuilds a copy that becomes the operator's own, rather than re-pointing it", async () => {
    silenceErrors()
    const world = fakeAudioWorld()
    // Output 1 stopped carrying the sound, so the only copy left is the band's.
    const sound = createRoutedSound(url, [copyTo('shotlister-out')], world.create)

    sound.setDestinations([own('shotlister-out')])
    await world.landRoutes()

    // Whether a copy may fall back to the default device is settled when its
    // element is made, so re-pointing would leave the operator's own copy muted
    // the moment its device went away.
    expect(world.elements).toHaveLength(2)
    expect(world.elements[1].muted).toBe(false)
  })

  it('sets the volume on every device, including a copy added later', () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(url, [own('speakers')], world.create)

    sound.setVolume(0.5)
    sound.setDestinations([own('speakers'), copyTo('shotlister-out')])

    expect(world.elements.map((audio) => audio.volume)).toEqual([0.5, 0.5])
  })

  it('plays nothing at all when no Output carries the sound', () => {
    const world = fakeAudioWorld()
    const sound = createRoutedSound(url, [], world.create)

    sound.play()

    // An operator choosing silence, not a fault.
    expect(world.elements).toHaveLength(0)
  })
})
