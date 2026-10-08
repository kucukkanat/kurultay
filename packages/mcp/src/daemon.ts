import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { DAEMON_PORT, decodeTicket, DEFAULT_RELAYS, EMPTY_SANDBOX_GRANTS, formatBytes, getPublicKey, Kurultay, type AgentMode, type AgentTicket, type DaemonAgentInfo, type DaemonSeatRequest, type DaemonSeatResult, type DaemonSnapshot, type FileRef, type Message, type SandboxAvailability, type SandboxConfig, type SandboxViolation } from '@kurultay/core'
import { extractAttachments, inboxDir, saveFiles, uploadPaths } from './attach'
import { defaultOrigins, startControl, type Control, type ControlApi } from './control'
import { blossomFromEnv, configRoot, displayName, FileStorage } from './instance'
import { deleteKey, loadOrCreateKey } from './keystore'
import { applyBoardBlocks, freshBoard, takeBoardBlocks } from './board-ops'
import { answerThread, buildPrompt, cleanAnswer, HEADLESS_HOSTS, headlessCommand, type Incoming } from './headless'
import { detectHosts, HOSTS, type Host } from './install'
import { serveIpc } from './ipc'
import { mergeViolations, readOutputFile, srtBackend, startTurn, validateGrants } from './sandbox'
import { createPairing } from './pairing'
import { installedRuntime, LABEL, seatAgents, SeatError, workdirOf } from './seat'
import { writePid } from './service'
import { AgentRuntime, getTools, type Delivered } from './tools'
import { VERSION } from './version'

/** Agents `kurultay join` set up on this machine: instance → host + working folder. */
export interface RegistryEntry {
  host: string
  workdir: string
  addedAt: number
  /** absent: seated by `join` or before sandboxes existed, so it runs unsandboxed until the owner turns it on (D8) */
  sandbox?: SandboxConfig
}

const registryFile = () => join(configRoot(), 'agents.json')

export function readRegistry(): Record<string, RegistryEntry> {
  try {
    return JSON.parse(readFileSync(registryFile(), 'utf8'))
  } catch {
    return {}
  }
}

export function writeRegistry(r: Record<string, RegistryEntry>) {
  mkdirSync(configRoot(), { recursive: true, mode: 0o700 })
  writeFileSync(registryFile(), JSON.stringify(r, null, 2), { mode: 0o600 })
  chmodSync(registryFile(), 0o600)
}

const INTERACTIVE_GRACE = 10 * 60_000
const RUNS_PER_HOUR = 30
const RUN_TIMEOUT = 10 * 60_000
const MAX_VIOLATIONS = 20
/** D34: the council learns that something was blocked, never what (paths and hosts would map the owner's machine) */
export const BLOCKED_NOTE = 'I couldn’t finish: my sandbox blocked something I needed. My owner can see what.'
export const fellBackNote = (reason: string) => `(I ran without my sandbox this time: ${reason.replace(/\.$/, '')}.)`

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

class BackgroundAgent {
  rt: AgentRuntime
  running = false
  lastRun?: number
  lastError?: string
  private pending: Delivered[] = []
  private timer?: ReturnType<typeof setTimeout>
  private runs: number[] = []
  /** the CLI answering right now: ended when the owner switches the agent off or the service stops */
  child?: ChildProcess
  /** what the sandbox refused in recent turns (one per kind and target, newest first); shown to the owner only */
  lastViolations: SandboxViolation[] = []
  /** the last turn should have been sandboxed but ran without it, and why (D6) */
  fellBack?: string

  constructor(
    public instance: string,
    public entry: RegistryEntry,
    engine: Kurultay,
  ) {
    this.rt = new AgentRuntime(engine, { dir: join(configRoot(), 'instances', instance), workdir: entry.workdir, background: true })
    this.rt.onDelivered((d) => this.onDelivered(d))
    engine.on('settings', () => {
      log(instance, 'permission set to', engine.agentMode)
      if (engine.agentMode === 'off') this.cancel('switched off by the owner')
      void this.report()
    })
  }

  get engine() {
    return this.rt.engine
  }

  get headless() {
    return (HEADLESS_HOSTS as readonly string[]).includes(this.entry.host)
  }

