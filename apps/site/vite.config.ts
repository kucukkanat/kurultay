import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { excalidrawAssets } from './vite-excalidraw'

const root = __dirname
const docsDir = resolve(root, 'docs')
const docs = existsSync(docsDir) ? readdirSync(docsDir).filter((f) => f.endsWith('.html')) : []

// CI builds the site right after the dist branch: pin every npx command on the pages to that exact build
// (npm can't install a `github:` spec at a commit, so a commit is referenced by its tarball URL)
const distRef = process.env.VITE_DIST_REF
const pinNpx = {
  name: 'kurultay-pin-npx',
  // docs only: the landing hero keeps the short, illustrative form
  transformIndexHtml: (html: string, ctx: { filename: string }) =>
    distRef && /^[0-9a-f]{40}$/.test(distRef) && /[\\/]docs[\\/]/.test(ctx.filename) ? html.replaceAll('github:kucukkanat/kurultay#dist', `https://codeload.github.com/kucukkanat/kurultay/tar.gz/${distRef}`) : html,
}

export default defineConfig({
  base: '/kurultay/',
  // the board runs Excalidraw on real React in its own root (src/app/board), so `react` must stay React, not preact/compat
  plugins: [preact({ reactAliasesEnabled: false }), excalidrawAssets(), pinNpx],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        app: resolve(root, 'app/index.html'),
        ...Object.fromEntries(docs.map((f) => ['docs-' + f.replace('.html', ''), resolve(docsDir, f)])),
      },
    },
  },
})
