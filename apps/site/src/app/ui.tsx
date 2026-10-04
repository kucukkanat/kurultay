import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input, textarea, button')?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => {
      removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [])
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>
          <h2>{title}</h2>
          <button class="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function CopyField({ value, label, multiline }: { value: string; label?: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <div class="copy-field">
      {label && <span class="field-label">{label}</span>}
      <div class="copy-row">
        {multiline ? <textarea readOnly value={value} rows={3} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} /> : <input readOnly value={value} onFocus={(e) => (e.target as HTMLInputElement).select()} />}
        <button class="btn small" onClick={copy} type="button">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

const PATHS: Record<string, string> = {
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 19v-1a4 4 0 0 0-3-3.9M15.5 3.2a3.5 3.5 0 0 1 0 6.6',
  bot: 'M12 3v3M7 7h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3zM9 12h.01M15 12h.01M9 16h6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 5l12 7-12 7z',
  send: 'M5 12h14M13 6l6 6-6 6',
  task: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  chat: 'M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z',
  key: 'M15.5 7.5a3 3 0 1 1-4.2 4.2M14 9l7-7M18 5l2 2M11.3 11.7L4 19v2h2l1-1h2v-2h2l1.3-1.3',
  back: 'M15 18l-6-6 6-6',
}

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  )
}

export function Avatar({ name, kind, online, size = 34 }: { name: string; kind: 'human' | 'agent'; online?: boolean; size?: number }) {
  return (
    <span class={`avatar ${kind}`} style={{ width: size, height: size, fontSize: size * 0.44 }} aria-hidden="true">
      {(name.replace(/[^\p{L}\p{N}]/gu, '')[0] ?? '?').toUpperCase()}
      {online !== undefined && <span class={`presence ${online ? 'on' : ''}`} />}
    </span>
  )
}

export function timeOf(ts: number) {
  const d = new Date(ts * 1000)
  const today = new Date()
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === today.toDateString() ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`
}

export function Rich({ text, names }: { text: string; names: Set<string> }) {
  // fenced code, inline code, links and @mentions — nothing else, and never raw HTML
  const blocks = text.split(/```(?:\w+)?\n?([\s\S]*?)```/g)
  return (
    <>
      {blocks.map((b, i) =>
        i % 2 === 1 ? (
          <pre key={i}>
            <code>{b}</code>
          </pre>
        ) : (
          <span key={i}>
            {b.split(/(`[^`\n]+`|https?:\/\/[^\s)]+|@[\w#.\-]+)/g).map((p, j) => {
              if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return <code key={j}>{p.slice(1, -1)}</code>
              if (/^https?:\/\//.test(p))
                return (
                  <a key={j} href={p} target="_blank" rel="noopener noreferrer">
                    {p}
                  </a>
                )
              if (p.startsWith('@') && (names.has(p.slice(1).toLowerCase()) || p === '@all' || p === '@here'))
                return (
                  <span key={j} class="mention">
                    {p}
                  </span>
                )
              return p
            })}
          </span>
        ),
      )}
    </>
  )
}
