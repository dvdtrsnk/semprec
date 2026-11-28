---
status: accepted
date: 2026-11-20
area: [backend, web, mobile]
supersedes: []
superseded-by: null
---

# Toggle blocks and extended inline formatting

## Context

[[2026-10-28-block-model-for-page-documents]] fixes a closed block type set (§1) and the inline attributes `bold`,
`italic`, `code` and `link` (§3). The note editors need strikethrough, underline, text color, highlight, toggle list
items and toggle headings. The TypeScript model (`shared/block-model/`) and the Kotlin mirror (`mobile/shared/domain`)
both read and write the canonical Markdown, so the stored fields and their Markdown spelling must be identical on both
sides. This decision extends §1 and §3 of that ADR; the rest of it, including validation and normalization (§4), is
unchanged and applies to the new fields.

## Decision

### Stored model

- **Inline attributes.** A `Y.Text` run of a block type with inline attributes may also carry `strike: true`,
  `underline: true`, `color: <key>` (text color) and `highlight: <key>` (background). A color key is one of the closed
  registry `INLINE_COLORS`: `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `red`. The key is
  stored; each renderer maps it to its own palette. Server-side writes reject an unknown key; reading drops it, like
  any other unknown attribute value.
- **`toggle` block type.** A toggle list item, with the same field rules as `text`. Its children are the following
  blocks with a greater indent, as for every other hierarchy in the flat model; nothing structural is added.
- **Toggle heading.** `h1`-`h3` carry an optional boolean `toggle` in the block's `Y.Map`, written like `done` and
  resolved last-writer-wins. Server-side writes reject it on any other type; reading ignores it there. The type rule
  records it as `hasToggle`. Changing a heading's level keeps it; any other type change removes it.
- Whether a toggle is collapsed is UI state of one client and is never stored.

### Canonical Markdown

- `strike` is `~~text~~`, `underline` is `<u>text</u>`, `color` is `<span data-color="red">text</span>` and
  `highlight` is `<mark data-color="yellow">text</mark>`.
- Marks nest, outermost first: link, color span, highlight mark, underline, strike, bold, italic, code span. The
  writer splits each mark at the boundaries of the marks outside it, so its output always nests. Bold and italic keep
  splitting only at links and keep their `<strong>`/`<em>` fallback.
- The parser accepts these marks in any nesting order, and `<s>`/`<del>` as strike. Any unescaped `~~` is a strike
  delimiter that opens when a closing one follows; the writer therefore escapes a `~` next to another `~` or next to
  a strike delimiter as `\~`. Nothing inside a code span is markup. A `<span>` or `<mark>` whose `data-color` is not a
  registry key is consumed and its text keeps no color.
- A `toggle` block is always written with its `alldots:block` comment (`type=toggle`), followed by its content written
  like a text line; the comment is what tells it from a text block on read.
- A toggle heading is always written with its `alldots:block` comment carrying the extra field `toggle=true`, after
  `indent`. The parser applies `toggle=true` only when the line is an `h1`-`h3` heading and ignores it on every other
  type.

Rejected: a dedicated `toggle-heading` type. It would duplicate the three heading levels and every heading rule (the
page summary's headings, the proposal placement under a heading) would have to learn a second spelling of each level.
Also rejected: storing the color as a CSS value. A closed key set keeps the Markdown, validation and both platforms'
palettes in step, and a theme can change a color without rewriting documents.

## Consequences

- Every consumer of the model reads the new fields through `readPageBlocks`, `parseMarkdown` and `serializeBlocks`;
  the page Markdown read and replace, the block diff, duplication, the page summary (`toggle` on each block) and
  `stripMarkdown` carry them without their own handling of the syntax.
- `page.convertToBlock` accepts `toggle` as a target type.
- The shared vectors in `shared/block-model/fixtures/markdown.json` cover the new marks, nesting, escaping, unknown
  colors, toggle blocks and toggle headings; the Kotlin mirror reads the same Markdown.
