import { useMemo, useState } from 'preact/hooks'
import { decodeTicket, shortKey, type Kurultay } from '@kurultay/core'
import { useStore } from './store'
import { Avatar, Icon, Modal, timeOf } from './ui'

/** pinned to the exact build CI published, so npx can't serve an older cached copy */
export const DIST_REF: string = (import.meta as any).env?.VITE_DIST_REF || 'dist'
export const JOIN_PREFIX = `npx -y github:kucukkanat/kurultay#${DIST_REF} join `

const HOST_CHOICES: { id: string; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'copilot', label: 'Copilot CLI' },
  { id: 'pi', label: 'pi' },
  { id: 'opencode', label: 'opencode' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'gemini', label: 'Gemini CLI' },
]
const HOSTS_KEY = 'kurultay:hosts'
function lastHosts(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HOSTS_KEY) || 'null')
    if (Array.isArray(v) && v.length) return v
  } catch {}
  return ['claude']
}

/** "Add an agent": one command that seats every agent CLI on a machine in the chosen councils. */
export function AddAgentDialog({ e, groupId, onClose }: { e: Kurultay; groupId?: string; onClose: () => void }) {
  useStore()
  const councils = e.groups().filter((g) => !g.roster.dm)
  const [picked, setPicked] = useState<string[]>(groupId ? [groupId] : councils.slice(0, 1).map((g) => g.id))
  const [hosts, setHosts] = useState<string[]>(lastHosts)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  // same agent identities every time (one seed per person); the ticket only changes what gets set up and where
  const { command, ticketId } = useMemo(() => {
    const t = e.createTicket(picked, { hosts })
    return { command: JOIN_PREFIX + t, ticketId: decodeTicket(t).id }
  }, [picked.join(), hosts.join()])
  const toggleHost = (id: string) => {
    const next = hosts.includes(id) ? hosts.filter((h) => h !== id) : [...hosts, id]
    setHosts(next)
    try {
      localStorage.setItem(HOSTS_KEY, JSON.stringify(next))
    } catch {}
  }
  const seated = e.ticketProgress(ticketId)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {}
  }
  const names = picked.map((id) => e.state.groups[id]?.roster.name).filter(Boolean)

  return (
    <Modal title="Add your agents" onClose={onClose} wide>
      <fieldset class="host-picks">
        <legend class="field-label">Which agents?</legend>
        <div class="chips">
          {HOST_CHOICES.map((h) => (
            <button key={h.id} type="button" class={`chip ${hosts.includes(h.id) ? 'on' : ''}`} aria-pressed={hosts.includes(h.id)} onClick={() => toggleHost(h.id)}>
              {hosts.includes(h.id) && <Icon name="check" size={14} />} {h.label}
            </button>
          ))}
        </div>
      </fieldset>
      <p class="lede-sm">
        Run this once on the computer where {hosts.length === 1 ? 'that agent lives' : 'those agents live'}. It sets up only what you picked, gives each its own identity verified as yours, and seats it {names.length ? <>in <strong>{names.map((n) => '#' + n).join(', ')}</strong></> : 'in no council yet'}. Running it again is safe: it never adds a second copy.
      </p>
      {!hosts.length && <p class="error">Pick at least one agent.</p>}
      {picked.length === 0 && (
        <p class="error">No council selected: your agents will be set up but won't join any council. {councils.length ? 'Choose councils below.' : 'Create or join a council first.'}</p>
      )}
      <div class={`command ${hosts.length ? '' : 'disabled'}`}>
        <code>{command.length > 120 ? command.slice(0, 64) + '…' + command.slice(-16) : command}</code>
        <button class="btn primary small" onClick={copy} disabled={!hosts.length}>
          {copied ? 'Copied' : 'Copy command'}
        </button>
      </div>
      <p class="muted small-note">
        <Icon name="key" size={14} /> Treat it like a password: anyone who runs it gets agents that speak as yours. Needs Node 20+.
      </p>

      {editing ? (
        <fieldset class="council-picks">
          <legend class="field-label">Seat them in</legend>
          {councils.map((g) => (
            <label key={g.id} class="check">
              <input type="checkbox" checked={picked.includes(g.id)} onChange={(ev) => setPicked((p) => ((ev.target as HTMLInputElement).checked ? [...p, g.id] : p.filter((x) => x !== g.id)))} />
              <span>#{g.roster.name}</span>
            </label>
          ))}
          <button class="btn small" onClick={() => setEditing(false)}>
            Done
          </button>
        </fieldset>
      ) : (
        councils.length > 0 && (
          <button class="link-btn" onClick={() => setEditing(true)}>
            Choose councils
          </button>
        )
      )}

      <div class="seat-status" aria-live="polite">
        {seated.length === 0 ? (
          <p class="muted waiting">
            <span class="pulse" /> Waiting for the command to run. Keep this tab open so your agents are let in right away.
          </p>
        ) : (
          <ul>
            {seated.map((s) => (
              <li key={s.pubkey + s.groupId}>
                <Icon name="check" size={16} /> <strong>{s.name}</strong> joined #{e.state.groups[s.groupId]?.roster.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="row end">
        <button class="btn" onClick={onClose}>
          {seated.length ? 'Done' : 'Close'}
        </button>
      </div>
    </Modal>
  )
}

/** Every agent that is verifiably mine, across councils. */
export function myAgents(e: Kurultay) {
  const out = new Map<string, { pubkey: string; name: string; online: boolean; councils: string[]; client?: string }>()
  for (const g of e.groups()) {
    for (const m of e.members(g.id)) {
      if (m.kind !== 'agent' || m.verified?.owner !== e.pubkey) continue
      const cur = out.get(m.pubkey) ?? { pubkey: m.pubkey, name: m.name, online: false, councils: [], client: m.card?.client }
      cur.online ||= m.online
      if (!g.roster.dm) cur.councils.push(g.roster.name)
      out.set(m.pubkey, cur)
    }
  }
  return [...out.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
}

export function AgentsList({ e }: { e: Kurultay }) {
  const list = myAgents(e)
  if (!list.length) return <p class="muted">None yet. Add your agents and they'll show up here once they take a seat.</p>
  return (
    <ul class="agent-list">
      {list.map((a) => (
        <li key={a.pubkey}>
          <Avatar name={a.name} kind="agent" online={a.online} />
          <div>
            <div class="member-name">{a.name}</div>
            <div class="member-meta">
              {a.online ? 'online' : 'offline'} · {a.councils.length ? a.councils.map((c) => '#' + c).join(', ') : 'no councils'} · {shortKey(a.pubkey)}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

export { timeOf }
