---
title: The board
order: 4.5
---

# The board

Every council has a board where its people and agents draw together, live. In the app, the board button in the council's top bar opens it beside the chat. The expand button makes it full screen, and Esc brings it back. You see where the others are pointing, with their names.

The board is [Excalidraw](https://excalidraw.com). It is loaded the first time you open a board, so the chat stays light until then.

## Who can see it

Only the members of the council. Each change is encrypted with the council's key and sent like a message, so relays see random-looking traffic and keep none of it. There is no board server. Every member's app keeps its own copy, and when you open the board, a member who has it sends it to you.

- If an admin removes someone, the council's key changes, and that person gets nothing drawn afterwards.
- Muted members cannot draw.
- Agents cannot draw while the council is paused.

## Asking an agent to draw

Mention an agent and ask, for example "@reviewer put the deploy pipeline on the board" or "@reviewer add a box for the cache between the API and the database". The agent reads the board first, so it can add to what is there, change words, move things or remove them.

An agent in an open session uses these tools:

| Tool | What it does |
|---|---|
| `board_read` | Lists the board, one line per element: id, kind, position, size and words. |
| `board_draw` | Draws rectangles, ellipses and diamonds (with an optional label inside), text, and arrows between elements or points. |
| `board_edit` | Moves, resizes, recolours or rewords elements. |
| `board_delete` | Removes elements. A shape takes its label with it. |

An arrow's `from` and `to` is an element id from `board_read`, `"#n"` for the n-th item of the same call, or a point `{"x": …, "y": …}`. Arrows start and end on the edges of the boxes they join. Colours are hex, like `#1971c2`.

### In the background

An agent answering in the background cannot call tools. It writes a fenced `board` block in its reply instead:

````markdown
Here is the flow.

```board
{
  "draw": [
    { "kind": "rectangle", "x": 0, "y": 0, "label": "API" },
    { "kind": "rectangle", "x": 400, "y": 0, "label": "Database" },
    { "kind": "arrow", "from": "#0", "to": "#1", "label": "reads" }
  ],
  "edit": [{ "ids": ["3f2a…"], "text": "Cache", "backgroundColor": "#ffec99" }],
  "delete": ["9c1e…"]
}
```
````

The service applies the block to the board and replaces it with a short note, such as _(On the board: drew 3, edited 1, removed 1.)_. The council never sees raw JSON. A block that is not valid becomes a one-line note that says what was wrong. Drawing counts as speech, not file access, so an agent may draw at every permission level that answers, including **Answer when tagged** alone.

The background prompt lists each council's board (at most 60 lines), so the agent knows the ids it can edit.

## What a board can hold

Shapes, text, arrows, lines, freehand drawing and frames, up to 4000 elements per board. Images and embedded web pages are not available, because they would load content from outside the council. Links on shapes must be `http(s)`.

## Fonts

Excalidraw's hand-drawn fonts are served from this site, under `/kurultay/excalidraw/fonts/`. Excalidraw normally falls back to a public CDN for fonts. The build rewrites that fallback to this site's own copy, so opening a board never tells a third party. Chinese, Japanese and Korean text uses your system font, because the 12 MB CJK font is left out.

## How it syncs

The wire format is in the [protocol](nip.html#board). In short:

- **Envelopes:** `board` carries the elements that changed, `board_req` asks for the whole board, and `board_ptr` carries a pointer.
- **Merging:** a higher `version` wins. On a tie, the lower `versionNonce` wins, so every copy settles on the same board.
- **Deletions:** a deleted element is kept as a tombstone, so an old copy of it cannot come back.
- **Rate limits:** board updates have their own limit, 300 a minute per council, so dragging a shape never uses up the chat limit.
