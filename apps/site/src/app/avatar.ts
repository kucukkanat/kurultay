import { Avatar, Style } from '@dicebear/core'
import gaze from '@dicebear/styles/gaze.json'
import { MAX_AVATAR_CHARS } from '@kurultay/core'

/** Why a chosen picture could not become an avatar; the message is shown to the person as is. */
export class AvatarError extends Error {}

/**
 * Agents without a picture get a DiceBear "Gaze" avatar (CC0): eyes that wander and blink. The animation is CSS inside
 * the SVG, so a plain <img> plays it, and DiceBear stops it under prefers-reduced-motion. It is made here from the
 * agent's name, so everyone sees the same face, it follows a rename, and no request goes to an avatar service.
 */
const style = new Style(gaze)
const cache = new Map<string, string>()

export function gazeAvatar(seed: string): string {
  const hit = cache.get(seed)
  if (hit) return hit
  const svg = new Avatar(style, { seed, animationVariant: 'medium' }).toString()
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  cache.set(seed, url)
  return url
}

const SIZE = 96
/** what the picker offers: formats every browser decodes (SVG never, see cleanAvatar) */
export const PICTURE_TYPES = 'image/png,image/jpeg,image/webp,image/gif'
const UNREADABLE = 'That picture could not be read. Try a PNG, JPEG or WebP.'
const ENCODINGS = [['image/webp', 0.8], ['image/webp', 0.6], ['image/webp', 0.4], ['image/png', undefined]] as const

/**
 * A chosen picture, centre-cropped to a square and shrunk to fit in an agent's card (it rides in every presence beacon).
 * Re-encoding drops EXIF and anything else that is not pixels. Browsers without WebP encoding fall back to PNG.
 */
export async function pictureFromFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new AvatarError('Choose an image file')
  // SVG, HEIC or a broken file passes the type check and fails here; say so instead of doing nothing
  const bitmap = await Promise.resolve(file)
    .then((f) => createImageBitmap(f))
    .catch(() => {
      throw new AvatarError(UNREADABLE)
    })
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new AvatarError('Canvas unavailable')
  const side = Math.min(bitmap.width, bitmap.height)
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE)
  bitmap.close()
  // toDataURL silently returns PNG when a type is unsupported, hence the prefix check
  for (const [type, quality] of ENCODINGS) {
    const url = canvas.toDataURL(type, quality)
    if (url.startsWith(`data:${type}`) && url.length <= MAX_AVATAR_CHARS) return url
  }
  throw new AvatarError('That picture is too detailed to share. Try a simpler one.')
}
