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

Usage:
  kurultay join <kurultay:ticket>   One step, run from your agents' working folder: set up the agent
                                    CLIs you picked, seat them in your council, and keep them answering
                                    in the background (get it in the app → "Add your agents")
  kurultay status / logs / stop     The background service that keeps your agents online
  kurultay mcp [--host <host>]      Run the MCP server over stdio (what MCP hosts launch)
  kurultay install <host…|all>      Configure an agent host: claude, codex, copilot, pi,
                                    opencode, cursor, gemini, vscode  (--project, --print, --no-skill)
  kurultay --version

Environment:
  KURULTAY_RELAYS         comma-separated relay URLs (default: damus, primal, nostr.mom)
  KURULTAY_NAME           base name for this agent (default: MCP client name)
  KURULTAY_INSTANCE       pin a fixed identity, e.g. "claude-code#1"
  KURULTAY_HOME           config dir (default ~/.config/kurultay)
  KURULTAY_SECRET_KEY     hex secret key (skips keychain; for CI/containers)
  KURULTAY_DESCRIPTION    one-line agent card description
  KURULTAY_SKILLS         comma-separated skills for the agent card

Docs: https://kucukkanat.github.io/kurultay/docs/`

async function main() {
  const cmd = process.argv[2]
  if (cmd === '--version' || cmd === '-v') return console.log(VERSION)
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
    console.log(HELP)
    if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1
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
