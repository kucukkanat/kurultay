// The council board: a shared Excalidraw scene, without a browser. What an element from a peer may look like (sanitize),
// how two copies of a scene come together (merge), how a scene is cut into envelopes small enough for relays (chunk), how
// an agent draws without Excalidraw (build, edit) and how it reads the scene back (summarize). Elements travel in the
// council's encrypted group channel like chat; nothing here touches the network or knows about React.
import { randomHex } from './util'

/** Drawing elements only. Images, embeds and iframes are left out: they would load content from outside the council. */
export const BOARD_TYPES = ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'freedraw', 'frame'] as const
export type BoardElementType = (typeof BOARD_TYPES)[number]

/** An Excalidraw element as JSON. Only the fields the board reads are typed; the rest travel through untouched. */
export interface BoardElement {
  id: string
  type: BoardElementType
  version: number
  versionNonce: number
  isDeleted: boolean
  updated: number
  x: number
  y: number
  width: number
  height: number
  [field: string]: unknown
}

export type BoardScene = Readonly<Record<string, BoardElement>>

/** A board holds at most this many elements, tombstones included (other copies merge against them). */
export const MAX_BOARD_ELEMENTS = 4000
/** One element as JSON. A long freehand stroke is the largest thing a person draws; this is far above it. */
export const MAX_ELEMENT_BYTES = 24 * 1024
/** One board envelope's elements as JSON: under the 32 KB message limit, with room for the envelope. */
export const MAX_CHUNK_BYTES = 28 * 1024
const MAX_POINTS = 4000
const MAX_TEXT = 4000
const COORD = 1e6

/** A drawing an agent asked for that cannot be made (an arrow to nothing, an edit to a missing element). */
export class BoardError extends Error {}

const enc = new TextEncoder()
const bytes = (v: unknown): number => enc.encode(JSON.stringify(v)).length
const finite = (v: unknown, lo = -COORD, hi = COORD): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isType = (v: unknown): v is BoardElementType => typeof v === 'string' && (BOARD_TYPES as readonly string[]).includes(v)
const isPoint = (p: unknown): boolean => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1])
const optional = (v: unknown, ok: (v: unknown) => boolean): boolean => v === undefined || ok(v)

/**
 * An element from a peer, made safe to merge and render, or null when it cannot be. Peers are council members, but a
 * member's client is not trusted to behave: shapes and sizes are checked, a link must be http(s), and anything that would
 * load outside content is refused.
 */
export function sanitizeElement(input: unknown): BoardElement | null {
  if (!isRecord(input)) return null
  const { id, type, version, versionNonce, isDeleted, x, y, width, height } = input
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || !isType(type)) return null
  if (!isInt(version) || version < 1 || !isInt(versionNonce) || typeof isDeleted !== 'boolean') return null
  if (!finite(x) || !finite(y) || !finite(width, 0) || !finite(height, 0)) return null
  const text = (v: unknown) => typeof v === 'string' && v.length <= MAX_TEXT
  const ref = (v: unknown) => v === null || typeof v === 'string'
  if (!optional(input.text, text) || !optional(input.originalText, text)) return null
  if (!optional(input.points, (p) => Array.isArray(p) && p.length <= MAX_POINTS && p.every(isPoint))) return null
  // fields that name another element must name it by id, or nothing
  if (!optional(input.containerId, ref) || !optional(input.frameId, ref)) return null
  const { customData: _dropped, ...rest } = input
  // a link is the one field Excalidraw turns into navigation: only plain web addresses
  const link = input.link === undefined || (typeof input.link === 'string' && /^https?:\/\/\S{1,2000}$/i.test(input.link)) ? input.link : null
  const out: BoardElement = { ...rest, id, type, version, versionNonce, isDeleted, x, y, width, height, updated: finite(input.updated, 0, 1e14) ? input.updated : 0, ...(link === undefined ? {} : { link }) }
  return bytes(out) <= MAX_ELEMENT_BYTES ? out : null
}

/** The fields the merge rule reads; the app's Excalidraw elements have them too. */
export interface Versioned {
  readonly id: string
  readonly version: number
  readonly versionNonce: number
}

/** Whether `a` should replace `b`: the newer version wins; on a tie the lower nonce wins, so every copy picks the same. */
export const newer = (a: Versioned, b: Versioned | undefined): boolean => !b || a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce)

