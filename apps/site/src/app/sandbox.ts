import { DEFAULT_AGENT_MODE, EMPTY_SANDBOX_GRANTS, type AgentMode, type AgentSandbox, type SandboxConfig, type SandboxGrants, type SandboxViolation } from '@kurultay/core'

/**
 * The DOM-free half of an agent's sandbox in the app: what the seat checkbox implies, the config sent to the background
 * service, and what an "Allow" button next to a blocked item adds. The service validates everything again (protected
 * folders, its own settings), so these helpers only keep the owner's edits tidy. Design: docs/sandbox.md.
 */

/** Words the owner reads. Kept here so a test can hold them to the "never name the technology" rule (D21). */
export const SANDBOX_COPY = {
  seatLabel: 'Keep these agents in a sandbox',
  seatHelp: 'They only see their working folder and the websites you allow.',
  seatUnavailable: 'This computer can’t keep agents in a sandbox yet, so they would run without one:',
  seatOld: 'Update Kurultay on that computer to use sandboxes.',
  seatFix: 'To fix it, run this on that computer:',
  badge: 'Sandboxed',
  switchLabel: 'Keep in a sandbox',
  switchHint: 'Sees only its working folder, the folders you add and the websites you allow.',
  offConfirm: 'This agent will be able to read your whole home folder and reach any website. Turn off?',
  fellBack: 'Its last answer ran without the sandbox: ',
  settings: 'Sandbox settings',
  blocked: 'Blocked recently',
  startsEdit: 'They start with “Edit files” in their working folder. Choose what each may do under My agents.',
  startsTalk: 'They start with only “Answer when tagged”: no file or command access. Choose what each may do under My agents.',
} as const

/** How a blocked item is described in the list. */
export const VIOLATION_LABEL: Record<SandboxViolation['kind'], string> = { read: 'Read', write: 'Change', network: 'Website', other: 'Other' }

/** D20: a sandboxed agent can safely start with Edit; one without a sandbox keeps the cautious default. */
export const initialMode = (sandboxed: boolean): AgentMode => (sandboxed ? 'edit' : DEFAULT_AGENT_MODE)

/** The editable part of an agent's sandbox. No `sandbox` means it was seated without one: off (D8). */
export function configOf(s: AgentSandbox | undefined): SandboxConfig {
  if (!s) return { enabled: false, ...EMPTY_SANDBOX_GRANTS }
  const { enabled, allowDomains, readPaths, writePaths } = s
  return { enabled, allowDomains, readPaths, writePaths }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
/** ports a website is reached on anyway, so the exact host alone allows it */
const WEB_PORTS = new Set([80, 443])

/** `host`, `host:port`, `[v6]:port` or a URL, as the host and (if given) port. */
export function splitHost(target: string): { host: string; port?: number } {
  const t = target.trim()
  const bare = t.includes('://') ? (t.split('://')[1] ?? '').split(/[/?#]/)[0] ?? '' : t
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(bare) ?? /^([^:]+)(?::(\d+))?$/.exec(bare)
  // a bare IPv6 address: no port to split off
  if (!m?.[1]) return { host: bare.toLowerCase() }
  return { host: m[1].toLowerCase(), ...(m[2] ? { port: Number(m[2]) } : {}) }
}

/**
 * The website an "Allow" button adds, or nothing when the item gets no button. Only websites, and only the exact host
 * (D24: wildcards are typed by hand). Files are a door the owner opens on purpose in the settings, and programs on this
 * computer can never be allowed.
 */
export function grantFor(v: SandboxViolation): string | undefined {
  if (v.kind !== 'network') return undefined
  const { host, port } = splitHost(v.target)
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return undefined
  return port && !WEB_PORTS.has(port) ? `${host}:${port}` : host
}

/** True once the website is already allowed, so the button can say "Allowed" instead. */
export const isGranted = (config: SandboxGrants, domain: string) => config.allowDomains.some((d) => d.toLowerCase() === domain.toLowerCase())

/** The config with one more website; the same object when it is already there. */
export const withGrant = (config: SandboxConfig, domain: string): SandboxConfig => (isGranted(config, domain) ? config : { ...config, allowDomains: [...config.allowDomains, domain] })

/** The fields of the settings editor. Folder lists stay lists: they are added with the folder picker. */
export interface SandboxDraft {
  readonly domains: string
  readonly readPaths: readonly string[]
  readonly writePaths: readonly string[]
}

export const draftOf = (c: SandboxGrants): SandboxDraft => ({ domains: c.allowDomains.join('\n'), readPaths: c.readPaths, writePaths: c.writePaths })

/** One entry per line or comma, trimmed, blanks and repeats dropped. */
export const parseList = (text: string): string[] => [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))]

/** Add a folder to a list once; blanks are ignored. */
export const addPath = (list: readonly string[], path: string): string[] => {
  const p = path.trim()
  return !p || list.includes(p) ? [...list] : [...list, p]
}

/** The config to send for these edits. */
export const configFromDraft = (enabled: boolean, d: SandboxDraft): SandboxConfig => ({ enabled, allowDomains: parseList(d.domains), readPaths: [...new Set(d.readPaths)], writePaths: [...new Set(d.writePaths)] })

/** Whether the editor holds anything the service doesn't have yet. */
export const isDirty = (saved: SandboxConfig, d: SandboxDraft): boolean => JSON.stringify(configFromDraft(saved.enabled, d)) !== JSON.stringify(saved)
