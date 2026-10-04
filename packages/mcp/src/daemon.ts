import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RELAYS, getPublicKey, Kurultay } from '@kurultay/core'
import { configRoot, displayName, FileStorage } from './instance'
import { loadOrCreateKey } from './keystore'
import { buildPrompt, cleanAnswer, HEADLESS_HOSTS, headlessCommand, type Incoming } from './headless'
import { serveIpc } from './ipc'
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
  mkdirSync(configRoot(), { recursive: true })
  writeFileSync(registryFile(), JSON.stringify(r, null, 2))
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

  constructor(
    public instance: string,
    public entry: RegistryEntry,
    engine: Kurultay,
  ) {
    this.rt = new AgentRuntime(engine, { dir: join(configRoot(), 'instances', instance), workdir: entry.workdir, background: true })
    this.rt.onDelivered((d) => this.onDelivered(d))
    engine.on('settings', () => {
      log(instance, 'permission set to', engine.agentMode)
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

  private async turn(batch: Delivered[]) {
    const e = this.engine
    const mode = e.agentMode
    const incoming: Incoming[] = batch.map((d) => ({ groupId: d.group, id: d.id, from: d.from, type: d.type as Incoming['type'], text: d.text, taskId: d.task_id }))
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
      const out = await runCommand(cmd.cmd, cmd.args, this.entry.workdir, cmd.env)
      answer = cleanAnswer(cmd.outputFile && existsSync(cmd.outputFile) ? readFileSync(cmd.outputFile, 'utf8') : out)
    } finally {
      clearInterval(typing)
      groups.forEach((g) => void e.typing(g, false).catch(() => {}))
      if (existsSync(outFile)) rmSync(outFile, { force: true })
    }
    if (!answer) throw new Error(`${cmd.cmd} returned no answer`)

    for (const m of tasks) await e.updateTask(m.groupId, m.taskId!, 'done', answer).catch(() => {})
    for (const gid of groups) {
      const chats = incoming.filter((m) => m.groupId === gid && m.type === 'chat')
      if (!chats.length) continue
      const askers = [...new Set(chats.map((m) => m.from))]
      const last = chats[chats.length - 1]
      const lead = askers.map((a) => '@' + a).join(' ')
      await e.send(gid, answer.startsWith('@') ? answer : `${lead} ${answer}`, { thread: last.id })
    }
  }
}

function runCommand(cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env, KURULTAY_BACKGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT)
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

export async function runDaemon() {
  writePid()
  const agents = new Map<string, BackgroundAgent>()
  const relaysEnv = process.env.KURULTAY_RELAYS?.split(',').map((s) => s.trim()).filter(Boolean)

  async function load() {
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
      const engine = new Kurultay({ sk: key.sk, name: displayName(instance), kind: 'agent', relays: relaysEnv?.length ? relaysEnv : DEFAULT_RELAYS, storage: new FileStorage(join(dir, 'state.json'), pk), card: { client: `${entry.host} (background)` } })
      if (process.env.KURULTAY_DEBUG) engine.on('frame', (f) => log(instance, f.dir, new URL(f.relay).host, JSON.stringify(f.data).slice(0, 140)))
      const agent = new BackgroundAgent(instance, entry, engine)
      agents.set(instance, agent)
      await engine.start()
      log('online:', engine.name, 'folder', entry.workdir, 'permission', engine.agentMode)
      setTimeout(() => void agent.report(), 3000)
    }
    for (const [instance, a] of agents) {
      if (!reg[instance]) {
        await a.engine.stop()
        agents.delete(instance)
      }
    }
  }

  await load()
  // re-report every 5 minutes so the owner's app stays current
  setInterval(() => agents.forEach((a) => void a.report()), 5 * 60_000)

  const srv = serveIpc({
    agents: () => ({
      pid: process.pid,
      version: VERSION,
      agents: [...agents.values()].map((a) => ({
        instance: a.instance,
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
      })),
    }),
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
    async post(path) {
      if (path === '/reload') {
        await load()
        return { ok: true, agents: agents.size }
      }
      if (path === '/stop') {
        setTimeout(() => shutdown(), 100)
        return { ok: true }
      }
      throw new Error('unknown')
    },
  })

  const shutdown = async () => {
    srv.close()
    await Promise.all([...agents.values()].map((a) => a.engine.stop().catch(() => {})))
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  log(`kurultay daemon ${VERSION} running with ${agents.size} agent(s)`)
}

/** Instances with a ticket identity on disk (for `kurultay status`). */
export function knownInstances() {
  try {
    return readdirSync(join(configRoot(), 'instances'))
  } catch {
    return []
  }
}
