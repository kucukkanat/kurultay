import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, now, utf8 } from './util'
import {
  KIND_ATTESTATION,
  KIND_INNER,
  KIND_WRAP,
  MAX_SKEW_SECONDS,
  ROUTE_TAG,
  SLOT_SECONDS,
  type Envelope,
  type NostrEvent,
} from './types'

const SALT = utf8('kurultay/v1')

function derive(secretHex: string, info: string): Uint8Array {
  return hkdf(sha256, hexToBytes(secretHex), SALT, utf8(info), 32)
}

export const slotOf = (t = now()) => Math.floor(t / SLOT_SECONDS)

/** Routing tag for a secret at a slot: opaque, rotating, unlinkable without the secret. */
export function routeTag(secretHex: string, purpose: 'group' | 'inbox', slot: number): string {
  const key = derive(secretHex, `route/${purpose}`)
  return bytesToHex(hmac(sha256, key, utf8(`slot/${slot}`))).slice(0, 32)
}

/** Tags a subscriber listens to right now: previous, current and next slot. */
export function routeWindow(secretHex: string, purpose: 'group' | 'inbox', t = now()): string[] {
  const s = slotOf(t)
  return [s - 1, s, s + 1].map((x) => routeTag(secretHex, purpose, x))
}

export function groupEncKey(groupKeyHex: string): Uint8Array {
  return derive(groupKeyHex, 'enc')
}

export function newSecretKey(): Uint8Array {
  return generateSecretKey()
}

export { getPublicKey, verifyEvent }

/** Build and sign the inner event (never published on its own). */
export function signInner(sk: Uint8Array, env: Envelope, bind: ['g' | 'p', string]): NostrEvent {
  return finalizeEvent(
    { kind: KIND_INNER, created_at: now(), tags: [bind], content: JSON.stringify(env) },
    sk,
  )
}

function outer(content: string, tag: string): NostrEvent {
  const throwaway = generateSecretKey()
  return finalizeEvent(
    { kind: KIND_WRAP, created_at: now(), tags: [[ROUTE_TAG, tag]], content },
    throwaway,
  )
}

/** Wrap a signed inner event for a group channel. */
export function wrapGroup(inner: NostrEvent, groupKeyHex: string): NostrEvent {
  const content = nip44.encrypt(JSON.stringify(inner), groupEncKey(groupKeyHex))
  return outer(content, routeTag(groupKeyHex, 'group', slotOf()))
}

/** Wrap a signed inner event for one recipient's inbox (pairwise NIP-44 with a throwaway key). */
export function wrapInbox(inner: NostrEvent, recipientPk: string, recipientInboxHex: string): NostrEvent {
  const throwaway = generateSecretKey()
  const content = nip44.encrypt(JSON.stringify(inner), nip44.getConversationKey(throwaway, recipientPk))
  return finalizeEvent(
    {
      kind: KIND_WRAP,
      created_at: now(),
      tags: [[ROUTE_TAG, routeTag(recipientInboxHex, 'inbox', slotOf())]],
      content,
    },
    throwaway,
  )
}

export class UnwrapError extends Error {}

function checkInner(inner: NostrEvent, bind: ['g' | 'p', string]): Envelope {
  if (inner.kind !== KIND_INNER) throw new UnwrapError('bad inner kind')
  if (!verifyEvent(inner)) throw new UnwrapError('bad inner signature')
  if (Math.abs(now() - inner.created_at) > MAX_SKEW_SECONDS) throw new UnwrapError('stale or future event')
  const tag = inner.tags.find((t) => t[0] === bind[0])
  if (!tag || tag[1] !== bind[1]) throw new UnwrapError('inner event bound to another channel')
  const env = JSON.parse(inner.content) as Envelope
  if (!env || typeof env.type !== 'string') throw new UnwrapError('bad envelope')
  return env
}

export function unwrapGroup(ev: NostrEvent, groupId: string, groupKeyHex: string) {
  if (!verifyEvent(ev)) throw new UnwrapError('bad outer signature')
  const plain = nip44.decrypt(ev.content, groupEncKey(groupKeyHex))
  const inner = JSON.parse(plain) as NostrEvent
  const env = checkInner(inner, ['g', groupId])
  return { inner, env }
}

export function unwrapInbox(ev: NostrEvent, sk: Uint8Array) {
  if (!verifyEvent(ev)) throw new UnwrapError('bad outer signature')
  const plain = nip44.decrypt(ev.content, nip44.getConversationKey(sk, ev.pubkey))
  const inner = JSON.parse(plain) as NostrEvent
  const env = checkInner(inner, ['p', getPublicKey(sk)])
  return { inner, env }
}

/** Owner certifies an agent key. */
export function attest(ownerSk: Uint8Array, agentPk: string, label: string, ownerName: string): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_ATTESTATION,
      created_at: now(),
      tags: [
        ['p', agentPk],
        ['label', label],
        ['name', ownerName],
      ],
      content: 'kurultay agent attestation',
    },
    ownerSk,
  )
}

/** Owner certifies several agent keys at once (one per host type of an agent ticket). */
export function attestMany(ownerSk: Uint8Array, agents: { pk: string; label: string }[], ownerName: string): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_ATTESTATION,
      created_at: now(),
      tags: [...agents.map((a) => ['p', a.pk, a.label]), ['name', ownerName]],
      content: 'kurultay agent attestation',
    },
    ownerSk,
  )
}

export function checkAttestation(att: NostrEvent | undefined, agentPk: string): { owner: string; label: string; ownerName: string } | null {
  if (!att || att.kind !== KIND_ATTESTATION) return null
  try {
    if (!verifyEvent(att)) return null
  } catch {
    return null
  }
  const p = att.tags.find((t) => t[0] === 'p' && t[1] === agentPk)
  if (!p) return null
  return {
    owner: att.pubkey,
    label: p[2] || att.tags.find((t) => t[0] === 'label')?.[1] || '',
    ownerName: att.tags.find((t) => t[0] === 'name')?.[1] ?? '',
  }
}

/** Deterministic per-host agent identity from a ticket seed. */
export function deriveAgent(seedHex: string, host: string): { sk: Uint8Array; pk: string; inbox: string } {
  const sk = derive(seedHex, `agent/${host}/key`)
  return { sk, pk: getPublicKey(sk), inbox: bytesToHex(derive(seedHex, `agent/${host}/inbox`)) }
}