/**
 * Brings incoming elements into a scene. Returns the next scene (the input is not changed) and the elements that changed
 * it, which is what a renderer applies and what a peer sends. A full board never grows past MAX_BOARD_ELEMENTS: new
 * elements beyond it are refused, edits to known ones still land.
 */
export function mergeElements(scene: BoardScene, incoming: readonly unknown[]): { next: Record<string, BoardElement>; changed: BoardElement[] } {
  const next: Record<string, BoardElement> = { ...scene }
  const changed: BoardElement[] = []
  let count = Object.keys(next).length
  for (const raw of incoming) {
    const el = sanitizeElement(raw)
    if (!el || !newer(el, next[el.id])) continue
    if (!next[el.id]) {
      if (count >= MAX_BOARD_ELEMENTS) continue
      count++
    }
    next[el.id] = el
    changed.push(el)
  }
  return { next, changed }
}

/** Cuts elements into groups whose JSON stays under `max` bytes, keeping their order. */
export function chunkElements(els: readonly BoardElement[], max = MAX_CHUNK_BYTES): BoardElement[][] {
  const out: BoardElement[][] = []
  let cur: BoardElement[] = []
  let size = 2 // the array's brackets
  for (const el of els) {
    const n = bytes(el) + 1 // and its comma
    if (cur.length && size + n > max) {
      out.push(cur)
      cur = []
      size = 2
    }
    cur.push(el)
    size += n
  }
  if (cur.length) out.push(cur)
  return out
}

/** The elements of a scene that are on the board, oldest first. */
export const visible = (scene: BoardScene): BoardElement[] => Object.values(scene).filter((e) => !e.isDeleted)

// ------------------------------------------------------------------ drawing without a browser (agents)

type Point = { x: number; y: number }
/** A box, optionally with words written inside. Coordinates are scene pixels. */
export type ShapeSpec = { kind: 'rectangle' | 'ellipse' | 'diamond'; x: number; y: number; width?: number; height?: number; label?: string; strokeColor?: string; backgroundColor?: string }
export type TextSpec = { kind: 'text'; x: number; y: number; text: string; fontSize?: number; strokeColor?: string }
/** An arrow between elements (an id on the board, or "#n" for the n-th spec of the same call) or points. */
export type ArrowSpec = { kind: 'arrow'; from: string | Point; to: string | Point; label?: string; strokeColor?: string }
export type DrawSpec = ShapeSpec | TextSpec | ArrowSpec

/** What an agent may change on an element. */
export type ElementPatch = { x?: number; y?: number; width?: number; height?: number; text?: string; strokeColor?: string; backgroundColor?: string }

type Bound = { type: string; id: string }

export const COLOR_RE = /^(#[0-9a-f]{3,8}|transparent)$/i
const INK = '#1e1e1e'
const color = (c: unknown, fallback: string): string => (typeof c === 'string' && COLOR_RE.test(c) ? c : fallback)
const nonce = (): number => Number.parseInt(randomHex(4), 16) & 0x7fffffff
const FONT = 5 // Excalifont, Excalidraw's hand-drawn face
const LINE = 1.25

function base(type: BoardElementType, at: Point, width: number, height: number, stroke: string, fill = 'transparent'): BoardElement {
  return {
    id: randomHex(10), type, x: at.x, y: at.y, width, height, angle: 0,
    strokeColor: stroke, backgroundColor: fill, fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, index: null, roundness: type === 'rectangle' ? { type: 3 } : type === 'diamond' || type === 'ellipse' ? { type: 2 } : null,
    seed: nonce(), version: 1, versionNonce: nonce(), isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false,
  }
}

/** The size text takes up, roughly as Excalidraw measures it; the browser re-measures when it renders. */
export function textSize(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split('\n')
  return { width: Math.max(1, ...lines.map((l) => l.length)) * fontSize * 0.6, height: lines.length * fontSize * LINE }
}

function textEl(at: Point, body: string, fontSize: number, stroke: string, container?: BoardElement): BoardElement {
  const { width, height } = textSize(body, fontSize)
  return {
    ...base('text', at, width, height, stroke), roundness: null, text: body, originalText: body, fontSize, fontFamily: FONT, lineHeight: LINE, autoResize: true,
    textAlign: container ? 'center' : 'left', verticalAlign: container ? 'middle' : 'top', containerId: container?.id ?? null,
  }
}

const centre = (e: BoardElement): Point => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 })
const boundOf = (e: BoardElement): Bound[] => (Array.isArray(e.boundElements) ? e.boundElements.filter((b): b is Bound => isRecord(b) && typeof b.id === 'string' && typeof b.type === 'string') : [])
/** A new version of an element: the edit every other copy will take. */
const bump = (e: BoardElement, fields: Record<string, unknown> = {}): BoardElement => ({ ...e, ...fields, version: e.version + 1, versionNonce: nonce(), updated: Date.now() })

