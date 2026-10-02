#!/usr/bin/env node
// Renders the app icon into every shape electron-builder asks for:
// build/icon.icns (mac), build/icon.ico (win) and build/icons/<size>.png (linux).
//
// The icon is drawn here rather than committed as one master PNG and downscaled,
// because the smallest sizes are where an app icon is actually read. A 16px box
// filter over a 1024px master turns the three bars into grey mush; rendering the
// same geometry at each size keeps them as three distinct strokes.
//
// No image library: PNG is deflate plus four CRCs, and zlib ships with node.
// Adding a dependency to draw nine rounded rectangles is not worth the install.

import { deflateSync } from 'zlib'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const iconsDir = join(buildDir, 'icons')

// --- Palette -----------------------------------------------------------------
// Near-black plate, one live bar, two queued bars. The live red is the only
// saturated colour in the icon, so what the app is about survives at 16px.
const PLATE_TOP = [0x22, 0x25, 0x2c, 0xff]
const PLATE_BOTTOM = [0x12, 0x14, 0x18, 0xff]
const LIVE = [0xe5, 0x48, 0x4d, 0xff]
const QUEUED = [0x5a, 0x61, 0x6e, 0xff]
const QUEUED_DIM = [0x42, 0x48, 0x53, 0xff]

// --- Geometry, in units of the canvas ----------------------------------------
// A transparent margin because macOS expects the plate to sit inside the grid
// rather than fill it; Windows and Linux tolerate the same inset.
const MARGIN = 0.0625
const CORNER = 0.195
const BAR_LEFT = 0.16
const BAR_RIGHT = 0.665
const BAR_HEIGHT = 0.1
const BAR_CENTERS = [0.315, 0.5, 0.685]
const DOT_CENTER = [0.79, 0.315]
const DOT_RADIUS = 0.055

// Signed distance to a rounded rectangle: negative inside, positive outside.
// One function covers the plate and the bars (a bar is a rounded rect whose
// radius is half its height), so there is one piece of edge maths to get right.
function roundedRectDistance(x, y, left, top, right, bottom, radius) {
  const halfWidth = (right - left) / 2
  const halfHeight = (bottom - top) / 2
  const dx = Math.abs(x - (left + halfWidth)) - (halfWidth - radius)
  const dy = Math.abs(y - (top + halfHeight)) - (halfHeight - radius)
  const outsideX = Math.max(dx, 0)
  const outsideY = Math.max(dy, 0)
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(outsideX, outsideY) - radius
}

function circleDistance(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) - radius
}

// Coverage of a shape at one pixel, sampled on a 4x4 grid. Antialiasing by
// supersampling rather than by analytic coverage: the shapes overlap and the
// sample grid is the cheap way to keep their seams clean.
const SUB = 4
function coverage(px, py, pixel, distance) {
  let hits = 0
  for (let sy = 0; sy < SUB; sy++) {
    for (let sx = 0; sx < SUB; sx++) {
      const x = px + ((sx + 0.5) / SUB) * pixel
      const y = py + ((sy + 0.5) / SUB) * pixel
      if (distance(x, y) < 0) hits++
    }
  }
  return hits / (SUB * SUB)
}

// Straight alpha source-over, which is what PNG stores.
function blend(dst, offset, color, alpha) {
  if (alpha <= 0) return
  const srcA = (color[3] / 255) * alpha
  const dstA = dst[offset + 3] / 255
  const outA = srcA + dstA * (1 - srcA)
  if (outA <= 0) {
    dst[offset] = dst[offset + 1] = dst[offset + 2] = dst[offset + 3] = 0
    return
  }
  for (let c = 0; c < 3; c++) {
    const src = color[c] / 255
    const d = dst[offset + c] / 255
    dst[offset + c] = Math.round(((src * srcA + d * dstA * (1 - srcA)) / outA) * 255)
  }
  dst[offset + 3] = Math.round(outA * 255)
}

