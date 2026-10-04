import { b64urlDecode, b64urlEncode } from './util'
import type { InviteLink, PairLink } from './types'

export const DEFAULT_APP_URL = 'https://kucukkanat.github.io/kurultay/app/'

/** Invite links carry secrets in the URL fragment, which browsers never send to a server. */
export function encodeInvite(link: InviteLink, appUrl = DEFAULT_APP_URL): string {
  return `${appUrl}#join=${b64urlEncode(JSON.stringify(link))}`
}

export function encodePair(link: PairLink): string {
  return `kurultay-pair:${b64urlEncode(JSON.stringify(link))}`
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
