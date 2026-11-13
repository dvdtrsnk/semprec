---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# Page replace is guarded by the page's ETag, trashes vanished subpages and is dispatched by REST alone

## Context

[[2026-10-28-page-operation-family]] names `page.replace` with a route `PUT /api/items/:id/page/content` and an optional
`expectedLastEditedAt`. Issue #1678 then gave a page its Markdown read, `GET /api/items/:id/page.md`, with a version
token (`docEtag`), and issue #1765 delivers the write that pairs with it. This decision records where #1765 differs from
the family ADR and the choices the family ADR leaves open.

[[2026-10-29-agent-page-write-policy]] says replacing a page needs approval and that #1844 wires that approval.
`GenericOperationGateway` can hold only the destructive operations whose approval snapshot and replay it implements
(`isDestructiveOperationName`); `page.replace` is not among them, and building them is the approval work of #1844, which
#1765 leaves out of scope.

[[2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position]] decides that trashing a page removes its
block from the parent's document and records where the block stood, so that a restore puts it back. A direct trash locks
the subpage row and then the parent's document.

## Decision

### 1. The route, the token and the status codes

The replace is `PUT /api/items/:id/page.md`, body `text/markdown` in UTF-8, bounded to 1 MiB. The precondition is the
`If-Match` header holding exactly one quoted strong tag: the `ETag` that `GET` of the same URL sent. The operation compares
`docEtag` of the stored document (that of an empty document when the item has none) with it.

| Request | Answer |
|---|---|
| no `If-Match` | `428` |
| `If-Match` that is not one quoted strong tag | `400` on field `If-Match` |
| token that is not the current one | `409` with the current `ETag` header; nothing is written |
| success | `200`, new `ETag`, body `{ trashedPages: [{ pageItemId, title }] }` |

This replaces `expectedLastEditedAt` and the `/page/content` route of the family ADR for the Markdown replace.

### 2. One transaction, one lock order

`replacePageMarkdown` runs in one transaction. It locks the host item row (`lockLiveItem`), then the rows of all live
subpages of the host in id order (the statement the trash of a page uses, `lockLiveChildPageIds`), and only then loads
the document and compares the token. Taking the document first would let a direct trash of a subpage, which locks its row
and then the document, and a replace wait for each other. Two replaces of one item cannot interleave: the second waits
on the host row and then fails the comparison with `409`. The ordering is atomicity plus these locks, not a lock on the
document itself.

### 3. Links are validated, vanished links trash, changed captions rename

A `page` block must name a live subpage of the host (a Pages item whose `parentItemId` is the host). An unknown id, a
trashed subpage, a page of another parent and the host itself are the same `400`; replace never creates a subpage and
never moves one. A subpage that the page links now and the new Markdown no longer links is trashed through the choke
point's `itemDeleteWithClient`, in the same transaction and before the diff removes its block, so the trash hook records
the block's position. A subpage with no block in the page is left alone. A subpage whose first link has a different
caption is renamed through `renamePageWithClient`. Any failure rolls all of it back.

### 4. The body changes by an id-preserving diff

`planBlockDiff` pairs the new blocks with the current ones by content (type, indent, `done`, formatted text, page id and
caption): the equal blocks at the start and at the end, then a longest common subsequence of the changed stretch, which
is skipped when the stretch is larger than `MAX_DIFF_CELLS` products of block counts. A paired block keeps its id and is
not rewritten; the others are inserted with fresh ids and the unpaired current blocks are deleted, all in one document
update.

### 5. Only REST dispatches the operation until #1844

`page.replace` is in the generic operation catalog, with `core.page.write` and destructive metadata, and in
`REST_ONLY_OPERATION_NAMES` like the select-option operations of
[[2026-11-10-select-options-change-on-a-schema-locked-database]]. The gateway therefore neither lists nor calls it, so
the AgentTool and MCP transports and a run credential on the REST route answer it as an unknown operation (`404`) and
write nothing. The application service still derives the origin from the actor (`ai_agent` for an agent actor, `user`
otherwise), so #1844 can lift the restriction after it adds the approval snapshot and replay, without changing the
operation.

Rejected: leaving it callable by agents with the destructive flag alone. The gateway would answer an approval-requiring
operation it cannot hold with a validation error rather than a held request, and the destructive default would hide that.

## Consequences

- #1844 removes `page.replace` from `REST_ONLY_OPERATION_NAMES` when it implements the approval of page operations.
- A client that wants Undo for a trashed subpage uses the item restore of #1723 with a `pageItemId` from `trashedPages`.
- The contract of the gateway, MCP and AgentTool tests lists `page.replace` among the REST-only operations.
