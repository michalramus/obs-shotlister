/**
 * The probe exists to tell three failure modes apart, so its arithmetic has to
 * be right — a rate that reads low would hide exactly the regression it is there
 * to catch.
 */

import { describe, it, expect } from 'vitest'
import { formatProbeReport } from './playback-probe'

describe('formatProbeReport', () => {
  it('reports per-second rates over the measured window, not raw counts', () => {
    const line = formatProbeReport({
      elapsedMs: 2000,
      renders: 20,
      frames: 120,
      droppedVideoFrames: 3,
    })
    expect(line).toContain('10.0 renders/s')
    expect(line).toContain('60.0 frames/s')
    expect(line).toContain('3 dropped video frames')
  })

  it('says n/a for dropped frames when there is no video element', () => {
    const line = formatProbeReport({
      elapsedMs: 1000,
      renders: 10,
      frames: 60,
      droppedVideoFrames: null,
    })
    expect(line).toContain('n/a dropped video frames')
  })

  it('does not divide by zero on a zero-length window', () => {
    const line = formatProbeReport({
      elapsedMs: 0,
      renders: 5,
      frames: 5,
      droppedVideoFrames: 0,
    })
    expect(line).toContain('0.0 renders/s')
  })
})
