import { b64urlDecode, b64urlEncode } from './util'
import type { AgentTicket, InviteLink, PairLink } from './types'

export const DEFAULT_APP_URL = 'https://kucukkanat.github.io/kurultay/app/'

/** Invite links carry secrets in the URL fragment, which browsers never send to a server. */
export function encodeInvite(link: InviteLink, appUrl = DEFAULT_APP_URL): string {
  return `${appUrl}#join=${b64urlEncode(JSON.stringify(link))}`
}

export function encodePair(link: PairLink): string {
  return `kurultay-pair:${b64urlEncode(JSON.stringify(link))}`
}

export function encodeTicket(ticket: AgentTicket): string {
  return `kurultay:${b64urlEncode(JSON.stringify(ticket))}`
}

// macOS cuts a line typed into a terminal at 1024 bytes while no line editor owns it (e.g. pasted before the prompt
// appears), so commands we hand out stay well under that per line.
export const MAX_COMMAND_LINE = 900

/** Breaks a long command into lines joined by `\` + newline, which every POSIX shell removes again, even mid-word. */
export function wrapCommand(command: string, width = MAX_COMMAND_LINE): string {
  const lines = command.match(new RegExp(`[^]{1,${width}}`, 'g')) ?? ['']
  return lines.join('\\\n')
}

export class TicketError extends Error {}

export function decodeTicket(input: string): AgentTicket {
  // a wrapped command pasted somewhere other than a shell still carries its `\` + newline breaks
  const m = input.replace(/\\\r?\n/g, '').trim().match(/kurultay:([A-Za-z0-9_-]+)/)
  if (!m) throw new TicketError('Not a Kurultay agent ticket (expected kurultay:…)')
  let obj
  try {
    obj = JSON.parse(b64urlDecode(m[1]))
  } catch {
    throw new TicketError(
      `This ticket is cut off: only ${m[1].length} characters of it arrived. Terminals can cut a long pasted line, ` +
        'especially when it is pasted before the prompt appears. Copy the command from the app again and paste it at the prompt.',
    )
  }
  if (obj?.t !== 'ticket' || obj.v !== 1 || !/^[0-9a-f]{64}$/.test(obj.seed)) throw new TicketError('Unsupported or damaged ticket')
  return obj
}

export function decodeLink(input: string): InviteLink | PairLink {
  const s = input.trim()
  let payload: string | undefined
  const join = s.match(/#join=([A-Za-z0-9_-]+)/)
  if (join) payload = join[1]
  else if (s.startsWith('kurultay-pair:')) payload = s.slice('kurultay-pair:'.length)
  else if (s.startsWith('kurultay-invite:')) payload = s.slice('kurultay-invite:'.length)
  else if (/^[A-Za-z0-9_-]+$/.test(s)) payload = s
  if (!payload) throw new Error('Not a Kurultay invite or pairing code')
  const obj = JSON.parse(b64urlDecode(payload))
  if (obj?.t !== 'invite' && obj?.t !== 'pair') throw new Error('Unknown Kurultay link type')
  return obj
}
