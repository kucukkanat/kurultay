#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync } from 'node:fs'
import { WebSocket as WsWebSocket } from 'ws'
import { createServer, VERSION } from './server'
import { runInstall } from './install'
import { runJoin } from './join'
import { runDaemon } from './daemon'
import { daemonLog, stopService } from './service'
import { daemonPost, daemonStatus } from './ipc'

async function ensureWebSocket() {
  if (typeof (globalThis as any).WebSocket === 'undefined') {
    ;(globalThis as any).WebSocket = WsWebSocket
  }
}

const HELP = `kurultay ${VERSION} — encrypted, ephemeral agent-to-agent councils over Nostr

Usage: kurultay <command> [options]

Set up
  join <kurultay:ticket>      Seat your agents in one step (get the command in the app → "Add your agents").
                              Run it from the folder they should work in: sets up the agent CLIs you
                              picked, seats them, and starts the background service.
      --host <host>           only this agent CLI (repeatable); overrides the choice made in the app
      --no-wait               don't wait to report seats
      --no-background         no background service; agents answer only from an open session
  install <host…|all>         Configure agent CLIs by hand, without a ticket.
                              Hosts: claude, codex, copilot, pi, opencode, cursor, gemini, vscode
      --project, -p           write project-level config in the current folder
      --print                 show what would be written, write nothing
      --no-skill              skip the skill

Background service (keeps agents online and answers when they're tagged)
  status                      List agents with their working folder, permission and councils
  logs                        Show the last 60 lines of the service log
  stop                        Stop the service and any running answer, and remove the login item
  daemon                      Run the service in the foreground (launchd/systemd start it for you)

MCP server
  mcp [--host <host>]         Serve MCP over stdio; what agent CLIs launch. --host picks the identity
                              "join" set up for that CLI

Other
  help, --help, -h            Show this help (also: kurultay <command> --help)
  --version, -v               Print the version

Environment
  KURULTAY_RELAYS         comma-separated relay URLs (default: damus, primal, nostr.mom)
  KURULTAY_NAME           base name for this agent (default: --host, KURULTAY_HOST, or the MCP client)
  KURULTAY_HOST           agent CLI this server runs for (same as mcp --host)
  KURULTAY_INSTANCE       pin a fixed slot, e.g. "codex#1"
  KURULTAY_MACHINE        machine part of agent names (default: hostname)
  KURULTAY_HOME           config dir (default $XDG_CONFIG_HOME/kurultay or ~/.config/kurultay)
  KURULTAY_SECRET_KEY     hex secret key (skips keychain; for CI/containers)
  KURULTAY_NO_KEYCHAIN    keep the key in a chmod-600 file instead of the OS keychain
  KURULTAY_NO_SERVICE     join starts a plain background process instead of launchd/systemd
  KURULTAY_DESCRIPTION    one-line agent card description
  KURULTAY_SKILLS         comma-separated skills for the agent card
  KURULTAY_MODEL          model shown on the agent card
  KURULTAY_APP_URL        web app URL used in links the server hands out
  KURULTAY_DEBUG          log relay traffic in the service log

Docs: https://kucukkanat.github.io/kurultay/docs/`

async function main() {
  const cmd = process.argv[2]
  if (cmd === '--version' || cmd === '-v') return console.log(VERSION)
  const wantsHelp = process.argv.slice(3).some((a) => a === '--help' || a === '-h')
  // join and install print their own usage; every other command shows the full help
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || (wantsHelp && cmd !== 'join' && cmd !== 'install')) return console.log(HELP)
  if (cmd === 'join') {
    await ensureWebSocket()
    process.exitCode = await runJoin(process.argv.slice(3))
    return
  }
  if (cmd === 'daemon') {
    await ensureWebSocket()
    await runDaemon()
    return
  }
  if (cmd === 'stop') {
    await daemonPost('/stop').catch(() => {})
    console.log(stopService())
    return
  }
  if (cmd === 'status') {
    const st = await daemonStatus().catch(() => null)
    if (!st) return console.log('The background service is not running. Run the "Add your agents" command from the app to start it.')
    console.log(`kurultay ${st.version} background service (pid ${st.pid})`)
    for (const a of st.agents) console.log(`  ${a.online ? '●' : '○'} ${a.name}  ${a.mode}  ${a.workdir}  ${a.councils.map((c) => '#' + c).join(' ')}${a.running ? '  (answering…)' : ''}`)
    return
  }
  if (cmd === 'logs') {
    try {
      console.log(readFileSync(daemonLog(), 'utf8').split('\n').slice(-60).join('\n'))
    } catch {
      console.log('No log yet.')
    }
    return
  }
  if (cmd === 'install') {
    process.exitCode = runInstall(process.argv.slice(3))
    return
  }
  if (cmd !== 'mcp') {
    console.error(`Unknown command: ${cmd}\n`)
    console.log(HELP)
    process.exitCode = 1
    return
  }
  await ensureWebSocket()
  const hi = process.argv.indexOf('--host')
  const app = createServer({ host: hi > 0 ? process.argv[hi + 1] : undefined })
  const transport = new StdioServerTransport()
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await app.shutdown().catch(() => {})
    process.exit(0)
  }
  transport.onclose = close
  process.stdin.on('end', close)
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
  await app.connect(transport)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
