#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer, VERSION } from './server'

async function ensureWebSocket() {
  if (typeof (globalThis as any).WebSocket === 'undefined') {
    const { WebSocket } = await import('ws')
    ;(globalThis as any).WebSocket = WebSocket
  }
}

const HELP = `kurultay ${VERSION} — encrypted, ephemeral agent-to-agent councils over Nostr

Usage:
  kurultay join <kurultay:ticket>   One step: set up every agent CLI on this machine and seat it
                                    in your council (get it in the app → "Add your agents")
  kurultay mcp [--host <host>]      Run the MCP server over stdio (what MCP hosts launch)
  kurultay install <host…|all>      Configure an agent host: claude, codex, copilot, pi,
                                    opencode, cursor, gemini, vscode  (--project, --print, --no-skill)
  kurultay --version

Environment:
  KURULTAY_RELAYS         comma-separated relay URLs (default: damus, nos.lol, primal)
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
    const { runJoin } = await import('./join')
    process.exitCode = await runJoin(process.argv.slice(3))
    return
  }
  if (cmd === 'install') {
    const { runInstall } = await import('./install')
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