/** Where the line from a box's centre towards `toward` leaves the box: arrows start and end on edges, not in the middle. */
export function edgePoint(e: BoardElement, toward: Point): Point {
  const c = centre(e)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (dx === 0 && dy === 0) return c
  const s = Math.min(e.width / 2 / Math.abs(dx || 1e-9), e.height / 2 / Math.abs(dy || 1e-9))
  return { x: c.x + dx * s, y: c.y + dy * s }
}

/**
 * Turns an agent's specs into elements, in order, so an arrow can point at a shape drawn earlier in the same call. Returns
 * every element to add or update: shapes, their labels, arrows, and existing shapes an arrow binds to (as new versions,
 * with the arrow in their `boundElements`, so they move together in Excalidraw).
 */
export function buildElements(specs: readonly DrawSpec[], scene: BoardScene = {}): BoardElement[] {
  const out = new Map<string, BoardElement>()
  const made: BoardElement[] = []
  const put = (e: BoardElement) => out.set(e.id, e)
  const lookup = (ref: string): BoardElement | undefined => {
    const n = /^#(\d+)$/.exec(ref)?.[1]
    const found = n !== undefined ? made[Number(n)] : (scene[ref] ?? undefined)
    return found && !found.isDeleted ? (out.get(found.id) ?? found) : undefined
  }
  const bind = (shapeId: string, ref: Bound) => {
    const cur = out.get(shapeId) ?? scene[shapeId]
    if (!cur) return
    // binding a shape that was already on the board is an edit to it: a new version, so peers take it
    put({ ...(out.has(shapeId) ? cur : bump(cur)), boundElements: [...boundOf(cur), ref] })
  }
  for (const spec of specs) {
    const stroke = color(spec.strokeColor, INK)
    if (spec.kind === 'text') {
      const t = textEl(spec, spec.text.slice(0, MAX_TEXT), spec.fontSize ?? 20, stroke)
      put(t)
      made.push(t)
    } else if (spec.kind === 'arrow') {
      const end = (ref: string | Point): { el?: BoardElement; at?: Point } => {
        if (typeof ref !== 'string') return { at: ref }
        const el = lookup(ref)
        if (!el) throw new BoardError(`arrow: cannot find ${ref} on the board`)
        return { el, at: centre(el) }
      }
      const a = end(spec.from)
      const b = end(spec.to)
      if (!a.at || !b.at) throw new BoardError('arrow: needs two ends')
      const s = a.el ? edgePoint(a.el, b.at) : a.at
      const e = b.el ? edgePoint(b.el, a.at) : b.at
      const arrow: BoardElement = {
        ...base('arrow', s, Math.abs(e.x - s.x), Math.abs(e.y - s.y), stroke),
        roundness: { type: 2 }, points: [[0, 0], [e.x - s.x, e.y - s.y]], lastCommittedPoint: null, elbowed: false, startArrowhead: null, endArrowhead: 'arrow',
        startBinding: a.el ? { elementId: a.el.id, focus: 0, gap: 6 } : null, endBinding: b.el ? { elementId: b.el.id, focus: 0, gap: 6 } : null,
      }
      put(arrow)
      made.push(arrow)
      if (a.el) bind(a.el.id, { type: 'arrow', id: arrow.id })
      if (b.el) bind(b.el.id, { type: 'arrow', id: arrow.id })
      if (spec.label) {
        const t = textEl({ x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 }, spec.label.slice(0, MAX_TEXT), 16, stroke, arrow)
        put(t)
        bind(arrow.id, { type: 'text', id: t.id })
      }
    } else {
      const label = spec.label?.slice(0, MAX_TEXT)
      const fit = label ? textSize(label, 20) : { width: 0, height: 0 }
      const w = spec.width ?? Math.max(160, fit.width + 40)
      const h = spec.height ?? Math.max(80, fit.height + 30)
      const shape = base(spec.kind, spec, w, h, stroke, color(spec.backgroundColor, 'transparent'))
      put(shape)
      made.push(shape)
      if (label) {
        const t = textEl({ x: spec.x + (w - fit.width) / 2, y: spec.y + (h - fit.height) / 2 }, label, 20, stroke, shape)
        put(t)
        bind(shape.id, { type: 'text', id: t.id })
      }
    }
  }
  return [...out.values()]
}

