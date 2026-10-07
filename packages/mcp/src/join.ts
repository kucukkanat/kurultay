import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { decodeTicket, DEFAULT_RELAYS, Kurultay, type AgentTicket } from '@kurultay/core'
import { configRoot, FileStorage } from './instance'
import { detectHosts, HOSTS, type Host } from './install'
import { LABEL, seatAgents, type Prepared } from './seat'
import { daemonAgents, daemonPost, daemonStatus } from './ipc'
import { readRegistry, writeRegistry } from './daemon'
import { daemonLog, startService } from './service'

const c = {
  dim: (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  ok: (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  warn: (s: string) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
}

/** Bring one prepared identity online briefly so admins can seat it right now. */
async function seat(p: Prepared, ticket: AgentTicket, relays: string[], ms: number) {
  const engine = new Kurultay({ sk: p.sk, name: p.name, kind: 'agent', relays, storage: new FileStorage(join(p.dir, 'state.json'), p.pubkey), card: { client: LABEL[p.host] } })
  await engine.start()
  const want = ticket.groups.map((g) => g.groupId)
  const done = () => want.every((id) => engine.state.groups[id] || Object.values(engine.state.pendingJoins).some((j) => j.link.groupId === id && j.status === 'denied'))
  const start = Date.now()
  while (!done() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 250))
  const result = ticket.groups.map((g) => ({
    name: g.name,
    joined: !!engine.state.groups[g.groupId],
    denied: Object.values(engine.state.pendingJoins).some((j) => j.link.groupId === g.groupId && j.status === 'denied'),
  }))
  await engine.stop()
  return result
}

export async function runJoin(argv: string[]): Promise<number> {
  const raw = argv.find((a) => a.includes('kurultay:'))
  if (!raw) {
    console.log(`Usage: kurultay join <kurultay:ticket> [--host <host>]… [--no-wait] [--no-background]

Get a ticket from the web app: open your council → "Add your agents".
Sets up the agent CLIs you picked in the app (or --host …), gives each one
its own identity verified as yours, and seats it in the ticket's councils.`)
    return 1
  }
  let ticket: AgentTicket
  try {
    ticket = decodeTicket(raw)
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }
  const explicit = argv.flatMap((a, i) => (a === '--host' && argv[i + 1] ? [argv[i + 1]] : [])).filter((h): h is Host => (HOSTS as readonly string[]).includes(h))
  const chosen = (ticket.hosts ?? []).filter((h): h is Host => (HOSTS as readonly string[]).includes(h))
  const hosts: Host[] = explicit.length ? explicit : chosen.length ? chosen : detectHosts().filter((h) => h !== 'vscode')
  if (!hosts.length) {
    console.error(`No agent CLI found on this machine. Install one (Claude Code, Codex, Copilot CLI, pi, opencode…) or name it: --host codex`)
    return 1
  }
  const missing = hosts.filter((h) => !detectHosts().includes(h) && h !== 'vscode')
  // one local copy of the server, run with this Node: fast starts, no npx cache to go stale, works without PATH tweaks
  const self = fileURLToPath(import.meta.url)
  let runtime: string | undefined
  if (/\.m?js$/.test(self)) {
    runtime = join(configRoot(), 'bin', 'kurultay.mjs')
    mkdirSync(join(configRoot(), 'bin'), { recursive: true })
    if (resolve(self) !== resolve(runtime)) copyFileSync(self, runtime)
  }

  const where = ticket.groups.length ? ticket.groups.map((g) => '#' + g.name).join(', ') : 'no councils yet'
  console.log(`\n${c.bold('Kurultay')} — seating your agents for ${ticket.owner.name} in ${where}\n`)
  const useBackground = !!runtime && !argv.includes('--no-background')
  // the background service owns the agents' state: pause it while we write, restart it afterwards
  if (useBackground && (await daemonAgents())) {
    await daemonPost('/stop').catch(() => {})
    for (let i = 0; i < 30 && (await daemonAgents()); i++) await new Promise((r) => setTimeout(r, 100))
  }

  const prepared: Prepared[] = []
  for (const { prepared: p, steps } of seatAgents(ticket, hosts, runtime)) {
    const problem = steps.find((s) => s.status === 'manual')
    console.log(`  ${problem ? c.warn('!') : c.ok('✓')} ${LABEL[p.host].padEnd(12)} ${c.dim(p.name)}`)
    if (problem?.detail) console.log(problem.detail.replace(/^/gm, '      '))
    const replaced = steps.find((s) => s.what === 'plugin' && s.status === 'written')
    if (replaced) console.log(c.dim(`      ${replaced.detail}`))
    if (missing.includes(p.host)) console.log(c.dim(`      ${LABEL[p.host]} isn't installed here yet; it will pick this up once it is`))
    prepared.push(p)
  }

  const workdir = process.cwd()
  console.log(`\n  Working folder: ${c.bold(workdir)}`)
  console.log(c.dim(`  When tagged, your agents answer from this folder. What they may do here is your call:`))
  console.log(c.dim(`  app → My agents → permission (starts as “Talk only”: no file or command access).`))

  let background: { ok: boolean; kind: string; persistent: boolean; detail?: string } | undefined
  if (useBackground) {
    const reg = readRegistry()
    for (const p of prepared) reg[`${p.host}#1`] = { host: p.host, workdir, addedAt: Date.now() }
    writeRegistry(reg)
    background = startService(runtime!)
    if (background.ok) {
      for (let i = 0; i < 50 && !(await daemonAgents()); i++) await new Promise((r) => setTimeout(r, 200))
    }
  }

  if (ticket.groups.length && !argv.includes('--no-wait')) {
    console.log(`\n  ${c.dim('Taking seats…')}`)
    const want = ticket.groups.map((g) => g.groupId)
    let pending = false
    if (background?.ok && (await daemonAgents())) {
      // the background service is online with these identities: watch it take the seats
      const deadline = Date.now() + 30_000
      let st = await daemonStatus().catch(() => null)
      const seated = () => prepared.every((p) => want.every((id) => (st?.agents.find((a) => a.instance === `${p.host}#1`) as any)?.groupIds?.includes(id)))
      while (!seated() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500))
        st = await daemonStatus().catch(() => st)
      }
      for (const p of prepared) {
        const a = st?.agents.find((x) => x.instance === `${p.host}#1`) as any
        for (const g of ticket.groups) {
          if (a?.groupIds?.includes(g.groupId)) console.log(`  ${c.ok('✓')} ${p.name} joined #${g.name}`)
          else pending = true
        }
      }
    } else {
      const relays = process.env.KURULTAY_RELAYS?.split(',').map((s) => s.trim()).filter(Boolean)
      const results = await Promise.all(prepared.map((p) => seat(p, ticket, relays?.length ? relays : ticket.owner.relays.length ? ticket.owner.relays : DEFAULT_RELAYS, 25_000).then((r) => ({ p, r }))))
      for (const { p, r } of results) {
        for (const g of r) {
          if (g.joined) console.log(`  ${c.ok('✓')} ${p.name} joined #${g.name}`)
          else if (g.denied) console.log(`  ${c.warn('✗')} ${p.name} was refused by #${g.name}`)
          else pending = true
        }
      }
    }
    if (pending) console.log(`  ${c.dim('· Some councils have no admin online right now. Your agents take their seats automatically when one is.')}`)
  }

  if (background?.ok) {
    const how = background.kind === 'launchd' ? 'a login item (launchd)' : background.kind === 'systemd' ? 'a systemd user service' : 'a background process'
    console.log(`\n  ${c.ok('✓')} Running in the background as ${how}: your agents stay online and answer when they're tagged.`)
    if (!background.persistent && background.detail) console.log(c.dim(`    ${background.detail}`))
    const self = `"${process.execPath}" "${runtime}"`
    console.log(c.dim(`    Status: ${self} status`))
    console.log(c.dim(`    Logs:   ${daemonLog()}`))
    console.log(c.dim(`    Stop:   ${self} stop`))
    console.log(`\nDone. Nothing else to run — tag ${prepared.map((p) => '@' + p.name).join(' or ')} in the council.\n`)
  } else {
    if (background && !background.ok) console.log(`\n  ${c.warn('!')} Couldn't start the background service${background.detail ? `: ${background.detail}` : ''}.`)
    console.log(`\nDone. Your agents answer while ${hosts.map((h) => LABEL[h]).join(' / ')} is open; ask it to ${c.bold('"check Kurultay"')}.\n`)
  }
  return 0
}
