import {
  attest,
  attestMany,
  deriveAgent,
  checkAttestation,
  getPublicKey,
  profileRev,
  routeWindow,
  signInner,
  slotOf,
  unwrapGroup,
  unwrapInbox,
  wrapGroup,
  wrapInbox,
} from './crypto'
import { decodeLink, encodeInvite, encodePair, encodeTicket } from './links'
import { cleanFileRefs, DEFAULT_BLOSSOM, deleteBlob, downloadFile, encryptFile, FILE_TTL, MAX_FILES_PER_MESSAGE, normalizeServer, safeFileName, uploadBlob, type FileRef } from './files'
import { RelayPool, type Frame, type RelayInfo } from './relay'
import { chunkElements, mergeElements, type BoardElement } from './board'
import {
  DEFAULT_RELAYS,
  MAX_TEXT_BYTES,
  ROUTE_TAG,
  KIND_WRAP,
  AGENT_HOSTS,
  DEFAULT_AGENT_MODE,
  cleanAvatar,
  cleanInstructions,
  cleanName,
  type AgentMode,
  type AgentStatus,
  type AgentTicket,
  type Approval,
  type Card,
  type Envelope,
  type GroupState,
  type InviteLink,
  type Member,
  type Message,
  type NostrEvent,
  type PairLink,
  type PeerKind,
  type Roster,
  type State,
  type Task,
  type TaskStatus,
} from './types'
import { Emitter, now, randomHex, utf8 } from './util'

export interface Storage {
  load(): Promise<State | null> | State | null
  save(state: State): Promise<void> | void
}

export class MemoryStorage implements Storage {
  state: State | null = null
  load() {
    return this.state ? structuredClone(this.state) : null
  }
  save(s: State) {
    this.state = structuredClone(s)
  }
}

export interface EngineOptions {
  sk: Uint8Array
  name: string
  kind: PeerKind
  card?: Partial<Card>
  relays?: string[]
  storage?: Storage
  appUrl?: string
  /** ms between presence beacons (default 60s) */
  presenceInterval?: number
  limits?: { agentSendPerMinute?: number; humanSendPerMinute?: number; recvPerMinute?: number }
  /** Blossom servers for attachments, tried in order (default: DEFAULT_BLOSSOM) */
  blossom?: string[]
}

export interface RawRecord {
  id: string
  ts: number
  dir: 'in' | 'out'
  channel: 'group' | 'inbox' | 'unknown'
  groupId?: string
  outer: NostrEvent
  inner?: NostrEvent
  env?: Envelope
  error?: string
  relay?: string
}

/**
 * The top of a reply chain. Threads are flat, as in Slack: a reply to a reply belongs to the thread of the first message.
 * The walk stops at the oldest message we still have, so a reply whose parent fell out of history is its own root.
 * `seen` guards against a hostile cycle of ids: a peer controls `thread`, and a loop must never hang the app or the daemon.
 */
export function rootOf(byId: ReadonlyMap<string, Message>, m: Message): Message {
  const seen = new Set<string>()
  let cur = m
  for (let up = cur.thread ? byId.get(cur.thread) : undefined; up && !seen.has(cur.id); up = cur.thread ? byId.get(cur.thread) : undefined) {
    seen.add(cur.id)
    cur = up
  }
  return cur
}

/**
 * A reply in a thread I am part of is addressed to me without an @mention: that is how a person keeps talking to an agent.
 * A direct reply to something I said always counts. Merely sharing a thread only counts when a human wrote the reply, so two
 * agents in one thread never keep each other talking.
 */
export function inMyThread(g: Pick<GroupState, 'history' | 'roster'>, msg: Pick<Message, 'from' | 'thread'>, me: string): boolean {
  if (!msg.thread) return false
  const byId = new Map(g.history.map((m) => [m.id, m]))
  const parent = byId.get(msg.thread)
  if (parent?.from === me) return true
  if (!parent || g.roster.members[msg.from]?.kind !== 'human') return false
  const root = rootOf(byId, parent).id
  return g.history.some((m) => m.from === me && rootOf(byId, m).id === root)
}

export interface MessageEvent {
  groupId: string
  message: Message
  /** true when the message explicitly addresses me (mention, @all, task to me, DM, a reply in a thread I spoke in) */
  forMe: boolean
}

export interface MemberView {
  pubkey: string
  name: string
  kind: PeerKind
  role: 'admin' | 'member'
  online: boolean
  isMe: boolean
  muted: boolean
  card?: Card
  verified: { owner: string; ownerName: string; label: string } | null
}

type EngineEvents = {
  message: MessageEvent
  typing: { groupId: string; from: string; on: boolean }
  change: { reason: string }
  raw: RawRecord
  frame: Frame
  relay: RelayInfo
  approval: Approval
  notice: { level: 'info' | 'warn' | 'error'; text: string; groupId?: string }
  settings: { mode: AgentMode }
  /** board elements that changed, from a peer or from me; `full` when a peer sent a whole board */
  board: { groupId: string; from: string; elements: BoardElement[]; full: boolean }
  /** another member's pointer on the board */
  pointer: { groupId: string; from: string; x: number; y: number }
}

const ONLINE_WINDOW = 150
/** Board envelopes per minute, apart from chat's limit: a drag sends a few a second, and a whole board goes out in chunks. */
export const BOARD_SEND_PER_MINUTE = 300
export const BOARD_RECV_PER_MINUTE = 600
const HISTORY_LIMIT = 500

export function emptyState(): State {
  return {
    v: 1,
    inbox: randomHex(32),
    groups: {},
    invites: {},
    pendingJoins: {},
    approvals: {},
    agents: {},
    pairOffers: {},
    seen: {},
  }
}

export class KurultayError extends Error {}

/** Peers' cards are untrusted: a picture that is not a small raster data URL (javascript:, tracking https:, SVG) is dropped. */
const safeCard = (card: Card): Card => ({ ...card, avatar: cleanAvatar(card.avatar) })

/** A copy of `table` with `key` set to `value`, or removed when `value` is undefined. */
const withEntry = (table: Record<string, string> | undefined, key: string, value: string | undefined): Record<string, string> => {
  const { [key]: _old, ...rest } = table ?? {}
  return value === undefined ? rest : { ...rest, [key]: value }
}

export class Kurultay extends Emitter<EngineEvents> {
  readonly pubkey: string
  readonly sk: Uint8Array
  state: State = emptyState()
  pool: RelayPool
  name: string
  kind: PeerKind
  card: Card
  appUrl?: string
  /** Blossom servers for my uploads, tried in order */
  blossom: string[]

  private storage: Storage
  private lastSweep = 0
  private baseRelays: string[]
  private timers: ReturnType<typeof setInterval>[] = []
  private saveTimer?: ReturnType<typeof setTimeout>
  private tagMap = new Map<string, { channel: 'inbox' } | { channel: 'group'; groupId: string; key: string }>()
  private sendLog = new Map<string, number[]>()
  /** owner: the last status that made me resend an agent its settings (see agent_status) */
  private settingsResent = new Map<string, string>()
  private recvLog = new Map<string, number[]>()
  private boardSendLog = new Map<string, number[]>()
  private boardRecvLog = new Map<string, number[]>()
  /** answers to a board_req I am waiting to send, by group; cancelled when someone else answers first */
  private boardReplies = new Map<string, ReturnType<typeof setTimeout>>()
  private lastPresence = 0
  private lastRetry = 0
  private presenceInterval: number
  private limits: Required<NonNullable<EngineOptions['limits']>>
  private started = false
  private reconnectTimer?: ReturnType<typeof setTimeout>

