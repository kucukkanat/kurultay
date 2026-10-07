import { expect, test } from 'bun:test'
import { DEFAULT_PREFS, parsePrefs, type Prefs } from './prefs'

test('anything that is not an object gives the defaults', () => {
  for (const x of [null, undefined, 42, 'loud', true, []]) expect(parsePrefs(x)).toEqual(DEFAULT_PREFS)
})

test('a wrong type falls back for that field alone', () => {
  const p = parsePrefs({ sound: 'yes', volume: '0.2', scope: 'everyone', soundWhenOpen: 1, vibrate: null, banners: false, titleBadge: {} })
  expect(p).toEqual({ ...DEFAULT_PREFS, banners: false })
})

test('the volume must be a finite number and is clamped to 0..1', () => {
  expect(parsePrefs({ volume: Number.NaN }).volume).toBe(DEFAULT_PREFS.volume)
  expect(parsePrefs({ volume: Number.POSITIVE_INFINITY }).volume).toBe(DEFAULT_PREFS.volume)
  expect(parsePrefs({ volume: -1 }).volume).toBe(0)
  expect(parsePrefs({ volume: 2 }).volume).toBe(1)
  expect(parsePrefs({ volume: 0.3 }).volume).toBe(0.3)
})

test('a valid object round-trips through JSON, and unknown fields are dropped', () => {
  const p: Prefs = { sound: false, volume: 0.25, scope: 'direct', soundWhenOpen: false, vibrate: false, banners: false, titleBadge: false }
  expect(parsePrefs(JSON.parse(JSON.stringify({ ...p, theme: 'bubble' })))).toEqual(p)
})
