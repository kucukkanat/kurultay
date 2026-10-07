import { expect, test } from 'bun:test'
import { DRAWER, drawerStart, isDrawerSwipe } from './gestures'

test('a long, flat swipe right opens and a swipe left closes', () => {
  expect(isDrawerSwipe(120, 10, 'open')).toBe(true)
  expect(isDrawerSwipe(-120, -10, 'close')).toBe(true)
})

test('the wrong direction does nothing', () => {
  expect(isDrawerSwipe(-120, 0, 'open')).toBe(false)
  expect(isDrawerSwipe(120, 0, 'close')).toBe(false)
})

test('the travel must reach the distance, inclusive', () => {
  expect(isDrawerSwipe(DRAWER.distance, 0, 'open')).toBe(true)
  expect(isDrawerSwipe(DRAWER.distance - 1, 0, 'open')).toBe(false)
  expect(isDrawerSwipe(-DRAWER.distance, 0, 'close')).toBe(true)
})

test('a steep swipe is a scroll; the slope bound is exclusive', () => {
  expect(isDrawerSwipe(100, 100, 'open')).toBe(false)
  expect(isDrawerSwipe(100, 100 * DRAWER.slope, 'open')).toBe(false)
  expect(isDrawerSwipe(100, 100 * DRAWER.slope - 1, 'open')).toBe(true)
  expect(isDrawerSwipe(100, -(100 * DRAWER.slope - 1), 'open')).toBe(true)
})

test('tracking starts at the left edge, anywhere while open, and never on wide screens', () => {
  expect(drawerStart(0, false, true)).toBe(true)
  expect(drawerStart(DRAWER.edge, false, true)).toBe(true)
  expect(drawerStart(DRAWER.edge + 1, false, true)).toBe(false)
  expect(drawerStart(300, true, true)).toBe(true)
  expect(drawerStart(0, false, false)).toBe(false)
  expect(drawerStart(300, true, false)).toBe(false)
})
