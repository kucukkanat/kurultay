import { useEffect, useState } from 'preact/hooks'
import { decodeTicket, type DaemonSnapshot, type Kurultay } from '@kurultay/core'
import { daemon } from './daemon-client'
import { FolderPicker } from './DaemonPanel'
import { toast, useStore } from './store'
import { Icon, Modal } from './ui'

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
  const [ticketId, setTicketId] = useState<string>()
  // an empty folder defaults to the home folder of the computer the service runs on, which only it knows
  useEffect(() => {
    if (!folder) void daemon.listDir('').then((l) => setFolder(l.path), () => {})
  }, [])
  const seated = ticketId ? e.ticketProgress(ticketId) : []
  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item))

  const go = async () => {
    setBusy(true)
    try {
      const ticket = e.createTicket(picked, { hosts })
      await daemon.seat(ticket, hosts, folder.trim())
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
      {seated.length > 0 && (
        <ul class="seat-status" data-testid="seat-progress">
          {seated.map((s) => (
            <li key={s.pubkey + s.groupId}>
              <Icon name="check" size={16} /> <strong>{s.name}</strong> joined #{e.state.groups[s.groupId]?.roster.name}
            </li>
          ))}
        </ul>
      )}
      {ticketId && <p class="muted small-note">They start as “Talk only”. Choose what they may do in that folder under My agents.</p>}
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
