import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import skillMd from '../../../plugins/kurultay/skills/kurultay/SKILL.md' with { type: 'text' }

const userHome = () => process.env.HOME || process.env.USERPROFILE || homedir()

const PACKAGE_SPEC = 'github:kucukkanat/kurultay#dist'
const DESCRIPTION = 'Kurultay: encrypted agent-to-agent councils over Nostr'

export const HOSTS = ['claude', 'codex', 'copilot', 'pi', 'opencode', 'cursor', 'gemini', 'vscode'] as const
export type Host = (typeof HOSTS)[number]

interface Opts {
  project: boolean
  print: boolean
  skill: boolean
  cwd: string
  home: string
  /** run a locally installed copy (`node <runtime> mcp`) instead of npx — what `kurultay join` does */
  runtime?: string
  node?: string
  /** uninstall a Kurultay plugin for this host so only one server runs (join) */
  replacePlugin?: boolean
}

/** Opts plus the server command line, resolved once per host */
interface Run extends Opts {
  command: string
  args: string[]
}

interface Step {
  what: string
  path?: string
  status: 'written' | 'unchanged' | 'printed' | 'manual' | 'skipped'
  detail?: string
}

const HOST_DIRS: Record<Host, string[]> = {
  claude: ['.claude'],
  codex: ['.codex'],
  copilot: ['.copilot'],
  pi: ['.pi'],
  opencode: ['.config/opencode'],
  cursor: ['.cursor'],
  gemini: ['.gemini'],
  vscode: [],
}

export function detectHosts(home = userHome()): Host[] {
  return HOSTS.filter((h) => HOST_DIRS[h].some((d) => existsSync(join(home, d))))
}

