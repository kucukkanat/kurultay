import type { AgentMode } from './types'

/**
 * Wire types shared by the web app and the local `kurultay` daemon's control server (127.0.0.1 only).
 * This API never touches Nostr, so it is outside the protocol spec.
 */

/** Not 47615, which an older fork's daemon uses, so both can run on one machine. */
export const DAEMON_PORT = 47616
/** The hosted web app; the daemon also accepts the local dev (5173) and preview (4173) servers. */
export const APP_ORIGIN = 'https://kucukkanat.github.io'

export interface DaemonAgentInfo {
  instance: string
  /** matches the agent the app sees in its councils; empty while the agents are stopped */
  pubkey: string
  name: string
  host: string
  workdir: string
  mode: AgentMode
  online: boolean
  running: boolean
  lastRun?: string
  lastError?: string
  councils: string[]
  groupIds: string[]
  /** absent: never sandboxed (seated by `join`, or before sandboxes existed), which means off (docs/sandbox.md D8) */
  sandbox?: AgentSandbox
}

/** What one sandboxed agent may reach besides its working folder. Local to the daemon: never sent over Nostr (D12). */
export interface SandboxGrants {
  /** hosts, `*.example.com` or `host:port` */
  allowDomains: string[]
  /** absolute (or `~/`) folders it may read */
  readPaths: string[]
  /** folders it may read and change, while its permission lets it edit */
  writePaths: string[]
}

export interface SandboxConfig extends SandboxGrants {
  enabled: boolean
}

export const EMPTY_SANDBOX_GRANTS: Readonly<SandboxGrants> = Object.freeze({ allowDomains: [], readPaths: [], writePaths: [] })

/** Whether this machine can run sandboxes; `fix` is the command that makes it able to. */
export type SandboxAvailability = { ok: true } | { ok: false; reason: string; fix?: string }

/** Something the sandbox refused during a background turn. Shown to the owner only, never to the council (D34). */
export interface SandboxViolation {
  kind: 'read' | 'write' | 'network' | 'other'
  target: string
  /** ms since the epoch */
  at: number
}

export interface AgentSandbox extends SandboxConfig {
  /** recent refusals, one per kind and target, newest first */
  lastViolations: SandboxViolation[]
  /** the last turn should have been sandboxed but ran without it, and why (D6) */
  fellBack?: string
}

export interface DaemonHostInfo {
  id: string
  label: string
  /** the agent CLI is installed on this machine */
  detected: boolean
  /** an agent is seated for it */
  seated: boolean
}

export interface DaemonSnapshot {
  version: string
  pid: number
  /** agents are offline but the control server stays up, so the app can start them again */
  paused: boolean
  home: string
  agents: DaemonAgentInfo[]
  hosts: DaemonHostInfo[]
  /** whether this machine can run sandboxes; an older daemon sends none, which the app treats as "can't" */
  sandbox?: SandboxAvailability
}

export interface DaemonHealth {
  app: 'kurultay'
  version: string
  paired: boolean
  paused: boolean
}

export interface DaemonSeatRequest {
  /** a `kurultay:` ticket made by the app for the chosen councils */
  ticket: string
  hosts: string[]
  workdir: string
  /** keep the seated agents in a sandbox (one choice for the batch, D13); re-seating keeps existing grants */
  sandbox?: boolean
}

export interface DaemonSeatResult {
  agents: { instance: string; name: string; host: string; pubkey: string }[]
}

export interface DaemonDirListing {
  path: string
  parent: string | null
  dirs: string[]
}

export interface PairRequest {
  id: string
  code: string
  /** seconds */
  expiresIn: number
}

export type PairPoll = { status: 'pending' } | { status: 'expired' } | { status: 'approved'; token: string }
