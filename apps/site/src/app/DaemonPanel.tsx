import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { DaemonDirListing, DaemonSnapshot } from '@kurultay/core'
import { cancelPairing, daemon, startPairing, unpair, useDaemon } from './daemon-client'
import { toast } from './store'
import { CopyField, Icon, Modal } from './ui'

/** pinned to the exact build CI published, so npx can't serve an older cached copy */
const DIST_REF = String(import.meta.env?.VITE_DIST_REF || 'dist')
/** `npx … <command>`; npm can't install a github: spec pinned to a commit hash, but a tarball URL works */
export const NPX = /^[0-9a-f]{40}$/.test(DIST_REF) ? `npx -y https://codeload.github.com/kucukkanat/kurultay/tar.gz/${DIST_REF}` : 'npx -y github:kucukkanat/kurultay#dist'

/** Runs a service command, turning success into a toast and every failure into an error toast (never a silent no-op). */
export async function act(done: string, work: () => Promise<unknown>) {
  try {
    await work()
    toast(done)
  } catch (err) {
    toast((err as Error).message, 'error')
  }
}

/** Pick a folder on the computer the service runs on. The browser can't see it, so the service lists folders. */
export function FolderPicker({ value, onChange, testid = 'folder', label = 'Working folder', children }: { value: string; onChange: (path: string) => void; testid?: string; label?: string; children?: ComponentChildren }) {
  const [open, setOpen] = useState(false)
  return (
    <div class="folder-picker row" data-testid={`${testid}-picker`}>
      <input class="input mono" value={value} onInput={(ev) => onChange((ev.target as HTMLInputElement).value)} placeholder="/path/to/project" aria-label={label} data-testid={`${testid}-input`} />
      <button class="btn small" type="button" onClick={() => setOpen(true)} data-testid={`${testid}-browse`}>
        Browse…
      </button>
      {children}
      {open && <BrowseDialog start={value} onPick={(p) => (onChange(p), setOpen(false))} onClose={() => setOpen(false)} />}
    </div>
  )
}

function BrowseDialog({ start, onPick, onClose }: { start: string; onPick: (path: string) => void; onClose: () => void }) {
  const [at, setAt] = useState<DaemonDirListing | null>(null)
  const [error, setError] = useState('')
  const open = async (path: string): Promise<void> => {
    try {
      setAt(await daemon.listDir(path))
      setError('')
    } catch (err) {
      // a typed path that doesn't exist (yet) falls back to the home folder
      if (path) return open('')
      setError((err as Error).message)
    }
  }
  useEffect(() => void open(start), [])
  const child = (dir: DaemonDirListing, name: string) => `${dir.path.replace(/\/$/, '')}/${name}`
  return (
    <Modal title="Choose a folder" onClose={onClose}>
      {error && <p class="error">{error}</p>}
      {at && (
        <>
          <code class="folder" data-testid="browse-path">
            {at.path}
          </code>
          <ul class="dir-list" data-testid="browse-list">
            {at.parent !== null && (
              <li>
                <button class="link-btn" type="button" onClick={() => at.parent !== null && void open(at.parent)} data-testid="browse-up">
                  ↑ ..
                </button>
              </li>
            )}
            {at.dirs.map((d) => (
              <li key={d}>
                <button class="link-btn" type="button" onClick={() => void open(child(at, d))} data-testid={`browse-dir-${d}`}>
                  {d}
                </button>
              </li>
            ))}
            {!at.dirs.length && <li class="muted">No subfolders</li>}
          </ul>
          <div class="row end">
            <button class="btn" type="button" onClick={onClose} data-testid="browse-cancel">
              Cancel
            </button>
            <button class="btn primary" type="button" onClick={() => onPick(at.path)} data-testid="browse-use">
              Use this folder
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

function Countdown({ until }: { until: number }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((until - Date.now()) / 1000)))
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((until - Date.now()) / 1000))), 500)
    return () => clearInterval(t)
  }, [until])
  return <>{left}</>
}

/** Finding the background service on this computer and pairing with it. */
export function Connection() {
  const d = useDaemon()
  if (d.status === 'pairing' && d.pairing)
    return (
      <section class="daemon-card" data-testid="daemon-pairing">
        <h3>Approve this browser</h3>
        <p class="muted">Run this in a terminal on this computer. Only someone at this computer can approve it.</p>
        <div class="pair-code" data-testid="pair-code" aria-label="Pairing code">
          {d.pairing.code}
        </div>
        <CopyField value={`${NPX} pair ${d.pairing.code}`} />
        <p class="muted small-note">
          <span class="pulse" /> Waiting for approval · expires in <Countdown until={d.pairing.expiresAt} /> s
        </p>
        <button class="btn small" type="button" onClick={cancelPairing} data-testid="pair-cancel">
          Cancel
        </button>
      </section>
    )
  if (d.status === 'unpaired')
    return (
      <section class="daemon-card" data-testid="daemon-unpaired">
        <h3>Kurultay is running on this computer</h3>
        <p class="muted">Pair this browser with it once, then add agents, change their folders and start or stop them from here. This page shows a code; you approve it in a terminal.</p>
        {d.error && <p class="error">{d.error}</p>}
        <button class="btn primary" type="button" onClick={() => void startPairing()} data-testid="pair-start">
          <Icon name="key" size={16} /> Pair this browser
        </button>
      </section>
    )
  return (
    <section class="daemon-card" data-testid="daemon-searching">
      <h3>
        <span class="pulse" /> Looking for Kurultay on this computer…
      </h3>
      <p class="muted">It runs once you have added agents with the command. This page finds it by itself and then offers to pair. If your browser asks whether this site may reach devices on your local network, allow it: that is how it talks to Kurultay.</p>
      {d.unsupportedBrowser && (
        <p class="error" data-testid="daemon-safari">
          Safari doesn't let a secure page talk to a program on your computer. Use Chrome, Edge or Firefox, or keep using the command.
        </p>
      )}
    </section>
  )
}

function Lifecycle({ snap }: { snap: DaemonSnapshot }) {
  return (
    <section class="daemon-card" data-testid="daemon-connected">
      <h3>
        <Icon name="check" size={16} /> Paired with this computer
      </h3>
      <p class="muted">
        v{snap.version} · {snap.agents.length} agent{snap.agents.length === 1 ? '' : 's'} · {snap.paused ? 'stopped' : 'running'}
      </p>
      <div class="row">
        {snap.paused ? (
          <button class="btn primary small" type="button" onClick={() => void act('Agents started', daemon.resume)} data-testid="daemon-resume">
            <Icon name="play" size={14} /> Start agents
          </button>
        ) : (
          <button class="btn small" type="button" onClick={() => void act('Agents stopped', daemon.pause)} data-testid="daemon-pause">
            <Icon name="pause" size={14} /> Stop agents
          </button>
        )}
        <button class="btn small" type="button" onClick={() => void unpair()} data-testid="daemon-unpair">
          Unpair this browser
        </button>
      </div>
      <p class="muted small-note">Stopping takes the agents offline but keeps the service, so you can start them again from here.</p>
    </section>
  )
}

/** My agents → This computer: finding, pairing and then controlling the background service. */
export function DaemonSection() {
  const d = useDaemon()
  return d.status === 'connected' && d.snapshot ? <Lifecycle snap={d.snapshot} /> : <Connection />
}
