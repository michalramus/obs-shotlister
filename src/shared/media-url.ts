/**
 * Conversion between local file paths and `media://` URLs.
 *
 * The renderer cannot load `file://` URLs, so local media is served through the
 * custom `media://` protocol registered in src/main/index.ts. Paths must be
 * percent-encoded: an unencoded `#` or `?` truncates the URL, and Windows paths
 * (`C:\Videos\x.mp4`) are not valid URL paths at all.
 */

const MEDIA_ORIGIN = 'media://localhost'

/** Builds a `media://` URL for a local file path. Safe for spaces, `#`, `?` and Windows paths. */
export function toMediaUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`
  const encoded = absolute.split('/').map(encodeURIComponent).join('/')
  return `${MEDIA_ORIGIN}${encoded}`
}

/** Recovers the local file path from a `media://` URL. Inverse of {@link toMediaUrl}. */
export function fromMediaUrl(url: string): string {
  const pathname = decodeURIComponent(new URL(url).pathname)
  // Windows drive paths come back as "/C:/Videos/x.mp4" — drop the leading slash.
  return /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname
}