  /** an open CLI session is using this agent right now: let it answer instead */
  get interactive() {
    return this.rt.waiting > 0 || Date.now() - this.rt.lastInteractive < INTERACTIVE_GRACE
  }

  cancel(reason: string) {
    if (!this.child) return
    log(this.instance, 'ending the running turn:', reason)
    endChild(this.child)
  }

  report() {
    return this.engine
      .reportStatus({ host: this.entry.host, workdir: this.entry.workdir, background: true, headless: this.headless, running: this.running, lastRun: this.lastRun, lastError: this.lastError })
      .catch(() => {})
  }

  private onDelivered(d: Delivered) {
    if (d.type !== 'chat' && d.type !== 'task') return
    if (this.engine.agentMode === 'off' || !this.headless || this.interactive) return
    this.pending.push(d)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.drain(), 1500)
  }

  private async drain() {
    if (this.running || !this.pending.length) return
    const t = Date.now()
    this.runs = this.runs.filter((x) => x > t - 3600_000)
    if (this.runs.length >= RUNS_PER_HOUR) {
      this.lastError = 'hourly limit reached'
      // pick the queue up again once the oldest run leaves the window
      clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.drain(), this.runs[0] + 3600_000 - t + 1000)
      return
    }
    const batch = this.pending.splice(0)
    // these are handled here, not by a later interactive `wait`
    this.rt.take((q) => batch.some((b) => b.id === q.id))
    this.runs.push(t)
    this.running = true
    void this.report()
    try {
      await this.turn(batch)
      this.lastError = undefined
    } catch (err) {
      this.lastError = (err as Error).message
      log(this.instance, 'turn failed:', this.lastError)
    } finally {
      this.running = false
      this.lastRun = Math.floor(Date.now() / 1000)
      void this.report()
      if (this.pending.length) void this.drain()
    }
  }

  /** Save a message's attachments where the CLI can read them (not in talk-only mode). */
  private async fetchFiles(m: Message, mode: AgentMode): Promise<NonNullable<Incoming['files']>> {
    const list = m.files ?? []
    const meta = list.map((f) => ({ name: f.name, size: formatBytes(f.size) }))
    if (mode === 'talk' || mode === 'off') return meta.map((f) => ({ ...f, note: 'not opened: your permission does not include reading files' }))
    try {
      const dir = join(inboxDir(this.entry.workdir), m.id.slice(0, 8))
      const saved = await saveFiles(this.engine, m, dir)
      return meta.map((f, i) => ({ ...f, path: relative(this.entry.workdir, saved[i]?.path ?? '') || undefined }))
    } catch (err) {
      return meta.map((f) => ({ ...f, note: `could not download: ${(err as Error).message}` }))
    }
  }

  private async turn(batch: Delivered[]) {
    const e = this.engine
    const mode = e.agentMode
    const incoming: Incoming[] = []
    for (const d of batch) {
      const m = e.state.groups[d.group]?.history.find((x) => x.id === d.id)
      incoming.push({ groupId: d.group, id: d.id, from: d.from, type: d.type as Incoming['type'], text: d.text, taskId: d.task_id, files: m?.files?.length ? await this.fetchFiles(m, mode) : undefined })
    }
    const groups = [...new Set(incoming.map((m) => m.groupId))]
    const tasks = incoming.filter((m) => m.type === 'task' && m.taskId)
    for (const m of tasks) await e.updateTask(m.groupId, m.taskId!, 'working').catch(() => {})
    // the prompt lists each council's board; one this agent has never seen is asked for while the sandbox starts
    const [turn] = await Promise.all([startTurn({ host: this.entry.host, mode, workdir: this.entry.workdir, config: this.entry.sandbox }), ...groups.map((g) => freshBoard(e, g))])
    // inside the sandbox the CLI may only write its turn folder, so its output file goes there
    const outFile = join(turn.outDir, `kurultay-${process.pid}-${Date.now()}.txt`)
    const prompt = buildPrompt(e, incoming, mode, this.entry.workdir, undefined, turn.promptNote)
    const base = headlessCommand(this.entry.host, mode, prompt, this.entry.workdir, outFile)
    if (!base) {
      turn.finish()
      throw new Error(`${this.entry.host} cannot answer on its own`)
    }
    const cmd = turn.wrap(base)
    const typing = setInterval(() => groups.forEach((g) => void e.typing(g, true).catch(() => {})), 20_000)
    groups.forEach((g) => void e.typing(g, true).catch(() => {}))
    log(this.instance, `answering ${incoming.length} message(s) with ${base.cmd} (${mode}${turn.active ? ', sandboxed' : ''}) in ${this.entry.workdir}`)
    let answer = ''
    let failure: Error | undefined
    let violations: SandboxViolation[] = []
    let board: ReturnType<typeof takeBoardBlocks> = { text: '', ops: [], errors: [] }
    try {
      const out = await runCommand(cmd.cmd, cmd.args, this.entry.workdir, cmd.env, (c) => (this.child = c), base.cmd)
      // a ```board block can be long: take it out before the answer is trimmed to message size
      // never followed through a link: the agent may write the folder the output file is in
      board = takeBoardBlocks(((cmd.outputFile ? readOutputFile(cmd.outputFile) : undefined) ?? out).replace(/\r/g, ''))
      answer = cleanAnswer(board.text)
    } catch (err) {
      // held until the sandbox is read: a blocked turn still tells the council it could not finish (D34)
      failure = err instanceof Error ? err : new Error(String(err))
    } finally {
      this.child = undefined
      clearInterval(typing)
      groups.forEach((g) => void e.typing(g, false).catch(() => {}))
      rmSync(outFile, { force: true })
      violations = turn.finish().violations
    }
    this.fellBack = turn.fellBack
    if (turn.fellBack) log(this.instance, 'sandbox unavailable, ran without it:', turn.fellBack)
    // a rolling list, not the last turn's: a clean turn must not take away the Allow buttons for what an earlier one hit
    if (turn.active) this.lastViolations = mergeViolations(this.lastViolations, violations, MAX_VIOLATIONS)
    for (const v of violations) log(this.instance, `sandbox blocked ${v.kind}: ${v.target}`)
    // drawing on the board is speech, not file access: every mode that answers may draw, each block on one council's board
    const newest = incoming[incoming.length - 1]?.groupId ?? ''
    const boardNotes = await applyBoardBlocks(e, board.ops, groups, newest)
    if (board.errors.length) boardNotes.set(newest, [...board.errors, ...(boardNotes.get(newest) ?? [])])
    /** the answer as one council gets it: with the notes about its own board only */
    const forGroup = (gid: string, text: string) => [text, ...(boardNotes.get(gid) ?? [])].filter(Boolean).join('\n\n')
    if (!answer && !boardNotes.size) {
      if (violations.length) {
        for (const m of tasks) if (m.taskId) await e.updateTask(m.groupId, m.taskId, 'failed', BLOCKED_NOTE).catch(() => {})
        for (const gid of groups) await e.send(gid, BLOCKED_NOTE).catch((err) => log(this.instance, 'could not post the blocked note:', (err as Error).message))
      }
      throw failure ?? new Error(`${base.cmd} returned no answer`)
    }
    // files the agent chose to share: only from inside its working folder, and only when it may read files
    const { text, paths } = extractAttachments(answer)
    let files: FileRef[] | undefined
    const notes: string[] = []
    if (paths.length && (mode === 'talk' || mode === 'off')) notes.push('(I can’t share files with my current permission.)')
    else if (paths.length) {
      files = []
      for (const p of paths) {
        try {
          files.push(...(await uploadPaths(e, [p], this.entry.workdir, this.entry.workdir)))
        } catch (err) {
          notes.push(`(couldn’t attach ${p}: ${(err as Error).message})`)
        }
      }
    }
    if (turn.fellBack) notes.push(fellBackNote(turn.fellBack))
    answer = [text, ...notes].filter(Boolean).join('\n') || (files?.length ? '' : answer)

    for (const m of tasks) if (m.taskId) await e.updateTask(m.groupId, m.taskId, 'done', forGroup(m.groupId, answer)).catch(() => {})
    for (const gid of groups) {
      const chats = incoming.filter((m) => m.groupId === gid && m.type === 'chat')
      const reply = forGroup(gid, answer)
      if (!chats.length || (!reply && !files?.length)) continue
      const askers = [...new Set(chats.map((m) => m.from))]
      const last = chats[chats.length - 1]
      const lead = askers.map((a) => '@' + a).join(' ')
      await e.send(gid, reply.startsWith('@') ? reply : `${lead} ${reply}`.trim(), { thread: answerThread(e.state.groups[gid]?.history ?? [], last.id), files })
      files = undefined // attach once, even when answering several councils
    }
  }
}

