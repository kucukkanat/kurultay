import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFor, detectHosts } from '../src/install'

const fresh = () => mkdtempSync(join(tmpdir(), 'kurultay-install-'))

test('codex: appends a table once and replaces it on re-run', () => {
  const home = fresh()
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex/config.toml'), 'model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n')
  installFor('codex', { home })
  installFor('codex', { home })
  const toml = readFileSync(join(home, '.codex/config.toml'), 'utf8')
  expect(toml.match(/\[mcp_servers\.kurultay\]/g)).toHaveLength(1)
  expect(toml).toContain('[mcp_servers.other]')
  expect(toml).toContain('tool_timeout_sec = 120')
  expect(existsSync(join(home, '.agents/skills/kurultay/SKILL.md'))).toBe(true)
})

test('json hosts merge without clobbering other settings', () => {
  const home = fresh()
  mkdirSync(join(home, '.config/opencode'), { recursive: true })
  writeFileSync(join(home, '.config/opencode/opencode.json'), JSON.stringify({ theme: 'x', mcp: { other: { type: 'local', command: ['a'] } } }))
  installFor('opencode', { home })
  const oc = JSON.parse(readFileSync(join(home, '.config/opencode/opencode.json'), 'utf8'))
  expect(oc.theme).toBe('x')
  expect(oc.mcp.other).toBeDefined()
  expect(oc.mcp.kurultay.command).toEqual(['npx', '-y', 'github:kucukkanat/kurultay#dist', 'mcp', '--host', 'opencode'])

  installFor('pi', { home })
  const pi = JSON.parse(readFileSync(join(home, '.pi/agent/mcp.json'), 'utf8'))
  expect(pi.mcpServers.kurultay.exposure).toBe('direct')

  installFor('copilot', { home })
  const cp = JSON.parse(readFileSync(join(home, '.copilot/mcp-config.json'), 'utf8'))
  expect(cp.mcpServers.kurultay.timeout).toBe(120000)
})

test('JSONC config is left alone with a manual snippet', () => {
  const home = fresh()
  mkdirSync(join(home, '.config/opencode'), { recursive: true })
  writeFileSync(join(home, '.config/opencode/opencode.json'), '{ // comment\n "theme": "x" }')
  const [step] = installFor('opencode', { home })
  expect(step.status).toBe('manual')
  expect(readFileSync(join(home, '.config/opencode/opencode.json'), 'utf8')).toContain('// comment')
})

test('project scope and detection', () => {
  const cwd = fresh()
  installFor('copilot', { project: true, cwd, home: fresh() })
  expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')).mcpServers.kurultay).toBeDefined()
  expect(existsSync(join(cwd, '.agents/skills/kurultay/SKILL.md'))).toBe(true)
  const home = fresh()
  mkdirSync(join(home, '.codex'))
  mkdirSync(join(home, '.pi'))
  expect(detectHosts(home)).toEqual(['codex', 'pi'])
})
