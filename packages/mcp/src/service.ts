import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configRoot } from './instance'

const LABEL = 'dev.kurultay.daemon'
const home = () => process.env.HOME || homedir()

export const daemonLog = () => join(configRoot(), 'daemon.log')
const pidFile = () => join(configRoot(), 'daemon.pid')

export interface ServiceResult {
  kind: 'launchd' | 'systemd' | 'process'
  ok: boolean
  detail?: string
  /** survives logout/reboot */
  persistent: boolean
}

function env() {
  const e: Record<string, string> = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home() }
  for (const k of ['KURULTAY_HOME', 'KURULTAY_RELAYS', 'KURULTAY_MACHINE', 'KURULTAY_NO_KEYCHAIN', 'XDG_CONFIG_HOME']) if (process.env[k]) e[k] = process.env[k]!
  return e
}

function killPid() {
  try {
    const pid = Number(readFileSync(pidFile(), 'utf8').trim())
    if (pid && pid !== process.pid) process.kill(pid, 'SIGTERM')
  } catch {}
}

function launchd(runtime: string): ServiceResult {
  const plistPath = join(home(), 'Library/LaunchAgents', `${LABEL}.plist`)
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const envXml = Object.entries(env())
    .map(([k, v]) => `      <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join('\n')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${esc(process.execPath)}</string>
      <string>${esc(runtime)}</string>
      <string>daemon</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${esc(daemonLog())}</string>
    <key>StandardErrorPath</key><string>${esc(daemonLog())}</string>
  </dict>
</plist>
`
  mkdirSync(join(home(), 'Library/LaunchAgents'), { recursive: true })
  writeFileSync(plistPath, plist)
  const domain = `gui/${process.getuid?.() ?? 501}`
  spawnSync('launchctl', ['bootout', domain, plistPath], { encoding: 'utf8' })
  const r = spawnSync('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' })
  if (r.status !== 0) {
    const legacy = spawnSync('launchctl', ['load', '-w', plistPath], { encoding: 'utf8' })
    if (legacy.status !== 0) return { kind: 'launchd', ok: false, persistent: true, detail: (r.stderr || legacy.stderr || '').trim() }
  }
  return { kind: 'launchd', ok: true, persistent: true }
}

function systemd(runtime: string): ServiceResult | null {
  if (spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).status !== 0) return null
  const dir = join(process.env.XDG_CONFIG_HOME || join(home(), '.config'), 'systemd/user')
  mkdirSync(dir, { recursive: true })
  const unit = `[Unit]
Description=Kurultay background agents
After=network-online.target

[Service]
ExecStart="${process.execPath}" "${runtime}" daemon
${Object.entries(env())
  .map(([k, v]) => `Environment="${k}=${v}"`)
  .join('\n')}
Restart=always
RestartSec=5
StandardOutput=append:${daemonLog()}
StandardError=append:${daemonLog()}

[Install]
WantedBy=default.target
`
  writeFileSync(join(dir, 'kurultay.service'), unit)
  const run = (...a: string[]) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf8' })
  run('daemon-reload')
  run('enable', 'kurultay.service')
  const r = run('restart', 'kurultay.service')
  return r.status === 0 ? { kind: 'systemd', ok: true, persistent: true } : { kind: 'systemd', ok: false, persistent: true, detail: r.stderr.trim() }
}

function plainProcess(runtime: string): ServiceResult {
  killPid()
  mkdirSync(configRoot(), { recursive: true, mode: 0o700 })
  const fd = openSync(daemonLog(), 'a', 0o600)
  chmodSync(daemonLog(), 0o600)
  const child = spawn(process.execPath, [runtime, 'daemon'], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env() } })
  child.unref()
  return { kind: 'process', ok: !!child.pid, persistent: false, detail: 'runs until you log out or restart; run the join command again after a reboot' }
}

/** Install and (re)start the background service that keeps agents online and answering. */
export function startService(runtime: string): ServiceResult {
  // the log names working folders: create it private before launchd/systemd append to it
  mkdirSync(configRoot(), { recursive: true, mode: 0o700 })
  closeSync(openSync(daemonLog(), 'a', 0o600))
  chmodSync(daemonLog(), 0o600)
  if (process.env.KURULTAY_NO_SERVICE) return plainProcess(runtime)
  if (process.platform === 'darwin') {
    const r = launchd(runtime)
    return r.ok ? r : plainProcess(runtime)
  }
  if (process.platform === 'linux') {
    const r = systemd(runtime)
    if (r?.ok) return r
  }
  return plainProcess(runtime)
}

export function stopService(): string {
  const out: string[] = []
  if (process.platform === 'darwin') {
    const plistPath = join(home(), 'Library/LaunchAgents', `${LABEL}.plist`)
    if (existsSync(plistPath)) {
      spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}`, plistPath])
      unlinkSync(plistPath)
      out.push('removed the login service')
    }
  }
  if (process.platform === 'linux') {
    const r = spawnSync('systemctl', ['--user', 'disable', '--now', 'kurultay.service'], { encoding: 'utf8' })
    if (r.status === 0) out.push('stopped and disabled the systemd user service')
  }
  killPid()
  out.push('stopped the background agents')
  return out.join('; ')
}

export function writePid() {
  mkdirSync(configRoot(), { recursive: true, mode: 0o700 })
  writeFileSync(pidFile(), String(process.pid))
}
