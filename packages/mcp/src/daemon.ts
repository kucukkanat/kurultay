import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DAEMON_PORT, decodeTicket, DEFAULT_RELAYS, formatBytes, getPublicKey, Kurultay, type AgentMode, type AgentTicket, type DaemonAgentInfo, type DaemonSeatRequest, type DaemonSeatResult, type DaemonSnapshot, type FileRef, type Message } from '@kurultay/core'
import { extractAttachments, inboxDir, saveFiles, uploadPaths } from './attach'
import { defaultOrigins, startControl, type Control, type ControlApi } from './control'
import { blossomFromEnv, configRoot, displayName, FileStorage } from './instance'
import { deleteKey, loadOrCreateKey } from './keystore'
import { answerThread, buildPrompt, cleanAnswer, HEADLESS_HOSTS, headlessCommand, type Incoming } from './headless'
import { detectHosts, HOSTS, type Host } from './install'
import { serveIpc } from './ipc'
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
    const typing = setInterval(() => groups.forEach((g) => void e.typing(g, true).catch(() => {})), 20_000)
    groups.forEach((g) => void e.typing(g, true).catch(() => {}))

    const outFile = join(tmpdir(), `kurultay-${process.pid}-${Date.now()}.txt`)
    const prompt = buildPrompt(e, incoming, mode, this.entry.workdir)
    const cmd = headlessCommand(this.entry.host, mode, prompt, this.entry.workdir, outFile)!
    log(this.instance, `answering ${incoming.length} message(s) with ${cmd.cmd} (${mode}) in ${this.entry.workdir}`)
    let answer: string
    try {
      const out = await runCommand(cmd.cmd, cmd.args, this.entry.workdir, cmd.env, (c) => (this.child = c))
      answer = cleanAnswer(cmd.outputFile && existsSync(cmd.outputFile) ? readFileSync(cmd.outputFile, 'utf8') : out)
    } finally {
      this.child = undefined
      clearInterval(typing)
      groups.forEach((g) => void e.typing(g, false).catch(() => {}))
      if (existsSync(outFile)) rmSync(outFile, { force: true })
    }
    if (!answer) throw new Error(`${cmd.cmd} returned no answer`)
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
    answer = [text, ...notes].filter(Boolean).join('\n') || (files?.length ? '' : answer)

    for (const m of tasks) await e.updateTask(m.groupId, m.taskId!, 'done', answer).catch(() => {})
    for (const gid of groups) {
      const chats = incoming.filter((m) => m.groupId === gid && m.type === 'chat')
      if (!chats.length) continue
      const askers = [...new Set(chats.map((m) => m.from))]
      const last = chats[chats.length - 1]
      const lead = askers.map((a) => '@' + a).join(' ')
      await e.send(gid, answer.startsWith('@') ? answer : `${lead} ${answer}`.trim(), { thread: answerThread(e.state.groups[gid]?.history ?? [], last.id), files })
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

function runCommand(cmd: string, args: string[], cwd: string, env: Record<string, string> | undefined, started: (c: ChildProcess) => void): Promise<string> {
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
      reject(new Error(`${cmd} not found or failed to start (${(e as Error).message})`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || out.trim()) resolve(out)
      else reject(new Error(`${cmd} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`))
    })
  })
}

const portFile = () => join(configRoot(), 'daemon.port')
const isHost = (h: string): h is Host => (HOSTS as readonly string[]).includes(h) && h !== 'vscode'

export async function runDaemon() {
  writePid()
  const agents = new Map<string, BackgroundAgent>()
  const relaysEnv = process.env.KURULTAY_RELAYS?.split(',').map((s) => s.trim()).filter(Boolean)
  const pairing = createPairing(join(configRoot(), 'pairings.json'))
  // stopped from the app: engines are down but the control server stays up, so the app can start them again
  let paused = false

  async function stopAgent(instance: string, reason: string) {
    const a = agents.get(instance)
    if (!a) return
    a.cancel(reason)
    agents.delete(instance)
    await a.engine.stop().catch(() => {})
  }

  async function load() {
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
    if (paused) return Object.entries(readRegistry()).map(([instance, e]) => ({ instance, pubkey: '', name: displayName(instance), host: e.host, workdir: e.workdir, mode: 'off', online: false, running: false, councils: [], groupIds: [] }))
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
    writeRegistry({ ...reg, ...Object.fromEntries(seated.map(({ prepared: p }) => [p.instance, { host: p.host, workdir, addedAt: reg[p.instance]?.addedAt ?? Date.now() }])) })
    await load()
    log('seated from the app:', seated.map((s) => s.prepared.name).join(', '), 'in', workdir)
    return { agents: seated.map(({ prepared: p }) => ({ instance: p.instance, name: p.name, host: p.host })) }
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
    async pause() {
      paused = true
      for (const instance of [...agents.keys()]) await stopAgent(instance, 'stopped from the app')
      log('agents stopped from the app')
    },
    async resume() {
      paused = false
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
    agents: () => ({ pid: process.pid, version: VERSION, agents: agentInfo() }),
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
