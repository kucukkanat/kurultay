// Renders /docs/*.md and /nip/kurultay.md into apps/site/docs/*.html (Vite inputs).
import { marked } from 'marked'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '../../..')
const out = resolve(import.meta.dir, '../docs')
mkdirSync(out, { recursive: true })

interface Page { slug: string; title: string; order: number; html: string }

function front(src: string) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/)
  const meta: Record<string, string> = {}
  if (m) for (const line of m[1].split('\n')) { const [k, ...v] = line.split(':'); meta[k.trim()] = v.join(':').trim() }
  return { meta, body: m ? src.slice(m[0].length) : src }
}

const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const renderer = new marked.Renderer()
renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens)
  const id = slugify(text)
  return depth === 1 ? `<h1>${text}</h1>\n` : `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${text}</h${depth}>\n`
}
const fixLinks = (html: string) =>
  html
    .replace(/href="(?:\.\.\/)?docs\/([\w-]+)\.md(#[\w-]*)?"/g, 'href="$1.html$2"')
    .replace(/href="([\w-]+)\.md(#[\w-]*)?"/g, 'href="$1.html$2"')
    .replace(/href="(\d\d)\.md"/g, 'href="https://github.com/nostr-protocol/nips/blob/master/$1.md"')

const pages: Page[] = []
for (const f of readdirSync(join(repo, 'docs')).filter((f) => f.endsWith('.md'))) {
  const { meta, body } = front(readFileSync(join(repo, 'docs', f), 'utf8'))
  pages.push({ slug: f.replace(/\.md$/, ''), title: meta.title || f, order: Number(meta.order || 50), html: fixLinks(marked.parse(body, { renderer }) as string) })
}
const nip = readFileSync(join(repo, 'nip/kurultay.md'), 'utf8')
pages.push({ slug: 'nip', title: 'Protocol (draft NIP)', order: 90, html: fixLinks(marked.parse(nip, { renderer }) as string) })
pages.sort((a, b) => a.order - b.order)

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin /><link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..800;1,9..144,300..600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />`

function page(p: Page, file: string) {
  const nav = pages.map((x) => `<a href="${x.slug}.html"${x.slug === p.slug ? ' aria-current="page"' : ''}>${x.title}</a>`).join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${p.title} — Kurultay</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%238e2c1f'/%3E%3Cpath d='M16 7c3 4 5 6.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.6 1 2.5 2 3 0-3 .5-5.5 1-8.5z' fill='%23f3c46a'/%3E%3C/svg%3E" />
${FONTS}
<script>try{var t=localStorage.getItem('kurultay:theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
</head>
<body class="docs">
<header class="docs-nav">
  <a class="brand" href="../"><svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="var(--madder)"/><path d="M16 7c3 4 5 6.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.6 1 2.5 2 3 0-3 .5-5.5 1-8.5z" fill="#f3c46a"/></svg><span>Kurultay</span></a>
  <span class="docs-crumb">Docs</span>
  <div class="nav-actions"><button class="btn ghost theme-toggle" data-theme-toggle type="button"></button><a class="btn primary small" href="../app/">Open the app</a></div>
</header>
<div class="docs-layout">
  <nav class="docs-side" aria-label="Documentation">${nav}<a href="https://github.com/kucukkanat/kurultay">GitHub</a></nav>
  <article class="prose">${p.html}</article>
</div>
<script type="module" src="/src/docs/main.ts"></script>
</body>
</html>`
}

for (const p of pages) writeFileSync(join(out, `${p.slug}.html`), page(p, p.slug))
writeFileSync(join(out, 'index.html'), page(pages[0], 'index'))
console.log(`docs: ${pages.length} pages → ${out}`)
