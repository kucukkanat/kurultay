import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = __dirname
const docsDir = resolve(root, 'docs')
const docs = existsSync(docsDir) ? readdirSync(docsDir).filter((f) => f.endsWith('.html')) : []

export default defineConfig({
  base: '/kurultay/',
  plugins: [preact()],
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