function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${path} is not plain JSON (comments or trailing commas?). Add the snippet below by hand.`)
  }
}

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Merge `entry` into `obj[key].kurultay` in a JSON config file. */
function mergeJson(path: string, key: string, entry: unknown, o: Opts, extra?: (doc: Record<string, any>) => void): Step {
  const snippet = JSON.stringify({ [key]: { kurultay: entry } }, null, 2)
  if (o.print) return { what: 'MCP server', path, status: 'printed', detail: snippet }
  let doc: Record<string, any>
  try {
    doc = readJson(path)
  } catch (err) {
    return { what: 'MCP server', path, status: 'manual', detail: `${(err as Error).message}\n${snippet}` }
  }
  const before = JSON.stringify(doc)
  extra?.(doc)
  doc[key] = { ...(doc[key] ?? {}), kurultay: entry }
  if (JSON.stringify(doc) === before) return { what: 'MCP server', path, status: 'unchanged' }
  writeFile(path, JSON.stringify(doc, null, 2) + '\n')
  return { what: 'MCP server', path, status: 'written' }
}

function codexToml(o: Run): Step {
  const path = o.project ? join(o.cwd, '.codex/config.toml') : join(o.home, '.codex/config.toml')
  const block = [
    '[mcp_servers.kurultay]',
    `command = ${JSON.stringify(o.command)}`,
    `args = [${o.args.map((a) => JSON.stringify(a)).join(', ')}]`,
    '# wait() long-polls up to 50 s; the first npx start can take a few seconds',
    'startup_timeout_sec = 60',
    'tool_timeout_sec = 120',
    '',
  ].join('\n')
  if (o.print) return { what: 'MCP server', path, status: 'printed', detail: block }
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  // replace an existing [mcp_servers.kurultay] table (up to the next table header) or append
  const re = /^\[mcp_servers\.kurultay\][\s\S]*?(?=^\[(?!mcp_servers\.kurultay\.)|(?![\s\S]))/m
  const next = re.test(current) ? current.replace(re, block) : (current && !current.endsWith('\n') ? current + '\n' : current) + (current ? '\n' : '') + block
  if (next === current) return { what: 'MCP server', path, status: 'unchanged' }
  writeFile(path, next)
  return { what: 'MCP server', path, status: 'written' }
}

function claudeMcp(o: Run): Step {
  const args = ['mcp', 'add', '--scope', o.project ? 'project' : 'user', 'kurultay', '--', o.command, ...o.args]
  const cmd = `claude ${args.map((a) => (/[#\s]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`
  if (o.print) return { what: 'MCP server', status: 'printed', detail: `${cmd}\n\nor install the plugin (MCP server + skill):\n  claude plugin marketplace add kucukkanat/kurultay\n  claude plugin install kurultay@kurultay` }
  // replace any earlier entry (e.g. an npx-based one) so there is exactly one kurultay server
  spawnSync('claude', ['mcp', 'remove', 'kurultay', '--scope', o.project ? 'project' : 'user'], { encoding: 'utf8' })
  const r = spawnSync('claude', args, { encoding: 'utf8' })
  if (r.error) return { what: 'MCP server', status: 'manual', detail: `Claude Code CLI not found. Run:\n  ${cmd}` }
  if (r.status !== 0 && /already exists/i.test(r.stderr + r.stdout)) return { what: 'MCP server', status: 'unchanged', detail: 'kurultay already configured in Claude Code' }
  if (r.status !== 0) return { what: 'MCP server', status: 'manual', detail: `${(r.stderr || r.stdout).trim()}\nRun:\n  ${cmd}` }
  return { what: 'MCP server', status: 'written', detail: o.project ? '.mcp.json (project scope)' : 'Claude Code user scope' }
}

const SKILL_DIRS: Partial<Record<Host, { user: string; project: string }>> = {
  claude: { user: '.claude/skills', project: '.claude/skills' },
  codex: { user: '.codex/skills', project: '.codex/skills' },
  copilot: { user: '.copilot/skills', project: '.github/skills' },
  pi: { user: '.pi/agent/skills', project: '.pi/skills' },
  opencode: { user: '.config/opencode/skills', project: '.opencode/skills' },
}

/** Each host gets the skill in its own folder, so a host never sees it twice. */
function skillPath(host: Host, o: Opts): string | null {
  const d = SKILL_DIRS[host]
  if (!d) return null
  return join(o.project ? o.cwd : o.home, o.project ? d.project : d.user, 'kurultay/SKILL.md')
}

/** Older versions put the skill in the shared ~/.agents/skills, which several hosts read; remove that copy. */
function removeLegacySharedSkill(o: Opts) {
  const p = join(o.project ? o.cwd : o.home, '.agents/skills/kurultay')
  try {
    if (readFileSync(join(p, 'SKILL.md'), 'utf8').includes('name: kurultay')) rmSync(p, { recursive: true, force: true })
  } catch {}
}

function installSkill(host: Host, o: Opts): Step | null {
  if (!o.skill) return null
  const path = skillPath(host, o)
  if (!path) return { what: 'skill', status: 'skipped', detail: `${host} has no Agent Skills folder; the MCP server's built-in instructions cover usage.` }
  if (o.print) return { what: 'skill', path, status: 'printed', detail: `copy SKILL.md to ${path}` }
  removeLegacySharedSkill(o)
  if (existsSync(path) && readFileSync(path, 'utf8') === skillMd) return { what: 'skill', path, status: 'unchanged' }
  writeFile(path, skillMd)
  return { what: 'skill', path, status: 'written' }
}

export function installFor(host: Host, opts: Partial<Opts> = {}): Step[] {
  const base: Opts = { project: false, print: false, skill: true, cwd: process.cwd(), home: userHome(), ...opts }
  // the server gets `--host <host>` so it picks the identity an agent ticket set up for that host
  const o: Run = base.runtime
    ? { ...base, command: base.node || process.execPath, args: [base.runtime, 'mcp', '--host', host] }
    : { ...base, command: 'npx', args: ['-y', PACKAGE_SPEC, 'mcp', '--host', host] }
  const steps: Step[] = []
  if (o.replacePlugin && !o.print) {
    const r = removePlugin(host)
    if (r) steps.push(r)
  }
  return [...steps, ...installForInner(host, o)]
}

const PLUGIN_CLI: Partial<Record<Host, { bin: string; list: string[]; remove: string[] }>> = {
  claude: { bin: 'claude', list: ['plugin', 'list'], remove: ['plugin', 'uninstall', 'kurultay@kurultay'] },
  codex: { bin: 'codex', list: ['plugin', 'list'], remove: ['plugin', 'remove', 'kurultay@kurultay'] },
  copilot: { bin: 'copilot', list: ['plugin', 'list'], remove: ['plugin', 'uninstall', 'kurultay@kurultay'] },
}

/** A Kurultay plugin and a direct config would run two servers (two agents). Keep only the direct one. */
function removePlugin(host: Host): Step | null {
  const c = PLUGIN_CLI[host]
  if (!c) return null
  const list = spawnSync(c.bin, c.list, { encoding: 'utf8', timeout: 30_000 })
  if (list.error || !/kurultay@kurultay/.test((list.stdout || '') + (list.stderr || ''))) return null
  const r = spawnSync(c.bin, c.remove, { encoding: 'utf8', timeout: 60_000 })
  return r.status === 0
    ? { what: 'plugin', status: 'written', detail: 'replaced the kurultay plugin with a direct install (one server, one agent)' }
    : { what: 'plugin', status: 'manual', detail: `Remove the old plugin to avoid a second agent:\n  ${c.bin} ${c.remove.join(' ')}` }
}

/** Claude Code plugin already provides the server (and finds its identity via the client name). */
function claudePluginInstalled(home: string) {
  try {
    return readFileSync(join(home, '.claude/plugins/installed_plugins.json'), 'utf8').includes('kurultay@')
  } catch {
    return false
  }
}

function installForInner(host: Host, o: Run): Step[] {
  const base = o.project ? o.cwd : o.home
  const steps: Step[] = []
  switch (host) {
    case 'claude':
      steps.push(!o.project && claudePluginInstalled(o.home) ? { what: 'MCP server', status: 'unchanged', detail: 'provided by the kurultay Claude Code plugin' } : claudeMcp(o))
      break
    case 'codex':
      steps.push(codexToml(o))
      break
    case 'copilot':
      steps.push(
        mergeJson(o.project ? join(o.cwd, '.mcp.json') : join(o.home, '.copilot/mcp-config.json'), 'mcpServers', { type: 'local', command: o.command, args: o.args, tools: ['*'], timeout: 120000 }, o),
      )
      break
    case 'pi':
      steps.push(mergeJson(o.project ? join(o.cwd, '.pi/mcp.json') : join(o.home, '.pi/agent/mcp.json'), 'mcpServers', { command: o.command, args: o.args, timeout: 120, exposure: 'direct', description: DESCRIPTION }, o))
      break
    case 'opencode':
      steps.push(
        mergeJson(
          o.project ? join(o.cwd, 'opencode.json') : join(o.home, '.config/opencode/opencode.json'),
          'mcp',
          { type: 'local', command: [o.command, ...o.args], enabled: true, timeout: 120000 },
          o,
          (doc) => {
            doc.$schema ??= 'https://opencode.ai/config.json'
          },
        ),
      )
      break
    case 'cursor':
      steps.push(mergeJson(join(base, '.cursor/mcp.json'), 'mcpServers', { command: o.command, args: o.args }, o))
      break
    case 'gemini':
      steps.push(mergeJson(join(base, '.gemini/settings.json'), 'mcpServers', { command: o.command, args: o.args, timeout: 120000 }, o))
      break
    case 'vscode':
      steps.push(mergeJson(join(o.cwd, '.vscode/mcp.json'), 'servers', { type: 'stdio', command: o.command, args: o.args }, o))
      break
  }
  const s = installSkill(host, o)
  if (s) steps.push(s)
  return steps
}

const LABEL: Record<Host, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  copilot: 'GitHub Copilot CLI',
  pi: 'pi',
  opencode: 'opencode',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  vscode: 'VS Code (this folder)',
}

const NEXT: Record<Host, string> = {
  claude: 'Restart Claude Code, then ask: "check my Kurultay status".',
  codex: 'Start codex and run /mcp to confirm kurultay is listed.',
  copilot: 'Start copilot and run /mcp to confirm kurultay is listed.',
  pi: 'Start pi (or /reload) and run /mcp to confirm kurultay is listed.',
  opencode: 'Run `opencode mcp list` to confirm kurultay is listed.',
  cursor: 'Open Cursor settings → MCP to enable kurultay.',
  gemini: 'Start gemini and run /mcp to confirm kurultay is listed.',
  vscode: 'Open .vscode/mcp.json in VS Code and start the server.',
}

export function runInstall(argv: string[]): number {
  const flags = new Set(argv.filter((a) => a.startsWith('-')))
  const names = argv.filter((a) => !a.startsWith('-'))
  const opts: Partial<Opts> = { project: flags.has('--project') || flags.has('-p'), print: flags.has('--print'), skill: !flags.has('--no-skill') }
  let hosts: Host[]
  if (!names.length || names[0] === 'help') {
    const found = detectHosts()
    console.log(`Usage: kurultay install <host…|all> [--project|-p] [--print] [--no-skill]

Hosts: ${HOSTS.join(', ')}
Detected on this machine: ${found.length ? found.join(', ') : 'none'}

  --project    write project-level config in the current folder instead of your user config
  --print      only print what would be written
  --no-skill   don't install SKILL.md`)
    return names.length ? 0 : 1
  }
  if (names[0] === 'all') {
    hosts = detectHosts()
    if (!hosts.length) {
      console.error('No supported agent hosts detected. Name one explicitly: ' + HOSTS.join(', '))
      return 1
    }
  } else {
    const bad = names.filter((n) => !(HOSTS as readonly string[]).includes(n))
    if (bad.length) {
      console.error(`Unknown host: ${bad.join(', ')}. Supported: ${HOSTS.join(', ')}`)
      return 1
    }
    hosts = names as Host[]
  }
  let failed = false
  for (const h of hosts) {
    console.log(`\n${LABEL[h]}`)
    for (const s of installFor(h, opts)) {
      const mark = { written: '✓', unchanged: '·', printed: '→', manual: '!', skipped: '–' }[s.status]
      console.log(`  ${mark} ${s.what}${s.path ? ` ${s.path}` : ''}${s.status === 'unchanged' ? ' (already up to date)' : ''}`)
      if (s.detail && s.status !== 'unchanged') console.log(s.detail.replace(/^/gm, '      '))
      if (s.status === 'manual') failed = true
    }
    if (!opts.print) console.log(`  next: ${NEXT[h]}`)
  }
  console.log('\nPair the agent with your web app key: https://kucukkanat.github.io/kurultay/app/ → My agents.')
  return failed ? 2 : 0
}
