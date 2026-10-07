import { useMemo, useState } from 'preact/hooks'
import { decodeTicket, shortKey, type AgentMode, type DaemonAgentInfo, type Kurultay } from '@kurultay/core'
import { AgentProfileEditor } from './AgentProfile'
import { daemon, useDaemon } from './daemon-client'
import { act, Connection, FolderPicker, NPX } from './DaemonPanel'
import { HOSTS_KEY, SeatDialog } from './SeatDialog'
import { toast, useStore } from './store'
import { modeAfterToggle, PERMISSIONS, switchesOf } from './permissions'
import { Avatar, Icon, Modal, timeOf } from './ui'

const JOIN_PREFIX = `${NPX} join `

const HOST_CHOICES: { id: string; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'copilot', label: 'Copilot CLI' },
  { id: 'pi', label: 'pi' },
  { id: 'opencode', label: 'opencode' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'gemini', label: 'Gemini CLI' },
]
function lastHosts(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HOSTS_KEY) || 'null')
    if (Array.isArray(v) && v.length) return v
  } catch {}
  return ['claude']
}

/** "Add your agents": through the paired background service when the page reaches it, else one command to run. */
export function AddAgentDialog({ e, groupId, onClose }: { e: Kurultay; groupId?: string; onClose: () => void }) {
  const d = useDaemon()
  if (d.status === 'connected' && d.snapshot) return <SeatDialog e={e} groupId={groupId} onClose={onClose} snap={d.snapshot} />
  return <CommandDialog e={e} groupId={groupId} onClose={onClose} />
}

/** The first run (no service yet) and the fallback when the browser can't reach it: one command that seats every agent CLI. */
function CommandDialog({ e, groupId, onClose }: { e: Kurultay; groupId?: string; onClose: () => void }) {
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
      <Connection />
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
        <button class="btn primary small" onClick={copy} disabled={!hosts.length} data-testid="join-copy">
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
  const out = new Map<string, { pubkey: string; name: string; online: boolean; councils: string[]; client?: string; avatar?: string }>()
  for (const g of e.groups()) {
    for (const m of e.members(g.id)) {
      if (m.kind !== 'agent' || m.verified?.owner !== e.pubkey) continue
      const cur = out.get(m.pubkey) ?? { pubkey: m.pubkey, name: m.name, online: false, councils: [], client: m.card?.client, avatar: m.card?.avatar }
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

/** where a CLI's own controls are coarser than the permission picked (see docs/getting-started.md) */
function modeCaveat(host: string | undefined, mode: AgentMode): string | undefined {
  if (!host) return
  if (host === 'cursor' && mode !== 'off' && mode !== 'full') return 'Cursor CLI has no per-tool switches: Talk, Read and Edit all run with its defaults. Only Full differs (it also runs commands).'
  if (mode === 'talk' && ['codex', 'copilot', 'gemini'].includes(host)) return 'This CLI can still read files in talk-only mode; it is told not to.'
  if (mode === 'edit' && host === 'codex') return 'Codex’s workspace-write sandbox also lets it run commands inside the folder.'
}

const ago = (ts?: number) => {
  if (!ts) return ''
  const s = Math.floor(Date.now() / 1000) - ts
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}

/** Controls for an agent that runs on the paired computer: its folder, and removing it. */
function LocalAgent({ agent }: { agent: DaemonAgentInfo }) {
  const [folder, setFolder] = useState(agent.workdir)
  const [confirming, setConfirming] = useState(false)
  return (
    <div class="agent-local" data-testid={`agent-local-${agent.instance}`}>
      <span class="field-label">Working folder on this computer</span>
      <FolderPicker value={folder} onChange={setFolder} testid={`agent-folder-${agent.instance}`}>
        <button class="btn small primary" type="button" disabled={folder.trim() === agent.workdir || !folder.trim()} onClick={() => void act('Folder changed', () => daemon.setWorkdir(agent.instance, folder.trim()))} data-testid={`agent-folder-save-${agent.instance}`}>
          Save
        </button>
      </FolderPicker>
      <div class="row">
        {confirming ? (
          <>
            <span class="member-meta">It leaves its councils and its key is deleted from this computer.</span>
            <button class="btn small danger" type="button" onClick={() => void act(`${agent.name} removed`, () => daemon.removeAgent(agent.instance))} data-testid={`agent-remove-confirm-${agent.instance}`}>
              Remove for good
            </button>
            <button class="btn small" type="button" onClick={() => setConfirming(false)} data-testid={`agent-remove-cancel-${agent.instance}`}>
              Keep
            </button>
          </>
        ) : (
          <button class="btn small danger" type="button" onClick={() => setConfirming(true)} data-testid={`agent-remove-${agent.instance}`}>
            Remove agent
          </button>
        )}
      </div>
    </div>
  )
}

export function AgentsList({ e }: { e: Kurultay }) {
  const d = useDaemon()
  const list = myAgents(e)
  if (!list.length) return <p class="muted">None yet. Add your agents and they'll show up here once they take a seat.</p>
  return (
    <ul class="agent-cards">
      {list.map((a) => {
        const st = e.state.agentStatus?.[a.pubkey]
        const here = d.snapshot?.agents.find((x) => x.pubkey === a.pubkey)
        const mine = !!e.state.agents[a.pubkey]
        const mode: AgentMode = e.state.agentModes?.[a.pubkey] ?? st?.mode ?? 'talk'
        const synced = !st || st.mode === mode
        const fresh = st && Date.now() / 1000 - st.at < 15 * 60
        return (
          <li key={a.pubkey} class="agent-card">
            <div class="agent-head">
              <Avatar name={a.name} kind="agent" online={a.online} picture={mine ? e.state.agentAvatars?.[a.pubkey] : a.avatar} />
              <div class="agent-head-text">
                {mine ? <AgentProfileEditor e={e} pubkey={a.pubkey} current={a.name} /> : <div class="member-name">{a.name}</div>}
                <div class="member-meta">
                  {/* playful handles no longer say which CLI runs the agent, so show it here */}
                  {a.client ? `${a.client} · ` : ''}
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
            {/* the folder the service last reported is the key: a change elsewhere resets the field */}
            {here && <LocalAgent key={here.workdir} agent={here} />}
            {mine && (
              <fieldset class="perm-set" data-testid="permissions">
                <legend class="field-label">When tagged, it may…</legend>
                {PERMISSIONS.map((p) => (
                  <label key={p.id} class="perm-switch" data-testid={`perm-${p.id}`}>
                    <span class="perm-text">
                      <strong>{p.label}</strong>
                      <span class="member-meta">{p.hint}</span>
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      class="toggle"
                      aria-label={p.label}
                      checked={switchesOf(mode)[p.id]}
                      onChange={(ev) => {
                        const next = modeAfterToggle(mode, p.id, (ev.target as HTMLInputElement).checked)
                        e.setAgentMode(a.pubkey, next)
                          .then(() => toast(`${a.name}: ${MODES.find((x) => x.id === next)?.label ?? next}`))
                          .catch((x) => toast(x.message, 'error'))
                      }}
                    />
                  </label>
                ))}
                {!synced && <span class="member-meta">Sent. It applies when the agent is next online.</span>}
                {modeCaveat(st?.host, mode) && <span class="member-meta">Note: {modeCaveat(st?.host, mode)}</span>}
              </fieldset>
            )}
          </li>
        )
      })}
    </ul>
  )
}

