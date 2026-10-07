// The board's React island. The app is Preact; Excalidraw is a React component, so it gets a real React root of its own
// inside the panel, loaded only when someone opens a board. Everything that crosses into the council goes through the
// engine (drawBoard, requestBoard, boardPointer), which encrypts it with the council's key like a chat message.
import { createElement, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { CaptureUpdateAction, Excalidraw, restoreElements } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { Kurultay } from '@kurultay/core'
import { applyRemote, CURSOR_TTL_MS, cursorColor, liveCursors, markKnown, takeUnsent, throttle, type Cursor } from './sync'

export type BoardTheme = 'light' | 'dark'

export interface BoardOptions {
  e: Kurultay
  groupId: string
  theme: BoardTheme
  /** told when sending fails (rate limit, muted, paused), to show the reason */
  onError: (message: string) => void
}

export interface BoardHandle {
  setTheme(theme: BoardTheme): void
  destroy(): void
}

/** Local edits go out at most this often: a drag becomes a few small envelopes a second, not one per frame. */
const SEND_MS = 120
const POINTER_MS = 90

/** Elements from the engine (sanitized JSON) as Excalidraw elements, with any missing defaults filled in. */
const restore = (els: readonly unknown[]): ExcalidrawElement[] => restoreElements(els as readonly ExcalidrawElement[], null)

function Board({ e, groupId, theme, onError }: BoardOptions) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  // versions already in the council, per element: a local edit is whatever differs from these
  const sent = useRef(new Map<string, number>())
  const cursors = useRef(new Map<string, Cursor>())
  const initial = useRef<ExcalidrawElement[] | null>(null)
  if (!initial.current) {
    initial.current = restore(Object.values(e.boardScene(groupId)))
    markKnown(sent.current, initial.current)
  }

  /** Brings elements from the council into the scene as remote changes (outside my undo history). */
  const merge = (elements: readonly unknown[], full: boolean) => {
    const a = api.current
    if (!a) return
    const incoming = restore(elements)
    markKnown(sent.current, incoming)
    const wasEmpty = !a.getSceneElements().length
    const next = applyRemote(a.getSceneElementsIncludingDeleted(), incoming)
    if (!next) return
    a.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER })
    // the council's board arrived while nothing was on screen: bring it into view once; later drawings never move my view
    if (full && wasEmpty) a.scrollToContent(undefined, { fitToContent: true, animate: true })
  }

  useEffect(() => {
    const showCursors = () => {
      const collaborators = new Map<SocketId, Collaborator>(
        liveCursors(cursors.current, Date.now()).map(([pk, c]) => [pk as SocketId, { username: c.name, pointer: { x: c.x, y: c.y, tool: 'pointer' }, color: cursorColor(pk), id: pk }]),
      )
      api.current?.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER })
    }
    const offBoard = e.on('board', (ev) => {
      if (ev.groupId === groupId && ev.from !== e.pubkey) merge(ev.elements, ev.full)
    })
    const offPointer = e.on('pointer', (p) => {
      if (p.groupId !== groupId) return
      cursors.current.set(p.from, { x: p.x, y: p.y, name: e.displayName(groupId, p.from), at: Date.now() })
      showCursors()
    })
    const sweep = setInterval(showCursors, CURSOR_TTL_MS / 2)
    // whoever has the board sends it; what arrives merges into what this device already had
    e.requestBoard(groupId).catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
    return () => {
      offBoard()
      offPointer()
      clearInterval(sweep)
    }
  }, [e, groupId])

  // Excalidraw bumps the version of what a local edit changed: send exactly those, a few times a second at most
  const pointer = useRef(throttle(POINTER_MS, (x: number, y: number) => void e.boardPointer(groupId, x, y).catch(() => {})))
  const onChange = useRef(
    throttle(SEND_MS, () => {
      const scene = api.current?.getSceneElementsIncludingDeleted()
      const out = scene ? takeUnsent(sent.current, scene) : []
      if (out.length) e.drawBoard(groupId, out).catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
    }),
  )
  useEffect(
    () => () => {
      pointer.current.cancel()
      onChange.current.cancel()
    },
    [],
  )

  return createElement(Excalidraw, {
    excalidrawAPI: (a: ExcalidrawImperativeAPI) => {
      api.current = a
      // whatever reached the engine while Excalidraw was starting is in the scene from its first frame
      requestAnimationFrame(() => merge(Object.values(e.boardScene(groupId)), false))
    },
    initialData: { elements: initial.current, scrollToContent: true },
    onChange: () => onChange.current(),
    onPointerUpdate: ({ pointer: p }) => pointer.current(p.x, p.y),
    theme,
    isCollaborating: true,
    // nothing on this board may load from outside the council: no images or embeds, no opening or saving files
    UIOptions: { tools: { image: false }, canvasActions: { loadScene: false, saveToActiveFile: false } },
    validateEmbeddable: false,
    name: e.state.groups[groupId]?.roster.name ?? 'board',
  })
}

/** Mounts a board into `el` (a React root of its own); the handle switches its theme and takes it down. */
export function mountBoard(el: HTMLElement, opts: BoardOptions): BoardHandle {
  const root = createRoot(el)
  let current = opts
  const render = () => root.render(createElement(Board, current))
  render()
  return {
    setTheme(theme) {
      if (theme === current.theme) return
      current = { ...current, theme }
      render()
    },
    destroy: () => root.unmount(),
  }
}
