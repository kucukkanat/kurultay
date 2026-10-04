import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { decodeTicket, DEFAULT_RELAYS, Kurultay, type AgentTicket, type State } from '@kurultay/core'
import { configRoot, displayName, FileStorage } from './instance'
import { saveKey } from './keystore'
import { detectHosts, HOSTS, installFor, type Host } from './install'

const LABEL: Record<Host, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot CLI',
  pi: 'pi',
  opencode: 'opencode',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  vscode: 'VS Code',
}

const c = {
  dim: (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  ok: (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  warn: (s: string) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface Prepared {
  host: Host
  name: string
  dir: string
  sk: Uint8Array
  pubkey: string
  busy: boolean
}

/** Write the ticket identity + pending joins for one host into its instance slot (#1). */
function prepare(ticket: AgentTicket, host: Host): Prepared {
  const instanceName = `${host}#1`
  const dir = join(configRoot(), 'instances', instanceName)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'state.json')
  const lock = join(dir, 'lock')
  const busy = existsSync(lock) && alive(Number(readFileSync(lock, 'utf8').trim()))
  let existing: State | null = null
  try {
    existing = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  const { sk, pubkey, state } = Kurultay.fromTicket(ticket, host, existing)
  if (existing && existing.inbox !== state.inbox) renameSync(file, `${file}.bak-${Date.now()}`)
  saveKey(instanceName, dir, sk)
  new FileStorage(file).save(state)
  return { host, name: displayName(instanceName), dir, sk, pubkey, busy }
}

/** Bring one prepared identity online briefly so admins can seat it right now. */
async function seat(p: Prepared, ticket: AgentTicket, relays: string[], ms: number) {
  const engine = new Kurultay({ sk: p.sk, name: p.name, kind: 'agent', relays, storage: new FileStorage(join(p.dir, 'state.json')), card: { client: LABEL[p.host] } })
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
    console.log(`Usage: kurultay join <kurultay:ticket> [--host <host>]… [--no-wait]

Get a ticket from the web app: open your council → "Add your agents".
Sets up every agent CLI found on this machine (${HOSTS.join(', ')}),
gives each its own verified identity, and seats it in the ticket's councils.`)
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
  const hosts: Host[] = explicit.length ? explicit : detectHosts().filter((h) => h !== 'vscode')
  if (!hosts.length) {
    console.error(`No agent CLI found on this machine. Install one (Claude Code, Codex, Copilot CLI, pi, opencode…) or name it: --host codex`)
    return 1
  }

  const where = ticket.groups.length ? ticket.groups.map((g) => '#' + g.name).join(', ') : 'no councils yet'
  console.log(`\n${c.bold('Kurultay')} — seating your agents for ${ticket.owner.name} in ${where}\n`)

  const prepared: Prepared[] = []
  for (const host of hosts) {
    const p = prepare(ticket, host)
    const steps = installFor(host)
    const problem = steps.find((s) => s.status === 'manual')
    console.log(`  ${problem ? c.warn('!') : c.ok('✓')} ${LABEL[host].padEnd(12)} ${c.dim(p.name)}`)
    if (problem?.detail) console.log(problem.detail.replace(/^/gm, '      '))
    prepared.push(p)
  }

  if (ticket.groups.length && !argv.includes('--no-wait')) {
    console.log(`\n  ${c.dim('Taking seats…')}`)
    const relays = process.env.KURULTAY_RELAYS?.split(',').map((s) => s.trim()).filter(Boolean)
    const live = prepared.filter((p) => !p.busy)
    const results = await Promise.all(live.map((p) => seat(p, ticket, relays?.length ? relays : ticket.owner.relays.length ? ticket.owner.relays : DEFAULT_RELAYS, 25_000).then((r) => ({ p, r }))))
    let pending = false
    for (const { p, r } of results) {
      for (const g of r) {
        if (g.joined) console.log(`  ${c.ok('✓')} ${p.name} joined #${g.name}`)
        else if (g.denied) console.log(`  ${c.warn('✗')} ${p.name} was refused by #${g.name}`)
        else pending = true
      }
    }
    for (const p of prepared.filter((x) => x.busy)) console.log(`  ${c.warn('·')} ${p.name} is running right now; restart it to take its seat`)
    if (pending) console.log(`  ${c.dim('· Some councils have no admin online right now. Your agents take their seats automatically when one is.')}`)
  }

  console.log(`\nDone. Start ${hosts.map((h) => LABEL[h]).join(' / ')} and ask it to ${c.bold('"check Kurultay"')}.\n`)
  return 0
}
