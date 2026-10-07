import { expect, test } from 'bun:test'
import { blocksLoopback, nextDelay, nextSearchDelay, PAIR_POLL_MS, SEARCH_FIRST_MS, SEARCH_MAX_MS, STATE_POLL_MS } from './daemon-search'

test('searching backs off from 3 s, doubling, to 30 s', () => {
  expect([0, 1, 2, 3, 4, 5, 50].map(nextSearchDelay)).toEqual([SEARCH_FIRST_MS, 3000, 6000, 12_000, 24_000, SEARCH_MAX_MS, SEARCH_MAX_MS])
})

test('connected and pairing poll at a steady pace whatever the misses', () => {
  expect(nextDelay('connected', 9)).toBe(STATE_POLL_MS)
  expect(nextDelay('pairing', 9)).toBe(PAIR_POLL_MS)
  expect(nextDelay('unpaired', 2)).toBe(nextSearchDelay(2))
})

test('only Safari on https is flagged', () => {
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
  expect(blocksLoopback(safari, 'https:')).toBe(true)
  expect(blocksLoopback(safari, 'http:')).toBe(false)
  expect(blocksLoopback(chrome, 'https:')).toBe(false)
})
