// Between Excalidraw and the council, without a DOM: which local elements to send, how remote ones join the scene, and
// how pointers from the council become cursors. The React island (excalidraw.ts) only wires these up.
import { newer, type Versioned } from '@kurultay/core'

/** Elements whose version I have not sent (or received) yet, i.e. what a local edit changed. Marks them as sent. */
export function takeUnsent<T extends Versioned>(sent: Map<string, number>, scene: readonly T[]): T[] {
  const out = scene.filter((e) => sent.get(e.id) !== e.version)
  for (const e of out) sent.set(e.id, e.version)
  return out
}

/** Remembers versions that arrived from the council, so they are not sent back. */
export function markKnown(sent: Map<string, number>, els: readonly Versioned[]): void {
  for (const e of els) if ((sent.get(e.id) ?? 0) < e.version) sent.set(e.id, e.version)
}

/**
 * The scene with remote elements in it: newer ones replace mine where they are (the engine's rule, so the two never
 * disagree), new ones go on top. Null when nothing changes, so the caller can skip a re-render.
 */
export function applyRemote<T extends Versioned>(local: readonly T[], incoming: readonly T[]): T[] | null {
  const at = new Map(local.map((e, i) => [e.id, i]))
  const next = [...local]
  let changed = false
  for (const el of incoming) {
    const i = at.get(el.id)
    if (i === undefined) {
      at.set(el.id, next.length)
      next.push(el)
      changed = true
    } else if (newer(el, next[i])) {
      next[i] = el
      changed = true
    }
  }
  return changed ? next : null
}

/** A member's pointer on the board and when it last moved. */
export interface Cursor {
  readonly x: number
  readonly y: number
  readonly name: string
  readonly at: number
}

/** How long a still pointer stays on the board. */
export const CURSOR_TTL_MS = 6000

/** The cursors still worth showing at `now`. */
export const liveCursors = (cursors: ReadonlyMap<string, Cursor>, now: number): [string, Cursor][] => [...cursors].filter(([, c]) => now - c.at < CURSOR_TTL_MS)

/** One steady colour per member, from their key, so a cursor keeps its colour across sessions and devices. */
export function cursorColor(pubkey: string): { background: string; stroke: string } {
  const hue = Number.parseInt(pubkey.slice(0, 6), 16) % 360
  return { background: `hsl(${hue} 80% 85%)`, stroke: `hsl(${hue} 70% 40%)` }
}

/** Calls `fn` at most once per `ms`, always with the latest arguments, and once more after the last call. */
export function throttle<A extends unknown[]>(ms: number, fn: (...args: A) => void): { (...args: A): void; cancel(): void } {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: A | undefined
  const run = () => {
    timer = undefined
    last = Date.now()
    const args = pending
    pending = undefined
    if (args) fn(...args)
  }
  const call = (...args: A) => {
    pending = args
    timer ??= setTimeout(run, Math.max(0, ms - (Date.now() - last)))
  }
  call.cancel = () => {
    clearTimeout(timer)
    timer = undefined
    pending = undefined
  }
  return call
}
