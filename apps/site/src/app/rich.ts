/** Pure helpers behind Markdown messages and their rich blocks (diagrams, charts, SVG, artifacts). Nothing here touches the DOM. */

export type RichErrorKind = 'json' | 'shape' | 'depth' | 'url' | 'svg'
/** Why a block could not be drawn. The message is shown to the reader next to the block's source. */
export class RichError extends Error {
  constructor(
    readonly kind: RichErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'RichError'
  }
}

/** At most this many blocks are drawn per message; further ones stay plain code, so one message cannot draw without end. */
export const MAX_RICH_BLOCKS = 6

/** Links open only these; anything else (javascript:, data:, vbscript:, file:) is shown as plain text. */
export function safeHref(href: string | null | undefined): string | null {
  const h = href?.trim() ?? ''
  // the regex sees what the browser will see first; URL() then rejects anything malformed behind the scheme
  if (!/^(https?:|mailto:)/i.test(h)) return null
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(h).protocol) ? h : null
  } catch {
    return null
  }
}

/** Images: https pictures, or small inline raster data. Never svg or html data, never plain http. */
export function safeImageSrc(href: string | null | undefined): string | null {
  const h = href?.trim() ?? ''
  if (/^https:\/\//i.test(h)) return h
  return h.length <= 400_000 && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(h) ? h : null
}

export const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/**
 * A Vega-Lite spec an agent wrote, checked before it is run. Charts get their numbers inline: a spec that points at a URL
 * (data, images, anything) is refused, so a chart can never make the viewer's browser fetch from somewhere.
 */
export function checkChartSpec(text: string): Record<string, unknown> {
  let spec: unknown
  try {
    spec = JSON.parse(text)
  } catch {
    throw new RichError('json', 'The chart is not valid JSON')
  }
  if (!isRecord(spec)) throw new RichError('shape', 'The chart must be a JSON object')
  const walk = (v: unknown, depth: number): void => {
    if (depth > 40) throw new RichError('depth', 'The chart is nested too deeply')
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1))
    if (!isRecord(v)) return
    for (const [k, x] of Object.entries(v)) {
      if (k === 'url') throw new RichError('url', 'Charts cannot load data from a URL: put the numbers inline under "values"')
      walk(x, depth + 1)
    }
  }
  walk(spec, 0)
  return spec
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface ChartColors {
  ink: string
  grid: string
}

/** Draws a checked chart to an SVG string. vega and vega-lite load only now, and only after the spec passed the check. */
export async function chartSvg(code: string, colors: ChartColors): Promise<string> {
  const spec = checkChartSpec(code)
  const [vega, vegaLite, { expressionInterpreter }] = await Promise.all([import('vega'), import('vega-lite'), import('vega-interpreter')])
  const { ink, grid } = colors
  const config = {
    background: 'transparent',
    axis: { labelColor: ink, titleColor: ink, domainColor: ink, tickColor: ink, gridColor: grid },
    legend: { labelColor: ink, titleColor: ink },
    title: { color: ink },
    view: { stroke: 'transparent' },
  }
  // the spec is the author's JSON: vega-lite validates it itself and its errors are shown to the reader
  const compiled = vegaLite.compile({ width: 480, height: 280, ...spec } as unknown as Parameters<typeof vegaLite.compile>[0], { config })
  // a second line of defence behind checkChartSpec: the loader refuses every request
  const refuse = () => Promise.reject(new RichError('url', 'Charts cannot load anything from outside'))
  const loader = { ...vega.loader(), load: refuse, sanitize: refuse, http: refuse, file: refuse }
  // the spec's expressions (calculate, filter, signals) are interpreted, never compiled with Function(): vega's default codegen
  // would run a stranger's code in this origin, which holds the user's keys, as soon as the message is shown
  const runtime = vega.parse(compiled.spec, undefined, { ast: true })
  const view = new vega.View(runtime, { expr: expressionInterpreter, renderer: 'none', loader, logLevel: vega.Error })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

/** SVG written by an agent is shown as a picture (an <img>), where scripts and outside requests do not run. */
export function checkSvg(text: string): string {
  const svg = text.trim()
  if (!/^(<\?xml[\s\S]*?)?<svg[\s>]/i.test(svg)) throw new RichError('svg', 'This is not an <svg> document')
  return svg
}

/**
 * An artifact runs in a sandboxed frame with no direct network requests, no storage, no top-level navigation and no way to reach
 * the page around it. The policy is part of the document itself, ahead of anything the author wrote. It is not a full seal: a
 * script can still navigate its own frame away (leaving the policy behind), so whatever is typed into an artifact can reach its author.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** The only message an artifact frame may send: how tall its content is. */
export interface HeightMsg {
  kurultay: 'height'
  h: number
}
export const isHeightMsg = (v: unknown): v is HeightMsg => isRecord(v) && v.kurultay === 'height'

const REPORT_HEIGHT = `new ResizeObserver(function(){parent.postMessage({kurultay:'height',h:document.documentElement.scrollHeight},'*')}).observe(document.documentElement)`

/** Build the document loaded into the sandboxed frame from what the author wrote. Its colours are its own: the frame cannot see the app's tokens. */
export function artifactDocument(html: string): string {
  const body = html
    // a page that redirects itself would leave the sandbox's rules behind: refresh and base tags are dropped
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}body{padding:10px;font:14px/1.5 system-ui,sans-serif;color:#111;background:#fff}</style><script>${REPORT_HEIGHT}</script></head><body>${body}</body></html>`
}

export const artifactTitle = (html: string): string => html.match(/<title[^>]*>([^<]{1,80})<\/title>/i)?.[1]?.trim() || 'Interactive artifact'

export const MIN_FRAME = 120
export const MAX_FRAME = 640
/** How tall the frame may become, whatever the content claims. */
export const clampHeight = (h: unknown): number => (typeof h === 'number' && Number.isFinite(h) ? Math.min(MAX_FRAME, Math.max(MIN_FRAME, Math.ceil(h))) : MIN_FRAME * 2)
