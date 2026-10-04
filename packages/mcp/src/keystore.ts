import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bytesToHex, hexToBytes, newSecretKey } from '@kurultay/core'

const SERVICE = 'kurultay'

export type KeySource = 'env' | 'macos-keychain' | 'libsecret' | 'file'

function run(cmd: string, args: string[], input?: string) {
  try {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 5000 })
    if (r.error || r.status !== 0) return null
    return r.stdout.trim()
  } catch {
    return null
  }
}

function keychainGet(account: string): string | null {
  if (process.env.KURULTAY_NO_KEYCHAIN) return null
  if (process.platform === 'darwin') return run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
  if (process.platform === 'linux') return run('secret-tool', ['lookup', 'service', SERVICE, 'account', account])
  return null
}

function keychainSet(account: string, hex: string): KeySource | null {
  if (process.env.KURULTAY_NO_KEYCHAIN) return null
  if (process.platform === 'darwin') {
    return run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', hex]) !== null ? 'macos-keychain' : null
  }
  if (process.platform === 'linux') {
    return run('secret-tool', ['store', '--label', `Kurultay agent key (${account})`, 'service', SERVICE, 'account', account], hex) !== null ? 'libsecret' : null
  }
  return null
}

/**
 * Load or create the agent secret key.
 * Order: KURULTAY_SECRET_KEY env → OS keychain → chmod-600 file fallback.
 */
export function loadOrCreateKey(account: string, dir: string): { sk: Uint8Array; source: KeySource } {
  const env = process.env.KURULTAY_SECRET_KEY
  if (env && /^[0-9a-f]{64}$/i.test(env)) return { sk: hexToBytes(env.toLowerCase()), source: 'env' }

  const fromChain = keychainGet(account)
  if (fromChain && /^[0-9a-f]{64}$/.test(fromChain)) {
    return { sk: hexToBytes(fromChain), source: process.platform === 'darwin' ? 'macos-keychain' : 'libsecret' }
  }

  const file = join(dir, 'secret.key')
  if (existsSync(file)) {
    const hex = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(hex)) return { sk: hexToBytes(hex), source: 'file' }
  }

  const sk = newSecretKey()
  const hex = bytesToHex(sk)
  const stored = keychainSet(account, hex)
  if (stored && keychainGet(account) === hex) return { sk, source: stored }

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, hex + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return { sk, source: 'file' }
}

/** Store a given secret key for an account (keychain when available, else chmod-600 file). */
export function saveKey(account: string, dir: string, sk: Uint8Array): KeySource {
  const hex = bytesToHex(sk)
  const stored = keychainSet(account, hex)
  if (stored && keychainGet(account) === hex) {
    const file = join(dir, 'secret.key')
    if (existsSync(file)) writeFileSync(file, '', { mode: 0o600 })
    return stored
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'secret.key'), hex + '\n', { mode: 0o600 })
  chmodSync(join(dir, 'secret.key'), 0o600)
  return 'file'
}
