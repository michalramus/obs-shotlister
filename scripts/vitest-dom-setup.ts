/**
 * What jsdom does not provide, for the component suites only.
 *
 * Node-environment suites import this too — every guard below checks for a DOM
 * first, so it is a no-op there rather than a second config to keep in step.
 */

if (typeof window !== 'undefined') {
  // jsdom has no layout engine and therefore no ResizeObserver. The timeline
  // measures itself through one; without a stub it throws on mount.
  if (!('ResizeObserver' in window)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    ;(window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub
  }

  // jsdom has no layout, so every element reports clientWidth 0. Components that
  // size themselves from a measurement then compute every position as zero, which
  // makes any position assertion vacuous. Report a plausible viewport width
  // instead. Defined on Element rather than HTMLElement so a test that wants to
  // count reads can shadow it on the same prototype and restore it afterwards.
  if (typeof Element !== 'undefined') {
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get(): number {
        return 1000
      },
    })
  }

  // Media elements are inert in jsdom: play() is undefined rather than a
  // promise-returning no-op, which the transport effect awaits.
  if (typeof HTMLMediaElement !== 'undefined') {
    HTMLMediaElement.prototype.play = function play(): Promise<void> {
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = function pause(): void {}
  }
}