/** SIGTERM, then SIGKILL if the CLI ignores it */
function endChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 5000).unref()
}

// `label` names the agent CLI in errors: a sandboxed turn runs the sandbox wrapper, whose name means nothing to the owner
function runCommand(cmd: string, args: string[], cwd: string, env: Record<string, string> | undefined, started: (c: ChildProcess) => void, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // KURULTAY_BACKGROUND tells a Kurultay MCP server inside the CLI not to act for the agent (see server.ts)
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env, KURULTAY_BACKGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    started(child)
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    const timer = setTimeout(() => endChild(child), RUN_TIMEOUT)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`${label} not found or failed to start (${(e as Error).message})`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || out.trim()) resolve(out)
      else reject(new Error(`${label} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`))
    })
  })
}

const portFile = () => join(configRoot(), 'daemon.port')
const pausedFile = () => join(configRoot(), 'paused')

/**
 * A stopped agent as the app lists it. Its engine is down, so the key and the name its owner gave it come from its saved
 * state (`pk` is written there for exactly this kind of check): the app finds its card by pubkey, and without one the
 * folder and Remove controls would vanish until the agents start again. No keychain read, since the app polls this.
 */
export function pausedAgentInfo(instance: string, e: RegistryEntry, dir = join(configRoot(), 'instances', instance)): DaemonAgentInfo {
  const saved = new FileStorage(join(dir, 'state.json')).load()
  return { instance, pubkey: saved?.pk ?? '', name: saved?.agentSettings?.name ?? displayName(instance), host: e.host, workdir: e.workdir, mode: 'off', online: false, running: false, councils: [], groupIds: [], sandbox: e.sandbox && { ...e.sandbox, lastViolations: [] } }
}
const isHost = (h: string): h is Host => (HOSTS as readonly string[]).includes(h) && h !== 'vscode'

