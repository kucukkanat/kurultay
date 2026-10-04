import type { Event as NostrEvent } from 'nostr-tools/pure'

export type { NostrEvent }

/** Outer, relay-visible event kind. Ephemeral range (20000-29999): relays MUST NOT store it. */
export const KIND_WRAP = 21059
/** Inner, signed-but-never-published event carrying a Kurultay envelope. */
export const KIND_INNER = 21061
/** Owner → agent certification, signed-but-never-published. */
export const KIND_ATTESTATION = 21062

/** Routing tag name. */
export const ROUTE_TAG = 'z'
/** Length of a routing slot in seconds. */
export const SLOT_SECONDS = 600
/** Accept inner events whose created_at is within this window. */
export const MAX_SKEW_SECONDS = 600
/** NIP-44 plaintext limit is 65535 bytes; keep a margin for the envelope. */
export const MAX_TEXT_BYTES = 32 * 1024

/** Probed: these forward ephemeral events without rate-limiting small bursts (nos.lol rejects them). */
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nostr.mom']

export type PeerKind = 'human' | 'agent'

export interface Card {
  name: string
  kind: PeerKind
  client?: string
  model?: string
  description?: string
  skills?: string[]
}

export interface Member {
  pubkey: string
  name: string
  kind: PeerKind
  /** hex secret for this member's pairwise inbox route */
  inbox: string
  role: 'admin' | 'member'
  owner?: string
  attestation?: NostrEvent
  joinedAt: number
}

export interface Roster {
  version: number
  name: string
  dm: boolean
  admins: string[]
  members: Record<string, Member>
  paused: boolean
  muted: string[]
  /** members may bring agents they own (admitted automatically); default true */
  allowMemberAgents?: boolean
}

export type TaskStatus = 'pending' | 'working' | 'done' | 'failed' | 'rejected'

export interface Task {
  taskId: string
  from: string
  to: string
  title: string
  input?: string
  status: TaskStatus
  output?: string
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: string
  groupId: string
  from: string
  ts: number
  type: 'chat' | 'task' | 'task_update' | 'system'
  text: string
  mentions?: string[]
  thread?: string
  taskId?: string
}

export interface Invite {
  inviteId: string
  groupId: string
  secret: string
  autoAdmit: boolean
  singleUse: boolean
  expiresAt: number
  uses: number
}

export interface GroupState {
  id: string
  relays: string[]
  epoch: number
  key: string
  /** previous epoch key kept for a short grace period */
  prevKey?: { epoch: number; key: string; until: number }
  roster: Roster
  cards: Record<string, Card>
  presence: Record<string, number>
  tasks: Record<string, Task>
  history: Message[]
  joinedAt: number
}

export interface PendingJoin {
  reqId: string
  link: InviteLink
  /** 'ticket': pre-approved by the owner, admitted by any admin because the owner is a member */
  via?: 'invite' | 'ticket'
  admins?: { pubkey: string; inbox: string }[]
  status: 'awaiting-owner' | 'awaiting-admin' | 'denied'
  createdAt: number
}

export interface Approval {
  reqId: string
  kind: 'join' | 'agent-join'
  createdAt: number
  groupId: string
  groupName: string
  /** who wants in (join) or which of my agents asks (agent-join) */
  requester: { pubkey: string; name: string; kind: PeerKind; owner?: string; inbox: string; attestation?: NostrEvent; card?: Card }
  inviteId?: string
}

export interface AgentRecord {
  pubkey: string
  label: string
  inbox: string
  client?: string
  attestation: NostrEvent
  pairedAt: number
}

export interface OwnerRecord {
  pubkey: string
  name: string
  inbox: string
  relays: string[]
  attestation?: NostrEvent
  pending?: { pairId: string; secret: string }
}

export interface TicketRecord {
  ticketId: string
  createdAt: number
  groups: string[]
  agents: Record<string, string> // pubkey -> host
}

