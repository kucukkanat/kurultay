import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFor, detectHosts, uninstallFor } from '../src/install'

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
  expect(existsSync(join(home, '.codex/skills/kurultay/SKILL.md'))).toBe(true)
  expect(existsSync(join(home, '.agents/skills/kurultay'))).toBe(false)
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
  expect(existsSync(join(cwd, '.github/skills/kurultay/SKILL.md'))).toBe(true)
  const home = fresh()
  mkdirSync(join(home, '.codex'))
  mkdirSync(join(home, '.pi'))
  expect(detectHosts(home)).toEqual(['codex', 'pi'])
})

test('FileStorage creates its folder (keychain path never makes one)', async () => {
  const { FileStorage } = await import('../src/instance')
  const dir = join(fresh(), 'instances', 'claude#1')
  new FileStorage(join(dir, 'state.json')).save({ v: 1 } as any)
  expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).v).toBe(1)
})

test('legacy shared skill copy is removed so hosts never see it twice', () => {
  const home = fresh()
  mkdirSync(join(home, '.agents/skills/kurultay'), { recursive: true })
  writeFileSync(join(home, '.agents/skills/kurultay/SKILL.md'), '---\nname: kurultay\n---\nold')
  installFor('opencode', { home })
  expect(existsSync(join(home, '.agents/skills/kurultay'))).toBe(false)
  expect(existsSync(join(home, '.config/opencode/skills/kurultay/SKILL.md'))).toBe(true)
})

test('uninstallFor reverses installFor and keeps unrelated settings', () => {
  const home = fresh()
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex/config.toml'), 'model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n')
  mkdirSync(join(home, '.gemini'))
  writeFileSync(join(home, '.gemini/settings.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'a' } } }))
  const hosts = ['codex', 'copilot', 'pi', 'opencode', 'cursor', 'gemini'] as const
  for (const h of hosts) installFor(h, { home })
  for (const h of hosts) expect(uninstallFor(h, home).every((s) => s.status === 'written')).toBe(true)
  expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe('model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n')
  expect(JSON.parse(readFileSync(join(home, '.gemini/settings.json'), 'utf8'))).toEqual({ theme: 'dark', mcpServers: { other: { command: 'a' } } })
  expect(JSON.parse(readFileSync(join(home, '.config/opencode/opencode.json'), 'utf8')).mcp).toEqual({})
  for (const d of ['.codex/skills', '.copilot/skills', '.pi/agent/skills', '.config/opencode/skills']) expect(existsSync(join(home, d, 'kurultay'))).toBe(false)
  // a second run has nothing left to remove
  for (const h of hosts) expect(uninstallFor(h, home)).toEqual([])
})

test('uninstallFor leaves a Claude plugin to the user and never runs the claude CLI without a kurultay entry', () => {
  const home = fresh()
  mkdirSync(join(home, '.claude/skills/kurultay'), { recursive: true })
  mkdirSync(join(home, '.claude/plugins'), { recursive: true })
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), '{"plugins":{"kurultay@kurultay":[]}}')
  const steps = uninstallFor('claude', home)
  expect(steps.map((s) => [s.what, s.status])).toEqual([['plugin', 'manual'], ['skill', 'written']])
  expect(steps[0]?.detail).toContain('claude plugin uninstall kurultay@kurultay')
  expect(existsSync(join(home, '.claude/skills/kurultay'))).toBe(false)
})

test('uninstallFor reports JSONC configs as manual', () => {
  const home = fresh()
  mkdirSync(join(home, '.cursor'))
  writeFileSync(join(home, '.cursor/mcp.json'), '{ // c\n "mcpServers": { "kurultay": {} } }')
  expect(uninstallFor('cursor', home)[0]?.status).toBe('manual')
})
