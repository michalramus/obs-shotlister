import { describe, it, expect } from 'vitest'
import { toMediaUrl, fromMediaUrl } from './media-url'

describe('toMediaUrl', () => {
  it('builds a URL for a plain POSIX path', () => {
    expect(toMediaUrl('/Users/me/clip.mp4')).toBe('media://localhost/Users/me/clip.mp4')
  })

  it('encodes spaces', () => {
    expect(toMediaUrl('/Users/me/my clip.mp4')).toBe('media://localhost/Users/me/my%20clip.mp4')
  })

  it('encodes characters that would truncate the URL', () => {
    expect(toMediaUrl('/media/take#3.mp4')).toBe('media://localhost/media/take%233.mp4')
    expect(toMediaUrl('/media/what?.mp4')).toBe('media://localhost/media/what%3F.mp4')
    expect(toMediaUrl('/media/100%.mp4')).toBe('media://localhost/media/100%25.mp4')
  })

  it('converts Windows separators and drive letters', () => {
    expect(toMediaUrl('C:\\Videos\\clip.mp4')).toBe('media://localhost/C%3A/Videos/clip.mp4')
  })

  it('does not double up the leading slash', () => {
    expect(toMediaUrl('/a/b')).toBe('media://localhost/a/b')
  })
})

describe('fromMediaUrl', () => {
  it.each([
    '/Users/me/clip.mp4',
    '/Users/me/my clip.mp4',
    '/media/take#3.mp4',
    '/media/what?.mp4',
    '/media/100%.mp4',
    '/media/ünïcode.mp4',
  ])('round-trips %s', (filePath) => {
    expect(fromMediaUrl(toMediaUrl(filePath))).toBe(filePath)
  })

  it('round-trips a Windows path to forward slashes', () => {
    expect(fromMediaUrl(toMediaUrl('C:\\Videos\\clip.mp4'))).toBe('C:/Videos/clip.mp4')
  })
})