function renderRGBA(size) {
  const pixels = new Uint8Array(size * size * 4)
  const pixel = 1 / size
  const plateLeft = MARGIN
  const plateRight = 1 - MARGIN
  const plate = (x, y) =>
    roundedRectDistance(x, y, plateLeft, plateLeft, plateRight, plateRight, CORNER)

  const bars = BAR_CENTERS.map((center, index) => ({
    color: index === 0 ? LIVE : index === 1 ? QUEUED : QUEUED_DIM,
    // The live bar stops short of the dot; the queued ones run past where the
    // dot would be, which is what makes the top row read as the current shot.
    right: index === 0 ? BAR_RIGHT : BAR_RIGHT + 0.08,
    top: center - BAR_HEIGHT / 2,
    bottom: center + BAR_HEIGHT / 2,
  }))

  for (let row = 0; row < size; row++) {
    const py = row * pixel
    for (let col = 0; col < size; col++) {
      const px = col * pixel
      const offset = (row * size + col) * 4

      const plateAlpha = coverage(px, py, pixel, plate)
      if (plateAlpha > 0) {
        // Vertical gradient, evaluated at the pixel centre. Flat dark reads as
        // a hole on a dark dock; the gradient gives the plate an edge.
        const t = (py + pixel / 2 - MARGIN) / (1 - 2 * MARGIN)
        const shade = PLATE_TOP.map((channel, c) =>
          c === 3 ? channel : Math.round(channel + (PLATE_BOTTOM[c] - channel) * Math.min(1, Math.max(0, t))),
        )
        blend(pixels, offset, shade, plateAlpha)
      }

      for (const bar of bars) {
        const alpha = coverage(px, py, pixel, (x, y) =>
          roundedRectDistance(x, y, BAR_LEFT, bar.top, bar.right, bar.bottom, BAR_HEIGHT / 2),
        )
        blend(pixels, offset, bar.color, alpha)
      }

      const dotAlpha = coverage(px, py, pixel, (x, y) =>
        circleDistance(x, y, DOT_CENTER[0], DOT_CENTER[1], DOT_RADIUS),
      )
      blend(pixels, offset, LIVE, dotAlpha)
    }
  }
  return pixels
}

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePNG(size, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  // Filter 0 on every scanline: these are flat shapes, so the gain from
  // per-line filter selection is a few hundred bytes on a file nobody ships
  // over the wire.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let row = 0; row < size; row++) {
    const at = row * (size * 4 + 1)
    raw[at] = 0
    Buffer.from(rgba.buffer, row * size * 4, size * 4).copy(raw, at + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- ICO ---------------------------------------------------------------------
// PNG-compressed entries, which every Windows since Vista reads. 256 is stored
// as 0 in the directory, per the format.
function encodeICO(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + entries.length * 16
  const directory = []
  for (const entry of entries) {
    const record = Buffer.alloc(16)
    record[0] = entry.size >= 256 ? 0 : entry.size
    record[1] = entry.size >= 256 ? 0 : entry.size
    record[2] = 0 // palette
    record[3] = 0 // reserved
    record.writeUInt16LE(1, 4) // colour planes
    record.writeUInt16LE(32, 6) // bits per pixel
    record.writeUInt32LE(entry.png.length, 8)
    record.writeUInt32LE(offset, 12)
    directory.push(record)
    offset += entry.png.length
  }
  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.png)])
}

// --- Output ------------------------------------------------------------------

const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
// Both the plain and @2x names, because iconutil wants the pairs and the
// Finder picks between them by display scale.
const ICNS_ENTRIES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

const cache = new Map()
function png(size) {
  let existing = cache.get(size)
  if (!existing) {
    existing = encodePNG(size, renderRGBA(size))
    cache.set(size, existing)
  }
  return existing
}

mkdirSync(iconsDir, { recursive: true })

for (const size of LINUX_SIZES) {
  writeFileSync(join(iconsDir, `${size}x${size}.png`), png(size))
}
// electron-builder's mac/win targets take a single file; the 1024 master also
// stands in as the generic PNG for anything that wants one.
writeFileSync(join(buildDir, 'icon.png'), png(1024))
writeFileSync(
  join(buildDir, 'icon.ico'),
  encodeICO(ICO_SIZES.map((size) => ({ size, png: png(size) }))),
)

const iconset = join(buildDir, 'icon.iconset')
mkdirSync(iconset, { recursive: true })
for (const [name, size] of ICNS_ENTRIES) writeFileSync(join(iconset, name), png(size))
try {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])
  rmSync(iconset, { recursive: true, force: true })
  console.log('wrote build/icon.icns, build/icon.ico, build/icon.png and build/icons/*.png')
} catch (err) {
  // Only macOS has iconutil. The icns in the repo is the one that ships, so a
  // Linux or Windows run regenerating everything else is still useful.
  console.log('wrote build/icon.ico, build/icon.png and build/icons/*.png')
  console.log(`icns skipped (iconutil unavailable): ${err instanceof Error ? err.message : err}`)
}
