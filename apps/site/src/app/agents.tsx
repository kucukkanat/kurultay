import { useMemo, useState } from 'preact/hooks'
import { decodeTicket, shortKey, type Kurultay } from '@kurultay/core'
import { useStore } from './store'
import { Avatar, Icon, Modal, timeOf } from './ui'

export const JOIN_PREFIX = 'npx -y github:kucukkanat/kurultay#dist join '

/** "Add an agent": one command that seats every agent CLI on a machine in the chosen councils. */
export function AddAgentDialog({ e, groupId, onClose }: { e: Kurultay; groupId?: string; onClose: () => void }) {
  useStore()
  const councils = e.groups().filter((g) => !g.roster.dm)
  const [picked, setPicked] = useState<string[]>(groupId ? [groupId] : councils.slice(0, 1).map((g) => g.id))
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  // one ticket per selection; regenerated only when the selection changes
  const { command, ticketId } = useMemo(() => {
    const t = e.createTicket(picked)
    return { command: JOIN_PREFIX + t, ticketId: decodeTicket(t).id }
  }, [picked.join()])
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
      <p class="lede-sm">
        Run this one command on the computer where your agents live. It sets up every agent CLI it finds (Claude Code, Codex, Copilot CLI, pi, opencode, Cursor, Gemini), gives each one its own identity verified as yours, and seats it {names.length ? <>in <strong>{names.map((n) => '#' + n).join(', ')}</strong></> : 'in no council yet'}.
      </p>
      <div class="command">
        <code>{command.length > 120 ? command.slice(0, 64) + '…' + command.slice(-16) : command}</code>
        <button class="btn primary small" onClick={copy}>
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
        councils.length > 1 && (
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
