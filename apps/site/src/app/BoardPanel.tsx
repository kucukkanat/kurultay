import { useEffect, useRef, useState } from 'preact/hooks'
import type { GroupState, Kurultay } from '@kurultay/core'
import { isDark } from '../shared/theme'
import { Icon } from './ui'
import { toast } from './store'
import type { BoardHandle } from './board/excalidraw'

/** Esc leaves a full-screen board, except while writing text on it, where Excalidraw uses Esc to finish the text. */
export const escLeavesFullBoard = (ev: Pick<KeyboardEvent, 'key' | 'target'>): boolean =>
  ev.key === 'Escape' && !(ev.target instanceof Element && ev.target.closest('.excalidraw textarea'))

/**
 * The council board, beside the chat or full screen. The drawing surface is Excalidraw in its own React root, loaded the
 * first time a board opens so the chat (and the landing page) never carry it. Every stroke is encrypted for this council.
 */
export function BoardPanel({ e, g, full, toggleFull, close }: { e: Kurultay; g: GroupState; full: boolean; toggleFull: () => void; close: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const handle = useRef<BoardHandle | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  // the app re-renders on every change, including the theme switch in Settings; the board follows
  const theme = isDark() ? 'dark' : 'light'

  useEffect(() => {
    let gone = false
    setStatus('loading')
    import('./board/excalidraw')
      .then(({ mountBoard }) => {
        if (gone || !host.current) return
        handle.current = mountBoard(host.current, { e, groupId: g.id, theme, onError: (m) => toast(m, 'error') })
        setStatus('ready')
      })
      .catch(() => !gone && setStatus('failed'))
    return () => {
      gone = true
      handle.current?.destroy()
      handle.current = null
    }
  }, [g.id])

  useEffect(() => handle.current?.setTheme(theme), [theme])

  return (
    <aside class={`board-panel ${full ? 'full' : ''}`} aria-label="Board" data-testid="board-panel">
      <header class="panel-head board-head">
        <div class="board-title">
          <h2>Board</h2>
          <span class="board-lock" title="Only members of this council can see the board. It is encrypted like messages and no server keeps it." data-testid="board-encrypted">
            <Icon name="shield" size={14} /> Encrypted for this council
          </span>
        </div>
        <button class="icon-btn" onClick={toggleFull} aria-label={full ? 'Back to the side panel' : 'Full screen'} title={full ? 'Back to the side panel (Esc)' : 'Full screen'} aria-pressed={full} data-testid="board-expand">
          <Icon name={full ? 'collapse' : 'expand'} />
        </button>
        <button class="icon-btn" onClick={close} aria-label="Close the board" title="Close the board" data-testid="board-close">
          <Icon name="x" />
        </button>
      </header>
      {status === 'loading' && (
        <p class="board-status" data-testid="board-loading">
          Opening the board…
        </p>
      )}
      {status === 'failed' && (
        <p class="board-status error" data-testid="board-failed">
          The board could not load. Check your connection and open it again.
        </p>
      )}
      <div class="board-canvas" ref={host} data-testid="board-canvas" />
    </aside>
  )
}
