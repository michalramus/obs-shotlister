import { describe, it, expect } from 'vitest'
import { isEchoScroll } from './scroll-sync'

describe('isEchoScroll', () => {
  it('recognises the exact value we wrote', () => {
    expect(isEchoScroll(1200, 1200)).toBe(true)
  })

  it('absorbs the browser rounding scrollLeft by a fraction of a pixel', () => {
    expect(isEchoScroll(1200.4, 1200)).toBe(true)
    expect(isEchoScroll(1199, 1200)).toBe(true)
  })

  it('treats a position we did not write as the operator scrolling', () => {
    expect(isEchoScroll(900, 1200)).toBe(false)
  })

  it('treats anything as the operator when we have written nothing', () => {
    // The state during an overrunning Live Shot: the playhead is frozen, nothing
    // auto-scrolls, and a drag on the overview has to be acted on.
    expect(isEchoScroll(0, null)).toBe(false)
    expect(isEchoScroll(1200, null)).toBe(false)
  })
})
