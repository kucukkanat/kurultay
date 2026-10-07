import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { decodeLink, shortKey, type GroupState, type Kurultay, type Message, type Task } from '@kurultay/core'
import { appUrl, devMode, getBlossom, getRelays, markRead, setBlossomPref, setDevMode, setRelaysPref, toast, toasts, typingMap, unreadCount, useEngine, useStore } from './store'
import { watchWord } from './devmode'
import { Avatar, CopyField, Icon, Modal, Rich, timeOf } from './ui'
import { Attachments, filesFrom, PendingChips, usePendingFiles, type PendingFiles } from './files'
import { DevDrawer } from './Dev'
import { AddAgentDialog, AgentsList, MODES, myAgents } from './agents'
import { forgetIdentity, loadIdentity, lockIdentity, nsecOf, renameIdentity } from './identity'
import { isDark, toggleTheme } from '../shared/theme'

type View = { kind: 'group'; id: string } | { kind: 'agents' } | { kind: 'approvals' } | { kind: 'settings' } | { kind: 'welcome' }
type Dialog = null | { kind: 'new' } | { kind: 'invite'; groupId: string } | { kind: 'join'; link?: string } | { kind: 'agents'; groupId?: string }

export function Shell({ initialJoin }: { initialJoin?: string }) {
  useStore()
  const e = useEngine()
  const groups = e.groups()
  const [view, setView] = useState<View>(() => (groups[0] ? { kind: 'group', id: groups[0].id } : { kind: 'welcome' }))
  const [dialog, setDialog] = useState<Dialog>(initialJoin ? { kind: 'join', link: initialJoin } : null)
  const [navOpen, setNavOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(() => matchMedia('(min-width: 1100px)').matches)
  const dev = devMode()

  // the visible switch is gone: typing the dev word toggles developer mode (see devmode.ts)
  useEffect(
    () =>
      watchWord(() => {
        const on = !devMode()
        setDevMode(on)
        toast(on ? 'Developer mode on' : 'Developer mode off')
      }),
    [],
  )

  // fall back when the open group disappears (left or removed)
  useEffect(() => {
    if (view.kind === 'group' && !e.state.groups[view.id]) setView(groups[0] ? { kind: 'group', id: groups[0].id } : { kind: 'welcome' })
  })

  const go = (v: View) => {
    setView(v)
    setNavOpen(false)
  }

  const approvals = Object.values(e.state.approvals)

  return (
    <div class={`shell ${dev ? 'with-dev' : ''} ${navOpen ? 'nav-open' : ''}`}>
      <aside class="sidebar" aria-label="Navigation">
        <div class="side-top">
          <a class="brand" href="../" title="Kurultay home">
            <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
              <circle cx="16" cy="16" r="15" fill="var(--madder)" />
              <path d="M16 7c3 4 5 6.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.6 1 2.5 2 3 0-3 .5-5.5 1-8.5z" fill="#f3c46a" />
            </svg>
            <span>Kurultay</span>
          </a>
        </div>
        <div class="side-actions">
          <button class="btn small" onClick={() => setDialog({ kind: 'new' })}>
            <Icon name="plus" size={16} /> New council
          </button>
          <button class="btn small ghost" onClick={() => setDialog({ kind: 'join' })}>
            <Icon name="link" size={16} /> Join
          </button>
        </div>
        <nav class="side-list">
          <GroupList e={e} title="Councils" groups={groups.filter((g) => !g.roster.dm)} view={view} go={go} empty="No councils yet" />
          <GroupList e={e} title="Direct" groups={groups.filter((g) => g.roster.dm)} view={view} go={go} />
        </nav>
        <div class="side-foot">
          <button class={`side-item ${view.kind === 'approvals' ? 'active' : ''}`} onClick={() => go({ kind: 'approvals' })}>
            <Icon name="inbox" /> Approvals {approvals.length > 0 && <span class="badge hot">{approvals.length}</span>}
          </button>
          <button class={`side-item ${view.kind === 'agents' ? 'active' : ''}`} onClick={() => go({ kind: 'agents' })}>
            <Icon name="bot" /> My agents {myAgents(e).length > 0 && <span class="badge">{myAgents(e).length}</span>}
          </button>
          <button class={`side-item ${view.kind === 'settings' ? 'active' : ''}`} onClick={() => go({ kind: 'settings' })}>
            <Icon name="gear" /> Settings
          </button>
          <div class="me">
            <Avatar name={e.name} kind="human" online />
            <div>
              <div class="me-name">{e.name}</div>
              <div class="me-key" title={e.pubkey}>
                {shortKey(e.pubkey)}
              </div>
            </div>
          </div>
        </div>
      </aside>
      <div class="scrim" onClick={() => setNavOpen(false)} />

      <main class="main">
        {view.kind === 'group' && e.state.groups[view.id] ? (
          <GroupView key={view.id} e={e} g={e.state.groups[view.id]} openNav={() => setNavOpen(true)} membersOpen={membersOpen} toggleMembers={() => setMembersOpen((x) => !x)} invite={() => setDialog({ kind: 'invite', groupId: view.id })} addAgents={() => setDialog({ kind: 'agents', groupId: view.id })} go={go} />
        ) : view.kind === 'agents' ? (
          <AgentsView e={e} openNav={() => setNavOpen(true)} addAgents={() => setDialog({ kind: 'agents' })} />
        ) : view.kind === 'approvals' ? (
          <ApprovalsView e={e} openNav={() => setNavOpen(true)} />
        ) : view.kind === 'settings' ? (
          <SettingsView e={e} openNav={() => setNavOpen(true)} />
        ) : (
          <Welcome openNav={() => setNavOpen(true)} onNew={() => setDialog({ kind: 'new' })} onJoin={() => setDialog({ kind: 'join' })} onAgents={() => setDialog({ kind: 'agents' })} />
        )}
      </main>

      {dev && <DevDrawer e={e} groupId={view.kind === 'group' ? view.id : undefined} />}

      {dialog?.kind === 'new' && (
        <NewGroupDialog
          e={e}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setDialog({ kind: 'invite', groupId: id })
            go({ kind: 'group', id })
          }}
        />
      )}
      {dialog?.kind === 'invite' && <InviteDialog e={e} groupId={dialog.groupId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'agents' && <AddAgentDialog e={e} groupId={dialog.groupId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'join' && <JoinDialog e={e} initial={dialog.link} onClose={() => setDialog(null)} onJoined={(id) => go({ kind: 'group', id })} />}

      <div class="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} class={`toast ${t.level}`} data-testid="toast">
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

function GroupList({ e, title, groups, view, go, empty }: { e: Kurultay; title: string; groups: GroupState[]; view: View; go: (v: View) => void; empty?: string }) {
  if (!groups.length && !empty) return null
  return (
    <div class="side-group">
      <h3>{title}</h3>
      {!groups.length && <p class="side-empty">{empty}</p>}
      {groups.map((g) => {
        const unread = view.kind === 'group' && view.id === g.id ? 0 : unreadCount(e, g.id)
        const label = g.roster.dm ? Object.values(g.roster.members).find((m) => m.pubkey !== e.pubkey)?.name ?? g.roster.name : g.roster.name
        const online = Object.keys(g.roster.members).filter((pk) => pk !== e.pubkey && e.member(g.id, pk)?.online).length
        return (
          <button key={g.id} class={`side-item ${view.kind === 'group' && view.id === g.id ? 'active' : ''}`} onClick={() => go({ kind: 'group', id: g.id })}>
            <span class="glyph">{g.roster.dm ? '@' : '#'}</span>
            <span class="side-name">{label}</span>
            {g.roster.paused && <span title="Agents paused"><Icon name="pause" size={13} /></span>}
            {unread > 0 ? <span class="badge hot">{unread}</span> : online > 0 ? <span class="side-online" title={`${online} online`} /> : null}
          </button>
        )
      })}
    </div>
  )
}

function TopBar({ title, sub, openNav, children }: { title: string; sub?: string; openNav: () => void; children?: preact.ComponentChildren }) {
  return (
    <header class="topbar">
      <button class="icon-btn only-mobile" onClick={openNav} aria-label="Open navigation">
        <Icon name="menu" />
      </button>
      <div class="topbar-title">
        <h1>{title}</h1>
        {sub && <span class="topbar-sub">{sub}</span>}
      </div>
      <div class="topbar-actions">{children}</div>
    </header>
  )
}

// ------------------------------------------------------------------------------------------ group

function GroupView({ e, g, openNav, membersOpen, toggleMembers, invite, addAgents, go }: { e: Kurultay; g: GroupState; openNav: () => void; membersOpen: boolean; toggleMembers: () => void; invite: () => void; addAgents: () => void; go: (v: View) => void }) {
  const isAdmin = e.isAdmin(g.id)
  const members = e.members(g.id)
  const online = members.filter((m) => m.online).length
  const feed = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const names = useMemo(() => new Set(members.flatMap((m) => [m.name.toLowerCase(), m.name.toLowerCase().split('@')[0]])), [members.map((m) => m.name).join()])
  const typers = Object.entries(typingMap[g.id] ?? {})
    .filter(([pk, until]) => until > Date.now() && pk !== e.pubkey)
    .map(([pk]) => e.displayName(g.id, pk))
  const dmPeer = g.roster.dm ? members.find((m) => !m.isMe) : undefined
  const pending = usePendingFiles(e)
  const [dragging, setDragging] = useState(false)
  // attachments belong to the council they were added in
  useEffect(() => () => pending.items.forEach((p) => pending.remove(p.id)), [g.id])

  useEffect(() => {
    markRead(g.id)
    const el = feed.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  })

  const title = dmPeer ? dmPeer.name : g.roster.name
  const sub = dmPeer ? (dmPeer.kind === 'agent' ? 'agent' : 'direct message') : `${members.length} members · ${online} online`

  return (
    <div class={`group-view ${membersOpen ? 'members-open' : ''}`}>
      <div
        class={`conversation ${dragging ? 'dragging' : ''}`}
        onDragOver={(ev) => {
          if (!ev.dataTransfer?.types.includes('Files')) return
          ev.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(ev) => {
          if (!(ev.currentTarget as HTMLElement).contains(ev.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={(ev) => {
          if (!ev.dataTransfer?.files.length) return
          ev.preventDefault()
          setDragging(false)
          pending.add(filesFrom(ev.dataTransfer))
        }}
      >
        {dragging && <div class="drop-hint">Drop to attach. Files are encrypted for this council only.</div>}
        <TopBar title={(dmPeer ? '@' : '#') + title} sub={sub} openNav={openNav}>
          {isAdmin && !g.roster.dm && (
            <button class="btn small ghost" onClick={() => e.moderate(g.id, g.roster.paused ? 'resume' : 'pause').catch((x) => toast(x.message, 'error'))} title={g.roster.paused ? 'Let agents speak again' : 'Stop all agents from speaking'}>
              <Icon name={g.roster.paused ? 'play' : 'pause'} size={16} /> {g.roster.paused ? 'Resume agents' : 'Pause agents'}
            </button>
          )}
          {!g.roster.dm && (
            <button class="btn small primary" onClick={addAgents} aria-label="Add your agents" title="One command seats your agent CLIs in this council">
              <Icon name="bot" size={16} /> Add your agents
            </button>
          )}
          {isAdmin && !g.roster.dm && (
            <button class="btn small" onClick={invite} aria-label="Invite people" title="Invite people">
              <Icon name="link" size={16} /> Invite
            </button>
          )}
          <button class={`icon-btn ${membersOpen ? 'on' : ''}`} onClick={toggleMembers} aria-label="Members and tasks" aria-pressed={membersOpen}>
            <Icon name="users" />
          </button>
        </TopBar>
        {g.roster.paused && <div class="banner">Agents are paused by a moderator. Humans can still talk.</div>}
        <div
          class="feed"
          ref={feed}
          onScroll={(ev) => {
            const el = ev.currentTarget as HTMLDivElement
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          <div class="feed-inner">
            {g.history.length === 0 && <p class="empty">Nothing said yet. Messages from before you joined don't exist anywhere: relays keep nothing.</p>}
            {g.history.map((m, i) => (
              <MessageRow key={m.id} e={e} g={g} m={m} prev={g.history[i - 1]} names={names} />
            ))}
          </div>
        </div>
        <div class="typing-line">{typers.length ? `${typers.join(', ')} ${typers.length > 1 ? 'are' : 'is'} thinking…` : ''}</div>
        <Composer e={e} g={g} pending={pending} />
      </div>
      {membersOpen && <MembersPanel e={e} g={g} close={toggleMembers} go={go} />}
    </div>
  )
}

function MessageRow({ e, g, m, prev, names }: { e: Kurultay; g: GroupState; m: Message; prev?: Message; names: Set<string> }) {
  if (m.type === 'system') return <div class="msg-system">{m.text}</div>
  const who = e.member(g.id, m.from)
  const name = who?.name ?? m.from.slice(0, 8)
  const kind = who?.kind ?? (g.roster.members[m.from]?.kind || 'agent')
  const grouped = prev && prev.from === m.from && prev.type !== 'system' && m.ts - prev.ts < 240 && m.type === 'chat' && prev.type === 'chat'
  const mine = m.from === e.pubkey
  const forMe = (m.mentions ?? []).includes(e.pubkey)
  const parent = m.thread ? g.history.find((x) => x.id === m.thread) : undefined

  if (m.type === 'task_update') {
    const t = m.taskId ? g.tasks[m.taskId] : undefined
    return (
      <div class="msg-system task-line">
        <strong>{name}</strong> marked <em>{t?.title ?? 'a task'}</em> {m.text.split(':')[0]}
      </div>
    )
  }

  return (
    <div class={`msg ${grouped ? 'grouped' : ''} ${mine ? 'mine' : ''} ${forMe ? 'for-me' : ''}`}>
      <div class="msg-gutter">{!grouped && <Avatar name={name} kind={kind} />}</div>
      <div class="msg-body">
        {!grouped && (
          <div class="msg-head">
            <span class="msg-name">{name}</span>
            <span class={`kind-tag ${kind}`}>{kind}</span>
            {who?.verified && <span class="owner-tag" title={`Certified by ${who.verified.ownerName} (${shortKey(who.verified.owner)})`}>{who.verified.owner === e.pubkey ? 'yours' : `${who.verified.ownerName}'s`}</span>}
            {kind === 'agent' && !who?.verified && <span class="owner-tag unverified">unverified</span>}
            <time>{timeOf(m.ts)}</time>
          </div>
        )}
        {parent && (
          <div class="reply-to">
            ↳ {e.displayName(g.id, parent.from)}: {parent.text.slice(0, 80) || (parent.files ?? []).map((f) => f.name).join(", ")}
          </div>
        )}
        {m.type === 'task' && m.taskId && g.tasks[m.taskId] ? (
          <TaskCard e={e} g={g} t={g.tasks[m.taskId]} />
        ) : (
          m.text && (
            <div class="msg-text">
              <Rich text={m.text} names={names} />
            </div>
          )
        )}
        {m.files && <Attachments e={e} files={m.files} />}
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<Task['status'], string> = { pending: 'Pending', working: 'Working', done: 'Done', failed: 'Failed', rejected: 'Declined' }

function TaskCard({ e, g, t }: { e: Kurultay; g: GroupState; t: Task }) {
  const [output, setOutput] = useState('')
  const [open, setOpen] = useState(false)
  const mineToDo = t.to === e.pubkey && (t.status === 'pending' || t.status === 'working')
  const update = (status: Task['status']) =>
    e
      .updateTask(g.id, t.taskId, status, output.trim() || undefined)
      .then(() => {
        setOutput('')
        setOpen(false)
      })
      .catch((x) => toast(x.message, 'error'))
  return (
    <div class={`task-card ${t.status}`}>
      <div class="task-top">
        <Icon name="task" size={16} />
        <span>
          Task for <strong>{e.displayName(g.id, t.to)}</strong>
        </span>
        <span class={`status ${t.status}`}>{STATUS_LABEL[t.status]}</span>
      </div>
      <div class="task-title">{t.title}</div>
      {t.input && <div class="task-input">{t.input}</div>}
      {t.output && (
        <div class="task-output">
          <span class="field-label">Result</span>
          {t.output}
        </div>
      )}
      {mineToDo &&
        (open ? (
          <div class="task-act">
            <textarea rows={2} value={output} onInput={(ev) => setOutput((ev.target as HTMLTextAreaElement).value)} placeholder="Result or note (optional)" />
            <div class="row">
              <button class="btn small primary" onClick={() => update('done')}>
                Mark done
              </button>
              <button class="btn small" onClick={() => update('failed')}>
                Failed
              </button>
              <button class="btn small ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div class="row">
            {t.status === 'pending' && (
              <button class="btn small" onClick={() => update('working')}>
                Start
              </button>
            )}
            <button class="btn small" onClick={() => setOpen(true)}>
              Finish…
            </button>
            {t.status === 'pending' && (
              <button class="btn small ghost" onClick={() => update('rejected')}>
                Decline
              </button>
            )}
          </div>
        ))}
    </div>
  )
}

function Composer({ e, g, pending }: { e: Kurultay; g: GroupState; pending: PendingFiles }) {
  const picker = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'chat' | 'task'>('chat')
  const [assignee, setAssignee] = useState('')
  const [suggest, setSuggest] = useState<{ q: string; idx: number } | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const members = e.members(g.id).filter((m) => !m.isMe)
  const muted = g.roster.muted.includes(e.pubkey)

  const matches = suggest ? [...members.map((m) => m.name), 'all'].filter((n) => n.toLowerCase().startsWith(suggest.q.toLowerCase())).slice(0, 6) : []

  const onInput = (v: string) => {
    setText(v)
    const el = ta.current
    if (!el) return
    const upto = v.slice(0, el.selectionStart ?? v.length)
    const m = upto.match(/(?:^|\s)@([\w#.\-@]*)$/)
    setSuggest(m ? { q: m[1], idx: 0 } : null)
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  const pick = (name: string) => {
    const el = ta.current!
    const pos = el.selectionStart ?? text.length
    const before = text.slice(0, pos).replace(/@([\w#.\-@]*)$/, '@' + name + ' ')
    const next = before + text.slice(pos)
    setText(next)
    setSuggest(null)
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = before.length
    })
  }

  const submit = async () => {
    const body = text.trim()
    const files = mode === 'chat' ? pending.refs : []
    if (!body && !files.length) return
    if (pending.busy) return toast('Still uploading. It sends when you press again after the upload finishes.', 'info')
    try {
      if (mode === 'task') {
        if (!assignee) return toast('Choose who the task is for', 'warn')
        const [title, ...rest] = body.split('\n')
        await e.sendTask(g.id, assignee, title.trim(), rest.join('\n').trim() || undefined)
        setMode('chat')
      } else {
        await e.send(g.id, body, { files })
        pending.clear()
      }
      setText('')
      if (ta.current) ta.current.style.height = 'auto'
    } catch (x) {
      toast((x as Error).message, 'error')
    }
  }

  const onKey = (ev: KeyboardEvent) => {
    if (suggest && matches.length) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault()
        const d = ev.key === 'ArrowDown' ? 1 : -1
        setSuggest({ ...suggest, idx: (suggest.idx + d + matches.length) % matches.length })
        return
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault()
        pick(matches[suggest.idx])
        return
      }
      if (ev.key === 'Escape') return setSuggest(null)
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault()
      submit()
    }
  }

  let typingTimer = useRef<number>()
  useEffect(() => {
    if (!text) return
    if (!typingTimer.current) void e.typing(g.id, true).catch(() => {})
    clearTimeout(typingTimer.current)
    typingTimer.current = window.setTimeout(() => {
      typingTimer.current = undefined
      void e.typing(g.id, false).catch(() => {})
    }, 4000)
  }, [text])

  if (muted) return <div class="composer muted-note">A moderator muted you in this council.</div>

  return (
    <div class="composer">
      {mode === 'chat' && <PendingChips pending={pending} />}
      {suggest && matches.length > 0 && (
        <ul class="suggest" role="listbox">
          {matches.map((n, i) => (
            <li key={n} role="option" aria-selected={i === suggest.idx} class={i === suggest.idx ? 'on' : ''} onMouseDown={(ev) => (ev.preventDefault(), pick(n))}>
              @{n}
            </li>
          ))}
        </ul>
      )}
      {mode === 'task' && (
        <div class="task-mode">
          <Icon name="task" size={16} />
          <span>Task for</span>
          <select value={assignee} onChange={(ev) => setAssignee((ev.target as HTMLSelectElement).value)} aria-label="Assignee">
            <option value="">choose…</option>
            {members.map((m) => (
              <option key={m.pubkey} value={m.pubkey}>
                {m.name} ({m.kind})
              </option>
            ))}
          </select>
          <span class="hint">First line is the title, the rest is detail.</span>
        </div>
      )}
      <div class="composer-row">
        <button class={`icon-btn ${mode === 'task' ? 'on' : ''}`} onClick={() => setMode(mode === 'task' ? 'chat' : 'task')} aria-pressed={mode === 'task'} title="Assign a task">
          <Icon name="task" />
        </button>
        {mode === 'chat' && (
          <>
            <button class="icon-btn" onClick={() => picker.current?.click()} title="Attach files (encrypted for this council)" aria-label="Attach files">
              <Icon name="clip" />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(ev) => {
                const input = ev.target as HTMLInputElement
                pending.add([...(input.files ?? [])])
                input.value = ''
              }}
            />
          </>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onPaste={(ev) => {
            const files = filesFrom(ev.clipboardData)
            if (!files.length || mode !== 'chat') return
            ev.preventDefault()
            pending.add(files)
          }}
          onInput={(ev) => onInput((ev.target as HTMLTextAreaElement).value)}
          onKeyDown={onKey}
          placeholder={mode === 'task' ? 'Describe the task' : g.roster.dm ? 'Message' : 'Message, or @mention an agent'} aria-label="Message" />
        <button class="btn primary send" onClick={submit} disabled={(!text.trim() && !pending.refs.length) || pending.busy} aria-label="Send" title={pending.busy ? 'Uploading…' : 'Send'}>
          <Icon name="send" />
        </button>
      </div>
    </div>
  )
}

function MembersPanel({ e, g, close, go }: { e: Kurultay; g: GroupState; close: () => void; go: (v: View) => void }) {
  const isAdmin = e.isAdmin(g.id)
  const members = e.members(g.id)
  const [menu, setMenu] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const openTasks = Object.values(g.tasks)
    .filter((t) => t.status === 'pending' || t.status === 'working')
    .sort((a, b) => b.createdAt - a.createdAt)
  const act = (p: Promise<unknown>) => p.catch((x) => toast((x as Error).message, 'error')).finally(() => setMenu(null))

  return (
    <aside class="members" aria-label="Members">
      <header class="panel-head">
        <h2>Members</h2>
        <button class="icon-btn" onClick={close} aria-label="Close members">
          <Icon name="x" />
        </button>
      </header>
      <ul class="member-list">
        {members.map((m) => (
          <li key={m.pubkey} class="member">
            <Avatar name={m.name} kind={m.kind} online={m.online} />
            <div class="member-main">
              <div class="member-name">
                {m.name}
                {m.isMe && <span class="you"> (you)</span>}
                {m.role === 'admin' && <span class="role">admin</span>}
                {m.muted && <span class="role">muted</span>}
              </div>
              <div class="member-meta">
                {m.kind}
                {m.verified ? ` · ${m.verified.owner === e.pubkey ? 'yours' : `owned by ${m.verified.ownerName}`}` : m.kind === 'agent' ? ' · unverified' : ''}
                {m.verified?.owner === e.pubkey && e.state.agentStatus?.[m.pubkey]?.background ? ` · answers in background (${MODES.find((x) => x.id === (e.state.agentModes?.[m.pubkey] ?? e.state.agentStatus![m.pubkey].mode))?.label})` : ''}
                {m.card?.client && ` · ${m.card.client}`}
              </div>
              {m.card?.description && <div class="member-card">{m.card.description}</div>}
              {m.card?.skills?.length ? (
                <div class="skills">
                  {m.card.skills.map((s) => (
                    <span key={s}>{s}</span>
                  ))}
                </div>
              ) : null}
            </div>
            {!m.isMe && (
              <div class="member-actions">
                <button class="icon-btn" onClick={() => setMenu(menu === m.pubkey ? null : m.pubkey)} aria-label={`Actions for ${m.name}`} aria-expanded={menu === m.pubkey}>
                  <Icon name="more" />
                </button>
                {menu === m.pubkey && (
                  <div class="menu" role="menu">
                    <button role="menuitem" onClick={() => act(e.openDM(m.pubkey).then((id) => go({ kind: 'group', id })))}>
                      Message directly
                    </button>
                    {isAdmin && !g.roster.dm && (
                      <>
                        <button role="menuitem" onClick={() => act(e.moderate(g.id, m.muted ? 'unmute' : 'mute', m.pubkey))}>
                          {m.muted ? 'Unmute' : 'Mute'}
                        </button>
                        {m.role !== 'admin' && (
                          <button role="menuitem" onClick={() => act(e.moderate(g.id, 'promote', m.pubkey))}>
                            Make admin
                          </button>
                        )}
                        <button role="menuitem" class="danger" onClick={() => (setConfirmRemove(m.pubkey), setMenu(null))}>
                          Remove…
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {confirmRemove === m.pubkey && (
              <div class="confirm inline">
                <p>Remove {m.name}? The group key rotates so they can't read anything new.</p>
                <div class="row">
                  <button class="btn small" onClick={() => setConfirmRemove(null)}>
                    Cancel
                  </button>
                  <button class="btn small danger" onClick={() => (setConfirmRemove(null), act(e.removeMember(g.id, m.pubkey)))}>
                    Remove
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <header class="panel-head">
        <h2>Open tasks</h2>
      </header>
      {openTasks.length === 0 ? (
        <p class="panel-empty">No open tasks. Use the task button next to the message box to hand one out.</p>
      ) : (
        <ul class="task-list">
          {openTasks.map((t) => (
            <li key={t.taskId}>
              <span class={`status ${t.status}`}>{STATUS_LABEL[t.status]}</span>
              <div>
                <div class="task-title small">{t.title}</div>
                <div class="member-meta">
                  {e.displayName(g.id, t.from)} → {e.displayName(g.id, t.to)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {isAdmin && !g.roster.dm && (
        <label class="check panel-check">
          <input type="checkbox" checked={g.roster.allowMemberAgents !== false} onChange={(ev) => act(e.moderate(g.id, (ev.target as HTMLInputElement).checked ? 'allow-agents' : 'deny-agents'))} />
          <span>
            Members can bring their agents
            <small>Agents verified as a member's own are let in without approval.</small>
          </span>
        </label>
      )}
      <div class="panel-foot">
        <button class="btn small ghost" onClick={() => e.leave(g.id).catch((x) => toast(x.message, 'error'))}>
          Leave {g.roster.dm ? 'conversation' : 'council'}
        </button>
        <span class="member-meta">epoch {g.epoch}</span>
      </div>
    </aside>
  )
}

// ------------------------------------------------------------------------------------------ other views

function Welcome({ openNav, onNew, onJoin, onAgents }: { openNav: () => void; onNew: () => void; onJoin: () => void; onAgents: () => void }) {
  return (
    <div class="page">
      <TopBar title="Welcome" openNav={openNav} />
      <div class="page-body welcome">
        <h2>Gather your first council</h2>
        <p>Start a council and invite people, or join one with a link someone sent you. Then bring your agents with one command.</p>
        <div class="welcome-actions">
          <button class="welcome-card" onClick={onNew}>
            <Icon name="plus" size={22} />
            <strong>New council</strong>
            <span>You become its admin and get an invite link.</span>
          </button>
          <button class="welcome-card" onClick={onJoin}>
            <Icon name="link" size={22} />
            <strong>Join with a link</strong>
            <span>Paste an invite from another admin.</span>
          </button>
          <button class="welcome-card" onClick={onAgents}>
            <Icon name="bot" size={22} />
            <strong>Add your agents</strong>
            <span>One command seats Claude Code, Codex, Copilot CLI, pi, opencode, Cursor or Gemini CLI.</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function AgentsView({ e, openNav, addAgents }: { e: Kurultay; openNav: () => void; addAgents: () => void }) {
  const [label, setLabel] = useState('')
  const [code, setCode] = useState<string | null>(null)
  return (
    <div class="page">
      <TopBar title="My agents" sub="Agents that speak as yours" openNav={openNav} />
      <div class="page-body">
        <section class="block">
          <h2>Add your agents</h2>
          <p class="muted">Pick your agent CLIs and run one command from the folder they should work in. They join your councils, verified as yours, and answer in the background whenever they're tagged, within the permission you set below. No pairing codes, nothing else to run.</p>
          <button class="btn primary" onClick={addAgents}>
            <Icon name="bot" size={16} /> Get the command
          </button>
        </section>
        <section class="block">
          <h2>Your agents</h2>
          <AgentsList e={e} />
        </section>
        <details class="block legacy">
          <summary>Pair an agent that's already running (older flow)</summary>
          <p class="muted">For an agent that already has Kurultay set up: create a code and tell the agent “Pair with Kurultay using this code: …”.</p>
          {code ? (
            <CopyField value={`Pair with Kurultay using this code: ${code}`} multiline />
          ) : (
            <div class="row">
              <input class="input" value={label} onInput={(ev) => setLabel((ev.target as HTMLInputElement).value)} placeholder="Label (optional)" aria-label="Agent label" />
              <button class="btn small" onClick={() => setCode(e.createPairCode(label.trim() || undefined))}>
                Create pairing code
              </button>
            </div>
          )}
        </details>
      </div>
    </div>
  )
}

function ApprovalsView({ e, openNav }: { e: Kurultay; openNav: () => void }) {
  const list = Object.values(e.state.approvals).sort((a, b) => b.createdAt - a.createdAt)
  const decide = (id: string, ok: boolean) => e.approve(id, ok).then(() => toast(ok ? 'Approved' : 'Declined')).catch((x) => toast(x.message, 'error'))
  return (
    <div class="page">
      <TopBar title="Approvals" sub="Requests waiting for you" openNav={openNav} />
      <div class="page-body">
        {list.length === 0 ? (
          <p class="empty">Nothing waiting. Join requests for your councils and your agents' requests to join others show up here.</p>
        ) : (
          <ul class="approval-list">
            {list.map((a) => (
              <li key={a.reqId}>
                <Avatar name={a.requester.name} kind={a.requester.kind} />
                <div class="approval-main">
                  {a.kind === 'agent-join' ? (
                    <p>
                      Your agent <strong>{a.requester.name}</strong> wants to join <strong>{a.groupName}</strong>.
                    </p>
                  ) : (
                    <p>
                      <strong>{a.requester.name}</strong> ({a.requester.kind}
                      {a.requester.attestation ? ', verified owner' : a.requester.kind === 'agent' ? ', unverified' : ''}) wants to join <strong>{a.groupName}</strong>.
                    </p>
                  )}
                  {a.requester.card?.description && <p class="member-card">{a.requester.card.description}</p>}
                  <div class="member-meta">{timeOf(a.createdAt)}</div>
                </div>
                <div class="row">
                  <button class="btn small ghost" onClick={() => decide(a.reqId, false)}>
                    Decline
                  </button>
                  <button class="btn small primary" onClick={() => decide(a.reqId, true)}>
                    Approve
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function SettingsView({ e, openNav }: { e: Kurultay; openNav: () => void }) {
  const [relays, setRelays] = useState(getRelays().join('\n'))
  const [blossom, setBlossom] = useState(getBlossom().join('\n'))
  const [reveal, setReveal] = useState(false)
  const [forget, setForget] = useState(false)
  const [name, setName] = useState(e.name)
  const id = loadIdentity()
  const statuses = e.pool.relays
  const [dark, setDark] = useState(isDark())
  return (
    <div class="page">
      <TopBar title="Settings" openNav={openNav} />
      <div class="page-body">
        <section class="block">
          <h2>Relays</h2>
          <p class="muted">Kurultay only needs relays that forward ephemeral events. Each relay is checked on connect by sending an event to ourselves.</p>
          <table class="relay-table">
            <tbody>
              {statuses.map((r) => (
                <tr key={r.url}>
                  <td>
                    <span class={`dot ${r.status}`} />
                    {r.url}
                  </td>
                  <td>{r.status}</td>
                  <td>{r.ephemeral === null ? 'checking…' : r.ephemeral ? `forwards ephemeral${r.latencyMs ? ` · ${r.latencyMs} ms` : ''}` : 'does not forward ephemeral'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <label class="field">
            <span class="field-label">Relay URLs, one per line</span>
            <textarea class="input mono" rows={4} value={relays} onInput={(ev) => setRelays((ev.target as HTMLTextAreaElement).value)} />
          </label>
          <button
            class="btn small"
            onClick={() => {
              const list = relays
                .split(/\s+/)
                .map((s) => s.trim())
                .filter((s) => /^wss?:\/\//.test(s))
              setRelaysPref(list)
              e.setRelays(list)
              toast('Relays saved')
            }}
          >
            Save relays
          </button>
        </section>

        <section class="block">
          <h2>File servers</h2>
          <p class="muted">
            Attachments are encrypted in this browser with a key only the council receives, then stored on a Blossom server, which sees random bytes from a throwaway key. Your
            uploads are deleted after 24 hours (when this app is next open). Servers are tried in order.
          </p>
          <label class="field">
            <span class="field-label">Blossom server URLs, one per line</span>
            <textarea class="input mono" rows={3} value={blossom} onInput={(ev) => setBlossom((ev.target as HTMLTextAreaElement).value)} />
          </label>
          <button
            class="btn small"
            onClick={() => {
              const list = blossom
                .split(/\s+/)
                .map((s) => s.trim().replace(/\/+$/, ''))
                .filter((s) => /^https:\/\/[^/\s]+$/.test(s) || /^http:\/\/localhost(:\d+)?$/.test(s))
              if (!list.length) return toast('Add at least one https:// server', 'warn')
              setBlossomPref(list)
              e.blossom = list
              setBlossom(list.join('\n'))
              toast('File servers saved')
            }}
          >
            Save file servers
          </button>
        </section>

        <section class="block">
          <h2>Appearance</h2>
          <button class="btn small" onClick={() => (toggleTheme(), setDark(isDark()))}>
            Switch to {dark ? 'light' : 'dark'} mode
          </button>
        </section>

        <section class="block">
          <h2>Identity</h2>
          <label class="field">
            <span class="field-label">Display name (applies to councils you join from now on, after reload)</span>
            <div class="row">
              <input class="input" value={name} onInput={(ev) => setName((ev.target as HTMLInputElement).value)} />
              <button class="btn small" onClick={() => (renameIdentity(name.trim().replace(/\s+/g, '-')), toast('Saved — reload to apply'))}>
                Save
              </button>
            </div>
          </label>
          <CopyField value={e.pubkey} label="Public key (hex)" />
          <p class="muted">Key protection: {id?.mode === 'passkey' ? 'passkey (state encrypted at rest)' : 'local key in this browser'}</p>
          {reveal ? <CopyField value={nsecOf(e.sk)} label="Secret key — anyone with this can speak as you" /> : <button class="btn small" onClick={() => setReveal(true)}>Reveal secret key (nsec)</button>}
          {id?.mode === 'passkey' && (
            <p class="muted">
              This browser stays unlocked between visits.{' '}
              <button class="link-btn" onClick={() => lockIdentity(e.pubkey).then(() => location.reload())}>
                Lock now
              </button>{' '}
              (the next visit asks for your passkey).
            </p>
          )}
        </section>

        <section class="block danger-zone">
          <h2>Leave this browser</h2>
          {forget ? (
            <div class="confirm">
              <p>This deletes your key and every group key from this browser. Export your nsec first if you want to come back.</p>
              <div class="row">
                <button class="btn small" onClick={() => setForget(false)}>
                  Cancel
                </button>
                <button
                  class="btn small danger"
                  onClick={async () => {
                    await e.stop()
                    forgetIdentity(e.pubkey)
                    location.href = appUrl
                  }}
                >
                  Delete key and data
                </button>
              </div>
            </div>
          ) : (
            <button class="btn small danger" onClick={() => setForget(true)}>
              Delete key and data…
            </button>
          )}
        </section>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------------------------ dialogs

function NewGroupDialog({ e, onClose, onCreated }: { e: Kurultay; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  return (
    <Modal title="New council" onClose={onClose}>
      <form
        onSubmit={(ev) => {
          ev.preventDefault()
          if (!name.trim()) return
          onCreated(e.createGroup(name.trim().slice(0, 64)).id)
        }}
      >
        <label class="field">
          <span class="field-label">Name</span>
          <input class="input" value={name} onInput={(ev) => setName((ev.target as HTMLInputElement).value)} placeholder="infra-council" maxLength={64} />
        </label>
        <p class="muted">You'll be its admin. Members and messages are end-to-end encrypted; the relays never learn the name.</p>
        <div class="row end">
          <button type="button" class="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" type="submit" disabled={!name.trim()}>
            Create council
          </button>
        </div>
      </form>
    </Modal>
  )
}

function InviteDialog({ e, groupId, onClose }: { e: Kurultay; groupId: string; onClose: () => void }) {
  const [auto, setAuto] = useState(true)
  const [single, setSingle] = useState(false)
  const [ttl, setTtl] = useState(86400)
  const [link, setLink] = useState('')
  const g = e.state.groups[groupId]
  return (
    <Modal title={`Invite to ${g?.roster.name ?? 'council'}`} onClose={onClose}>
      {!link ? (
        <form
          onSubmit={(ev) => {
            ev.preventDefault()
            setLink(e.createInvite(groupId, { autoAdmit: auto, singleUse: single, ttlSeconds: ttl }))
          }}
        >
          <label class="check">
            <input type="checkbox" checked={auto} onChange={(ev) => setAuto((ev.target as HTMLInputElement).checked)} />
            <span>
              Admit automatically
              <small>Otherwise each request waits in Approvals.</small>
            </span>
          </label>
          <label class="check">
            <input type="checkbox" checked={single} onChange={(ev) => setSingle((ev.target as HTMLInputElement).checked)} />
            <span>
              Single use
              <small>The link stops working after one person joins.</small>
            </span>
          </label>
          <label class="field">
            <span class="field-label">Expires after</span>
            <select class="input" value={ttl} onChange={(ev) => setTtl(Number((ev.target as HTMLSelectElement).value))}>
              <option value={3600}>1 hour</option>
              <option value={86400}>1 day</option>
              <option value={604800}>7 days</option>
              <option value={2592000}>30 days</option>
            </select>
          </label>
          <div class="row end">
            <button class="btn primary" type="submit">
              Create invite link
            </button>
          </div>
        </form>
      ) : (
        <>
          <CopyField value={link} label="Invite link" multiline />
          <p class="muted">The secret is in the part after #, which browsers never send to a server. For an agent, say: “Join this Kurultay council: {'<link>'}”.</p>
          <p class="muted">Keep this app open (or another admin online) so new members can be admitted and receive the key.</p>
          <div class="row end">
            <button class="btn" onClick={() => setLink('')}>
              Another link
            </button>
            <button class="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

function JoinDialog({ e, initial, onClose, onJoined }: { e: Kurultay; initial?: string; onClose: () => void; onJoined: (id: string) => void }) {
  const [link, setLink] = useState(initial ?? '')
  const [status, setStatus] = useState<{ name: string; groupId: string } | null>(null)
  const [err, setErr] = useState('')
  useStore()
  const preview = useMemo(() => {
    try {
      const l = decodeLink(link)
      return l.t === 'invite' ? l : null
    } catch {
      return null
    }
  }, [link])
  const joined = status && e.state.groups[status.groupId]
  const denied = status && Object.values(e.state.pendingJoins).some((p) => p.link.groupId === status.groupId && p.status === 'denied')
  useEffect(() => {
    if (joined) {
      onJoined(status!.groupId)
      onClose()
    }
  }, [joined])
  return (
    <Modal title="Join a council" onClose={onClose}>
      {!status ? (
        <form
          onSubmit={async (ev) => {
            ev.preventDefault()
            setErr('')
            try {
              const l = decodeLink(link)
              if (l.t !== 'invite') throw new Error('That is a pairing code for agents. Paste it into your agent instead.')
              const r = await e.redeem(link)
              if (r.status === 'already-member' || r.status === 'joined') {
                onJoined(l.groupId)
                return onClose()
              }
              setStatus({ name: r.name, groupId: l.groupId })
            } catch (x) {
              setErr((x as Error).message)
            }
          }}
        >
          <label class="field">
            <span class="field-label">Invite link</span>
            <textarea class="input mono" rows={3} value={link} onInput={(ev) => setLink((ev.target as HTMLTextAreaElement).value)} placeholder={`${appUrl}#join=…`} />
          </label>
          {preview && (
            <p class="muted">
              Council <strong>{preview.name}</strong> · expires {timeOf(preview.expiresAt)}
            </p>
          )}
          {err && <p class="error">{err}</p>}
          <div class="row end">
            <button type="button" class="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button class="btn primary" type="submit" disabled={!link.trim()}>
              Ask to join
            </button>
          </div>
        </form>
      ) : denied ? (
        <p class="error">The admin of “{status.name}” declined, or the invite is no longer valid.</p>
      ) : (
        <div class="waiting-block">
          <p class="muted waiting">
            <span class="pulse" /> Asked to join <strong>{status.name}</strong>. Waiting for an admin to let you in…
          </p>
          <p class="muted">The admin's app or agent has to be online. You can close this; you'll get the council as soon as you're admitted.</p>
          <div class="row end">
            <button class="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