export async function runDaemon() {
  writePid()
  const agents = new Map<string, BackgroundAgent>()
  const relaysEnv = process.env.KURULTAY_RELAYS?.split(',').map((s) => s.trim()).filter(Boolean)
  const pairing = createPairing(join(configRoot(), 'pairings.json'))
  // stopped from the app: engines are down but the control server stays up, so the app can start them again. Kept in a
  // file so a launchd/systemd restart (login, crash, update) does not bring back agents the owner stopped
  let paused = existsSync(pausedFile())
  // snapshot() is synchronous: the machine check is cached here and refreshed whenever the agents load
  let availability: SandboxAvailability = { ok: false, reason: 'not checked yet' }

  async function stopAgent(instance: string, reason: string) {
    const a = agents.get(instance)
    if (!a) return
    a.cancel(reason)
    agents.delete(instance)
    await a.engine.stop().catch(() => {})
  }

  async function load() {
    availability = await srtBackend.available()
    if (paused) return
    const reg = readRegistry()
    for (const [instance, entry] of Object.entries(reg)) {
      const dir = join(configRoot(), 'instances', instance)
      if (!existsSync(join(dir, 'state.json'))) continue
      const existing = agents.get(instance)
      const key = loadOrCreateKey(instance, dir)
      const pk = getPublicKey(key.sk)
      if (existing && existing.engine.pubkey === pk) {
        existing.entry = entry
        existing.rt.meta.workdir = entry.workdir
        void existing.report()
        continue
      }
      if (existing) await existing.engine.stop()
      const engine = new Kurultay({ sk: key.sk, name: displayName(instance), kind: 'agent', relays: relaysEnv?.length ? relaysEnv : DEFAULT_RELAYS, storage: new FileStorage(join(dir, 'state.json'), pk), blossom: blossomFromEnv(), card: { client: `${entry.host} (background)` } })
      if (process.env.KURULTAY_DEBUG) engine.on('frame', (f) => log(instance, f.dir, new URL(f.relay).host, JSON.stringify(f.data).slice(0, 140)))
      const agent = new BackgroundAgent(instance, entry, engine)
      agents.set(instance, agent)
      await engine.start()
      log('online:', engine.name, 'folder', entry.workdir, 'permission', engine.agentMode)
      setTimeout(() => void agent.report(), 3000)
    }
    for (const instance of agents.keys()) if (!reg[instance]) await stopAgent(instance, 'removed')
  }

  const agentInfo = (): DaemonAgentInfo[] => {
    // stopped: the engines are gone but the seats are still registered, so the app can list them
    if (paused) return Object.entries(readRegistry()).map(([instance, e]) => pausedAgentInfo(instance, e))
    return [...agents.values()].map((a) => ({
      instance: a.instance,
      pubkey: a.engine.pubkey,
      name: a.engine.name,
      host: a.entry.host,
      workdir: a.entry.workdir,
      mode: a.engine.agentMode,
      online: a.engine.pool.relays.some((r) => r.status === 'open'),
      running: a.running,
      lastRun: a.lastRun ? new Date(a.lastRun * 1000).toISOString() : undefined,
      lastError: a.lastError,
      councils: a.engine.groups().map((g) => g.roster.name),
      groupIds: a.engine.groups().map((g) => g.id),
      sandbox: a.entry.sandbox && { ...a.entry.sandbox, lastViolations: a.lastViolations, fellBack: a.fellBack },
    }))
  }

  const snapshot = (): DaemonSnapshot => {
    const reg = readRegistry()
    const found = new Set<string>(detectHosts())
    return {
      version: VERSION,
      pid: process.pid,
      paused,
      home: configRoot(),
      agents: agentInfo(),
      hosts: HOSTS.filter(isHost).map((id) => ({ id, label: LABEL[id], detected: found.has(id), seated: Object.values(reg).some((e) => e.host === id) })),
      sandbox: availability,
    }
  }

  const running = () => {
    if (paused) throw new SeatError('paused', 'The agents are stopped. Start them first.')
  }

  async function seat(req: DaemonSeatRequest): Promise<DaemonSeatResult> {
    running()
    let ticket: AgentTicket
    try {
      ticket = decodeTicket(req.ticket)
    } catch (err) {
      throw new SeatError('bad-ticket', (err as Error).message)
    }
    const hosts = [...new Set(req.hosts)].filter(isHost)
    if (!hosts.length) throw new SeatError('no-hosts', 'Pick at least one agent CLI')
    const workdir = workdirOf(req.workdir)
    // a running agent holds this identity's state: stop it before its state is rewritten, load() brings it back
    for (const h of hosts) await stopAgent(`${h}#1`, 'seating again')
    const seated = seatAgents(ticket, hosts, installedRuntime())
    const reg = readRegistry()
    // seating again keeps what the owner already granted; the batch checkbox only switches the sandbox on or off
    const entry = (instance: string, host: string): RegistryEntry => {
      const prev = reg[instance]
      const sandbox = req.sandbox ? { ...EMPTY_SANDBOX_GRANTS, ...prev?.sandbox, enabled: true } : prev?.sandbox && { ...prev.sandbox, enabled: false }
      return { host, workdir, addedAt: prev?.addedAt ?? Date.now(), ...(sandbox ? { sandbox } : {}) }
    }
    writeRegistry({ ...reg, ...Object.fromEntries(seated.map(({ prepared: p }) => [p.instance, entry(p.instance, p.host)])) })
    await load()
    log('seated from the app:', seated.map((s) => s.prepared.name).join(', '), 'in', workdir)
    return { agents: seated.map(({ prepared: p }) => ({ instance: p.instance, name: p.name, host: p.host, pubkey: p.pubkey })) }
  }

  async function removeAgent(instance: string) {
    // leaving is what takes the agent off the member lists; a stopped agent cannot say goodbye
    running()
    const { [instance]: entry, ...rest } = readRegistry()
    if (!entry) throw new SeatError('unknown-agent', `No agent ${instance}`)
    const a = agents.get(instance)
    if (a) for (const g of a.engine.groups().filter((g) => !g.roster.dm)) await a.engine.leave(g.id).catch((err) => log(instance, `could not leave #${g.roster.name}:`, (err as Error).message))
    await stopAgent(instance, 'removed')
    writeRegistry(rest)
    const dir = join(configRoot(), 'instances', instance)
    deleteKey(instance, dir)
    rmSync(dir, { recursive: true, force: true })
    log('removed', instance)
  }

  const api: ControlApi = {
    snapshot,
    seat,
    removeAgent,
    async setWorkdir(instance, workdir) {
      const reg = readRegistry()
      const entry = reg[instance]
      if (!entry) throw new SeatError('unknown-agent', `No agent ${instance}`)
      writeRegistry({ ...reg, [instance]: { ...entry, workdir: workdirOf(workdir) } })
      await load()
    },
    async setSandbox(instance, raw) {
      const reg = readRegistry()
      const entry = reg[instance]
      if (!entry) throw new SeatError('unknown-agent', `No agent ${instance}`)
      const enabled = typeof raw === 'object' && raw !== null && 'enabled' in raw ? raw.enabled : undefined
      const check = validateGrants(raw, { home: homedir(), configRoot: configRoot() })
      const problems = [...(typeof enabled === 'boolean' ? [] : ['enabled must be true or false']), ...(check.ok ? [] : check.errors.map((x) => `${x.field} ${x.value}: ${x.reason}`))]
      if (!check.ok || typeof enabled !== 'boolean') throw new SeatError('not-allowed', `Not allowed: ${problems.join('; ')}`)
      writeRegistry({ ...reg, [instance]: { ...entry, sandbox: { ...check.grants, enabled } } })
      log(instance, `sandbox ${enabled ? 'on' : 'off'}`)
      await load()
    },
    async pause() {
      paused = true
      writeFileSync(pausedFile(), '', { mode: 0o600 })
      for (const instance of [...agents.keys()]) await stopAgent(instance, 'stopped from the app')
      log('agents stopped from the app')
    },
    async resume() {
      paused = false
      rmSync(pausedFile(), { force: true })
      await load()
      log('agents started from the app')
    },
  }

  await load()
  // re-report every 5 minutes so the owner's app stays current
  setInterval(() => agents.forEach((a) => void a.report()), 5 * 60_000)

  let control: Control | undefined
  try {
    control = await startControl(api, pairing, { port: Number(process.env.KURULTAY_PORT ?? DAEMON_PORT), origins: defaultOrigins() })
    writeFileSync(portFile(), String(control.port), { mode: 0o600 })
    log(`control server on http://127.0.0.1:${control.port}`)
  } catch (err) {
    // the agents keep working without the app connection, e.g. when another program holds the port
    log(`control server not started: ${(err as Error).message}`)
  }

  const srv = serveIpc({
    agents: () => ({ pid: process.pid, version: VERSION, paused, agents: agentInfo() }),
    get(path) {
      if (path === '/pair/pending') return { pending: pairing.list(), paired: pairing.pairedCount() }
      throw new Error('unknown')
    },
    async call(instance, tool, args, signal) {
      const a = agents.get(instance)
      if (!a) throw new Error(`No background agent ${instance}`)
      a.rt.lastInteractive = Date.now()
      const t = getTools().find((x) => x.name === tool)
      if (!t) throw new Error(`Unknown tool ${tool}`)
      try {
        const data = await t.run(args, a.engine, { signal }, a.rt)
        return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
      }
    },
    async post(path, body) {
      if (path === '/reload') {
        await load()
        return { ok: true, agents: agents.size }
      }
      if (path === '/stop') {
        setTimeout(() => shutdown(), 100)
        return { ok: true }
      }
      if (path === '/pair/approve') {
        const code = typeof body === 'object' && body !== null && 'code' in body ? String(body.code) : ''
        const r = pairing.approve(code)
        log('paired with', r.origin)
        return { ok: true, origin: r.origin }
      }
      if (path === '/pair/revoke') {
        pairing.revoke()
        log('signed every paired browser out')
        return { ok: true }
      }
      throw new Error('unknown')
    },
  })

  const shutdown = async () => {
    srv.close()
    await control?.close().catch(() => {})
    rmSync(portFile(), { force: true })
    agents.forEach((a) => a.cancel('service stopping'))
    await Promise.all([...agents.values()].map((a) => a.engine.stop().catch(() => {})))
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  log(`kurultay daemon ${VERSION} running with ${agents.size} agent(s)`)
}