  constructor(opts: EngineOptions) {
    super()
    this.sk = opts.sk
    this.pubkey = getPublicKey(opts.sk)
    this.name = opts.name
    this.kind = opts.kind
    this.card = { name: opts.name, kind: opts.kind, ...opts.card }
    this.storage = opts.storage ?? new MemoryStorage()
    this.baseRelays = opts.relays?.length ? opts.relays : DEFAULT_RELAYS
    this.appUrl = opts.appUrl
    this.blossom = opts.blossom?.length ? opts.blossom.map(normalizeServer) : DEFAULT_BLOSSOM
    this.presenceInterval = opts.presenceInterval ?? 60_000
    this.limits = {
      agentSendPerMinute: opts.limits?.agentSendPerMinute ?? 12,
      humanSendPerMinute: opts.limits?.humanSendPerMinute ?? 40,
      recvPerMinute: opts.limits?.recvPerMinute ?? 40,
    }
    this.pool = new RelayPool()
    this.pool.on('event', ({ relay, event }) => this.onOuter(event, relay))
    this.pool.on('frame', (f) => this.emit('frame', f))
    this.pool.on('status', (r) => {
      this.emit('relay', r)
      // a (re)connected relay missed everything sent while it was down: catch up on control traffic
      if (r.status === 'open' && this.started) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = setTimeout(() => {
          this.syncAll()
          this.retryPending()
          this.beacon()
        }, 400)
      }
    })
  }

  // ------------------------------------------------------------------ lifecycle

  async start() {
    if (this.started) return
    this.started = true
    const loaded = await this.storage.load()
    if (loaded && loaded.v === 1) this.state = { ...emptyState(), ...loaded }
    this.state.pk = this.pubkey
    // an agent keeps the name its owner gave it
    if (this.state.agentSettings?.name) {
      this.name = this.state.agentSettings.name
      this.card = { ...this.card, name: this.name }
    }
    if (this.state.agentSettings?.avatar) this.card = { ...this.card, avatar: this.state.agentSettings.avatar }
    this.persist()
    this.pool.setRelays(this.allRelays())
    this.resubscribe()
    this.syncAll()
    this.beacon()
    this.retryPending()
    this.timers.push(setInterval(() => this.tick(), 5_000))
  }

  async stop() {
    if (!this.started) return
    this.started = false
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const t of this.boardReplies.values()) clearTimeout(t)
    this.boardReplies.clear()
    await Promise.race([
      Promise.all(Object.keys(this.state.groups).map((g) => this.sendGroup(g, { type: 'presence', status: 'offline' }))),
      new Promise((r) => setTimeout(r, 1500)),
    ])
    this.flush()
    this.pool.close()
  }

  setRelays(relays: string[]) {
    this.baseRelays = relays.length ? relays : DEFAULT_RELAYS
    this.pool.setRelays(this.allRelays())
  }

  get relays() {
    return this.baseRelays
  }

  private allRelays() {
    const set = new Set(this.baseRelays)
    for (const g of Object.values(this.state.groups)) for (const r of g.relays) set.add(r)
    if (this.state.owner) for (const r of this.state.owner.relays) set.add(r)
    return [...set]
  }

  private tick() {
    this.resubscribe()
    const t = now()
    for (const g of Object.values(this.state.groups)) {
      if (g.prevKey && g.prevKey.until < t) {
        delete g.prevKey
        this.persist()
      }
    }
    if (Date.now() - this.lastPresence >= this.presenceInterval) this.beacon()
    if (Date.now() - this.lastRetry >= 30_000) this.retryPending()
    for (const [id, inv] of Object.entries(this.state.invites)) if (inv.expiresAt < t) delete this.state.invites[id]
    for (const [id, o] of Object.entries(this.state.pairOffers)) if (o.expiresAt < t) delete this.state.pairOffers[id]
    for (const [id, ts] of Object.entries(this.state.seen)) if (ts < t - 1200) delete this.state.seen[id]
    if (Date.now() - this.lastSweep >= 60_000) void this.sweepUploads()
  }

  // ------------------------------------------------------------------ files

  /** Encrypt and upload a file for one of my councils. Send the returned FileRef with `send(…, { files })`. */
  async uploadFile(bytes: Uint8Array, name: string, mime = 'application/octet-stream', opts: { width?: number; height?: number; ttl?: number; signal?: AbortSignal } = {}): Promise<FileRef> {
    const enc = await encryptFile(bytes)
    const up = await uploadBlob(this.blossom, enc.blob, enc.sha256, { signal: opts.signal })
    const expiresAt = now() + (opts.ttl ?? FILE_TTL)
    const ref: FileRef = { name: safeFileName(name), mime: mime || 'application/octet-stream', size: bytes.length, sha256: enc.sha256, servers: [up.server], key: enc.key, iv: enc.iv, expiresAt, width: opts.width, height: opts.height }
    ;(this.state.uploads ??= {})[enc.sha256] = { sha256: enc.sha256, servers: [up.server], sk: up.sk, expiresAt, name: ref.name }
    this.changed('upload')
    return ref
  }

  /** Delete an upload right away (e.g. the attachment was removed before sending). */
  async discardUpload(sha256: string) {
    const u = this.state.uploads?.[sha256]
    if (!u) return
    for (const s of u.servers) await deleteBlob(s, u.sha256, u.sk).catch(() => false)
    delete this.state.uploads![sha256]
    this.changed('upload-deleted')
  }

  /** Download and decrypt an attachment from a message I can read. */
  downloadFile(ref: FileRef, opts: { signal?: AbortSignal } = {}) {
    return downloadFile(ref, opts)
  }

  /** Delete my uploads once they expire (runs whenever this client is online). */
  async sweepUploads(force = false) {
    this.lastSweep = Date.now()
    const t = now()
    for (const u of Object.values(this.state.uploads ?? {})) {
      if (!force && u.expiresAt > t) continue
      const left: string[] = []
      for (const s of u.servers) if (!(await deleteBlob(s, u.sha256, u.sk).catch(() => false))) left.push(s)
      // give up a week after expiry: the server is gone or has dropped it
      if (!left.length || u.expiresAt < t - 7 * 86400) delete this.state.uploads![u.sha256]
      else u.servers = left
      this.changed('upload-deleted')
    }
  }

  private persist() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 200)
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    void this.storage.save(this.state)
  }

  private changed(reason: string) {
    this.persist()
    this.emit('change', { reason })
  }

  // ------------------------------------------------------------------ subscriptions

  resubscribe() {
    const tags = new Map<string, { channel: 'inbox' } | { channel: 'group'; groupId: string; key: string }>()
    for (const tag of routeWindow(this.state.inbox, 'inbox')) tags.set(tag, { channel: 'inbox' })
    for (const g of Object.values(this.state.groups)) {
      for (const tag of routeWindow(g.key, 'group')) tags.set(tag, { channel: 'group', groupId: g.id, key: g.key })
      if (g.prevKey) for (const tag of routeWindow(g.prevKey.key, 'group')) tags.set(tag, { channel: 'group', groupId: g.id, key: g.prevKey.key })
    }
    this.tagMap = tags
    this.pool.setRelays(this.allRelays())
    this.pool.subscribe('kurultay', { kinds: [KIND_WRAP], ['#' + ROUTE_TAG]: [...tags.keys()].sort() })
  }

  /** Tags currently listened to (dev mode). */
  routes() {
    return [...this.tagMap.entries()].map(([tag, r]) => ({ tag, channel: r.channel, groupId: r.channel === 'group' ? r.groupId : undefined, slot: slotOf() }))
  }

  // ------------------------------------------------------------------ inbound

  private onOuter(outer: NostrEvent, relay: string) {
    const tag = outer.tags.find((t) => t[0] === ROUTE_TAG)?.[1]
    const route = tag ? this.tagMap.get(tag) : undefined
    const base = { id: outer.id, ts: Date.now(), dir: 'in' as const, outer, relay }
    if (!route) {
      this.emit('raw', { ...base, channel: 'unknown', error: 'no matching route' })
      return
    }
    try {
      if (route.channel === 'group') {
        const { inner, env } = unwrapGroup(outer, route.groupId, route.key)
        if (this.isSeen(inner.id)) return
        this.emit('raw', { ...base, channel: 'group', groupId: route.groupId, inner, env })
        this.onGroup(route.groupId, inner, env)
      } else {
        const { inner, env } = unwrapInbox(outer, this.sk)
        if (this.isSeen(inner.id)) return
        this.emit('raw', { ...base, channel: 'inbox', inner, env })
        this.onInbox(inner, env)
      }
    } catch (err) {
      this.emit('raw', { ...base, channel: route.channel, groupId: route.channel === 'group' ? route.groupId : undefined, error: (err as Error).message })
    }
  }

  private isSeen(id: string) {
    if (this.state.seen[id]) return true
    this.state.seen[id] = now()
    return false
  }

  private rateOk(log: Map<string, number[]>, key: string, limit: number) {
    const t = Date.now()
    const arr = (log.get(key) ?? []).filter((x) => x > t - 60_000)
    if (arr.length >= limit) {
      log.set(key, arr)
      return false
    }
    arr.push(t)
    log.set(key, arr)
    return true
  }

  private onGroup(groupId: string, inner: NostrEvent, env: Envelope) {
    const g = this.state.groups[groupId]
    if (!g) return
    const from = inner.pubkey
    const member = g.roster.members[from]
    if (!member) {
      this.emit('notice', { level: 'warn', text: `Dropped ${env.type} from non-member ${from.slice(0, 8)}`, groupId })
      return
    }
    if (from !== this.pubkey) g.presence[from] = now()

    const isSpeech = env.type === 'chat' || env.type === 'task' || env.type === 'task_update'
    if (isSpeech && from !== this.pubkey) {
      if (g.roster.muted.includes(from)) return
      if (g.roster.paused && member.kind === 'agent') return
      if (!this.rateOk(this.recvLog, groupId + from, this.limits.recvPerMinute)) {
        this.emit('notice', { level: 'warn', text: `Rate-limited ${member.name}`, groupId })
        return
      }
    }

    switch (env.type) {
      case 'chat': {
        const mentions = (env.mentions ?? []).filter((m) => typeof m === 'string')
        const msg: Message = { id: inner.id, groupId, from, ts: inner.created_at, type: 'chat', text: String(env.text ?? '').slice(0, MAX_TEXT_BYTES), mentions, thread: env.thread, files: cleanFileRefs(env.files) }
        this.record(g, msg, from !== this.pubkey && (g.roster.dm || mentions.includes(this.pubkey) || mentions.includes('all') || inMyThread(g, msg, this.pubkey)))
        break
      }
      case 'typing':
        if (from !== this.pubkey) this.emit('typing', { groupId, from, on: !!env.on })
        break
      case 'task': {
        const task: Task = { taskId: env.taskId, from, to: env.to, title: env.title, input: env.input, status: 'pending', createdAt: inner.created_at, updatedAt: inner.created_at }
        g.tasks[task.taskId] = task
        const msg: Message = { id: inner.id, groupId, from, ts: inner.created_at, type: 'task', text: env.title + (env.input ? `\n\n${env.input}` : ''), taskId: env.taskId, mentions: [env.to] }
        this.record(g, msg, from !== this.pubkey && env.to === this.pubkey)
        break
      }
      case 'task_update': {
        const task = g.tasks[env.taskId]
        if (!task || (from !== task.to && from !== task.from)) return
        task.status = env.status
        task.output = env.output
        task.updatedAt = inner.created_at
        const msg: Message = { id: inner.id, groupId, from, ts: inner.created_at, type: 'task_update', text: `${env.status}${env.output ? ': ' + env.output : ''}`, taskId: env.taskId, mentions: [task.from] }
        this.record(g, msg, from !== this.pubkey && task.from === this.pubkey)
        break
      }
      case 'presence':
        if (env.status === 'offline') delete g.presence[from]
        if (env.card) g.cards[from] = { ...safeCard(env.card), kind: member.kind }
        if (env.attestation && checkAttestation(env.attestation, from) && !member.attestation) {
          member.attestation = env.attestation
          member.owner = env.attestation.pubkey
        }
        this.changed('presence')
        break
      case 'state':
        if (!g.roster.admins.includes(from)) return
        if (env.epoch !== g.epoch || env.roster.version <= g.roster.version) return
        if (!env.roster.members[this.pubkey]) return this.dropGroup(groupId, 'You were removed from the group')
        g.roster = env.roster
        this.changed('roster')
        this.keepName(g)
        break
      case 'leave':
        if (this.isAdmin(groupId) && from !== this.pubkey) void this.removeMember(groupId, from, 'left')
        break
      case 'board':
      case 'board_req':
      case 'board_ptr':
        this.onBoard(g, from, member.kind, env)
        break
    }
  }

  // ------------------------------------------------------------------ board

  /**
   * Board traffic follows the speech rules (a muted member, or an agent in a paused council, cannot draw) but has its own,
   * higher rate limit, so dragging a shape never eats into the chat limit.
   */
  private onBoard(g: GroupState, from: string, kind: PeerKind, env: Extract<Envelope, { type: 'board' | 'board_req' | 'board_ptr' }>) {
    const mine = from === this.pubkey
    if (!mine && (g.roster.muted.includes(from) || (g.roster.paused && kind === 'agent'))) return
    if (!mine && !this.rateOk(this.boardRecvLog, g.id + from, BOARD_RECV_PER_MINUTE)) return
    if (env.type === 'board_ptr') {
      if (!mine && Number.isFinite(env.x) && Number.isFinite(env.y)) this.emit('pointer', { groupId: g.id, from, x: env.x, y: env.y })
      return
    }
    if (env.type === 'board_req') {
      if (mine || !Object.keys(g.board ?? {}).length || this.boardReplies.has(g.id)) return
      // everyone who has the board would answer at once: a random wait lets the first answer cancel the rest
      const reply = setTimeout(() => {
        this.boardReplies.delete(g.id)
        void this.sendBoard(g.id, Object.values(this.state.groups[g.id]?.board ?? {}), true).catch(() => {})
      }, 300 + Math.random() * 1500)
      this.boardReplies.set(g.id, reply)
      return
    }
    if (!Array.isArray(env.els)) return
    if (env.full && !mine) {
      clearTimeout(this.boardReplies.get(g.id))
      this.boardReplies.delete(g.id)
    }
    const { next, changed } = mergeElements(g.board ?? {}, env.els)
    if (!changed.length) return
    g.board = next
    // persisted, but not a 'change': a stroke must not re-render the whole app
    this.persist()
    this.emit('board', { groupId: g.id, from, elements: changed, full: !!env.full })
  }

  private async sendBoard(groupId: string, els: readonly BoardElement[], full = false) {
    for (const chunk of chunkElements(els)) {
      if (!this.rateOk(this.boardSendLog, groupId, BOARD_SEND_PER_MINUTE)) throw new KurultayError(`Board rate limit: at most ${BOARD_SEND_PER_MINUTE} updates per minute. Wait a moment.`)
      await this.sendGroup(groupId, { type: 'board', els: chunk, ...(full ? { full: true } : {}) })
    }
  }

  private guardBoard(groupId: string): GroupState {
    const g = this.state.groups[groupId]
    if (!g) throw new KurultayError(`Unknown group ${groupId}`)
    if (g.roster.muted.includes(this.pubkey)) throw new KurultayError('You are muted in this group')
    if (g.roster.paused && this.kind === 'agent') throw new KurultayError('The group is paused by a moderator; agents cannot draw until it is resumed')
    return g
  }

  /** The board as I have it: Excalidraw elements by id, deleted ones included. */
  boardScene(groupId: string): Record<string, BoardElement> {
    return this.state.groups[groupId]?.board ?? {}
  }

  /**
   * Puts elements on the board and sends the ones that changed it to the council, encrypted with the group key like any
   * message. The app passes what Excalidraw changed, agents pass what board.ts builds. Returns the elements that changed
   * the board (one no newer than mine changes nothing and is not sent).
   */
  async drawBoard(groupId: string, els: readonly unknown[]): Promise<BoardElement[]> {
    const g = this.guardBoard(groupId)
    const { changed } = mergeElements(g.board ?? {}, els)
    if (changed.length) await this.sendBoard(groupId, changed)
    return changed
  }

  /** Asks the council for the board: someone who has it answers with all of it. Call when the board opens. */
  async requestBoard(groupId: string) {
    this.guardBoard(groupId)
    await this.sendGroup(groupId, { type: 'board_req' })
  }

  /** Shows the others where my pointer is on the board. Callers throttle; over the board rate it is silently skipped. */
  async boardPointer(groupId: string, x: number, y: number) {
    this.guardBoard(groupId)
    if (!this.rateOk(this.boardSendLog, groupId, BOARD_SEND_PER_MINUTE)) return
    await this.sendGroup(groupId, { type: 'board_ptr', x: Math.round(x), y: Math.round(y) })
  }

  private record(g: GroupState, msg: Message, forMe: boolean) {
    g.history.push(msg)
    if (g.history.length > HISTORY_LIMIT) g.history.splice(0, g.history.length - HISTORY_LIMIT)
    this.changed('message')
    this.emit('message', { groupId: g.id, message: msg, forMe })
  }

  private system(groupId: string, text: string) {
    const g = this.state.groups[groupId]
    if (!g) return
    this.record(g, { id: 'sys-' + randomHex(8), groupId, from: '', ts: now(), type: 'system', text }, false)
  }

  private onInbox(inner: NostrEvent, env: Envelope) {
    const from = inner.pubkey
    switch (env.type) {
      case 'join_req':
        return this.onJoinReq(from, env)
      case 'agent_join':
        return this.onAgentJoin(from, env)
      case 'agent_settings': {
        if (!this.state.owner || from !== this.state.owner.pubkey) return
        const name = env.name ? cleanName(env.name) ?? undefined : this.state.agentSettings?.name
        const avatar = cleanAvatar(env.avatar)
        const pictureChanged = avatar !== this.state.agentSettings?.avatar
        this.state.agentSettings = { mode: env.mode, name, avatar, instructions: cleanInstructions(env.instructions), updatedAt: now() }
        this.emit('settings', { mode: env.mode })
        this.changed('settings')
        // the picture rides in the card every council sees; without one, apps fall back to the generated avatar.
        // It goes into the card before the rename beacons, so councils never get a card with the new name and the old picture.
        if (pictureChanged) this.card = { ...this.card, avatar }
        if (name && name !== this.name) this.useName(name)
        else if (pictureChanged) this.beacon()
        return
      }
      case 'rename': {
        // a member asks the admins to change the name it goes by
        const g = this.state.groups[env.groupId]
        if (!g || !this.isAdmin(g.id) || !g.roster.members[from]) return
        void this.renameMember(g.id, from, env.name).catch(() => {})
        return
      }
      case 'agent_status': {
        if (!this.state.agents[from]) return
        const st = (this.state.agentStatus ??= {})
        st[from] = { ...env.status, at: now() }
        // the agent came online with an older setting than the one I chose: send mine again
        const want = this.state.agentModes?.[from]
        const wantName = this.state.agentNames?.[from]
        const wantRev = profileRev(this.state.agentAvatars?.[from], this.state.agentInstructions?.[from])
        const got = env.status
        // agents from before profiles never report one and cannot apply ours: resending to them would never settle
        const stale = (want && want !== got.mode) || (wantName && got.name && wantName !== got.name) || (got.profile !== undefined && got.profile !== wantRev)
        // the agent answers every settings with a status, so resend once per (reported, chosen) pair: an agent that
        // cannot keep what we send, or two owner tabs that chose differently, would otherwise trade them forever
        const pair = JSON.stringify([got.mode, got.name, got.profile, want, wantName, wantRev])
        if (stale && this.settingsResent.get(from) !== pair) {
          this.settingsResent.set(from, pair)
          void this.sendAgentSettings(from)
        }
        this.changed('agent-status')
        return
      }
      case 'key':
        return this.onKey(from, env)
      case 'deny': {
        const p = this.state.pendingJoins[env.reqId]
        if (!p || (p.link.admin !== from && !(p.admins ?? []).some((a) => a.pubkey === from))) return
        p.status = 'denied'
        this.emit('notice', { level: 'warn', text: `Join to “${p.link.name}” denied: ${env.reason}` })
        this.changed('join-denied')
        return
      }
      case 'sync_req': {
        const g = this.state.groups[env.groupId]
        if (!g || !g.roster.admins.includes(this.pubkey)) return
        const m = g.roster.members[from]
        if (m) void this.sendInbox(from, m.inbox, { type: 'key', groupId: g.id, relays: g.relays, epoch: g.epoch, key: g.key, roster: g.roster })
        return
      }
      case 'removed': {
        const g = this.state.groups[env.groupId]
        if (g && g.roster.admins.includes(from)) this.dropGroup(g.id, 'You were removed from the group')
        return
      }
      case 'pair_req': {
        const offer = this.state.pairOffers[env.pairId]
        if (!offer || offer.secret !== env.secret || offer.expiresAt < now()) return
        delete this.state.pairOffers[env.pairId]
        const label = offer.label || env.label || 'agent'
        const att = attest(this.sk, from, label, this.name)
        this.state.agents[from] = { pubkey: from, label, inbox: env.inbox, client: env.client, attestation: att, pairedAt: now() }
        void this.sendInbox(from, env.inbox, { type: 'pair_ok', pairId: env.pairId, attestation: att })
        this.emit('notice', { level: 'info', text: `Paired agent “${label}”` })
        this.changed('paired')
        return
      }
      case 'pair_ok': {
        const owner = this.state.owner
        if (!owner || owner.pubkey !== from || !checkAttestation(env.attestation, this.pubkey)) return
        owner.attestation = env.attestation
        this.emit('notice', { level: 'info', text: `Paired with owner ${owner.name}` })
        this.changed('paired')
        this.beacon()
        return
      }
      case 'approve_req': {
        const agent = this.state.agents[from]
        if (!agent) return
        const a: Approval = {
          reqId: env.reqId,
          kind: 'agent-join',
          createdAt: now(),
          groupId: '',
          groupName: env.groupName,
          requester: { pubkey: from, name: agent.label, kind: 'agent', inbox: agent.inbox, owner: this.pubkey, card: env.card && safeCard(env.card) },
        }
        this.state.approvals[env.reqId] = a
        this.emit('approval', a)
        this.changed('approval')
        return
      }
      case 'approve_res': {
        const p = this.state.pendingJoins[env.reqId]
        if (!p || !this.state.owner || from !== this.state.owner.pubkey || p.status !== 'awaiting-owner') return
        if (env.ok) {
          p.status = 'awaiting-admin'
          void this.sendJoinReq(env.reqId, p.link)
          this.emit('notice', { level: 'info', text: `Owner approved joining “${p.link.name}”` })
        } else {
          p.status = 'denied'
          this.emit('notice', { level: 'warn', text: `Owner declined joining “${p.link.name}”` })
        }
        this.changed('approval')
        return
      }
    }
  }

  private onJoinReq(from: string, env: Extract<Envelope, { type: 'join_req' }>) {
    const inv = this.state.invites[env.inviteId]
    if (!inv || inv.secret !== env.secret) return
    const g = this.state.groups[inv.groupId]
    if (!g || !this.isAdmin(g.id)) return
    if (g.roster.members[from]) {
      void this.sendInbox(from, g.roster.members[from].inbox, { type: 'key', groupId: g.id, reqId: env.reqId, relays: g.relays, epoch: g.epoch, key: g.key, roster: g.roster })
      return
    }
    if (inv.expiresAt < now() || (inv.singleUse && inv.uses > 0)) {
      void this.sendInbox(from, env.inbox, { type: 'deny', reqId: env.reqId, reason: 'invite expired or already used' })
      return
    }
    const att = checkAttestation(env.attestation, from)
    const requester = {
      pubkey: from,
      name: String(env.name).slice(0, 64),
      kind: env.kind === 'human' ? ('human' as const) : ('agent' as const),
      inbox: env.inbox,
      owner: att?.owner,
      attestation: att ? env.attestation : undefined,
      card: env.card && safeCard(env.card),
    }
    inv.uses++
    if (inv.autoAdmit) {
      this.admit(g.id, requester, env.reqId)
    } else {
      if (this.state.approvals[env.reqId]) return
      const a: Approval = { reqId: env.reqId, kind: 'join', createdAt: now(), groupId: g.id, groupName: g.roster.name, requester, inviteId: inv.inviteId }
      this.state.approvals[env.reqId] = a
      this.emit('approval', a)
      this.changed('approval')
    }
  }

  /** An agent carrying its owner's attestation asks to join; admitted when the owner is a human member. */
  private onAgentJoin(from: string, env: Extract<Envelope, { type: 'agent_join' }>) {
    const g = this.state.groups[env.groupId]
    if (!g || !this.isAdmin(g.id)) return
    const existing = g.roster.members[from]
    if (existing) {
      void this.sendInbox(from, existing.inbox, { type: 'key', groupId: g.id, reqId: env.reqId, relays: g.relays, epoch: g.epoch, key: g.key, roster: g.roster })
      return
    }
    const att = checkAttestation(env.attestation, from)
    const owner = att ? g.roster.members[att.owner] : undefined
    if (!att || !owner || owner.kind !== 'human') {
      void this.sendInbox(from, env.inbox, { type: 'deny', reqId: env.reqId, reason: 'the agent’s owner is not a member of this council' })
      return
    }
    if (g.roster.removed?.includes(from)) {
      void this.sendInbox(from, env.inbox, { type: 'deny', reqId: env.reqId, reason: 'this agent was removed from the council; mint a new ticket in the app to seat it again' })
      return
    }
    if (g.roster.allowMemberAgents === false) {
      void this.sendInbox(from, env.inbox, { type: 'deny', reqId: env.reqId, reason: 'this council does not accept members’ agents' })
      return
    }
    // one agent per owner and host: an older identity for the same host (e.g. from an earlier ticket) is replaced
    const stale = Object.values(g.roster.members).filter((m) => m.kind === 'agent' && m.pubkey !== from && m.owner === att.owner && checkAttestation(m.attestation, m.pubkey)?.label === att.label)
    const admitNow = () => this.admit(g.id, { pubkey: from, name: String(env.name).slice(0, 64), kind: 'agent', inbox: env.inbox, owner: att.owner, attestation: env.attestation, card: env.card && safeCard(env.card) }, env.reqId)
    if (!stale.length) return admitNow()
    void (async () => {
      for (const m of stale) await this.removeMember(g.id, m.pubkey, 'was replaced by a newer identity')
      admitNow()
    })()
  }

  private onKey(from: string, env: Extract<Envelope, { type: 'key' }>) {
    const roster = env.roster
    if (!roster?.members?.[this.pubkey] || !roster.admins.includes(from)) return
    const pendingEntry = env.reqId ? this.state.pendingJoins[env.reqId] : undefined
    const groupId = env.groupId
    const pendingAdmins = pendingEntry ? [pendingEntry.link.admin, ...(pendingEntry.admins ?? []).map((a) => a.pubkey)] : []
    if (pendingEntry && (!pendingAdmins.includes(from) || pendingEntry.link.groupId !== groupId)) return
    const existing = this.state.groups[groupId]
    // unsolicited adds (DMs, direct adds) are only accepted from peers we already share a group with
    if (!existing && !pendingEntry && !Object.values(this.state.groups).some((x) => x.roster.members[from])) return
    // an owned agent sits only where its owner is (or in a DM): nobody else can pull it into a council
    const owner = this.state.owner?.pubkey
    if (!existing && !pendingEntry && this.kind === 'agent' && owner && !roster.dm && !roster.members[owner]) return
    if (existing) {
      if (!existing.roster.admins.includes(from)) return
      if (env.epoch < existing.epoch) return
      if (env.epoch === existing.epoch && roster.version < existing.roster.version) return
      if (env.epoch > existing.epoch) {
        existing.prevKey = { epoch: existing.epoch, key: existing.key, until: now() + 600 }
        existing.rotatedAt = now()
      }
      existing.epoch = env.epoch
      existing.key = env.key
      existing.roster = roster
      existing.relays = env.relays?.length ? env.relays : existing.relays
    } else {
      this.state.groups[groupId] = {
        id: groupId,
        relays: env.relays?.length ? env.relays : pendingEntry!.link.relays,
        epoch: env.epoch,
        key: env.key,
        roster,
        cards: {},
        presence: {},
        tasks: {},
        history: [],
        joinedAt: now(),
      }
      this.system(groupId, `You joined “${roster.name}”`)
    }
    if (env.reqId) delete this.state.pendingJoins[env.reqId]
    this.resubscribe()
    this.changed('key')
    if (!existing) this.beacon()
    this.keepName(this.state.groups[groupId])
  }

  private renameAsked: Record<string, number> = {}
  /** Agent: the roster still shows an old name (e.g. no admin was online when I was renamed): ask again. */
  private keepName(g: GroupState) {
    const want = this.state.agentSettings?.name
    if (!want || g.roster.members[this.pubkey]?.name === want) return
    if (Date.now() - (this.renameAsked[g.id] ?? 0) < 60_000) return
    this.renameAsked[g.id] = Date.now()
    if (this.isAdmin(g.id)) return void this.renameMember(g.id, this.pubkey, want).catch(() => {})
    for (const a of g.roster.admins) {
      const m = g.roster.members[a]
      if (m && a !== this.pubkey) void this.sendInbox(a, m.inbox, { type: 'rename', groupId: g.id, name: want }).catch(() => {})
    }
  }

  private dropGroup(groupId: string, why: string) {
    const g = this.state.groups[groupId]
    if (!g) return
    delete this.state.groups[groupId]
    this.emit('notice', { level: 'warn', text: `${why}: “${g.roster.name}”`, groupId })
    this.resubscribe()
    this.changed('removed')
  }

  // ------------------------------------------------------------------ outbound

  private async publish(outer: NostrEvent, rec: Omit<RawRecord, 'id' | 'ts' | 'dir' | 'outer'>) {
    this.emit('raw', { id: outer.id, ts: Date.now(), dir: 'out', outer, ...rec })
    return this.pool.publish(outer)
  }

  private async sendGroup(groupId: string, env: Envelope) {
    const g = this.state.groups[groupId]
    if (!g) throw new KurultayError(`Unknown group ${groupId}`)
    const inner = signInner(this.sk, env, ['g', groupId])
    this.state.seen[inner.id] = now()
    const outer = wrapGroup(inner, g.key)
    // apply locally right away (the relay echo is deduplicated)
    this.onGroup(groupId, inner, env)
    await this.publish(outer, { channel: 'group', groupId, inner, env })
    return inner
  }

  private async sendInbox(to: string, inbox: string, env: Envelope) {
    const inner = signInner(this.sk, env, ['p', to])
    this.state.seen[inner.id] = now()
    const outer = wrapInbox(inner, to, inbox)
    await this.publish(outer, { channel: 'inbox', inner, env })
    return inner
  }

  private guardSpeech(groupId: string) {
    const g = this.state.groups[groupId]
    if (!g) throw new KurultayError(`Unknown group ${groupId}`)
    if (g.roster.muted.includes(this.pubkey)) throw new KurultayError('You are muted in this group')
    if (g.roster.paused && this.kind === 'agent') throw new KurultayError('The group is paused by a moderator; agents cannot speak until it is resumed')
    const limit = this.kind === 'agent' ? this.limits.agentSendPerMinute : this.limits.humanSendPerMinute
    if (!this.rateOk(this.sendLog, groupId, limit)) throw new KurultayError(`Rate limit: at most ${limit} messages per minute per group. Wait before sending again.`)
    return g
  }

  async send(groupId: string, text: string, opts: { mentions?: string[]; thread?: string; files?: FileRef[] } = {}) {
    this.guardSpeech(groupId)
    if (utf8(text).length > MAX_TEXT_BYTES) throw new KurultayError(`Message too large (max ${MAX_TEXT_BYTES} bytes)`)
    const files = opts.files?.length ? cleanFileRefs(opts.files) : undefined
    if (opts.files && opts.files.length > MAX_FILES_PER_MESSAGE) throw new KurultayError(`At most ${MAX_FILES_PER_MESSAGE} files per message`)
    if (!text.trim() && !files) throw new KurultayError('Nothing to send')
    const mentions = this.resolveMentions(groupId, [...(opts.mentions ?? []), ...this.extractMentions(text)])
    const inner = await this.sendGroup(groupId, { type: 'chat', text, mentions, thread: opts.thread, files })
    return inner.id
  }

  async sendTask(groupId: string, to: string, title: string, input?: string) {
    this.guardSpeech(groupId)
    const [target] = this.resolveMentions(groupId, [to])
    if (!target || target === 'all') throw new KurultayError(`Unknown member ${to}`)
    const taskId = randomHex(8)
    await this.sendGroup(groupId, { type: 'task', taskId, to: target, title, input })
    return taskId
  }

  async updateTask(groupId: string, taskId: string, status: TaskStatus, output?: string) {
    const g = this.guardSpeech(groupId)
    const task = g.tasks[taskId]
    if (!task) throw new KurultayError(`Unknown task ${taskId}`)
    if (task.to !== this.pubkey && task.from !== this.pubkey) throw new KurultayError('Only the assignee or requester can update a task')
    await this.sendGroup(groupId, { type: 'task_update', taskId, status, output })
  }

  async typing(groupId: string, on: boolean) {
    if (!this.state.groups[groupId]) return
    await this.sendGroup(groupId, { type: 'typing', on })
  }

  private extractMentions(text: string) {
    return [...text.matchAll(/(?:^|[^\w@])@([\w#.\-]+(?:@[\w.\-]+)?)/g)].map((m) => m[1].replace(/[.\-]+$/, ''))
  }

  /** Resolve names, labels, short or full pubkeys to member pubkeys ("all" passes through). */
  resolveMentions(groupId: string, refs: string[]): string[] {
    const g = this.state.groups[groupId]
    if (!g) return []
    const out = new Set<string>()
    const members = Object.values(g.roster.members)
    for (const raw of refs) {
      const r = raw.replace(/^@/, '').trim()
      if (!r) continue
      if (r === 'all' || r === 'here') {
        out.add('all')
        continue
      }
      const lower = r.toLowerCase()
      const short = members.filter((m) => m.name.toLowerCase().split('@')[0] === lower)
      const hit =
        members.find((m) => m.pubkey === r) ??
        members.find((m) => m.name.toLowerCase() === lower) ??
        (short.length === 1 ? short[0] : undefined) ??
        members.find((m) => m.pubkey.startsWith(lower) && lower.length >= 6)
      if (hit) out.add(hit.pubkey)
    }
    return [...out]
  }

  // ------------------------------------------------------------------ groups

  isAdmin(groupId: string) {
    return !!this.state.groups[groupId]?.roster.admins.includes(this.pubkey)
  }

  private me(): Member {
    return {
      pubkey: this.pubkey,
      name: this.name,
      kind: this.kind,
      inbox: this.state.inbox,
      role: 'admin',
      owner: this.state.owner?.attestation ? this.state.owner.pubkey : undefined,
      attestation: this.state.owner?.attestation,
      joinedAt: now(),
    }
  }

  createGroup(name: string, opts: { relays?: string[]; dm?: boolean } = {}): GroupState {
    const id = randomHex(16)
    const g: GroupState = {
      id,
      relays: opts.relays?.length ? opts.relays : this.baseRelays,
      epoch: 0,
      key: randomHex(32),
      roster: { version: 1, name, dm: !!opts.dm, admins: [this.pubkey], members: { [this.pubkey]: this.me() }, paused: false, muted: [] },
      cards: { [this.pubkey]: this.card },
      presence: {},
      tasks: {},
      history: [],
      joinedAt: now(),
    }
    this.state.groups[id] = g
    this.resubscribe()
    this.system(id, `Group “${name}” created`)
    this.changed('group-created')
    return g
  }

  createInvite(groupId: string, opts: { autoAdmit?: boolean; singleUse?: boolean; ttlSeconds?: number } = {}): string {
    const g = this.state.groups[groupId]
    if (!g) throw new KurultayError(`Unknown group ${groupId}`)
    if (!this.isAdmin(groupId)) throw new KurultayError('Only admins can invite')
    const inviteId = randomHex(8)
    const secret = randomHex(16)
    const expiresAt = now() + (opts.ttlSeconds ?? 86400)
    this.state.invites[inviteId] = { inviteId, groupId, secret, autoAdmit: opts.autoAdmit ?? true, singleUse: opts.singleUse ?? false, expiresAt, uses: 0 }
    this.changed('invite')
    const link: InviteLink = { t: 'invite', groupId, name: g.roster.name, relays: g.relays, admin: this.pubkey, adminInbox: this.state.inbox, inviteId, secret, expiresAt }
    return encodeInvite(link, this.appUrl)
  }

  /** Redeem an invite link or pairing code. */
  async redeem(input: string): Promise<{ kind: 'invite' | 'pair'; status: string; reqId?: string; name: string }> {
    const link = decodeLink(input)
    if (link.expiresAt < now()) throw new KurultayError('This link has expired')
    if (link.t === 'pair') return this.pairWith(link)
    if (this.state.groups[link.groupId]) return { kind: 'invite', status: 'already-member', name: link.name }
    const reqId = randomHex(8)
    const viaOwner = this.kind === 'agent' && !!this.state.owner?.attestation
    this.state.pendingJoins[reqId] = { reqId, link, status: viaOwner ? 'awaiting-owner' : 'awaiting-admin', createdAt: now() }
    this.pool.setRelays(this.allRelays().concat(link.relays))
    if (viaOwner) {
      const o = this.state.owner!
      await this.sendInbox(o.pubkey, o.inbox, { type: 'approve_req', reqId, groupName: link.name, admin: link.admin, card: this.card })
    } else {
      await this.sendJoinReq(reqId, link)
    }
    this.changed('join-pending')
    // the admin may answer before the publish even resolves: then the request is already settled
    const status = this.state.pendingJoins[reqId]?.status ?? (this.state.groups[link.groupId] ? 'joined' : 'denied')
    return { kind: 'invite', status, reqId, name: link.name }
  }

  private async sendJoinReq(reqId: string, link: InviteLink) {
    const p = this.state.pendingJoins[reqId]
    if (p?.via === 'ticket') {
      const att = this.state.owner?.attestation
      if (!att) return
      await Promise.all(
        (p.admins ?? [{ pubkey: link.admin, inbox: link.adminInbox }]).map((a) =>
          this.sendInbox(a.pubkey, a.inbox, { type: 'agent_join', groupId: link.groupId, reqId, name: this.name, inbox: this.state.inbox, attestation: att, card: this.card }),
        ),
      )
      return
    }
    await this.sendInbox(link.admin, link.adminInbox, {
      type: 'join_req',
      reqId,
      inviteId: link.inviteId,
      secret: link.secret,
      name: this.name,
      kind: this.kind,
      inbox: this.state.inbox,
      owner: this.state.owner?.attestation ? this.state.owner.pubkey : undefined,
      attestation: this.state.owner?.attestation,
      card: this.card,
    })
  }

  private retryPending() {
    this.lastRetry = Date.now()
    const t = now()
    for (const p of Object.values(this.state.pendingJoins)) {
      if (p.status !== 'awaiting-admin') continue
      if (p.link.expiresAt < t || (p.via !== 'ticket' && t - p.createdAt > 3600)) {
        delete this.state.pendingJoins[p.reqId]
        continue
      }
      void this.sendJoinReq(p.reqId, p.link)
    }
    const o = this.state.owner
    if (o && !o.attestation && o.pending) void this.sendPairReq()
  }

  private admit(groupId: string, req: Approval['requester'], reqId: string) {
    const g = this.state.groups[groupId]
    if (!g) return
    g.roster.members[req.pubkey] = {
      pubkey: req.pubkey,
      name: this.uniqueName(g, req.name),
      kind: req.kind,
      inbox: req.inbox,
      role: 'member',
      owner: req.owner,
      attestation: req.attestation,
      joinedAt: now(),
    }
    if (req.card) g.cards[req.pubkey] = { ...safeCard(req.card), kind: req.kind }
    g.roster.version++
    void this.sendInbox(req.pubkey, req.inbox, { type: 'key', groupId: g.id, reqId, relays: g.relays, epoch: g.epoch, key: g.key, roster: g.roster })
    void this.sendGroup(groupId, { type: 'state', roster: g.roster, epoch: g.epoch })
    this.system(groupId, `${g.roster.members[req.pubkey].name} joined`)
  }

  private uniqueName(g: GroupState, name: string, self?: string) {
    const taken = new Set(Object.values(g.roster.members).filter((m) => m.pubkey !== self).map((m) => m.name.toLowerCase()))
    const base = name.replace(/\s+/g, '-') || 'peer'
    if (!taken.has(base.toLowerCase())) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`.toLowerCase())) return `${base}-${i}`
  }

  /** Add a known peer directly (e.g. for DMs) — they must share another group with us so we know their inbox. */
  async addKnownMember(groupId: string, pubkey: string) {
    const g = this.state.groups[groupId]
    if (!g || !this.isAdmin(groupId)) throw new KurultayError('Only admins can add members')
    const m = Object.values(this.state.groups).map((x) => x.roster.members[pubkey]).find(Boolean)
    if (!m) throw new KurultayError('Unknown peer: no shared group')
    if (g.roster.removed?.includes(pubkey)) g.roster.removed = g.roster.removed.filter((x) => x !== pubkey)
    this.admit(groupId, { pubkey, name: m.name, kind: m.kind, inbox: m.inbox, owner: m.owner, attestation: m.attestation }, randomHex(8))
  }

  /** Open (or reuse) a direct message channel with a peer from a shared group. */
  async openDM(pubkey: string) {
    const existing = Object.values(this.state.groups).find((g) => g.roster.dm && g.roster.members[pubkey] && Object.keys(g.roster.members).length === 2)
    if (existing) return existing.id
    const peer = Object.values(this.state.groups).map((x) => x.roster.members[pubkey]).find(Boolean)
    if (!peer) throw new KurultayError('Unknown peer')
    const g = this.createGroup(`${this.name} ↔ ${peer.name}`, { dm: true })
    await this.addKnownMember(g.id, pubkey)
    return g.id
  }

  async approve(reqId: string, ok: boolean) {
    const a = this.state.approvals[reqId]
    if (!a) throw new KurultayError('Unknown approval request')
    delete this.state.approvals[reqId]
    if (a.kind === 'agent-join') {
      await this.sendInbox(a.requester.pubkey, a.requester.inbox, { type: 'approve_res', reqId, ok })
    } else if (ok) {
      this.admit(a.groupId, a.requester, reqId)
    } else {
      await this.sendInbox(a.requester.pubkey, a.requester.inbox, { type: 'deny', reqId, reason: 'declined by admin' })
    }
    this.changed('approval')
  }

  async removeMember(groupId: string, pubkey: string, why = 'removed') {
    const g = this.state.groups[groupId]
    if (!g || !this.isAdmin(groupId)) throw new KurultayError('Only admins can remove members')
    const m = g.roster.members[pubkey]
    if (!m) return
    delete g.roster.members[pubkey]
    g.roster.admins = g.roster.admins.filter((a) => a !== pubkey)
    g.roster.muted = g.roster.muted.filter((a) => a !== pubkey)
    // an agent removed on purpose stays out: its ticket would otherwise seat it again
    if (why === 'removed' && m.kind === 'agent') g.roster.removed = [...(g.roster.removed ?? []).filter((x) => x !== pubkey), pubkey].slice(-200)
    g.roster.version++
    await this.rollKey(g, [this.sendInbox(pubkey, m.inbox, { type: 'removed', groupId })])
    this.system(groupId, `${m.name} ${why} — group key rotated to epoch ${g.epoch}`)
    this.changed('removed-member')
  }

  /** Admin-only: switch the council to a fresh key without changing who is in it (e.g. after a suspected leak). */
  async rotateKey(groupId: string) {
    const g = this.state.groups[groupId]
    if (!g || !this.isAdmin(groupId)) throw new KurultayError('Only admins can rotate the key')
    if (g.roster.dm) throw new KurultayError('A direct message has no key to rotate')
    await this.rollKey(g)
    this.system(groupId, `${this.name} rotated the group key — epoch ${g.epoch}`)
    this.changed('key-rotated')
  }

  /**
   * The one rekey path shared by removal and manual rotation, so both keep the same guarantees: a fresh random key at
   * epoch+1, the old key kept 120 s for messages already in flight, and the new key delivered privately to every other
   * member's inbox (`alsoSend` lets removal ship its `removed` notice in the same batch).
   */
  private async rollKey(g: GroupState, alsoSend: readonly Promise<unknown>[] = []) {
    g.prevKey = { epoch: g.epoch, key: g.key, until: now() + 120 }
    g.epoch++
    g.key = randomHex(32)
    g.rotatedAt = now()
    this.resubscribe()
    await Promise.all([
      ...alsoSend,
      ...Object.values(g.roster.members)
        .filter((x) => x.pubkey !== this.pubkey)
        .map((x) => this.sendInbox(x.pubkey, x.inbox, { type: 'key', groupId: g.id, relays: g.relays, epoch: g.epoch, key: g.key, roster: g.roster })),
    ])
  }

  async moderate(groupId: string, action: 'pause' | 'resume' | 'mute' | 'unmute' | 'promote' | 'allow-agents' | 'deny-agents', target?: string) {
    const g = this.state.groups[groupId]
    if (!g || !this.isAdmin(groupId)) throw new KurultayError('Only admins can moderate')
    const r = g.roster
    if (action === 'pause') r.paused = true
    if (action === 'resume') r.paused = false
    if (action === 'allow-agents') r.allowMemberAgents = true
    if (action === 'deny-agents') r.allowMemberAgents = false
    if (action === 'mute' && target && !r.muted.includes(target)) r.muted.push(target)
    if (action === 'unmute' && target) r.muted = r.muted.filter((x) => x !== target)
    if (action === 'promote' && target && r.members[target] && !r.admins.includes(target)) {
      r.admins.push(target)
      r.members[target].role = 'admin'
    }
    r.version++
    await this.sendGroup(groupId, { type: 'state', roster: r, epoch: g.epoch })
    const who = target ? r.members[target]?.name ?? target.slice(0, 8) : ''
    this.system(groupId, { pause: 'Agents paused by moderator', resume: 'Agents resumed', mute: `${who} muted`, unmute: `${who} unmuted`, promote: `${who} is now an admin`, 'allow-agents': 'Members may now bring their own agents', 'deny-agents': 'Members can no longer bring their own agents' }[action])
  }

  async leave(groupId: string) {
    const g = this.state.groups[groupId]
    if (!g) return
    if (Object.keys(g.roster.members).length > 1) await this.sendGroup(groupId, { type: 'leave' }).catch(() => {})
    delete this.state.groups[groupId]
    this.resubscribe()
    this.changed('left')
  }

  /** Admin: change the name a member goes by (kept unique within the group). */
  async renameMember(groupId: string, pubkey: string, name: string) {
    const g = this.state.groups[groupId]
    if (!g || !this.isAdmin(groupId)) throw new KurultayError('Only admins can rename members')
    const m = g.roster.members[pubkey]
    const clean = cleanName(name)
    if (!m || !clean) throw new KurultayError('Names may use letters, digits and _ # . - (no spaces)')
    const next = this.uniqueName(g, clean, pubkey)
    if (next === m.name) return
    const old = m.name
    m.name = next
    g.roster.version++
    await this.sendGroup(groupId, { type: 'state', roster: g.roster, epoch: g.epoch })
    this.system(groupId, `${old} is now ${next}`)
    this.changed('renamed-member')
  }

  /** Go by a new name everywhere: rename myself where I'm admin, ask the admins elsewhere. */
  private useName(name: string) {
    this.name = name
    this.card = { ...this.card, name }
    this.renameAsked = {}
    for (const g of Object.values(this.state.groups)) this.keepName(g)
    this.changed('name')
    this.beacon()
  }

  async renameGroup(groupId: string, name: string) {
    const g = this.state.groups[groupId]
    if (!g || !this.isAdmin(groupId)) throw new KurultayError('Only admins can rename')
    g.roster.name = name
    g.roster.version++
    await this.sendGroup(groupId, { type: 'state', roster: g.roster, epoch: g.epoch })
    this.changed('renamed')
  }

  private syncAll() {
    for (const g of Object.values(this.state.groups)) {
      for (const admin of g.roster.admins) {
        if (admin === this.pubkey) continue
        const m = g.roster.members[admin]
        if (m) void this.sendInbox(admin, m.inbox, { type: 'sync_req', groupId: g.id, epoch: g.epoch })
      }
    }
  }

  private beacon() {
    this.lastPresence = Date.now()
    const att = this.state.owner?.attestation
    for (const id of Object.keys(this.state.groups)) {
      void this.sendGroup(id, { type: 'presence', status: 'online', card: this.card, attestation: att }).catch(() => {})
    }
  }

  setCard(card: Partial<Card>) {
    this.card = { ...this.card, ...card, kind: this.kind }
    this.beacon()
  }

  // ------------------------------------------------------------------ agent tickets

  /**
   * Mint a one-command ticket that seats this person's agents (one identity per host type) in the given councils.
   * The ticket is a secret: it contains the seed every agent key is derived from.
   */
  createTicket(groupIds: string[], opts: { hosts?: string[] } = {}): string {
    if (this.kind !== 'human') throw new KurultayError('Only people can create agent tickets')
    // one seed per person: every ticket yields the same agent identities, so running it again never adds duplicates
    let seed = (this.state.agentSeed ??= randomHex(32))
    // an admin removed one of these identities somewhere: start over with fresh ones (the old ticket stays dead there)
    const removed = new Set(Object.values(this.state.groups).flatMap((g) => g.roster.removed ?? []))
    if (AGENT_HOSTS.some((host) => removed.has(deriveAgent(seed, host).pk))) seed = this.state.agentSeed = randomHex(32)
    const ticketId = randomHex(6)
    const agents = AGENT_HOSTS.map((host) => ({ host, ...deriveAgent(seed, host) }))
    const att = attestMany(this.sk, agents.map((a) => ({ pk: a.pk, label: a.host })), this.name)
    const groups = groupIds
      .map((id) => this.state.groups[id])
      .filter(Boolean)
      .map((g) => ({
        groupId: g.id,
        name: g.roster.name,
        relays: g.relays,
        admins: g.roster.admins.map((pk) => ({ pubkey: pk, inbox: g.roster.members[pk]?.inbox })).filter((a): a is { pubkey: string; inbox: string } => !!a.inbox),
      }))
    const tickets = (this.state.tickets ??= {})
    tickets[ticketId] = { ticketId, createdAt: now(), groups: groups.map((g) => g.groupId), agents: Object.fromEntries(agents.map((a) => [a.pk, a.host])) }
    // recognise these agents as mine: approvals they request for other councils come here
    for (const a of agents) this.state.agents[a.pk] = { pubkey: a.pk, label: a.host, inbox: a.inbox, attestation: att, pairedAt: now() }
    this.changed('ticket')
    const ticket: AgentTicket = { t: 'ticket', v: 1, id: ticketId, seed, owner: { pubkey: this.pubkey, name: this.name, inbox: this.state.inbox, relays: this.baseRelays }, att, groups, hosts: opts.hosts?.length ? opts.hosts : undefined }
    return encodeTicket(ticket)
  }

  /** Agents of a ticket that have taken a seat somewhere (for the app's live status). */
  ticketProgress(ticketId: string) {
    const t = this.state.tickets?.[ticketId]
    if (!t) return []
    const out: { pubkey: string; host: string; name: string; groupId: string }[] = []
    for (const gid of t.groups) {
      const g = this.state.groups[gid]
      if (!g) continue
      for (const pk of Object.keys(t.agents)) if (g.roster.members[pk]) out.push({ pubkey: pk, host: t.agents[pk], name: g.roster.members[pk].name, groupId: gid })
    }
    return out
  }

  /** Build the starting identity and state for one host of a ticket (used by the CLI). */
  static fromTicket(ticket: AgentTicket, host: string, existing?: State | null): { sk: Uint8Array; pubkey: string; state: State } {
    const a = deriveAgent(ticket.seed, host)
    const state: State = existing && existing.inbox === a.inbox ? existing : { ...emptyState(), inbox: a.inbox }
    state.owner = { pubkey: ticket.owner.pubkey, name: ticket.owner.name, inbox: ticket.owner.inbox, relays: ticket.owner.relays, attestation: ticket.att }
    for (const g of ticket.groups) {
      if (state.groups[g.groupId] || !g.admins.length) continue
      if (Object.values(state.pendingJoins).some((p) => p.link.groupId === g.groupId)) continue
      const reqId = randomHex(8)
      state.pendingJoins[reqId] = {
        reqId,
        via: 'ticket',
        admins: g.admins,
        status: 'awaiting-admin',
        createdAt: now(),
        link: { t: 'invite', groupId: g.groupId, name: g.name, relays: g.relays, admin: g.admins[0].pubkey, adminInbox: g.admins[0].inbox, inviteId: '', secret: '', expiresAt: now() + 30 * 86400 },
      }
    }
    return { sk: a.sk, pubkey: a.pk, state }
  }

  // ------------------------------------------------------------------ agent settings

  /** Owner: choose what one of my agents may do when it answers on its own. */
  async setAgentMode(agentPk: string, mode: AgentMode) {
    const a = this.state.agents[agentPk]
    if (!a) throw new KurultayError('Not one of your agents')
    ;(this.state.agentModes ??= {})[agentPk] = mode
    this.changed('agent-mode')
    await this.sendAgentSettings(agentPk)
  }

  /** Owner: rename one of my agents. It takes the name in every council it sits in. */
  renameAgent(agentPk: string, name: string) {
    return this.setAgentProfile(agentPk, { name })
  }

  /**
   * Owner: set an agent's name, picture and standing instructions. They reach the agent privately (like its permission)
   * and are re-sent whenever it reports an older copy. A field left out is unchanged; `null` clears it.
   * Everything is validated before anything is stored, so a rejected field never leaves a half-applied profile.
   */
  async setAgentProfile(agentPk: string, profile: { name?: string; avatar?: string | null; instructions?: string | null }) {
    if (!this.state.agents[agentPk]) throw new KurultayError('Not one of your agents')
    const name = profile.name === undefined ? undefined : cleanName(profile.name)
    if (name === null) throw new KurultayError('Names may use letters, digits and _ # . - (no spaces)')
    const avatar = profile.avatar == null ? undefined : cleanAvatar(profile.avatar)
    if (profile.avatar != null && !avatar) throw new KurultayError('The picture must be a small PNG, JPEG or WebP data URL')
    if (name) (this.state.agentNames ??= {})[agentPk] = name
    if (profile.avatar !== undefined) this.state.agentAvatars = withEntry(this.state.agentAvatars, agentPk, avatar)
    if (profile.instructions !== undefined) this.state.agentInstructions = withEntry(this.state.agentInstructions, agentPk, cleanInstructions(profile.instructions))
    this.changed('agent-profile')
    await this.sendAgentSettings(agentPk)
  }

  private async sendAgentSettings(agentPk: string) {
    const a = this.state.agents[agentPk]
    if (!a) return
    const mode = this.state.agentModes?.[agentPk] ?? this.state.agentStatus?.[agentPk]?.mode ?? DEFAULT_AGENT_MODE
    await this.sendInbox(agentPk, a.inbox, { type: 'agent_settings', mode, name: this.state.agentNames?.[agentPk], avatar: this.state.agentAvatars?.[agentPk], instructions: this.state.agentInstructions?.[agentPk] })
  }

  /** Agent: the permission my owner set (talk only until told otherwise). */
  get agentMode(): AgentMode {
    return this.state.agentSettings?.mode ?? DEFAULT_AGENT_MODE
  }

  /** Agent: tell my owner (privately) where I work and what I'm doing. */
  async reportStatus(status: Omit<AgentStatus, 'at' | 'mode'>) {
    const o = this.state.owner
    if (!o?.attestation) return
    await this.sendInbox(o.pubkey, o.inbox, { type: 'agent_status', status: { ...status, mode: this.agentMode, name: this.name, profile: profileRev(this.state.agentSettings?.avatar, this.state.agentSettings?.instructions) } })
  }

  // ------------------------------------------------------------------ pairing

  createPairCode(label?: string, ttlSeconds = 900): string {
    const pairId = randomHex(8)
    const secret = randomHex(16)
    const expiresAt = now() + ttlSeconds
    this.state.pairOffers[pairId] = { pairId, secret, label, expiresAt }
    this.changed('pair-offer')
    const link: PairLink = { t: 'pair', owner: this.pubkey, name: this.name, inbox: this.state.inbox, relays: this.baseRelays, pairId, secret, expiresAt }
    return encodePair(link)
  }

  private async pairWith(link: PairLink) {
    if (this.kind !== 'agent') throw new KurultayError('Only agents pair with an owner')
    this.state.owner = { pubkey: link.owner, name: link.name, inbox: link.inbox, relays: link.relays, pending: { pairId: link.pairId, secret: link.secret } }
    this.pool.setRelays(this.allRelays())
    await this.sendPairReq()
    this.changed('pairing')
    return { kind: 'pair' as const, status: 'awaiting-owner', name: link.name }
  }

  private async sendPairReq() {
    const o = this.state.owner
    if (!o?.pending) return
    await this.sendInbox(o.pubkey, o.inbox, { type: 'pair_req', pairId: o.pending.pairId, secret: o.pending.secret, label: this.name, client: this.card.client, inbox: this.state.inbox })
  }

  async unpairAgent(pubkey: string) {
    delete this.state.agents[pubkey]
    this.changed('unpaired')
  }

  // ------------------------------------------------------------------ views

  groups() {
    return Object.values(this.state.groups).sort((a, b) => (b.history.at(-1)?.ts ?? b.joinedAt) - (a.history.at(-1)?.ts ?? a.joinedAt))
  }

  member(groupId: string, pubkey: string): MemberView | undefined {
    const g = this.state.groups[groupId]
    const m = g?.roster.members[pubkey]
    if (!g || !m) return undefined
    const att = checkAttestation(m.attestation, pubkey)
    const isMe = pubkey === this.pubkey
    return {
      pubkey,
      name: m.name,
      kind: m.kind,
      role: g.roster.admins.includes(pubkey) ? 'admin' : 'member',
      online: isMe ? this.started : now() - (g.presence[pubkey] ?? 0) < ONLINE_WINDOW,
      isMe,
      muted: g.roster.muted.includes(pubkey),
      card: g.cards[pubkey],
      verified: att ? { owner: att.owner, ownerName: att.ownerName, label: att.label } : null,
    }
  }

  members(groupId: string): MemberView[] {
    const g = this.state.groups[groupId]
    if (!g) return []
    return Object.keys(g.roster.members)
      .map((pk) => this.member(groupId, pk)!)
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
  }

  displayName(groupId: string, pubkey: string) {
    if (!pubkey) return 'kurultay'
    const v = this.member(groupId, pubkey)
    if (!v) return pubkey.slice(0, 8)
    return v.name
  }
}