/**
 * An edit to elements on the board, as new versions of them. `text` changes a text element, or the label inside a shape or
 * on an arrow; a moved shape takes its label along. Deleting removes an element and the label bound to it.
 */
export function editElements(scene: BoardScene, ids: readonly string[], patch: ElementPatch | 'delete'): BoardElement[] {
  return ids.flatMap((id) => {
    const e = scene[id]
    if (!e || e.isDeleted) throw new BoardError(`no element ${id} on the board`)
    const labelId = boundOf(e).find((b) => b.type === 'text')?.id
    const label = labelId ? scene[labelId] : undefined
    const liveLabel = label && !label.isDeleted ? label : undefined
    if (patch === 'delete') return [bump(e, { isDeleted: true }), ...(liveLabel ? [bump(liveLabel, { isDeleted: true })] : [])]
    const fields: Record<string, unknown> = {}
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      const v = patch[k]
      if (v === undefined) continue
      if (!finite(v, k === 'width' || k === 'height' ? 0 : -COORD)) throw new BoardError(`${k} must be a number`)
      fields[k] = v
    }
    if (patch.strokeColor !== undefined) fields.strokeColor = color(patch.strokeColor, String(e.strokeColor ?? INK))
    if (patch.backgroundColor !== undefined) fields.backgroundColor = color(patch.backgroundColor, String(e.backgroundColor ?? 'transparent'))
    const labelFields: Record<string, unknown> = {}
    if (patch.text !== undefined) {
      const target = e.type === 'text' ? e : liveLabel
      if (!target) throw new BoardError(`${id} has no text to change; draw a text or a labelled shape instead`)
      const body = patch.text.slice(0, MAX_TEXT)
      const size = textSize(body, typeof target.fontSize === 'number' ? target.fontSize : 20)
      Object.assign(target === e ? fields : labelFields, { text: body, originalText: body, width: size.width, height: size.height })
    }
    if (liveLabel && e.type !== 'text') {
      const dx = typeof fields.x === 'number' ? fields.x - e.x : 0
      const dy = typeof fields.y === 'number' ? fields.y - e.y : 0
      if (dx || dy) Object.assign(labelFields, { x: liveLabel.x + dx, y: liveLabel.y + dy })
    }
    return [...(liveLabel && Object.keys(labelFields).length ? [bump(liveLabel, labelFields)] : []), bump(e, fields)]
  })
}

/** One line per element on the board, for an agent to read: id, kind, where, size, and its words. */
export function summarize(scene: BoardScene): string {
  const els = visible(scene)
  const byId = new Map(els.map((e) => [e.id, e]))
  const labelOf = (e: BoardElement): unknown => byId.get(boundOf(e).find((b) => b.type === 'text')?.id ?? '')?.text
  const endOf = (b: unknown): string => (isRecord(b) && typeof b.elementId === 'string' ? b.elementId : 'a point')
  const lines = els
    // a label is written on its shape's line
    .filter((e) => !(e.type === 'text' && typeof e.containerId === 'string' && byId.has(e.containerId)))
    .map((e) => {
      const where = `at ${Math.round(e.x)},${Math.round(e.y)} size ${Math.round(e.width)}x${Math.round(e.height)}`
      const words = e.type === 'text' ? e.text : labelOf(e)
      const ends = e.type === 'arrow' ? ` from ${endOf(e.startBinding)} to ${endOf(e.endBinding)}` : ''
      return `${e.id} ${e.type} ${where}${ends}${typeof words === 'string' && words ? ` "${words.replace(/\n/g, ' / ')}"` : ''}`
    })
  if (!lines.length) return 'The board is empty.'
  return `${lines.length} element${lines.length === 1 ? '' : 's'} on the board:\n${lines.join('\n')}`
}
