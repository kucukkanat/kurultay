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
  kurultay mcp            Run the MCP server over stdio (add this to your MCP host)
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
  if (cmd !== 'mcp') {
    console.log(HELP)
    if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1
    return
  }
  await ensureWebSocket()
  const app = createServer()
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
