import { useEffect, useState } from 'preact/hooks'
import type { DaemonAgentInfo, SandboxConfig } from '@kurultay/core'
import { daemon } from './daemon-client'
import { FolderPicker } from './DaemonPanel'
import { addPath, configFromDraft, configOf, draftOf, grantFor, isDirty, isGranted, SANDBOX_COPY, VIOLATION_LABEL, withGrant, type SandboxDraft } from './sandbox'
import { toast } from './store'

/** A list of extra folders: each removable, new ones added with the same picker as the working folder. */
function PathList({ label, hint, paths, testid, onChange }: { label: string; hint: string; paths: readonly string[]; testid: string; onChange: (paths: string[]) => void }) {
  const [adding, setAdding] = useState('')
  return (
    <div class="sandbox-field" data-testid={testid}>
      <span class="field-label">{label}</span>
      {paths.length > 0 && (
        <ul class="sandbox-paths">
          {paths.map((p, i) => (
            <li key={p}>
              <code class="folder">{p}</code>
              <button class="link-btn" type="button" aria-label={`Remove ${p}`} data-testid={`${testid}-remove-${i}`} onClick={() => onChange(paths.filter((x) => x !== p))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <FolderPicker value={adding} onChange={setAdding} label={label} testid={`${testid}-folder`}>
        <button class="btn small" type="button" disabled={!adding.trim()} data-testid={`${testid}-add`} onClick={() => (onChange(addPath(paths, adding)), setAdding(''))}>
          Add
        </button>
      </FolderPicker>
      <span class="member-meta">{hint}</span>
    </div>
  )
}

/**
 * Per agent, under My agents: the sandbox switch, what it last blocked (with one-click allow for websites), and the
 * grants. Every change goes to the service on this computer, which checks it again; what it refuses is shown here.
 */
export function SandboxSettings({ local }: { local: DaemonAgentInfo }) {
  const saved = configOf(local.sandbox)
  const savedKey = JSON.stringify(saved)
  const [draft, setDraft] = useState<SandboxDraft>(() => draftOf(saved))
  const [confirmOff, setConfirmOff] = useState(false)
  // shown next to what caused it: the switch and Allow buttons above, the settings form below
  const [error, setError] = useState<{ at: 'top' | 'settings'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // the service's copy changed (an Allow click, another tab): start the editor again from it
  useEffect(() => setDraft(draftOf(saved)), [savedKey])
  const patch = (p: Partial<SandboxDraft>) => setDraft((d) => ({ ...d, ...p }))
  const t = (suffix: string) => `agent-sandbox-${suffix}-${local.instance}`

  const send = async (next: SandboxConfig, done: string, at: 'top' | 'settings' = 'top') => {
    setBusy(true)
    try {
      await daemon.setSandbox(local.instance, next)
      setError(null)
      toast(done)
    } catch (err) {
      setError({ at, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }
  const violations = saved.enabled ? (local.sandbox?.lastViolations ?? []) : []

  return (
    <div class="sandbox" data-testid={t('panel')}>
      <label class="perm-switch">
        <span class="perm-text">
          <strong>
            {SANDBOX_COPY.switchLabel}
            {saved.enabled && (
              <span class="badge sandbox-badge" data-testid={t('badge')}>
                {SANDBOX_COPY.badge}
              </span>
            )}
          </strong>
          <span class="member-meta">{SANDBOX_COPY.switchHint}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          class="toggle"
          checked={saved.enabled}
          disabled={busy}
          aria-label={SANDBOX_COPY.switchLabel}
          data-testid={t('toggle')}
          onChange={(ev) => ((ev.target as HTMLInputElement).checked ? void send({ ...saved, enabled: true }, `${local.name} is sandboxed`) : setConfirmOff(true))}
        />
      </label>
      {confirmOff && (
        <div class="sandbox-note" role="alertdialog" aria-label="Turn off the sandbox?" data-testid={t('off-ask')}>
          <p>{SANDBOX_COPY.offConfirm}</p>
          <div class="row">
            <button class="btn small danger" type="button" data-testid={t('off-confirm')} onClick={() => (setConfirmOff(false), void send({ ...saved, enabled: false }, `${local.name} runs without a sandbox`))}>
              Turn off
            </button>
            <button class="btn small" type="button" data-testid={t('off-cancel')} onClick={() => setConfirmOff(false)}>
              Keep it on
            </button>
          </div>
        </div>
      )}

      {saved.enabled && local.sandbox?.fellBack && (
        <p class="sandbox-note warn" role="status" data-testid={t('fellback')}>
          {SANDBOX_COPY.fellBack}
          {local.sandbox.fellBack}
        </p>
      )}

      {violations.length > 0 && (
        <div class="sandbox-blocked" data-testid={t('blocked')}>
          <span class="field-label">{SANDBOX_COPY.blocked}</span>
          <ul>
            {violations.map((v, i) => {
              const domain = grantFor(v)
              return (
                <li key={`${v.kind}-${v.target}`} data-testid={t(`blocked-${i}`)}>
                  <span class="member-meta">{VIOLATION_LABEL[v.kind]}</span>
                  <code class="folder">{v.target}</code>
                  {domain &&
                    (isGranted(saved, domain) ? (
                      <span class="member-meta">Allowed</span>
                    ) : (
                      <button class="btn small" type="button" disabled={busy} data-testid={t(`allow-${i}`)} onClick={() => void send(withGrant(saved, domain), `Allowed ${domain}`)}>
                        Allow
                      </button>
                    ))}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {error?.at === 'top' && (
        <p class="error" role="alert" data-testid={t('error')}>
          {error.text}
        </p>
      )}

      {saved.enabled && (
        <details class="sandbox-settings" data-testid={t('settings')}>
          <summary>{SANDBOX_COPY.settings}</summary>
          <label class="sandbox-field">
            <span class="field-label">Websites it may reach</span>
            <textarea class="input mono" rows={3} value={draft.domains} placeholder="example.com" data-testid={t('domains')} onInput={(ev) => patch({ domains: (ev.target as HTMLTextAreaElement).value })} />
            <span class="member-meta">One per line. *.example.com allows every address under it. The service its answers come from is always allowed.</span>
          </label>
          <PathList label="Extra folders it may read" hint="Besides its working folder." paths={draft.readPaths} testid={t('read')} onChange={(readPaths) => patch({ readPaths })} />
          <PathList label="Extra folders it may read and change" hint="Only takes effect while it may edit files." paths={draft.writePaths} testid={t('write')} onChange={(writePaths) => patch({ writePaths })} />
          <div class="row">
            <button class="btn small primary" type="button" disabled={busy || !isDirty(saved, draft)} data-testid={t('save')} onClick={() => void send(configFromDraft(saved.enabled, draft), 'Sandbox settings saved', 'settings')}>
              Save sandbox settings
            </button>
            <button class="btn small" type="button" disabled={busy || !isDirty(saved, draft)} data-testid={t('reset')} onClick={() => (setDraft(draftOf(saved)), setError(null))}>
              Undo changes
            </button>
          </div>
          {error?.at === 'settings' && (
            <p class="error" role="alert" data-testid={t('settings-error')}>
              {error.text}
            </p>
          )}
        </details>
      )}
    </div>
  )
}
