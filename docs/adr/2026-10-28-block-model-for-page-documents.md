---
status: accepted
date: 2026-10-28
area: [backend, web, mobile]
supersedes: []
superseded-by: null
---

# Block model for page documents

## Context

Page content is stored as Yjs documents (`docs`, `doc_snapshots`,
`doc_updates`). Today the only content model is
`backend/packages/data/src/docs/blocks.ts`: a block is a `Y.Map` inside
`doc.getMap('blocks')` with `sys:id`, `sys:flavour` (any string), `sys:children`
(a plain JS array overwritten whole) and arbitrary scalar fields. There is no
type registry, no ordering and no validation, and `listBlocks` returns map
iteration order. `WS /api/sync` (`backend/packages/realtime/src/docSync.ts`,
see [[2026-09-12-per-process-doc-sync-subscription-registry]]) applies any Yjs
update a client sends, so the server cannot reject part of an update after the
fact. Existing tests use a different convention (a root block
`{id: 'root', flavour: 'page'}` plus `paragraph` blocks with a `content`
field), which collides with the product's `page` block type (a subpage).

The editor shows text, three heading levels, bullet, number, todo (with a done
flag), quote and page (a subpage link). Every type has an indent level 0-5;
bullet markers and numbering such as "1.1" are drawn by the renderer, not
stored. Shift+Enter inserts a soft line break inside a block, text carries
bold, italic, code and link formatting, and a document is never empty. The same
page is routinely open on a phone, a Mac and the web at once, so concurrent
editing must converge. On iOS and macOS the editor runs in a WKWebView with the
same JavaScript/Yjs code as the web.

This ADR records decisions only. The shared model is implemented by #1539,
multi-block operations by #1610, Markdown serialization by #1608, the page
operation family on the API by #1394, and where subpages live by #1393. In line
with [[2026-09-10-no-speculative-generality-beyond-issue-scope]], it fixes only
what those issues need.

## Decision

### 1. Block type registry

The type keys are a closed set: `text`, `h1`, `h2`, `h3`, `bullet`, `number`,
`todo`, `quote`, `page`. A block is a `Y.Map` in `doc.getMap('blocks')`, keyed
by its id, with this field contract:

| Field | Type | Rule |
|---|---|---|
| `sys:id` | string | the block id, equal to its map key |
| `sys:flavour` | string | the type key |
| `indent` | integer 0-5 | default 0; kept on every type, including non-list types |
| `done` | boolean | meaningful only for `todo` |
| `text` | `Y.Text` | absent for `page` |
| `pageId` | string | only for `page`; its meaning is owned by #1393 |

`sys:children` is no longer written. The test-only convention (`root`, `page`
as document root, `paragraph`) is abandoned.

Rejected: keeping `sys:flavour` as an open string with per-flavour conventions.
It keeps today's flexibility, but nothing can then tell a typo from a type, and
every consumer would have to guess how to render unknown input.

### 2. Document order

Block order lives in the top-level shared type `doc.getArray('order')`, a
`Y.Array<string>` of block ids. The list is flat; hierarchy exists only through
the per-block `indent`. Top-level shared types merge by name, whereas two
clients concurrently creating a root `Y.Map` under the same key makes Yjs
discard one side together with the ids it inserted. A document with no entries
is read as one empty text block without writing anything.

Rejected: a root block in the `blocks` map holding the order (the concurrent
creation problem above), and a fractional index on each block (every move
rewrites a field, two concurrent inserts can produce equal or unreadable
indexes, and the index needs rebalancing; `Y.Array` already merges concurrent
inserts and deletes). Trade-off: a move is a delete plus an insert of the id
in `order`, so two concurrent moves of the same block can leave the id twice;
normalization (below) keeps the first occurrence.

### 3. Inline text model

The text of a block is a `Y.Text` with the attributes `bold`, `italic`, `code`
and `link` (`{href}`). A soft line break is a `\n` character inside the
`Y.Text`. Markdown is only a serialization of this model; its format is owned
by #1608 and never defines the stored model.

