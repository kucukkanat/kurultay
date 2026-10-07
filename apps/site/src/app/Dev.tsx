import { useState } from 'preact/hooks'
import { slotOf, SLOT_SECONDS, type Kurultay, type RawRecord } from '@kurultay/core'
import { frames, raw, useStore } from './store'

type Tab = 'envelopes' | 'frames' | 'routes' | 'relays'

const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false }) + '.' + String(t % 1000).padStart(3, '0')

export function DevDrawer({ e, groupId }: { e: Kurultay; groupId?: string }) {
  useStore()
  const [tab, setTab] = useState<Tab>('envelopes')
  const [onlyGroup, setOnlyGroup] = useState(false)
  const [hidePresence, setHidePresence] = useState(true)
  const [open, setOpen] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  const records = raw
    .filter((r) => !onlyGroup || !groupId || r.groupId === groupId)
    .filter((r) => !hidePresence || (r.env?.type !== 'presence' && r.env?.type !== 'typing'))
    .slice(-250)
    .reverse()

  return (
    <section class={`dev ${collapsed ? 'collapsed' : ''}`} aria-label="Developer mode" data-testid="dev-drawer">
      <div class="dev-tabs" role="tablist">
        <strong class="dev-title">Developer</strong>
        {(['envelopes', 'frames', 'routes', 'relays'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} class={tab === t ? 'on' : ''} onClick={() => (setTab(t), setCollapsed(false))}>
            {t[0].toUpperCase() + t.slice(1)}
            {t === 'envelopes' && <span class="count">{raw.length}</span>}
            {t === 'frames' && <span class="count">{frames.length}</span>}
          </button>
        ))}
        <span class="spacer" />
        {tab === 'envelopes' && (
          <>
            <label class="dev-check">
              <input type="checkbox" checked={onlyGroup} onChange={(ev) => setOnlyGroup((ev.target as HTMLInputElement).checked)} /> this council only
            </label>
            <label class="dev-check">
              <input type="checkbox" checked={hidePresence} onChange={(ev) => setHidePresence((ev.target as HTMLInputElement).checked)} /> hide presence &amp; typing
            </label>
          </>
        )}
        <button class="dev-collapse" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <div class="dev-body">
          {tab === 'envelopes' && (
            <table class="dev-table">
              <thead>
                <tr>
                  <th>time</th>
                  <th></th>
                  <th>channel</th>
                  <th>type</th>
                  <th>from</th>
                  <th>z tag</th>
                  <th>outer key</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <EnvRow key={r.id + r.dir} e={e} r={r} open={open === r.id + r.dir} toggle={() => setOpen(open === r.id + r.dir ? null : r.id + r.dir)} />
                ))}
              </tbody>
            </table>
          )}
          {tab === 'frames' && (
            <table class="dev-table">
              <thead>
                <tr>
                  <th>time</th>
                  <th></th>
                  <th>relay</th>
                  <th>frame</th>
                </tr>
              </thead>
              <tbody>
                {frames
                  .slice(-250)
                  .reverse()
                  .map((f, i) => (
                    <tr key={i}>
                      <td class="t">{fmt(f.ts)}</td>
                      <td class={`dir ${f.dir}`}>{f.dir === 'in' ? '↓' : '↑'}</td>
                      <td>{new URL(f.relay).host}</td>
                      <td class="mono clip">{JSON.stringify(f.data).slice(0, 220)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          {tab === 'routes' && <Routes e={e} />}
          {tab === 'relays' && (
            <table class="dev-table">
              <thead>
                <tr>
                  <th>relay</th>
                  <th>status</th>
                  <th>ephemeral</th>
                  <th>latency</th>
                  <th>notices</th>
                </tr>
              </thead>
              <tbody>
                {e.pool.relays.map((r) => (
                  <tr key={r.url}>
                    <td>
                      <span class={`dot ${r.status}`} />
                      {r.url}
                    </td>
                    <td>{r.status}</td>
                    <td>{r.ephemeral === null ? '…' : r.ephemeral ? 'yes' : 'no'}</td>
                    <td>{r.latencyMs ? `${r.latencyMs} ms` : ''}</td>
                    <td class="clip">{r.notices.join(' | ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  )
}

function EnvRow({ e, r, open, toggle }: { e: Kurultay; r: RawRecord; open: boolean; toggle: () => void }) {
  const g = r.groupId ? e.state.groups[r.groupId] : undefined
  const from = r.inner ? (r.groupId ? e.displayName(r.groupId, r.inner.pubkey) : r.inner.pubkey === e.pubkey ? 'me' : r.inner.pubkey.slice(0, 8)) : '—'
  return (
    <>
      <tr class={`clickable ${r.error ? 'err' : ''}`} onClick={toggle} aria-expanded={open}>
        <td class="t">{fmt(r.ts)}</td>
        <td class={`dir ${r.dir}`}>{r.dir === 'in' ? '↓' : '↑'}</td>
        <td>{r.channel === 'group' ? `#${g?.roster.name ?? r.groupId?.slice(0, 6)}` : r.channel}</td>
        <td>{r.env?.type ?? (r.error ? 'undecryptable' : '')}</td>
        <td>{from}</td>
        <td class="mono">{r.outer.tags[0]?.[1]?.slice(0, 12)}…</td>
        <td class="mono">{r.outer.pubkey.slice(0, 10)}…</td>
      </tr>
      {open && (
        <tr class="detail">
          <td colSpan={7}>
            {r.error && <p class="err">Error: {r.error}</p>}
            <div class="detail-grid">
              <div>
                <h4>Outer event: what the relay saw</h4>
                <pre>{JSON.stringify(r.outer, null, 2)}</pre>
              </div>
              {r.inner && (
                <div>
                  <h4>Inner event: decrypted, signed by the sender</h4>
                  <pre>{JSON.stringify({ ...r.inner, content: r.env ?? r.inner.content }, null, 2)}</pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Routes({ e }: { e: Kurultay }) {
  const slot = slotOf()
  const nextIn = (slot + 1) * SLOT_SECONDS - Math.floor(Date.now() / 1000)
  const routes = e.routes()
  return (
    <div class="routes">
      <p class="muted">
        Current slot <strong>{slot}</strong>; tags rotate in {Math.floor(nextIn / 60)}m {nextIn % 60}s. The subscription covers the previous, current and next slot for your inbox and every council key.
      </p>
      <table class="dev-table">
        <thead>
          <tr>
            <th>z tag</th>
            <th>channel</th>
            <th>council</th>
          </tr>
        </thead>
        <tbody>
          {routes.map((r) => (
            <tr key={r.tag}>
              <td class="mono">{r.tag}</td>
              <td>{r.channel}</td>
              <td>{r.groupId ? e.state.groups[r.groupId]?.roster.name : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
