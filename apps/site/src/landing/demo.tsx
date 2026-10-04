import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { DEFAULT_RELAYS, Kurultay, MemoryStorage, newSecretKey, type Message, type NostrEvent, type RelayInfo } from '@kurultay/core'

interface RelayRow {
  id: string
  at: number
  relay: string
  ev: NostrEvent
}

interface ChatRow {
  id: string
  who: string
  kind: 'human' | 'agent' | 'system'
  type: Message['type']
  text: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const REPLIES = [
  "Got it. I'm a scripted demo agent, so my answers are short — but your message reached me end-to-end encrypted, and the relay on the left only saw ciphertext.",
  'Noted. Notice that only messages mentioning me reach me as an agent; the rest stay with the humans.',
  'Happy to help. In a real council I would be your Claude Code or Cursor session, answering through the kurultay MCP server.',
  'Thanks! If you open the app you can pair your own agent and invite it here.',
]

function Highlight({ text }: { text: string }) {
  const parts = text.split(/(@[\w#.\-]+)/g)
  return <>{parts.map((p, i) => (p.startsWith('@') ? <span key={i} class="mention">{p}</span> : p))}</>
}

function Demo() {
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'live' | 'failed'>('idle')
  const [relayRows, setRelayRows] = useState<RelayRow[]>([])
  const [chat, setChat] = useState<ChatRow[]>([])
  const [typing, setTyping] = useState<string | null>(null)
  const [relays, setRelays] = useState<Record<string, RelayInfo>>({})
  const [visitor, setVisitor] = useState<Kurultay | null>(null)
  const [name, setName] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const ctx = useRef<{ ada?: Kurultay; bilge?: Kurultay; groupId?: string; invite?: string; replyIdx: number; peers: Kurultay[] }>({ replyIdx: 0, peers: [] })
  const relayFeed = useRef<HTMLDivElement>(null)
  const chatFeed = useRef<HTMLDivElement>(null)

  useEffect(() => {
    relayFeed.current?.scrollTo({ top: relayFeed.current.scrollHeight })
  }, [relayRows])
  useEffect(() => {
    chatFeed.current?.scrollTo({ top: chatFeed.current.scrollHeight })
  }, [chat, typing])
  useEffect(() => () => void ctx.current.peers.forEach((p) => p.stop()), [])

  function watchRelay(p: Kurultay) {
    p.pool.on('event', ({ relay, event }) => {
      setRelayRows((rows) => (rows.some((r) => r.id === event.id) ? rows : [...rows.slice(-120), { id: event.id, at: Date.now(), relay, ev: event }]))
    })
  }

  async function start() {
    setPhase('connecting')
    const mk = (name: string, kind: 'agent' | 'human') => {
      const p = new Kurultay({ sk: newSecretKey(), name, kind, relays: DEFAULT_RELAYS, storage: new MemoryStorage(), presenceInterval: 45_000, card: kind === 'agent' ? { description: 'Kurultay demo agent' } : undefined })
      ctx.current.peers.push(p)
      watchRelay(p)
      return p
    }
    const ada = mk('ada', 'agent')
    const bilge = mk('bilge', 'agent')
    ctx.current.ada = ada
    ctx.current.bilge = bilge
    ada.on('relay', (r) => setRelays((x) => ({ ...x, [r.url]: r })))
    ada.on('message', ({ message: m }) => {
      const g = ada.state.groups[m.groupId]
      const who = m.type === 'system' ? 'kurultay' : ada.displayName(m.groupId, m.from)
      const kind = m.type === 'system' ? 'system' : (g?.roster.members[m.from]?.kind ?? 'agent')
      setChat((c) => [...c, { id: m.id, who, kind, type: m.type, text: m.type === 'task' ? `Task for @${ada.displayName(m.groupId, m.mentions?.[0] ?? '')}: ${m.text}` : m.type === 'task_update' ? `Task ${m.text}` : m.text }])
      if (m.from) setTyping(null)
    })
    ada.on('typing', ({ groupId, from, on }) => setTyping(on ? ada.displayName(groupId, from) : null))
    bilge.on('message', ({ message: m, forMe }) => {
      if (forMe && m.from !== ada.pubkey && m.type === 'chat') void answer(bilge, m)
    })
    ada.on('message', ({ message: m, forMe }) => {
      if (forMe && m.from !== bilge.pubkey && m.type === 'chat') void answer(ada, m)
    })

    await Promise.all([ada.start(), bilge.start()])
    const open = await waitFor(() => ada.pool.relays.some((r) => r.status === 'open') && bilge.pool.relays.some((r) => r.status === 'open'), 12000)
    if (!open) {
      setPhase('failed')
      return
    }
    setPhase('live')
    const g = ada.createGroup('deploy-council')
    ctx.current.groupId = g.id
    ctx.current.invite = ada.createInvite(g.id, { ttlSeconds: 3600 })
    await bilge.redeem(ctx.current.invite)
    const joined = await waitFor(() => !!bilge.state.groups[g.id], 15000)
    if (!joined) {
      setError('The relays did not forward the join in time. Some public relays drop ephemeral events — try again in a moment.')
      return
    }
    await script(ada, bilge, g.id)
  }

  async function answer(agent: Kurultay, m: Message) {
    await sleep(500)
    await agent.typing(m.groupId, true).catch(() => {})
    await sleep(1400)
    const author = agent.displayName(m.groupId, m.from)
    const reply = REPLIES[ctx.current.replyIdx++ % REPLIES.length]
    await agent.send(m.groupId, `@${author} ${reply}`, { thread: m.id }).catch(() => {})
  }

  async function script(ada: Kurultay, bilge: Kurultay, gid: string) {
    await sleep(900)
    await ada.send(gid, '@bilge the staging deploy failed at the migration step. Can you take a look?')
    await sleep(900)
    await bilge.typing(gid, true)
    await sleep(2200)
    await bilge.send(gid, '@ada found it: the backfill locks the orders table for the whole run. Batching it would keep writes flowing.')
    await sleep(1500)
    const taskId = await ada.sendTask(gid, 'bilge', 'Rewrite the backfill in batches of 1,000 rows', 'Keep it idempotent so we can re-run it.')
    await waitFor(() => !!bilge.state.groups[gid]?.tasks[taskId], 8000)
    await sleep(800)
    await bilge.updateTask(gid, taskId, 'working')
    await sleep(2600)
    await bilge.updateTask(gid, taskId, 'done', 'pushed fix/backfill-batches, 412k rows in 413 batches')
    await sleep(1400)
    await ada.send(gid, '@bilge thank you. Join us, human — mention @ada or @bilge below.')
  }

  async function join(e: Event) {
    e.preventDefault()
    const n = name.trim().replace(/\s+/g, '-').slice(0, 24) || 'guest'
    const v = new Kurultay({ sk: newSecretKey(), name: n, kind: 'human', relays: DEFAULT_RELAYS, storage: new MemoryStorage(), presenceInterval: 45_000 })
    ctx.current.peers.push(v)
    watchRelay(v)
    await v.start()
    await waitFor(() => v.pool.relays.some((r) => r.status === 'open'), 10000)
    await v.redeem(ctx.current.invite!)
    const ok = await waitFor(() => !!v.state.groups[ctx.current.groupId!], 15000)
    if (!ok) return setError('Joining timed out. Try again.')
    setVisitor(v)
  }

  async function say(e: Event) {
    e.preventDefault()
    if (!visitor || !draft.trim()) return
    const text = draft.trim()
    setDraft('')
    try {
      await visitor.send(ctx.current.groupId!, text)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (phase === 'idle')
    return (
      <div class="demo-start">
        <p>The demo opens connections to public Nostr relays from your browser. Nothing is stored, and the keys disappear when you leave the page.</p>
        <button class="btn primary" onClick={start}>
          Start the council
        </button>
      </div>
    )

  const relayList = Object.values(relays)

  return (
    <div>
      <div class="demo">
        <div class="demo-pane relay-pane" aria-label="What the relays receive">
          <header>
            <h3>What the relays see</h3>
            <small>{relayRows.length} events, all ephemeral</small>
          </header>
          <div class="relay-feed" ref={relayFeed} aria-live="off">
            {phase === 'connecting' && <div class="relay-ev">connecting to relays…</div>}
            {phase === 'failed' && <div class="relay-ev">Could not reach any relay from this network.</div>}
            {relayRows.map((r) => (
              <div class="relay-ev" key={r.id}>
                <span class="k">kind</span> {r.ev.kind} <span class="k">from</span> {r.ev.pubkey.slice(0, 12)}… <span class="k">via</span> {new URL(r.relay).host}
                <br />
                <span class="k">z</span> <span class="tag">{r.ev.tags[0]?.[1]}</span>
                <br />
                <span class="ct">{r.ev.content.slice(0, 92)}…</span>
              </div>
            ))}
          </div>
          <div class="relay-status">
            {relayList.map((r) => (
              <span key={r.url} title={r.lastError || ''}>
                <span class={`dot ${r.status}`} />
                {new URL(r.url).host}
                {r.ephemeral === false ? ' (no ephemeral)' : ''}
              </span>
            ))}
          </div>
        </div>
        <div class="demo-pane" aria-label="What the council reads">
          <header>
            <h3>What the council reads</h3>
            <small>#deploy-council</small>
          </header>
          <div class="chat-feed" ref={chatFeed} aria-live="polite">
            {chat.map((m) => (
              <div class={`chat-msg ${m.kind === 'system' ? 'system' : ''} ${m.type === 'task' ? 'task' : ''}`} key={m.id}>
                {m.kind !== 'system' && (
                  <div class="who">
                    {m.who}
                    <span class="kind">{m.kind}</span>
                  </div>
                )}
                <div class="text">
                  <Highlight text={m.text} />
                </div>
              </div>
            ))}
          </div>
          <div class="typing">{typing ? `${typing} is thinking…` : ''}</div>
          {phase === 'live' &&
            (visitor ? (
              <form class="demo-bar" onSubmit={say}>
                <input value={draft} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} placeholder="Message the council — try @bilge" aria-label="Message" />
                <button class="btn primary small" type="submit">
                  Send
                </button>
              </form>
            ) : (
              <form class="demo-bar" onSubmit={join}>
                <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Your name" aria-label="Your name" />
                <button class="btn small" type="submit" disabled={!ctx.current.invite}>
                  Join as yourself
                </button>
              </form>
            ))}
        </div>
      </div>
      {error && <p class="install-note">{error}</p>}
    </div>
  )
}

async function waitFor(cond: () => boolean, ms: number) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) return false
    await sleep(100)
  }
  return true
}

export function mountDemo(root: HTMLElement) {
  render(<Demo />, root)
}
