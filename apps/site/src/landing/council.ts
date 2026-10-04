const NS = 'http://www.w3.org/2000/svg'

const SEATS = [
  { label: 'tolga', kind: 'human' },
  { label: 'claude-code#1', kind: 'agent' },
  { label: 'copilot#1', kind: 'agent' },
  { label: 'pi#1', kind: 'agent' },
  { label: 'alice', kind: 'human' },
  { label: 'opencode#1', kind: 'agent' },
  { label: 'codex#2', kind: 'agent' },
] as const

const C = 220
const R = 168

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>) {
  const e = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}

/** Seats around the fire; sparks (messages) arc from speaker to listener through the fire's heat. */
export function mountCouncil(svg: SVGSVGElement) {
  const seatsG = svg.querySelector('#council-seats')!
  const sparksG = svg.querySelector('#council-sparks')!
  const pos = SEATS.map((_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / SEATS.length
    return { x: C + R * Math.cos(a), y: C + R * Math.sin(a), a }
  })
  const seatEls = SEATS.map((s, i) => {
    const g = el('g', { class: `seat ${s.kind}`, transform: `translate(${pos[i].x} ${pos[i].y})` })
    g.append(el('circle', { class: 'body', r: 21 }))
    const t = el('text', { class: 'initial' })
    t.textContent = s.label[0].toUpperCase()
    g.append(t)
    const below = Math.sin(pos[i].a) > -0.2
    const lbl = el('text', { class: 'label', y: below ? 40 : -32 })
    lbl.textContent = s.label
    g.append(lbl)
    seatsG.append(g)
    return g
  })

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return

  let last = -1
  const fly = () => {
    if (document.hidden) return
    let from = Math.floor(Math.random() * SEATS.length)
    if (from === last) from = (from + 1) % SEATS.length
    last = from
    let to = Math.floor(Math.random() * (SEATS.length - 1))
    if (to >= from) to++
    const a = pos[from]
    const b = pos[to]
    // control point pulled toward the fire so every message passes through the relay
    const cx = C + (a.x + b.x - 2 * C) * 0.12
    const cy = C + (a.y + b.y - 2 * C) * 0.12
    const spark = el('circle', { class: 'spark', r: 7 })
    sparksG.append(spark)
    seatEls[from].classList.add('lit')
    const dur = 1500
    const start = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur)
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      const x = (1 - e) ** 2 * a.x + 2 * (1 - e) * e * cx + e ** 2 * b.x
      const y = (1 - e) ** 2 * a.y + 2 * (1 - e) * e * cy + e ** 2 * b.y
      spark.setAttribute('cx', x.toFixed(1))
      spark.setAttribute('cy', y.toFixed(1))
      spark.setAttribute('r', (5 + 4 * Math.sin(Math.PI * k)).toFixed(1))
      if (k > 0.25) seatEls[from].classList.remove('lit')
      if (k < 1) requestAnimationFrame(step)
      else {
        spark.remove()
        seatEls[to].classList.add('lit')
        setTimeout(() => seatEls[to].classList.remove('lit'), 500)
      }
    }
    requestAnimationFrame(step)
  }
  setTimeout(fly, 600)
  setInterval(fly, 1900)
}
