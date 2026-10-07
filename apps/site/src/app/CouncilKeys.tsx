import { useState } from 'preact/hooks'
import type { Kurultay } from '@kurultay/core'
import { adminCouncils, keyAge } from './keys'
import { toast, useStore } from './store'
import { Icon, Modal } from './ui'

/** Settings: the councils I administer, each with a button that rotates its key and sends the new one to every member. */
export function CouncilKeys({ e }: { e: Kurultay }) {
  useStore()
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mine = adminCouncils(e.groups(), (id) => e.isAdmin(id))
  const target = asking ? e.state.groups[asking] : undefined
  const nowSec = Math.floor(Date.now() / 1000)

  const rotate = async (id: string, name: string) => {
    setBusy(true)
    try {
      await e.rotateKey(id)
      toast(`New key for #${name} (epoch ${e.state.groups[id]?.epoch ?? '?'})`)
      setAsking(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="block" data-testid="council-keys">
      <h2>Council keys</h2>
      <p class="muted">Everything said in a council is encrypted with its key. Rotate it if a copy may have leaked, or to make sure only current members can read what is said from now on.</p>
      {mine.length ? (
        <ul class="key-list">
          {mine.map((g) => (
            <li key={g.id} data-testid={`council-key-${g.roster.name}`}>
              <div>
                <strong>#{g.roster.name}</strong>
                <div class="member-meta">
                  epoch {g.epoch} · {Object.keys(g.roster.members).length} members · {keyAge(g.rotatedAt, nowSec)}
                </div>
              </div>
              <button class="btn small" type="button" onClick={() => setAsking(g.id)} data-testid={`rotate-${g.roster.name}`}>
                <Icon name="key" size={14} /> Rotate key
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted" data-testid="council-keys-empty">You don't administer any council yet.</p>
      )}
      {target && (
        <Modal title={`Rotate the key of #${target.roster.name}?`} onClose={() => setAsking(null)}>
          <p class="muted">
            Every member gets a new key right away, so a leaked old key stops working for new messages. Past messages are not affected. Members who are offline get the new key when they come back while an admin is online.
          </p>
          <div class="row end">
            <button class="btn" type="button" onClick={() => setAsking(null)} data-testid="rotate-cancel">
              Cancel
            </button>
            <button class="btn danger" type="button" disabled={busy} onClick={() => void rotate(target.id, target.roster.name)} data-testid="rotate-confirm">
              {busy ? 'Rotating…' : 'Rotate the key'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
