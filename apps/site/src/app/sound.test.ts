import { expect, test } from 'bun:test'
import { gapAllows, MIN_GAP_MS, playSound, toneScript, type SoundKind } from './sound'

const kinds: SoundKind[] = ['message', 'mention']

test('every note is capped and gentle: low gain, short, in a comfortable range', () => {
  for (const k of kinds) {
    expect(toneScript(k).length).toBeGreaterThan(0)
    for (const n of toneScript(k)) {
      expect(n.gain).toBeLessThanOrEqual(0.25)
      expect(n.dur).toBeLessThan(0.6)
      expect(n.freq).toBeGreaterThanOrEqual(200)
      expect(n.freq).toBeLessThanOrEqual(2000)
    }
  }
})

test('a mention sounds different from a plain message', () => {
  expect(toneScript('mention')).not.toEqual(toneScript('message'))
})

test('nothing plays without Web Audio', () => {
  expect(playSound(null, 'message', 1, { now: 0 })).toBe(false)
  expect(playSound(null, 'mention', 1, { force: true })).toBe(false)
})

test('a burst of messages is one sound; previews skip the gap', () => {
  expect(gapAllows(Number.NEGATIVE_INFINITY, 0)).toBe(true)
  expect(gapAllows(1000, 1000 + MIN_GAP_MS - 1)).toBe(false)
  expect(gapAllows(1000, 1000 + MIN_GAP_MS)).toBe(true)
  expect(gapAllows(1000, 1001, true)).toBe(true)
})
