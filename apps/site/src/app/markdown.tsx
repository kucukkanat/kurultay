import { marked, type Token, type Tokens } from 'marked'
import { Fragment, type ComponentChildren, type FunctionComponent } from 'preact'
import { useState } from 'preact/hooks'
import { MAX_RICH_BLOCKS, safeHref, safeImageSrc } from './rich'

/**
 * Chat messages as Markdown. `marked` only tokenises; each token becomes a Preact element here, so nothing is ever put into
 * the page as HTML: raw HTML in a message is shown as the text it is, and links and images are limited to safe protocols.
 * Fenced code can be handed to a richer renderer by language (diagrams, charts, artifacts).
 */

/** What a fenced block with this language is shown as, instead of plain code. */
export type CodeBlockRenderer = FunctionComponent<{ code: string; lang: string }>

interface Opts {
  /** names (lowercase) that @mentions may refer to */
  names: Set<string>
  blocks: Readonly<Partial<Record<string, CodeBlockRenderer>>>
  maxSpecial: number
  /** rich blocks drawn so far in this message; the one mutable bit, local to a single render */
  used: { n: number }
}

const MENTION = /(@[\w#.\-]+(?:@[\w.\-]+)?)/g

const plain = (s: string, o: Opts): ComponentChildren =>
  s.split(MENTION).map((p, i) => {
    const n = p.slice(1).toLowerCase()
    const known = p.startsWith('@') && (o.names.has(n) || o.names.has(n.split('@')[0] ?? '') || p === '@all' || p === '@here')
    return known ? <span key={i} class="mention">{p}</span> : p
  })

const textOf = (t: Tokens.Text | Tokens.Tag | Tokens.Generic, o: Opts): ComponentChildren =>
  'tokens' in t && t.tokens?.length ? inline(t.tokens, o) : plain(t.text ?? '', o)

function inline(tokens: Token[] | undefined, o: Opts): ComponentChildren {
  return (tokens ?? []).map((t, i) => {
    switch (t.type) {
      case 'text':
        return <Fragment key={i}>{textOf(t, o)}</Fragment>
      case 'escape':
        return t.text
      case 'strong':
        return <strong key={i}>{inline(t.tokens, o)}</strong>
      case 'em':
        return <em key={i}>{inline(t.tokens, o)}</em>
      case 'del':
        return <del key={i}>{inline(t.tokens, o)}</del>
      case 'codespan':
        return <code key={i}>{t.text}</code>
      case 'br':
        return <br key={i} />
      case 'link': {
        const href = safeHref(t.href)
        const label = inline(t.tokens, o)
        return href ? (
          <a key={i} href={href} target="_blank" rel="noopener noreferrer nofollow" title={t.title ?? undefined}>
            {label}
          </a>
        ) : (
          <span key={i}>{label}</span>
        )
      }
      case 'image':
        return <MdImage key={i} href={t.href} alt={t.text} title={t.title ?? undefined} />
      default:
        // raw html (and anything unknown) is shown as the text it is, never as markup
        return <span key={i}>{t.raw}</span>
    }
  })
}

/** A picture linked from a message: https only, no referrer, no cookies. If it will not load, its description and a link remain. */
function MdImage({ href, alt, title }: { href: string; alt: string; title?: string }) {
  const [failed, setFailed] = useState(false)
  const src = safeImageSrc(href)
  const link = safeHref(href)
  if (!src || failed)
    return link ? (
      <a href={link} target="_blank" rel="noopener noreferrer nofollow">
        {alt || link}
      </a>
    ) : (
      <span>{alt}</span>
    )
  return <img class="md-img" src={src} alt={alt} title={title} loading="lazy" decoding="async" referrerpolicy="no-referrer" crossorigin="anonymous" onError={() => setFailed(true)} />
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard?.writeText(code).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1400)))
  return (
    <div class="md-code" data-testid="md-code">
      <div class="md-code-bar">
        <span>{lang || 'text'}</span>
        <button class="link-btn" type="button" onClick={copy} data-testid="md-code-copy">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

function block(t: Token, i: number, o: Opts): ComponentChildren {
  switch (t.type) {
    case 'space':
    case 'def':
      return null
    case 'heading': {
      // chat is not a page: headings are shown two levels lower than written
      const Tag = `h${Math.min(6, t.depth + 2)}` as 'h3'
      return <Tag key={i} class="md-h">{inline(t.tokens, o)}</Tag>
    }
    case 'paragraph':
      return <p key={i}>{inline(t.tokens, o)}</p>
    case 'text':
      // only tight list items hold bare text blocks: kept inline so a task's checkbox sits on the same line
      return <Fragment key={i}>{textOf(t, o)}</Fragment>
    case 'code': {
      const lang = (t.lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      const Special = o.blocks[lang]
      return Special && o.used.n++ < o.maxSpecial ? <Special key={i} code={t.text} lang={lang} /> : <CodeBlock key={i} code={t.text} lang={lang} />
    }
    case 'blockquote':
      return <blockquote key={i}>{blocks(t.tokens, o)}</blockquote>
    case 'list': {
      const items = (t as Tokens.List).items.map((it, j) => (
        <li key={j} class={it.task ? 'md-task' : undefined}>
          {it.task && <input type="checkbox" checked={!!it.checked} disabled aria-label={it.checked ? 'done' : 'not done'} />}
          {blocks(it.tokens, o)}
        </li>
      ))
      return t.ordered ? <ol key={i} start={typeof t.start === 'number' && t.start !== 1 ? t.start : undefined}>{items}</ol> : <ul key={i}>{items}</ul>
    }
    case 'table': {
      const tb = t as Tokens.Table
      const cell = (c: Tokens.TableCell, j: number) => <Fragment key={j}>{inline(c.tokens, o)}</Fragment>
      const align = (c: Tokens.TableCell) => (c.align ? { textAlign: c.align } : undefined)
      return (
        <div key={i} class="md-table">
          <table>
            <thead>
              <tr>{tb.header.map((c, j) => <th key={j} style={align(c)}>{cell(c, j)}</th>)}</tr>
            </thead>
            <tbody>
              {tb.rows.map((r, j) => (
                <tr key={j}>{r.map((c, k) => <td key={k} style={align(c)}>{cell(c, k)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'hr':
      return <hr key={i} />
    default:
      // raw html blocks (and anything unknown) are text
      return <p key={i}>{t.raw.trim()}</p>
  }
}

const blocks = (tokens: Token[] | undefined, o: Opts): ComponentChildren => (tokens ?? []).map((t, i) => block(t, i, o))

export function Markdown({ text, names, blocks: custom = {}, maxSpecial = MAX_RICH_BLOCKS }: { text: string; names: Set<string>; blocks?: Readonly<Partial<Record<string, CodeBlockRenderer>>>; maxSpecial?: number }) {
  // breaks: a single newline is a line break, as people (and agents) write in chat
  const tokens = marked.lexer(text, { gfm: true, breaks: true })
  return (
    <div class="md" data-testid="md">
      {blocks(tokens, { names, blocks: custom, maxSpecial, used: { n: 0 } })}
    </div>
  )
}
