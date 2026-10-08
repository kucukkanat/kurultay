// Test-only: every DOM test file lends itself a happy-dom window through these two, never through GlobalRegistrator
// directly. Bun runs many test files in one process, so modules (preact, the store) outlive the window they first saw,
// while each window's timers and frames die with it. These keep that from leaking from one file into the next.
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { options } from 'preact'

type DomOptions = NonNullable<Parameters<typeof GlobalRegistrator.register>[0]>

export function registerDom(opts: DomOptions = {}): void {
  // engines talk to relays over Bun's own WebSocket: happy-dom's wraps the `ws` package and listens for its 'error' only
  // once, so a socket torn down mid-handshake throws an unhandled error between tests
  const { WebSocket } = globalThis
  GlobalRegistrator.register({ url: 'http://localhost:5173/app/', ...opts })
  globalThis.WebSocket = WebSocket
  // preact/hooks runs effects after a frame, and two things about that do not survive a change of window: it checks for
  // requestAnimationFrame once, when first imported (a graph loaded before any DOM falls back to a 35 ms timer), and it
  // schedules a flush only when its queue goes from empty to one, so a flush lost with the last window leaves every later
  // effect waiting forever. A new function here makes preact schedule its next flush on this window's frames.
  options.requestAnimationFrame = (flush) => requestAnimationFrame(flush)
}

export async function unregisterDom(): Promise<void> {
  // let frames already asked for (preact's effects, the store's repaint) run in the window that asked for them
  await new Promise((r) => requestAnimationFrame(r))
  await GlobalRegistrator.unregister()
  // the window's requestAnimationFrame is gone with it: hand preact back its own scheduler
  delete options.requestAnimationFrame
}
