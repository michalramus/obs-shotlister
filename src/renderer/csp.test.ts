import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The renderer's CSP governs the waveform as much as it governs playback.
 *
 * `media-src` covers the <audio>/<video> elements, so playback kept working
 * while the waveform — which fetches the same file to decode its peaks — was
 * blocked by `connect-src` falling back to `default-src 'self'`. The failure
 * surfaced as a bare "Failed to fetch" that pointed at the file rather than at
 * the policy, so the policy is pinned here.
 */
describe('renderer Content-Security-Policy', () => {
  const html = readFileSync(join(__dirname, 'index.html'), 'utf8')
  const policy = /content="([^"]*default-src[^"]*)"/.exec(html)?.[1] ?? ''

  it('is present', () => {
    expect(policy).toContain('default-src')
  })

  it('lets media elements load media:// URLs', () => {
    expect(policy).toMatch(/media-src[^;]*\bmedia:/)
  })

  it('lets fetch read media:// URLs, so the waveform can decode peaks', () => {
    expect(policy).toMatch(/connect-src[^;]*\bmedia:/)
  })
})
