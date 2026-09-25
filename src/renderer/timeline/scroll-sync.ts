/**
 * Telling our own scrolling apart from the operator's.
 *
 * The timeline scrolls itself every frame to keep a fixed playhead over moving
 * content, and each of those writes comes back as a `scroll` event. Acting on
 * those events re-renders the whole timeline once per frame, which is what
 * defeated the playhead's commit budget.
 *
 * It cannot be guarded with a flag cleared in a `setTimeout(0)`: a browser
 * dispatches `scroll` during the *next* frame's rendering steps, long after that
 * task has run, so the flag is always back to false by the time it matters. It
 * cannot be guarded on "is playback running" either — during an overrunning Live
 * Shot the playhead is deliberately frozen and nothing scrolls, so an operator
 * dragging the overview then produces real events that must be acted on.
 *
 * What does work is comparing against the last value we wrote.
 */

/**
 * Whether a scroll event is the echo of our own programmatic write.
 *
 * `expectedPx` is the last position this code set, or null if it has not set one
 * since the operator last scrolled. The tolerance absorbs the sub-pixel rounding a
 * browser applies when storing `scrollLeft`.
 */
export function isEchoScroll(
  actualPx: number,
  expectedPx: number | null,
  tolerancePx = 1,
): boolean {
  if (expectedPx === null) return false
  return Math.abs(actualPx - expectedPx) <= tolerancePx
}
