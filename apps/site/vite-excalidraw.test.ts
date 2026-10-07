import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fontFiles, withoutCdn } from './vite-excalidraw'

describe('the board’s fonts stay on Kurultay', () => {
  test('Excalidraw’s CDN fallback points at our own copy, as a usable URL base', () => {
    const code = 'P(jn,"ASSETS_FALLBACK_URL",`https://esm.sh/${M.PKG_NAME?`${M.PKG_NAME}@${M.PKG_VERSION}`:"@excalidraw/excalidraw"}/dist/prod/`);var x=1'
    const out = withoutCdn(code, '/kurultay/excalidraw/')
    expect(out).toBe('P(jn,"ASSETS_FALLBACK_URL",new URL("/kurultay/excalidraw/", location.origin).href);var x=1')
    const base = new URL('/kurultay/excalidraw/', 'https://kucukkanat.github.io').href
    expect(new URL('./fonts/Excalifont/x.woff2', base).href).toBe('https://kucukkanat.github.io/kurultay/excalidraw/fonts/Excalifont/x.woff2')
  })

  test('the real, pinned package has no esm.sh reference left after the rewrite', () => {
    const dir = dirname(require.resolve('@excalidraw/excalidraw'))
    const hits = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, f), 'utf8')).filter((c) => c.includes('esm.sh'))
    expect(hits.length).toBeGreaterThan(0)
    for (const c of hits) expect(withoutCdn(c, '/x/')).not.toContain('esm.sh')
  })

  test('every font family is published as real woff2 files, except the 12 MB CJK one', () => {
    const files = fontFiles()
    const families = new Set(files.map(([rel]) => rel.split('/')[0]))
    expect(families).toContain('Excalifont')
    expect(families).not.toContain('Xiaolai')
    for (const [rel, abs] of files) {
      expect(rel).toEndWith('.woff2')
      // woff2 files start with the "wOF2" signature
      expect(new TextDecoder().decode(readFileSync(abs).subarray(0, 4))).toBe('wOF2')
    }
  })
})
