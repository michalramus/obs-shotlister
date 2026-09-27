import { describe, expect, it } from 'vitest'
import {
  ASSIGNMENT_STRIP_BORDER_PX,
  ASSIGNMENT_STRIP_MIN_HEIGHT,
  ASSIGNMENT_STRIP_PADDING_Y,
  ASSIGNMENT_STRIP_ROW_GAP,
  assignmentStripLayout,
} from './assignment-strip'

/** A button as the buttons in the strip actually measure: 13px text + padding. */
const BUTTON = 29
/** Natural content height of `n` wrapped lines of those buttons. */
function lines(n: number): number {
  return n * BUTTON + (n - 1) * ASSIGNMENT_STRIP_ROW_GAP
}

describe('assignmentStripLayout', () => {
  it('leaves a single line at the height the strip has always had', () => {
    const layout = assignmentStripLayout({ contentHeightPx: lines(1), buttonHeightPx: BUTTON })
    expect(layout.lines).toBe(1)
    expect(layout.heightPx).toBe(ASSIGNMENT_STRIP_MIN_HEIGHT)
    expect(layout.scrolls).toBe(false)
  })

  it('grows to fit exactly two lines', () => {
    const layout = assignmentStripLayout({ contentHeightPx: lines(2), buttonHeightPx: BUTTON })
    expect(layout.lines).toBe(2)
    expect(layout.linesShown).toBe(2)
    expect(layout.heightPx).toBe(
      lines(2) + 2 * ASSIGNMENT_STRIP_PADDING_Y + ASSIGNMENT_STRIP_BORDER_PX,
    )
    // The whole complaint: a two-line strip is taller than a one-line one.
    expect(layout.heightPx).toBeGreaterThan(ASSIGNMENT_STRIP_MIN_HEIGHT)
    // And it fits both lines, so nothing scrolls.
    expect(layout.scrolls).toBe(false)
  })

  it('stops at two lines and scrolls beyond that', () => {
    const two = assignmentStripLayout({ contentHeightPx: lines(2), buttonHeightPx: BUTTON })
    for (const n of [3, 4, 9]) {
      const layout = assignmentStripLayout({ contentHeightPx: lines(n), buttonHeightPx: BUTTON })
      expect(layout.lines).toBe(n)
      expect(layout.linesShown).toBe(2)
      expect(layout.heightPx).toBe(two.heightPx)
      expect(layout.scrolls).toBe(true)
    }
  })

  it('reads a fraction of a pixel over a line as that line, not the next', () => {
    const layout = assignmentStripLayout({
      contentHeightPx: lines(2) + 0.4,
      buttonHeightPx: BUTTON,
    })
    expect(layout.lines).toBe(2)
    expect(layout.scrolls).toBe(false)
  })

  it('reports one line at the old height when nothing has been measured yet', () => {
    // jsdom and the first paint: every offsetHeight is 0. A strip that guessed
    // zero lines here would collapse, and one that guessed many would be thick.
    const layout = assignmentStripLayout({ contentHeightPx: 0, buttonHeightPx: 0 })
    expect(layout).toEqual({
      lines: 1,
      linesShown: 1,
      heightPx: ASSIGNMENT_STRIP_MIN_HEIGHT,
      scrolls: false,
    })
  })

  it('survives a content height with no buttons to divide by', () => {
    // "No cameras configured" is a bare span: content with no button in it.
    const layout = assignmentStripLayout({ contentHeightPx: 14, buttonHeightPx: 0 })
    expect(layout.lines).toBe(1)
    expect(layout.heightPx).toBe(ASSIGNMENT_STRIP_MIN_HEIGHT)
    expect(layout.scrolls).toBe(false)
  })

  it('never returns a height below the one-line minimum', () => {
    for (const buttonHeightPx of [0, 8, 20, 29]) {
      const layout = assignmentStripLayout({ contentHeightPx: buttonHeightPx, buttonHeightPx })
      expect(layout.heightPx).toBeGreaterThanOrEqual(ASSIGNMENT_STRIP_MIN_HEIGHT)
    }
  })

  it('fits two lines of taller buttons rather than clipping them', () => {
    // A larger system font makes the buttons taller; two lines of those must
    // still fit, which a constant height could not promise.
    const tall = 40
    const layout = assignmentStripLayout({ contentHeightPx: 2 * tall + 6, buttonHeightPx: tall })
    expect(layout.lines).toBe(2)
    expect(layout.heightPx).toBeGreaterThanOrEqual(2 * tall + ASSIGNMENT_STRIP_ROW_GAP)
  })
})