Rejected: storing a JSON or Markdown string per block. Concurrent edits of one
block would then replace the whole string instead of merging character by
character.

### 4. Validation split

The WebSocket sync path cannot reject part of a Yjs update, so validity is
enforced at read time and strictly on every server-side write.

- **Server-side writes** reject, as a validation error (HTTP 400): an unknown
  type key, `indent` outside 0-5 or not an integer, `done` on a non-todo,
  `pageId` on a non-page, and any malformed field type.
- **Read-time normalization** for what arrives through `WS /api/sync`:
  - a duplicated id in `order` keeps its first occurrence;
  - an unknown type key is read as `text`, while the stored value stays
    untouched in Yjs (so a Markdown round trip can preserve it);
  - `indent` is clamped to 0-5;
  - `done` is read as false for a non-todo;
  - a block that exists in the map but not in `order` is appended at the end;
    several such blocks are ordered by id, so every client derives the same
    order;
  - an id in `order` with no block in the map is skipped;
  - an empty document is one empty text block.
- Reading never modifies the Yjs state. Normalization is a pure function from
  the document to a view, so two replicas holding the same state always derive
  the same view and reading cannot generate updates that loop between clients.

Rejected: repairing the document on read (writing the normalized form back).
It would make every reader a writer, and concurrent repairs by several devices
would produce new conflicts.

### 5. Module placement

The block model is pure TypeScript over `yjs`, importable by the server and by
the WebView editor. It lives in the new directory `shared/block-model/` at the
repository root, as its own pnpm package (`@semprec/block-model`), outside
`backend/`. #1539 creates it. The module has no `pg` dependency and no
Node-only dependency (no `node:*` imports, no `Buffer`); its only runtime
dependency is `yjs`. The backend consumes it by a `link:`/`file:` dependency on
that directory and `web/` the same way (`web/` stays a standalone pnpm project
with its own lockfile). #1539 adds a test in the module that fails when its source
imports anything but `yjs` and itself.

Rejected: keeping the module in `@semprec/data`. The WebView editor would then
have to depend on a package whose entry point imports `pg`, or deep-import a
file from it, and nothing would stop a later change in that package from
pulling a Node-only import into the editor bundle. Also rejected: a root-level
pnpm workspace joining `backend/` and `web/`; it would merge two lockfiles and
change both CI pipelines for the sake of one small module. Trade-off accepted:
one more package to install and verify, and `backend/pnpm-workspace.yaml` does
not cover it.

### 6. Existing documents

Production currently has no documents (the only producer is unreachable). The
product owner decided that there is no sweep and no migration of existing
documents; read-time normalization covers any older document, including one
written with the old `sys:children` convention. No cleanup issue is planned,
and this is the only place the decision is recorded.

### 7. No native block API

iOS, macOS and Android edit through the WebView with the same JavaScript/Yjs
code as the web. A native JSON block API is not built for any client.
Reversing this needs a new ADR.

### 8. Concurrency

The same page open on several devices of one user must converge. The model
relies on these Yjs behaviors:

- `order` is a `Y.Array`, so concurrent inserts and deletes of ids merge
  without loss; top-level shared types of the same name merge.
- Block text is a `Y.Text`, so concurrent edits and formatting of one block
  merge; formatting attributes on overlapping ranges resolve by Yjs rules.
- Two inserts of the same id into `order`, or two blocks created under the
  same map key, collapse in normalization (first `order` occurrence wins; a
  map key holds one value after merge).
- Scalar fields (`sys:flavour`, `indent`, `done`, `pageId`) resolve
  last-writer-wins per key, so concurrent changes of one field keep one value
  and lose the other.

Anything outside these behaviors (for example two different moves of one block
yielding an order neither user intended) is accepted, provided every replica
derives the same order.

## Consequences

- #1539 builds `shared/block-model/` (registry, validation, normalization) from
  this ADR; #1610, #1608, #1394 and #1393 build on it.
- Server-side write paths added from now on call the strict validator, and
  readers use the normalized view rather than raw `blocks`/`order`.
- The Czech labels of types and any UI copy are outside the stored model; only
  the English type keys above are stored.
