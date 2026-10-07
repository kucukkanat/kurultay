// The board's fonts, served from Kurultay itself. Excalidraw fetches its hand-drawn fonts from a public CDN unless
// window.EXCALIDRAW_ASSET_PATH says otherwise, and keeps that CDN as a fallback even then; either request would tell a
// third party when someone opens a board. This copies the fonts to <base>excalidraw/fonts/ (dev and build) and points
// the fallback at that copy too. Xiaolai, a 12 MB CJK fallback, is left out: CJK text falls back to the system font.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import type { Plugin } from 'vite'

const SKIP = new Set(['Xiaolai'])

export function fontDir(): string {
  const main = createRequire(import.meta.url).resolve('@excalidraw/excalidraw')
  return join(dirname(main), 'fonts')
}

/** Every font file to publish, as [path under fonts/, absolute path]. */
export function fontFiles(dir = fontDir()): [string, string][] {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
  return readdirSync(dir)
    .filter((family) => !SKIP.has(family) && statSync(join(dir, family)).isDirectory())
    .flatMap((family) => walk(join(dir, family)))
    .map((abs): [string, string] => [relative(dir, abs).split(sep).join('/'), abs])
}

/**
 * Excalidraw's fallback for any font it cannot find at EXCALIDRAW_ASSET_PATH: a public CDN, as a template literal that
 * nests another one (`https://esm.sh/${pkg ? `${name}@${version}` : '…'}/dist/prod/`), hence the lazy match to its end.
 */
export const CDN_FALLBACK = /`https:\/\/esm\.sh\/[\s\S]*?\/dist\/prod\/`/g

/**
 * Points Excalidraw's CDN fallback at Kurultay's own copy, so even a font it misses is never asked of a third party. It is
 * used as a URL base, so it must be absolute: the page's own origin plus the base path, worked out in the browser.
 */
export const withoutCdn = (code: string, local: string): string => code.replace(CDN_FALLBACK, `new URL(${JSON.stringify(local)}, location.origin).href`)

export function excalidrawAssets(): Plugin {
  let base = '/'
  return {
    name: 'kurultay-excalidraw-assets',
    enforce: 'pre',
    configResolved: (c) => {
      base = c.base
    },
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw') || !code.includes('esm.sh')) return null
      return { code: withoutCdn(code, `${base}excalidraw/`), map: null }
    },
    configureServer(server) {
      const files = new Map(fontFiles())
      server.middlewares.use((req, res, next) => {
        const prefix = `${base}excalidraw/fonts/`
        const path = req.url?.split('?')[0] ?? ''
        const file = path.startsWith(prefix) ? files.get(decodeURIComponent(path.slice(prefix.length))) : undefined
        if (!file) return next()
        res.setHeader('content-type', 'font/woff2')
        res.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const [rel, abs] of fontFiles()) this.emitFile({ type: 'asset', fileName: `excalidraw/fonts/${rel}`, source: readFileSync(abs) })
    },
  }
}
