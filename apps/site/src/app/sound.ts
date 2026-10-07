/** `message` is any incoming message, `mention` one that is for me. */
export type SoundKind = 'message' | 'mention'

export interface Note {
  /** Hz */
  freq: number
  /** seconds after the sound starts */
  at: number
  /** seconds the note rings */
  dur: number
  /** peak gain, 0..1, before the person's volume */
  gain: number
  wave: 'sine' | 'triangle'
}

/**
 * Synthesised, not recorded: soft sine notes with a fast attack and a long decay, so nothing ships as an asset and nothing
 * is ever harsh. The gains are deliberately low (the tests cap them); the volume setting scales them further.
 */
const SCRIPTS: Readonly<Record<SoundKind, readonly Note[]>> = {
  message: [{ freq: 659.25, at: 0, dur: 0.32, gain: 0.16, wave: 'sine' }],
  mention: [
    { freq: 659.25, at: 0, dur: 0.3, gain: 0.2, wave: 'sine' },
    { freq: 987.77, at: 0.11, dur: 0.45, gain: 0.2, wave: 'sine' },
  ],
}

export const toneScript = (kind: SoundKind): readonly Note[] => SCRIPTS[kind]

/** Messages for the council I am looking at are quieter than ones that pull me back to the app. */
export const QUIET_FACTOR = 0.6
/** A burst of messages is one sound, not a rattle. */
export const MIN_GAP_MS = 500

export const gapAllows = (lastMs: number, nowMs: number, force = false) => force || nowMs - lastMs >= MIN_GAP_MS

let lastPlayed = Number.NEGATIVE_INFINITY

/**
 * Play a tone at `volume` (0..1). The context and the clock are parameters so the rules stay testable without a browser.
 * Returns false when nothing played: no audio, still locked by the autoplay policy, or too soon after the last sound.
 */
export function playSound(ctx: BaseAudioContext | null, kind: SoundKind, volume: number, opts: { quiet?: boolean; force?: boolean; now?: number } = {}): boolean {
  const now = opts.now ?? Date.now()
  if (!ctx || ctx.state !== 'running' || !gapAllows(lastPlayed, now, opts.force)) return false
  lastPlayed = now
  const out = ctx.createGain()
  out.gain.value = volume * (opts.quiet ? QUIET_FACTOR : 1)
  // rounding off the top end is what makes a synthesised beep sound soft instead of electronic
  const soften = ctx.createBiquadFilter()
  soften.type = 'lowpass'
  soften.frequency.value = 2400
  out.connect(soften).connect(ctx.destination)
  const t0 = ctx.currentTime + 0.01
  for (const n of toneScript(kind)) {
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = n.wave
    osc.frequency.setValueAtTime(n.freq, t0 + n.at)
    env.gain.setValueAtTime(0.0001, t0 + n.at)
    env.gain.linearRampToValueAtTime(n.gain, t0 + n.at + 0.012)
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur)
    osc.connect(env).connect(out)
    osc.start(t0 + n.at)
    osc.stop(t0 + n.at + n.dur + 0.05)
  }
  return true
}

let shared: AudioContext | null = null

/** One context for the page, made on first use; null where Web Audio is missing. */
export function audioContext(): AudioContext | null {
  if (!shared && typeof AudioContext === 'function') shared = new AudioContext()
  return shared
}

/** Browsers keep audio locked until the person touches the page; call this from a gesture. True once sound can play. */
export async function unlockAudio(): Promise<boolean> {
  const c = audioContext()
  if (c?.state === 'suspended') await c.resume()
  return c?.state === 'running'
}
