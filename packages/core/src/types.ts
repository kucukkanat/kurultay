import type { BoardElement } from './board'
import type { FileRef, UploadRecord } from './files'
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
  /** profile picture: a small raster data URL (see cleanAvatar). Without one, apps draw a generated avatar from the name. */
  avatar?: string
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
  /** agents an admin removed: their tickets no longer seat them here (a new ticket mints new identities) */
  removed?: string[]
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
  /** encrypted attachments (see files.ts) */
  files?: FileRef[]
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
  /** unix seconds when this device last switched to a new key (removal or rotation); absent = never */
  rotatedAt?: number
  roster: Roster
  cards: Record<string, Card>
  presence: Record<string, number>
  tasks: Record<string, Task>
  history: Message[]
  joinedAt: number
  /** the council board: its Excalidraw elements by id, tombstones included (see board.ts) */
  board?: Record<string, BoardElement>
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

/** What an agent may do when it answers on its own (background turns). Set by its owner in the app. */
export type AgentMode = 'off' | 'talk' | 'read' | 'edit' | 'full'
export const DEFAULT_AGENT_MODE: AgentMode = 'talk'

export interface AgentStatus {
  host?: string
  workdir?: string
  background: boolean
  /** this host can answer headlessly */
  headless: boolean
  mode: AgentMode
  /** the name the agent goes by now */
  name?: string
  running?: boolean
  lastRun?: number
  lastError?: string
  /** profileRev of the picture and instructions the agent holds, so the owner can tell a stale copy */
  profile?: string
  at: number
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
  /** owner side: permission I chose per agent, and what each agent last reported */
  agentModes?: Record<string, AgentMode>
  agentStatus?: Record<string, AgentStatus>
  /** agent side: settings from my owner */
  agentSettings?: { mode: AgentMode; name?: string; avatar?: string; instructions?: string; updatedAt: number }
  /** blobs I uploaded and must delete when they expire */
  uploads?: Record<string, UploadRecord>
  /** owner: the names I gave my agents */
  agentNames?: Record<string, string>
  /** owner: the pictures and standing instructions I gave my agents */
  agentAvatars?: Record<string, string>
  agentInstructions?: Record<string, string>
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
  | { type: 'chat'; text: string; mentions?: string[]; thread?: string; files?: FileRef[] }
  | { type: 'typing'; on: boolean }
  | { type: 'task'; taskId: string; to: string; title: string; input?: string }
  | { type: 'task_update'; taskId: string; status: TaskStatus; output?: string }
  | { type: 'presence'; status: 'online' | 'offline'; card?: Card; attestation?: NostrEvent }
  | { type: 'state'; roster: Roster; epoch: number }
  | { type: 'leave' }
  /** board elements that changed (with `full`: a whole board answering board_req), as Excalidraw JSON; sanitized on arrival */
  | { type: 'board'; els: unknown[]; full?: boolean }
  /** a member who just opened the board asks whoever has it to send it */
  | { type: 'board_req' }
  /** where a member's pointer is on the board, for live cursors; never stored */
  | { type: 'board_ptr'; x: number; y: number }
  // pairwise inbox
  | { type: 'join_req'; reqId: string; inviteId: string; secret: string; name: string; kind: PeerKind; inbox: string; owner?: string; attestation?: NostrEvent; card?: Card }
  | { type: 'key'; groupId: string; reqId?: string; relays: string[]; epoch: number; key: string; roster: Roster }
  | { type: 'deny'; reqId: string; reason: string }
  | { type: 'sync_req'; groupId: string; epoch: number }
  | { type: 'removed'; groupId: string }
  | { type: 'agent_join'; groupId: string; reqId: string; name: string; inbox: string; attestation: NostrEvent; card?: Card }
  | { type: 'agent_settings'; mode: AgentMode; name?: string; avatar?: string; instructions?: string }
  | { type: 'rename'; groupId: string; name: string }
  | { type: 'agent_status'; status: Omit<AgentStatus, 'at'> }
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

/** Member names double as @mention handles: letters, digits, `_ # . -`, optionally `@machine`. */
export function cleanName(input: string): string | null {
  const name = input.trim().replace(/\s+/g, '-').replace(/^@+/, '').slice(0, 48)
  return /^[\w#.\-]+(?:@[\w.\-]+)?$/.test(name) && /\w/.test(name) ? name : null
}

/** A picture rides inside every presence beacon, so type and size are capped for every reader. SVG never: it can script. */
export const MAX_AVATAR_CHARS = 12_000
export const MAX_INSTRUCTIONS_CHARS = 4000
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

export function cleanAvatar(input: unknown): string | undefined {
  return typeof input === 'string' && input.length <= MAX_AVATAR_CHARS && AVATAR_RE.test(input) ? input : undefined
}

/** Idempotent (trim again after the cut), so owner and agent fingerprint the same text. */
export function cleanInstructions(input: unknown): string | undefined {
  return (typeof input === 'string' ? input.trim().slice(0, MAX_INSTRUCTIONS_CHARS).trim() : '') || undefined
}
