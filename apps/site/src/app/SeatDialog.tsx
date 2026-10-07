import { useEffect, useState } from 'preact/hooks'
import { decodeTicket, DEFAULT_AGENT_MODE, type DaemonSnapshot, type Kurultay } from '@kurultay/core'
import { daemon } from './daemon-client'
import { FolderPicker } from './DaemonPanel'
import { toast, useStore } from './store'
import { initialMode, SANDBOX_COPY } from './sandbox'
import { CopyField, Icon, Modal } from './ui'

/** localStorage key for the agent CLIs last seated; the command fallback in agents.tsx reads it too */
export const HOSTS_KEY = 'kurultay:hosts'
const WORKDIR_KEY = 'kurultay:workdir'

const remembered = (key: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}
const remember = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {} // storage blocked: remembering the choice is a convenience, seating already happened
}

/** Seat agents through the paired background service: no command, no pasted ticket. */
export function SeatDialog({ e, groupId, onClose, snap }: { e: Kurultay; groupId?: string; onClose: () => void; snap: DaemonSnapshot }) {
  useStore()
  const councils = e.groups().filter((g) => !g.roster.dm)
  const [picked, setPicked] = useState<string[]>(groupId ? [groupId] : councils.slice(0, 1).map((g) => g.id))
  const detected = snap.hosts.filter((h) => h.detected).map((h) => h.id)
  const [hosts, setHosts] = useState<string[]>(() => {
    const last = remembered(HOSTS_KEY)
    const pre = Array.isArray(last) ? last.filter((h): h is string => typeof h === 'string' && detected.includes(h)) : []
    return pre.length ? pre : detected.slice(0, 1)
  })
  const [folder, setFolder] = useState(() => {
    const last = remembered(WORKDIR_KEY)
    return typeof last === 'string' ? last : (snap.agents[0]?.workdir ?? '')
  })
  const [busy, setBusy] = useState(false)
  // one choice for the whole batch, on by default (D13); per-agent changes happen later under My agents
  const [sandbox, setSandbox] = useState(true)
  // an older service sends no `sandbox`: treat that as "can't", so the owner is never told it is safe when it isn't
  const availability = snap.sandbox ?? { ok: false as const, reason: SANDBOX_COPY.seatOld }
  const startMode = initialMode(sandbox, availability)
  const [ticketId, setTicketId] = useState<string>()
  // an empty folder defaults to the home folder of the computer the service runs on, which only it knows; a folder typed
  // while it was asked for wins
  useEffect(() => {
    if (!folder) void daemon.listDir('').then((l) => setFolder((cur) => cur || l.path), () => {})
  }, [])
  const seated = ticketId ? e.ticketProgress(ticketId) : []
  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item))

  const go = async () => {
    setBusy(true)
    try {
      const ticket = e.createTicket(picked, { hosts })
      const result = await daemon.seat(ticket, hosts, folder.trim(), sandbox)
      // D20: the first permission travels like any later change (agent_settings). Only a fresh agent gets it: seating
      // again must never widen what the owner already chose
      if (startMode !== DEFAULT_AGENT_MODE) for (const a of result.agents) if (!e.state.agentModes?.[a.pubkey]) await e.setAgentMode(a.pubkey, startMode).catch((err: Error) => toast(err.message, 'error'))
      setTicketId(decodeTicket(ticket).id)
      remember(WORKDIR_KEY, folder.trim())
      remember(HOSTS_KEY, hosts)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Add your agents" onClose={onClose} wide>
      <p class="lede-sm">Kurultay on this computer is paired with this browser. Choose agents, a folder and councils: nothing to run.</p>
      <fieldset class="host-picks">
        <legend class="field-label">Which agents?</legend>
        <div class="council-picks" data-testid="seat-hosts">
          {snap.hosts.map((h) => (
            <label key={h.id} class="check">
              <input type="checkbox" checked={hosts.includes(h.id)} disabled={!h.detected} onChange={(ev) => setHosts((cur) => toggle(cur, h.id, (ev.target as HTMLInputElement).checked))} data-testid={`seat-host-${h.id}`} />
              <span>
                {h.label}
                <small>{h.detected ? (h.seated ? 'Seated already: seating again keeps its identity' : 'Installed') : 'Not found on this computer'}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div class="field">
        <span class="field-label">Where do they work?</span>
        <FolderPicker value={folder} onChange={setFolder} testid="seat-folder" />
      </div>
      <fieldset class="council-picks" data-testid="seat-councils">
        <legend class="field-label">Seat them in</legend>
        {councils.length ? (
          councils.map((g) => (
            <label key={g.id} class="check">
              <input type="checkbox" checked={picked.includes(g.id)} onChange={(ev) => setPicked((p) => toggle(p, g.id, (ev.target as HTMLInputElement).checked))} data-testid={`seat-council-${g.id}`} />
              <span>#{g.roster.name}</span>
            </label>
          ))
        ) : (
          <p class="muted">No council yet: they are set up and wait for you to invite them.</p>
        )}
      </fieldset>
      <div class="field">
        <label class="check">
          <input type="checkbox" checked={sandbox} onChange={(ev) => setSandbox((ev.target as HTMLInputElement).checked)} data-testid="seat-sandbox" />
          <span>
            {SANDBOX_COPY.seatLabel}
            <small>{SANDBOX_COPY.seatHelp}</small>
          </span>
        </label>
        {sandbox && !availability.ok && (
          <div class="sandbox-note warn" data-testid="seat-sandbox-unavailable">
            <p>
              {SANDBOX_COPY.seatUnavailable} {availability.reason}
            </p>
            {availability.fix && <CopyField value={availability.fix} label={SANDBOX_COPY.seatFix} />}
          </div>
        )}
      </div>
      <p class="muted small-note" data-testid="seat-start-mode">
        {startMode === 'edit' ? SANDBOX_COPY.startsEdit : SANDBOX_COPY.startsTalk}
      </p>
      {seated.length > 0 && (
        <ul class="seat-status" data-testid="seat-progress">
          {seated.map((s) => (
            <li key={s.pubkey + s.groupId}>
              <Icon name="check" size={16} /> <strong>{s.name}</strong> joined #{e.state.groups[s.groupId]?.roster.name}
            </li>
          ))}
        </ul>
      )}
      <div class="row end">
        <button class="btn" type="button" onClick={onClose} data-testid="seat-close">
          {ticketId ? 'Done' : 'Close'}
        </button>
        <button class="btn primary" type="button" disabled={busy || !hosts.length || !folder.trim()} onClick={() => void go()} data-testid="seat-submit">
          {busy ? 'Setting up…' : ticketId ? 'Seat again' : `Seat ${hosts.length > 1 ? `${hosts.length} agents` : 'agent'}`}
        </button>
      </div>
    </Modal>
  )
}
