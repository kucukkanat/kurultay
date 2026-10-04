import { useEffect, useState } from 'preact/hooks'
import { createIdentity, loadIdentity, parseSecret, passkeySupported, quietUnlock, unlock, forgetIdentity, type Unlocked } from './identity'

export function Gate({ onReady }: { onReady: (u: Unlocked) => void }) {
  const existing = loadIdentity()
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'passkey' | 'local'>(passkeySupported() ? 'passkey' : 'local')
  const [importing, setImporting] = useState(false)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirmForget, setConfirmForget] = useState(false)
  // returning visitor: reopen silently (local key, or a remembered passkey unlock)
  const [checking, setChecking] = useState(!!existing)
  useEffect(() => {
    if (!existing) return
    quietUnlock(existing)
      .then((u) => (u ? onReady(u) : setChecking(false)))
      .catch(() => setChecking(false))
  }, [])

  async function create(e: Event) {
    e.preventDefault()
    setErr('')
    const n = name.trim().replace(/\s+/g, '-')
    if (!n) return setErr('Choose a display name.')
    setBusy(true)
    try {
      const sk = importing ? parseSecret(secret) : undefined
      onReady(await createIdentity(n, mode, sk))
    } catch (ex) {
      setErr((ex as Error).message || 'Something went wrong creating your key.')
    } finally {
      setBusy(false)
    }
  }

  async function doUnlock() {
    setErr('')
    setBusy(true)
    try {
      onReady(await unlock(existing!))
    } catch (ex) {
      setErr((ex as Error).message || 'Unlock failed.')
    } finally {
      setBusy(false)
    }
  }

  if (checking) return <div class="gate" aria-busy="true" />

  return (
    <div class="gate">
      <div class="gate-card">
        <a class="brand" href="../">
          <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="15" fill="var(--madder)" />
            <path d="M16 7c3 4 5 6.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.6 1 2.5 2 3 0-3 .5-5.5 1-8.5z" fill="#f3c46a" />
          </svg>
          <span>Kurultay</span>
        </a>

        {existing && existing.mode === 'passkey' ? (
          <>
            <h1>Welcome back, {existing.name}</h1>
            <p class="muted">Your key is sealed with a passkey on this device.</p>
            <button class="btn primary wide" onClick={doUnlock} disabled={busy}>
              {busy ? 'Waiting for passkey…' : 'Unlock with passkey'}
            </button>
            {err && <p class="error">{err}</p>}
            {confirmForget ? (
              <div class="confirm">
                <p>This deletes your key and all group keys from this browser. Without an exported nsec you can't get back in.</p>
                <div class="row">
                  <button class="btn small" onClick={() => setConfirmForget(false)}>
                    Keep my key
                  </button>
                  <button
                    class="btn small danger"
                    onClick={() => {
                      forgetIdentity(existing.pubkey)
                      location.reload()
                    }}
                  >
                    Delete from this browser
                  </button>
                </div>
              </div>
            ) : (
              <button class="link-btn" onClick={() => setConfirmForget(true)}>
                Use a different key
              </button>
            )}
          </>
        ) : (
          <form onSubmit={create}>
            <h1>Take a seat at the council</h1>
            <p class="muted">Your key lives only in this browser. Pick the name others will see.</p>
            <label class="field">
              <span class="field-label">Display name</span>
              <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="tolga" maxLength={32} autoComplete="nickname" />
            </label>

            <fieldset class="choice">
              <legend class="field-label">Protect your key with</legend>
              <label class={`choice-opt ${mode === 'passkey' ? 'on' : ''} ${passkeySupported() ? '' : 'disabled'}`}>
                <input type="radio" name="mode" checked={mode === 'passkey'} disabled={!passkeySupported()} onChange={() => setMode('passkey')} />
                <span>
                  <strong>A passkey</strong>
                  <small>Your key and group keys are encrypted at rest and unlocked with Touch ID, Windows Hello or a security key. Needs PRF support.</small>
                </span>
              </label>
              <label class={`choice-opt ${mode === 'local' ? 'on' : ''}`}>
                <input type="radio" name="mode" checked={mode === 'local'} onChange={() => setMode('local')} />
                <span>
                  <strong>A local key</strong>
                  <small>Stored unencrypted in this browser's storage. Quick to start; export it from Settings to back it up.</small>
                </span>
              </label>
            </fieldset>

            {importing ? (
              <label class="field">
                <span class="field-label">Existing key</span>
                <input value={secret} onInput={(e) => setSecret((e.target as HTMLInputElement).value)} placeholder="nsec1…" autoComplete="off" spellcheck={false} />
              </label>
            ) : (
              <button type="button" class="link-btn" onClick={() => setImporting(true)}>
                I already have an nsec
              </button>
            )}

            <button class="btn primary wide" type="submit" disabled={busy}>
              {busy ? 'Creating…' : importing ? 'Import key' : 'Create my key'}
            </button>
            {err && <p class="error">{err}</p>}
          </form>
        )}
      </div>
      <p class="gate-foot">
        No account, no server. <a href="../docs/security.html">How your keys are kept</a>
      </p>
    </div>
  )
}
