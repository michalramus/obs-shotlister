/**
 * A stand-in for the element the players drive, for tests only.
 *
 * Not named `*.test.ts` so it is not collected as a suite, and imported by no
 * production module, so it never reaches a bundle. The players take their element
 * factory as an argument precisely so this can exist: routing rules are the part
 * of audio worth asserting on, and they are unobservable through a real element
 * without a sound card and two output devices.
 *
 * `setSinkId` here does not settle by itself — a test lands or fails it — because
 * *when* it settles is the whole hazard the routed clip exists to handle.
 */

import type { AudioElementFactory, RoutableAudio } from './routed-clip'

export class FakeAudio {
  src: string
  preload = ''
  volume = 1
  muted = false
  currentTime = 0
  /** How many times it has been asked to play. */
  plays = 0
  pauses = 0
  /** Every sink it has been pointed at, in order. `''` is the system default. */
  routes: string[] = []

  private pending: { resolve: () => void; reject: (err: unknown) => void }[] = []

  constructor(src: string) {
    this.src = src
  }

  setSinkId(sinkId: string): Promise<void> {
    this.routes.push(sinkId)
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
    })
  }

  play(): Promise<void> {
    this.plays += 1
    return Promise.resolve()
  }

  pause(): void {
    this.pauses += 1
  }

  /** The Announcement player listens for `canplaythrough`; nothing asserts on it. */
  addEventListener(_type: string, _listener: () => void): void {}

  /** Whether it would be heard right now, had it been played. */
  get audible(): boolean {
    return !this.muted
  }

  /** Settles the routing Chromium would settle once the device is open. */
  async landRoutes(): Promise<void> {
    const pending = this.pending
    this.pending = []
    for (const route of pending) route.resolve()
    await Promise.resolve()
  }

  /** Refuses the routing, as a device unplugged since it was chosen would. */
  async failRoutes(): Promise<void> {
    const pending = this.pending
    this.pending = []
    for (const route of pending) route.reject(new Error('no such device'))
    await Promise.resolve()
  }
}

export interface FakeAudioWorld {
  /** Pass this where a player wants an {@link AudioElementFactory}. */
  create: AudioElementFactory
  /** Every element made, in creation order. */
  elements: FakeAudio[]
  /** The elements made for one clip, primary first. */
  for: (url: string) => FakeAudio[]
  /** Lands every outstanding routing, everywhere. */
  landRoutes: () => Promise<void>
}

export function fakeAudioWorld(): FakeAudioWorld {
  const elements: FakeAudio[] = []
  return {
    create: (url: string): RoutableAudio => {
      const audio = new FakeAudio(url)
      elements.push(audio)
      return audio as unknown as RoutableAudio
    },
    elements,
    for: (url) => elements.filter((audio) => audio.src === url),
    landRoutes: async () => {
      for (const audio of elements) await audio.landRoutes()
    },
  }
}
