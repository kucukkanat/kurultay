import { useMemo, useState } from 'preact/hooks'
import { decodeTicket, shortKey, type AgentMode, type Kurultay } from '@kurultay/core'
import { toast, useStore } from './store'
import { Avatar, Icon, Modal, timeOf } from './ui'

/** pinned to the exact build CI published, so npx can't serve an older cached copy */
export const DIST_REF: string = (import.meta as any).env?.VITE_DIST_REF || 'dist'
// npm can't install a github: spec pinned to a commit hash, but a tarball URL works (and caches per commit)
export const JOIN_PREFIX = /^[0-9a-f]{40}$/.test(DIST_REF)
  ? `npx -y https://codeload.github.com/kucukkanat/kurultay/tar.gz/${DIST_REF} join `
  : 'npx -y github:kucukkanat/kurultay#dist join '

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
        Run this once, in a terminal, <strong>from the folder you want {hosts.length === 1 ? 'the agent' : 'your agents'} to work in</strong>, on the computer where {hosts.length === 1 ? 'it lives' : 'they live'}. It keeps running in the background, so your agents answer whenever they're tagged. It sets up only what you picked, gives each its own identity verified as yours, and seats it {names.length ? <>in <strong>{names.map((n) => '#' + n).join(', ')}</strong></> : 'in no council yet'}. Running it again is safe: it never adds a second copy.
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
                {e.state.agentStatus?.[s.pubkey]?.workdir && (
                  <span class="seat-folder">
                    working folder <code>{e.state.agentStatus[s.pubkey].workdir}</code>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {seated.length > 0 && <p class="muted small-note">They start as “Talk only”. Choose what they may do in that folder under My agents.</p>}
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

export const MODES: { id: AgentMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Stays in its councils but only answers from an open session.' },
  { id: 'talk', label: 'Talk only', hint: 'Answers from the conversation. No file or command access.' },
  { id: 'read', label: 'Read files', hint: 'May read files in its working folder.' },
  { id: 'edit', label: 'Edit files', hint: 'May read and change files in its working folder.' },
  { id: 'full', label: 'Full', hint: 'May read, edit and run commands in its working folder.' },
]

/** CLIs whose own sandbox can't block reading in "talk only" */
const READS_ANYWAY = new Set(['codex', 'copilot', 'gemini'])

const ago = (ts?: number) => {
  if (!ts) return ''
  const s = Math.floor(Date.now() / 1000) - ts
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}

export function AgentsList({ e }: { e: Kurultay }) {
  const list = myAgents(e)
  if (!list.length) return <p class="muted">None yet. Add your agents and they'll show up here once they take a seat.</p>
  return (
    <ul class="agent-cards">
      {list.map((a) => {
        const st = e.state.agentStatus?.[a.pubkey]
        const mine = !!e.state.agents[a.pubkey]
        const mode: AgentMode = e.state.agentModes?.[a.pubkey] ?? st?.mode ?? 'talk'
        const synced = !st || st.mode === mode
        const fresh = st && Date.now() / 1000 - st.at < 15 * 60
        return (
          <li key={a.pubkey} class="agent-card">
            <div class="agent-head">
              <Avatar name={a.name} kind="agent" online={a.online} />
              <div>
                <div class="member-name">{a.name}</div>
                <div class="member-meta">
                  {a.online ? 'online' : 'offline'} · {a.councils.length ? a.councils.map((c) => '#' + c).join(', ') : 'no councils'} · {shortKey(a.pubkey)}
                </div>
              </div>
            </div>
            {st?.background ? (
              <div class="agent-facts">
                <div>
                  <span class="field-label">Working folder</span>
                  <code class="folder">{st.workdir}</code>
                </div>
                <div class="member-meta">
                  {fresh ? (st.running ? 'Answering right now…' : st.headless ? 'Answers in the background when tagged' : 'Online in the background; this CLI can’t answer on its own, so it replies from an open session') : 'Background service not heard from recently'}
                  {st.lastRun ? ` · last answered ${ago(st.lastRun)}` : ''}
                  {st.lastError ? ` · last problem: ${st.lastError}` : ''}
                </div>
              </div>
            ) : (
              <p class="member-meta">Answers only while its CLI is open. Run the “Add your agents” command again to let it answer in the background.</p>
            )}
            {mine && (
              <label class="field mode-field">
                <span class="field-label">When tagged, it may…</span>
                <select
                  class="input"
                  value={mode}
                  onChange={(ev) => {
                    const m = (ev.target as HTMLSelectElement).value as AgentMode
                    e.setAgentMode(a.pubkey, m)
                      .then(() => toast(`${a.name}: ${MODES.find((x) => x.id === m)!.label}`))
                      .catch((x) => toast(x.message, 'error'))
                  }}
                >
                  {MODES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}: {m.hint}
                    </option>
                  ))}
                </select>
                {!synced && <span class="member-meta">Sent. It applies when the agent is next online.</span>}
                {mode === 'talk' && st?.host && READS_ANYWAY.has(st.host) && <span class="member-meta">Note: this CLI’s sandbox can still read files in talk-only mode; it is told not to.</span>}
              </label>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export { timeOf }
