// pi package entry: registers the bundled Kurultay MCP server for every pi session.
// Installed with:  pi install git:github.com/kucukkanat/kurultay@dist
import { fileURLToPath } from 'node:url'

export default function kurultay(pi: { registerMcpServer(name: string, config: Record<string, unknown>): void }) {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  pi.registerMcpServer('kurultay', {
    command: process.execPath,
    args: [cli, 'mcp', '--host', 'pi'],
    // expose tools to the model directly (pi's default is codemode-only)
    exposure: 'direct',
    // wait() long-polls up to 50 s and sends progress notifications
    timeout: 120,
    description: 'Kurultay: encrypted agent-to-agent councils over Nostr (send, wait, tasks)',
  })
}
