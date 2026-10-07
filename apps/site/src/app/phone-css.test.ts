// Integration: reads the real stylesheets and pages, so the phone layout cannot drift from its tokens and breakpoint.
import { expect, test } from 'bun:test'
import { PHONE_MAX } from '../shared/theme'

const read = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text()
const app = await read('./app.css')
const theme = await read('../shared/theme.css')
const landing = await read('../landing/landing.css')
/** The body of the first `@media <query> {…}` block, matched by brace depth. */
const block = (css: string, query: string): string => {
  const start = css.indexOf(`@media ${query} {`)
  if (start < 0) throw new Error(`no @media ${query} block`)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0
    if (depth === 0) return css.slice(start, i)
  }
  throw new Error(`unclosed @media ${query} block`)
}

test('every phone media query uses PHONE_MAX (the wider 1100px tablet rules aside)', () => {
  const widths = [...app.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]))
  expect(widths).toContain(PHONE_MAX)
  expect(widths.filter((w) => w !== PHONE_MAX && w !== 1100)).toEqual([])
})

test('every custom property the app and landing use is defined', () => {
  const defined = new Set([...(theme + app).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
  const used = new Set([...(app + landing).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))
  expect([...used].filter((v) => !defined.has(v))).toEqual([])
})

test('layers and motion come from tokens, not raw numbers', () => {
  expect(app.match(/z-index:\s*-?\d/g)).toBeNull()
  expect(app.match(/(transition|animation)[^;]*\d(ms|s)\b/g)).toBeNull()
})

test('touch screens get finger-sized targets and fields that do not zoom iOS', () => {
  const coarse = block(app, '(pointer: coarse)')
  expect(coarse).toMatch(/\.btn,\s*\.icon-btn,\s*\.side-item \{\s*min-height: var\(--tap\)/)
  expect(coarse).toMatch(/\.icon-btn \{\s*min-width: var\(--tap\)/)
  expect(coarse).toMatch(/textarea, select\) \{\s*font-size: var\(--field-touch\)/)
  expect(theme).toMatch(/--tap: 44px/)
  expect(theme).toMatch(/--field-touch: 16px/)
})

test('on a phone, my messages sit right, dialogs are sheets and toasts clear the notch', () => {
  const phone = app.slice(app.lastIndexOf(`@media (max-width: ${PHONE_MAX}px)`, app.indexOf('messages become bubbles')))
  const rules = block(phone, `(max-width: ${PHONE_MAX}px)`)
  expect(rules).toMatch(/\.msg\.mine \.msg-gutter \{\s*display: none/)
  expect(rules).toMatch(/\.msg\.mine \.msg-body \{\s*justify-self: end/)
  expect(rules).toMatch(/\.modal-backdrop \{\s*place-items: end stretch/)
  expect(rules).toMatch(/animation: sheet-in/)
  expect(rules).toMatch(/top: calc\(var\(--safe-top\)/)
  expect(app).toContain('@keyframes sheet-in')
})

test('both pages let the layout run edge to edge under the notch', async () => {
  for (const page of ['../../index.html', '../../app/index.html']) expect(await read(page)).toContain('viewport-fit=cover')
})

test('the phone layout parts carry test ids for end-to-end runs', async () => {
  const shell = await read('./Shell.tsx')
  for (const id of ['sidebar', 'nav-scrim', 'nav-open', 'message', 'composer-input']) expect(shell).toContain(`data-testid="${id}"`)
  expect(shell).toContain('data-mine={mine}')
})
