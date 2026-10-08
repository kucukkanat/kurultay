// Between Excalidraw and the council, without a DOM: which local elements to send, how remote ones join the scene, and
// how pointers from the council become cursors. The React island (excalidraw.ts) only wires these up.
import { BoardRefusedError, newer, type Versioned } from '@kurultay/core'

/** Elements whose version the council does not have from me yet (nor sent me), i.e. what a local edit changed. */
export const unsent = <T extends Versioned>(sent: ReadonlyMap<string, number>, scene: readonly T[]): T[] => scene.filter((e) => sent.get(e.id) !== e.version)

export interface BoardSender {
  /** Sends what changed locally; call on every scene change (throttled). */
  flush(): void
  cancel(): void
}

/**
 * Local edits to the council, one send at a time. A version counts as sent only once `draw` took it, so a send that
 * fails (rate limit, muted, paused, relay down) is tried again after `retryMs`, then twice as long each time it fails
 * again (up to a minute, so a long mute does not report every few seconds), instead of leaving peers out of sync.
 * Elements the board refused are marked too: sending them again would be refused again, and `onError` has said so.
 */
export function boardSender<T extends Versioned>(o: { sent: Map<string, number>; scene: () => readonly T[]; draw: (els: T[]) => Promise<unknown>; onError: (err: unknown) => void; retryMs: number }): BoardSender {
  let busy = false
  let again = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let delay = o.retryMs
  const flush = () => {
    // one send in flight, and no attempt while waiting to retry: edits meanwhile go out with the next one
    if (busy || retry) {
      again ||= busy
      return
    }
    const out = unsent(o.sent, o.scene())
    if (!out.length) return
    busy = true
    o.draw(out)
      .then(
        () => {
          markKnown(o.sent, out)
          delay = o.retryMs
        },
        (err: unknown) => {
          if (err instanceof BoardRefusedError) markKnown(o.sent, out)
          else
            retry = setTimeout(() => {
              retry = undefined
              flush()
            }, delay)
          delay = Math.min(delay * 2, 60_000)
          o.onError(err)
        },
      )
      .finally(() => {
        busy = false
        if (again) {
          again = false
          flush()
        }
      })
  }
  return {
    flush,
    cancel: () => {
      clearTimeout(retry)
      retry = undefined
      again = false
    },
  }
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