/** Everything an agent CLI needs to take its seat, minted by the owner's app. Secret: treat like a password. */
export interface AgentTicket {
  t: 'ticket'
  v: 1
  id: string
  seed: string
  owner: { pubkey: string; name: string; inbox: string; relays: string[] }
  att: NostrEvent
  groups: { groupId: string; name: string; relays: string[]; admins: { pubkey: string; inbox: string }[] }[]
  /** agent CLIs the owner picked; the CLI sets up only these */
  hosts?: string[]
}

/** Host types an agent ticket mints identities for (one key per host type per machine). */
export const AGENT_HOSTS = ['claude', 'codex', 'copilot', 'pi', 'opencode', 'cursor', 'gemini', 'vscode'] as const
export type AgentHost = (typeof AGENT_HOSTS)[number]

export interface PairOffer {
  pairId: string
  secret: string
  label?: string
  expiresAt: number
}

export interface State {
  v: 1
  /** pubkey this state belongs to (guards against two identities writing one file) */
  pk?: string
  /** owner side: seed all my agent identities derive from, reused by every ticket so re-runs never duplicate agents */
  agentSeed?: string
  inbox: string
  groups: Record<string, GroupState>
  invites: Record<string, Invite>
  pendingJoins: Record<string, PendingJoin>
  approvals: Record<string, Approval>
  /** agents certified by me (human side) */
  agents: Record<string, AgentRecord>
  pairOffers: Record<string, PairOffer>
  /** my owner (agent side) */
  owner?: OwnerRecord
  /** agent tickets I created (human side) */
  tickets?: Record<string, TicketRecord>
  seen: Record<string, number>
}

export interface InviteLink {
  t: 'invite'
  groupId: string
  name: string
  relays: string[]
  admin: string
  adminInbox: string
  inviteId: string
  secret: string
  expiresAt: number
}

export interface PairLink {
  t: 'pair'
  owner: string
  name: string
  inbox: string
  relays: string[]
  pairId: string
  secret: string
  expiresAt: number
}

/** Envelope types, carried JSON-encoded in the content of a KIND_INNER event. */
export type Envelope =
  // group channel
  | { type: 'chat'; text: string; mentions?: string[]; thread?: string }
  | { type: 'typing'; on: boolean }
  | { type: 'task'; taskId: string; to: string; title: string; input?: string }
  | { type: 'task_update'; taskId: string; status: TaskStatus; output?: string }
  | { type: 'presence'; status: 'online' | 'offline'; card?: Card; attestation?: NostrEvent }
  | { type: 'state'; roster: Roster; epoch: number }
  | { type: 'leave' }
  // pairwise inbox
  | { type: 'join_req'; reqId: string; inviteId: string; secret: string; name: string; kind: PeerKind; inbox: string; owner?: string; attestation?: NostrEvent; card?: Card }
  | { type: 'key'; groupId: string; reqId?: string; relays: string[]; epoch: number; key: string; roster: Roster }
  | { type: 'deny'; reqId: string; reason: string }
  | { type: 'sync_req'; groupId: string; epoch: number }
  | { type: 'removed'; groupId: string }
  | { type: 'agent_join'; groupId: string; reqId: string; name: string; inbox: string; attestation: NostrEvent; card?: Card }
  | { type: 'pair_req'; pairId: string; secret: string; label: string; client?: string; inbox: string }
  | { type: 'pair_ok'; pairId: string; attestation: NostrEvent }
  | { type: 'approve_req'; reqId: string; groupName: string; admin: string; card?: Card }
  | { type: 'approve_res'; reqId: string; ok: boolean }

export type EnvelopeType = Envelope['type']

/** A decrypted, verified inner event as delivered to the engine. */
export interface Inbound {
  channel: 'group' | 'inbox'
  groupId?: string
  inner: NostrEvent
  env: Envelope
  outer: NostrEvent
  relay: string
}
