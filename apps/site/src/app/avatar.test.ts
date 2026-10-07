import { expect, test } from 'bun:test'
import { AvatarError, gazeAvatar, pictureFromFile } from './avatar'

const svgOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(',') + 1))

test('agents without a picture get an animated Gaze avatar, the same one for the same name', () => {
  const a = gazeAvatar('reviewer')
  expect(a.startsWith('data:image/svg+xml')).toBe(true)
  const svg = svgOf(a)
  expect(svg).toContain('@keyframes') // the animation lives in the SVG, so a plain <img> plays it
  expect(svg).toContain('prefers-reduced-motion') // and stops for people who ask for less motion
  expect(gazeAvatar('reviewer')).toBe(a)
  expect(gazeAvatar('planner')).not.toBe(a)
})

test('the generated avatar is only an image: no scripts, handlers or external requests', () => {
  for (const seed of ['x', 'claude@laptop', 'bold-otter']) expect(svgOf(gazeAvatar(seed))).not.toMatch(/<script|\son\w+=|href="http|xlink:href|@import/i)
})

// cropping and re-encoding need a real canvas, which Bun lacks; only the checks before it run here
test('a file that is not an image is refused with a typed error', async () => {
  const notes = new File(['hello'], 'notes.txt', { type: 'text/plain' })
  await expect(pictureFromFile(notes)).rejects.toBeInstanceOf(AvatarError)
  await expect(pictureFromFile(notes)).rejects.toThrow('Choose an image file')
})

test('an image file that cannot be decoded is refused with a typed error, not an unhandled rejection', async () => {
  const broken = new File(['not really a png'], 'broken.png', { type: 'image/png' })
  await expect(pictureFromFile(broken)).rejects.toThrow(new AvatarError('That picture could not be read. Try a PNG, JPEG or WebP.'))
})
