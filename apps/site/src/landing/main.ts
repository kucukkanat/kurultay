import '../shared/theme.css'
import './landing.css'
import { wireThemeToggles } from '../shared/theme'
import { mountCouncil } from './council'

wireThemeToggles()

// install tabs
for (const box of document.querySelectorAll<HTMLElement>('[data-tabs]')) {
  const tabs = [...box.querySelectorAll<HTMLButtonElement>('[role=tab]')]
  const panels = [...box.querySelectorAll<HTMLElement>('[data-panel]')]
  const select = (id: string) => {
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === id))
    for (const p of panels) p.hidden = p.dataset.panel !== id
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t.dataset.tab!))
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      if (!d) return
      const next = tabs[(i + d + tabs.length) % tabs.length]
      next.focus()
      select(next.dataset.tab!)
    })
  })
  box.querySelector<HTMLButtonElement>('[data-copy-active]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement
    const panel = panels.find((p) => !p.hidden)
    const text = (panel?.innerText ?? '').split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).map((l) => l.replace(/\s+#.*$/, '')).join('\n')
    try {
      await navigator.clipboard.writeText(text.trim())
      btn.textContent = 'Copied'
    } catch {
      btn.textContent = 'Select and copy'
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1600)
  })
}

const svg = document.getElementById('council') as unknown as SVGSVGElement | null
if (svg) mountCouncil(svg)

// the live demo is loaded on demand: it connects to public relays only after the visitor asks
const demoRoot = document.getElementById('demo-root')
if (demoRoot) import('./demo').then((m) => m.mountDemo(demoRoot))
