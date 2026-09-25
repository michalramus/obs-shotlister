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

  // Media elements are inert in jsdom: play() is undefined rather than a
  // promise-returning no-op, which the transport effect awaits.
  if (typeof HTMLMediaElement !== 'undefined') {
    HTMLMediaElement.prototype.play = function play(): Promise<void> {
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = function pause(): void {}
  }
}
