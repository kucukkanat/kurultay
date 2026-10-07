import type { AgentMode } from './types'

/**
 * Wire types shared by the web app and the local `kurultay` daemon's control server (127.0.0.1 only).
 * This API never touches Nostr, so it is outside the protocol spec.
 */

/** Not Fika's 47615, so both can run on one machine. */
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
}

export interface DaemonSeatResult {
  agents: { instance: string; name: string; host: string }[]
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
