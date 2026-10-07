import { z } from 'zod'
import { buildElements, COLOR_RE, editElements, summarize, type BoardElement, type Kurultay } from '@kurultay/core'

/**
 * How an agent draws on the council board. An open session uses the board_* tools (tools.ts); a background turn cannot
 * call tools (it runs the agent CLI locked down), so it writes a fenced ```board block in its answer instead, which the
 * service takes out, checks and applies. Both read the same schemas, so both accept exactly the same drawing.
 */

const point = z.object({ x: z.number(), y: z.number() })
const colorField = z.string().regex(COLOR_RE).optional()

export const drawItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['rectangle', 'ellipse', 'diamond']), x: z.number(), y: z.number(), width: z.number().positive().optional(), height: z.number().positive().optional(), label: z.string().max(2000).optional(), strokeColor: colorField, backgroundColor: colorField }),
  z.object({ kind: z.literal('text'), x: z.number(), y: z.number(), text: z.string().min(1).max(4000), fontSize: z.number().min(8).max(96).optional(), strokeColor: colorField }),
  z.object({ kind: z.literal('arrow'), from: z.union([z.string(), point]), to: z.union([z.string(), point]), label: z.string().max(500).optional(), strokeColor: colorField }),
])

export const patchShape = {
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  text: z.string().max(4000).optional(),
  strokeColor: colorField,
  backgroundColor: colorField,
}

/** One ```board block: things to draw, edits to elements already there, and ids to remove. */
export const boardOps = z.object({
  draw: z.array(drawItem).max(60).optional(),
  edit: z.array(z.object({ ids: z.array(z.string()).min(1).max(60), ...patchShape })).max(30).optional(),
  delete: z.array(z.string()).max(200).optional(),
})
export type BoardOps = z.infer<typeof boardOps>

/** What a background turn is told about the board block; tools.ts and SKILL.md say the same for open sessions. */
export const BOARD_BLOCK_RULE =
  'The council has a shared drawing board (its contents are listed above, per council). When asked to put something on the board, sketch, map or lay something out there, add a fenced ```board block to your reply with JSON: {"draw": [...], "edit": [...], "delete": [...]}. draw items: {"kind":"rectangle"|"ellipse"|"diamond","x":0,"y":0,"label":"text inside"} (width/height optional), {"kind":"text","x":0,"y":0,"text":"..."}, {"kind":"arrow","from":"#0","to":"#1","label":"optional"} where from/to is an id from the board list, "#n" for the n-th draw item of the same block, or {"x":..,"y":..}. edit items: {"ids":["id"],"text":"new words"} or x, y, width, height, strokeColor, backgroundColor (hex). delete: ["id", ...]. Coordinates are pixels; leave about 60 px between shapes (about 220 px when a labelled arrow joins them) and place new things beside what is already there. The block is drawn for the council and removed from your message; say in your words what you drew.'

const BLOCK = /```board[^\S\n]*\n([\s\S]*?)\n```[^\S\n]*(?:\n|$)/g

const parseBlock = (body: string): BoardOps | string => {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return '(I couldn’t draw that on the board: the drawing was not valid JSON.)'
  }
  const parsed = boardOps.safeParse(json)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  return `(I couldn’t draw that on the board: ${issue?.path.join('.') || 'input'} ${issue?.message ?? 'is invalid'}.)`
}

/**
 * Takes every ```board block out of an answer. Returns the answer without them, the blocks that parsed, and a plain note
 * for each one that did not, so the council sees that a drawing failed instead of a block of JSON.
 */
export function takeBoardBlocks(answer: string): { text: string; ops: BoardOps[]; errors: string[] } {
  const results = [...answer.matchAll(BLOCK)].map((m) => parseBlock(m[1] ?? ''))
  return {
    text: answer.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n').trim(),
    ops: results.filter((r): r is BoardOps => typeof r !== 'string'),
    errors: results.filter((r): r is string => typeof r === 'string'),
  }
}

/** Applies parsed board blocks in order and says what happened, in one line for the council. */
export async function applyBoardOps(e: Kurultay, groupId: string, all: readonly BoardOps[]): Promise<string> {
  const count = { drew: 0, edited: 0, removed: 0 }
  const problems: string[] = []
  // each step reads the scene as the previous one left it, so an edit can follow a drawing in the same block
  const run = async (key: keyof typeof count, n: number, build: () => BoardElement[]) => {
    try {
      await e.drawBoard(groupId, build())
      count[key] += n
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err))
    }
  }
  for (const ops of all) {
    if (ops.draw?.length) await run('drew', ops.draw.length, () => buildElements(ops.draw ?? [], e.boardScene(groupId)))
    for (const { ids, ...patch } of ops.edit ?? []) await run('edited', ids.length, () => editElements(e.boardScene(groupId), ids, patch))
    if (ops.delete?.length) await run('removed', ops.delete.length, () => editElements(e.boardScene(groupId), ops.delete ?? [], 'delete'))
  }
  const did = count.drew + count.edited + count.removed ? `_(On the board: drew ${count.drew}, edited ${count.edited}, removed ${count.removed}.)_` : ''
  return [did, problems.length ? `(Board: ${problems.join('; ')}.)` : ''].filter(Boolean).join(' ')
}

/** Groups this engine already asked for the board: after one ask it is subscribed, so every later change reaches it live. */
const asked = new WeakMap<Kurultay, Set<string>>()

/**
 * The board as this agent has it. When it has nothing yet (it was offline while people drew) it asks the council once and
 * waits up to `ms` for a whole board to arrive.
 */
export async function freshBoard(e: Kurultay, groupId: string, ms = 4000): Promise<Record<string, BoardElement>> {
  const done = asked.get(e) ?? new Set<string>()
  asked.set(e, done)
  if (Object.keys(e.boardScene(groupId)).length || done.has(groupId)) return e.boardScene(groupId)
  done.add(groupId)
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      off()
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const off = e.on('board', (b) => b.groupId === groupId && b.full && finish())
    // muted or paused: nobody will answer, and drawing will say why
    e.requestBoard(groupId).catch(finish)
  })
  return e.boardScene(groupId)
}

/** The board, briefly, for a background turn's prompt: enough to place things and name ids, never crowding out the chat. */
export function boardForPrompt(e: Kurultay, groupId: string, maxLines = 60): string {
  const lines = summarize(e.boardScene(groupId)).split('\n')
  return lines.length > maxLines + 1 ? [...lines.slice(0, maxLines + 1), `… and ${lines.length - maxLines - 1} more`].join('\n') : lines.join('\n')
}
