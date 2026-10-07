import { previewSound, setPrefs, usePrefs } from './store'
import { SOUND_SCOPES, type Prefs, type SoundScope } from './prefs'

const SCOPE_LABEL: Record<SoundScope, string> = {
  all: 'Every new message',
  direct: 'Only messages for me (mentions, @all, direct messages, tasks, replies in my threads)',
}

type Flag = { [K in keyof Prefs]: Prefs[K] extends boolean ? K : never }[keyof Prefs]

function Switch({ prefs, flag, title, hint, disabled }: { prefs: Prefs; flag: Flag; title: string; hint: string; disabled?: boolean }) {
  return (
    <label class="perm-switch">
      <span class="perm-text">
        <strong>{title}</strong>
        <span class="member-meta">{hint}</span>
      </span>
      <input type="checkbox" role="switch" class="toggle" disabled={disabled} checked={prefs[flag]} aria-label={title} data-testid={`pref-${flag}`} onChange={(ev) => setPrefs({ [flag]: ev.currentTarget.checked })} />
    </label>
  )
}

/** Sounds and visual alerts, kept in this browser. */
export function NotificationSettings() {
  const prefs = usePrefs()
  const off = !prefs.sound
  return (
    <section class="block" data-testid="notification-settings">
      <h2>Notifications and sounds</h2>
      <p class="muted">
        New messages show as a soft sound, a banner, an unread count next to each council and in the tab title. Sounds are made in your browser; nothing is downloaded.
        These settings are kept in this browser only.
      </p>

      <Switch prefs={prefs} flag="sound" title="Sounds" hint="A gentle tone when a message arrives. Browsers only allow sound after you have tapped or typed in the app once." />

      <div class={`pref-group ${off ? 'is-off' : ''}`}>
        <label class="field">
          <span class="field-label">Volume {Math.round(prefs.volume * 100)}%</span>
          <input
            class="pref-volume"
            type="range"
            min="0"
            max="100"
            step="5"
            disabled={off}
            value={Math.round(prefs.volume * 100)}
            aria-label="Volume"
            data-testid="pref-volume"
            onInput={(ev) => setPrefs({ volume: Number(ev.currentTarget.value) / 100 })}
            onChange={() => void previewSound('message')}
          />
        </label>

        <label class="field">
          <span class="field-label">Play a sound for</span>
          <select class="input" value={prefs.scope} disabled={off} data-testid="pref-scope" onChange={(ev) => setPrefs({ scope: SOUND_SCOPES.find((s) => s === ev.currentTarget.value) ?? prefs.scope })}>
            {SOUND_SCOPES.map((s) => (
              <option key={s} value={s}>
                {SCOPE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>

        <Switch prefs={prefs} flag="soundWhenOpen" title="Also in the council I am looking at" hint="Played more quietly. Turn off to hear only councils you are not in." disabled={off} />
        <Switch prefs={prefs} flag="vibrate" title="Vibrate" hint="A short buzz with the sound while you are away from the council, on phones that support it." disabled={off} />

        <div class="row">
          <button class="btn small" data-testid="test-message-sound" onClick={() => void previewSound('message')} disabled={off}>
            Try a message
          </button>
          <button class="btn small" data-testid="test-mention-sound" onClick={() => void previewSound('mention')} disabled={off}>
            Try a mention
          </button>
        </div>
      </div>

      <Switch prefs={prefs} flag="banners" title="Banners" hint="A banner you can tap when a message arrives in a council you are not looking at." />
      <Switch prefs={prefs} flag="titleBadge" title="Unread count in the tab title and icon" hint="Shows (3) in the tab title and a dot on the page icon." />
    </section>
  )
}
