import { describe, expect, test } from 'bun:test'
import { faviconHref, planAlert, previewOf, titleFor, type AlertContext, type AlertPlan } from './notify'
import { DEFAULT_PREFS } from './prefs'

const at = (o: Partial<AlertContext> = {}): AlertContext => ({ prefs: DEFAULT_PREFS, forMe: false, viewing: true, visible: true, focused: true, ...o })

describe('planAlert', () => {
  test('attending: a quiet sound, no buzz, no banner', () => {
    expect(planAlert(at())).toEqual({ sound: 'message', quiet: true, vibrate: false, banner: false })
    expect(planAlert(at({ forMe: true })).sound).toBe('mention')
  })

  test('another council open, or the window blurred, counts as away: full sound, buzz and banner', () => {
    const away: AlertPlan = { sound: 'message', quiet: false, vibrate: true, banner: true }
    expect(planAlert(at({ viewing: false }))).toEqual(away)
    expect(planAlert(at({ focused: false }))).toEqual(away)
  })

  test('a hidden tab gets sound and buzz but no banner (nobody would see it)', () => {
    expect(planAlert(at({ visible: false }))).toEqual({ sound: 'message', quiet: false, vibrate: true, banner: false })
  })

  test('the direct scope only sounds for what is for me', () => {
    const prefs = { ...DEFAULT_PREFS, scope: 'direct' as const }
    expect(planAlert(at({ prefs, viewing: false })).sound).toBeNull()
    expect(planAlert(at({ prefs, viewing: false })).vibrate).toBe(false)
    expect(planAlert(at({ prefs, viewing: false, forMe: true })).sound).toBe('mention')
  })

  test('soundWhenOpen off silences only the council being looked at', () => {
    const prefs = { ...DEFAULT_PREFS, soundWhenOpen: false }
    expect(planAlert(at({ prefs })).sound).toBeNull()
    expect(planAlert(at({ prefs, viewing: false })).sound).toBe('message')
  })

  test('each layer has its own switch', () => {
    const prefs = { ...DEFAULT_PREFS, sound: false, banners: false }
    expect(planAlert(at({ prefs, viewing: false }))).toEqual({ sound: null, quiet: false, vibrate: false, banner: false })
    expect(planAlert(at({ prefs: { ...DEFAULT_PREFS, vibrate: false }, viewing: false })).vibrate).toBe(false)
  })
})

test('titleFor counts, caps at 99+, marks mentions and can be turned off', () => {
  expect(titleFor('Kurultay app', 0, 0, true)).toBe('Kurultay app')
  expect(titleFor('Kurultay app', 3, 0, true)).toBe('(3) Kurultay app')
  expect(titleFor('Kurultay app', 3, 1, true)).toBe('● (3) Kurultay app')
  expect(titleFor('Kurultay app', 250, 0, true)).toBe('(99+) Kurultay app')
  expect(titleFor('Kurultay app', 3, 1, false)).toBe('Kurultay app')
})

test('previewOf flattens code, Markdown and whitespace, truncates, and falls back to file names', () => {
  expect(previewOf('look:\n```ts\nconst x = 1\n```\ndone')).toBe('look: [code] done')
  expect(previewOf('**bold** _it_ `x` > quote ~~gone~~ # head')).toBe('bold it x quote gone head')
  const long = previewOf('a'.repeat(200))
  expect(long).toHaveLength(90)
  expect(long.endsWith('…')).toBe(true)
  expect(previewOf('', [{ name: 'plan.pdf' }, { name: 'shot.png' }])).toBe('Attached: plan.pdf, shot.png')
  expect(previewOf('')).toBe('')
})

describe('faviconHref', () => {
  const colors = { dot: 'rgb(255, 210, 122)', mention: 'rgb(142, 44, 31)', ring: 'white' }
  const svg = (href: string) => decodeURIComponent(href.replace('data:image/svg+xml,', ''))

  test('is an SVG data URL with the mark, and no dot when nothing is unread', () => {
    const href = faviconHref(0, false, colors)
    expect(href).toStartWith('data:image/svg+xml,')
    expect(svg(href)).toStartWith('<svg')
    expect(svg(href)).not.toContain('cx=\'25\'')
  })

  test('the dot uses the mention colour only when something is for me', () => {
    expect(svg(faviconHref(2, false, colors))).toContain(colors.dot)
    expect(svg(faviconHref(2, true, colors))).toContain(colors.mention)
    expect(svg(faviconHref(2, true, colors))).not.toContain(colors.dot)
  })
})
