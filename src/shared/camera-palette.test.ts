import { describe, it, expect } from 'vitest'
import { CAMERA_PALETTE, nextCameraColor } from './camera-palette'

const cam = (color: string): { color: string } => ({ color })

describe('CAMERA_PALETTE', () => {
  it('offers 24 colours', () => {
    expect(CAMERA_PALETTE).toHaveLength(24)
  })

  it('contains no duplicates', () => {
    expect(new Set(CAMERA_PALETTE).size).toBe(CAMERA_PALETTE.length)
  })

  it('is all lowercase 6-digit hex', () => {
    for (const color of CAMERA_PALETTE) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe('nextCameraColor', () => {
  it('assigns the first palette colour to the first camera', () => {
    expect(nextCameraColor([])).toBe(CAMERA_PALETTE[0])
  })

  it('walks the palette in order as cameras are added', () => {
    const cameras: { color: string }[] = []
    for (let i = 0; i < 5; i++) {
      const color = nextCameraColor(cameras)
      expect(color).toBe(CAMERA_PALETTE[i])
      cameras.push(cam(color))
    }
  })

  it('skips colours already taken', () => {
    expect(nextCameraColor([cam(CAMERA_PALETTE[0])])).toBe(CAMERA_PALETTE[1])
  })

  it('reuses a gap left by a deleted camera', () => {
    // Camera holding palette[0] was deleted; the next new camera reclaims it.
    const remaining = [cam(CAMERA_PALETTE[1]), cam(CAMERA_PALETTE[2])]
    expect(nextCameraColor(remaining)).toBe(CAMERA_PALETTE[0])
  })

  it('ignores custom colours outside the palette', () => {
    expect(nextCameraColor([cam('#123456')])).toBe(CAMERA_PALETTE[0])
  })

  it('matches taken colours case-insensitively', () => {
    expect(nextCameraColor([cam(CAMERA_PALETTE[0].toUpperCase())])).toBe(CAMERA_PALETTE[1])
  })

  it('tolerates surrounding whitespace', () => {
    expect(nextCameraColor([cam(` ${CAMERA_PALETTE[0]} `)])).toBe(CAMERA_PALETTE[1])
  })

  it('wraps once every colour is in use', () => {
    const all = CAMERA_PALETTE.map(cam)
    expect(nextCameraColor(all)).toBe(CAMERA_PALETTE[0])
    expect(nextCameraColor([...all, cam(CAMERA_PALETTE[0])])).toBe(CAMERA_PALETTE[1])
  })
})
