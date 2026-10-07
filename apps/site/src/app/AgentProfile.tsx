import { useRef, useState } from 'preact/hooks'
import { cleanName, MAX_INSTRUCTIONS_CHARS, profileRev, type Kurultay } from '@kurultay/core'
import { AvatarError, pictureFromFile } from './avatar'
import { toast } from './store'
import { Avatar, Icon } from './ui'

/** The agent's picture: its own or, when none is chosen, the animated avatar from its name, exactly as councils see it. */
export function AvatarPicker({ name, value, onChange }: { name: string; value?: string; onChange: (picture?: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const pick = (file?: File) =>
    file &&
    pictureFromFile(file)
      .then((url) => (onChange(url), setError('')))
      // only our own typed errors are meant for people; anything else is a bug and stays loud
      .catch((err: unknown) => {
        if (!(err instanceof AvatarError)) throw err
        setError(err.message)
      })
  return (
    <div class="avatar-picker" data-testid="avatar-picker">
      <Avatar name={name} kind="agent" picture={value} size={64} />
      <div class="avatar-picker-actions">
        <span class="field-label">Picture</span>
        <div class="row">
          <button class="btn small" type="button" onClick={() => input.current?.click()} data-testid="avatar-upload">
            <Icon name="upload" size={14} /> Upload…
          </button>
          {value && (
            <button class="btn small ghost" type="button" onClick={() => onChange(undefined)} data-testid="avatar-reset">
              Use the default
            </button>
          )}
        </div>
        <span class="member-meta">{value ? 'Your picture, shown in every council.' : 'An animated avatar made from its name.'}</span>
        {error && (
          <span class="error" role="alert" data-testid="avatar-error">
            {error}
          </span>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        class="sr-only"
        tabIndex={-1}
        data-testid="avatar-file"
        onChange={(ev) => {
          const el = ev.currentTarget
          void pick(el.files?.[0])
          el.value = ''
        }}
      />
    </div>
  )
}

export function InstructionsField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  return (
    <label class="field">
      <span class="field-label">Instructions</span>
      <textarea
        class="input"
        rows={4}
        maxLength={MAX_INSTRUCTIONS_CHARS}
        value={value}
        placeholder="e.g. You review pull requests for this team. Be concise, and check for security problems first."
        onInput={(ev) => onChange(ev.currentTarget.value)}
        data-testid="agent-instructions"
      />
      <span class="member-meta">
        Standing orders for how it answers when tagged. They shape its role and style and never widen what it may do. {value.length}/{MAX_INSTRUCTIONS_CHARS}
      </span>
    </label>
  )
}

type Draft = Readonly<{ name: string; avatar?: string; instructions: string }>

/** The agent's name, picture and instructions, edited by its owner and saved together. */
export function AgentProfileEditor({ e, pubkey, current }: { e: Kurultay; pubkey: string; current: string }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const wanted = e.state.agentNames?.[pubkey]
  const avatar = e.state.agentAvatars?.[pubkey]
  const instructions = e.state.agentInstructions?.[pubkey]
  const reported = e.state.agentStatus?.[pubkey]
  // the agent reports a fingerprint of the profile it holds; a different one means it has not applied ours yet
  const pending = (!!wanted && wanted !== current) || (!!reported && (reported.profile ?? '') !== profileRev(avatar, instructions))
  const clean = draft && cleanName(draft.name)
  const update = (patch: Partial<Draft>) => setDraft((d) => d && { ...d, ...patch })

  if (!draft)
    return (
      <div class="member-name agent-name">
        {current}
        <button class="icon-btn" type="button" title="Edit profile" aria-label={`Edit ${current}`} onClick={() => setDraft({ name: wanted ?? current, avatar, instructions: instructions ?? '' })} data-testid="agent-profile-edit">
          <Icon name="pencil" size={14} />
        </button>
        {pending && <span class="member-meta"> → {wanted && wanted !== current ? `${wanted}, ` : ''}applies when it’s next online</span>}
      </div>
    )

  const save = () =>
    clean &&
    e
      .setAgentProfile(pubkey, { name: clean, avatar: draft.avatar ?? null, instructions: draft.instructions.trim() || null })
      .then(() => (setDraft(null), toast(`Saved ${clean}’s profile`)))
      .catch((x: unknown) => toast(x instanceof Error ? x.message : String(x), 'error'))

  return (
    <form
      class="agent-profile"
      data-testid="agent-profile-form"
      onSubmit={(ev) => {
        ev.preventDefault()
        void save()
      }}
    >
      <label class="field">
        <span class="field-label">Name</span>
        <input
          class="input"
          value={draft.name}
          aria-label="Agent name"
          maxLength={48}
          autoFocus
          onInput={(ev) => update({ name: ev.currentTarget.value })}
          onKeyDown={(ev) => ev.key === 'Escape' && setDraft(null)}
          data-testid="agent-name-input"
        />
        <span class="member-meta">{clean ? `Others will see and @mention it as ${clean}` : 'Letters, digits and _ # . - only'}</span>
      </label>
      <AvatarPicker name={clean ?? current} value={draft.avatar} onChange={(picture) => update({ avatar: picture })} />
      <InstructionsField value={draft.instructions} onChange={(text) => update({ instructions: text })} />
      <div class="row end">
        <button class="btn small" type="button" onClick={() => setDraft(null)} data-testid="agent-profile-cancel">
          Cancel
        </button>
        <button class="btn small primary" type="submit" disabled={!clean} data-testid="agent-profile-save">
          Save
        </button>
      </div>
    </form>
  )
}
