---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Restyling a page block trashes its page tree, and only after the caller confirmed the page count

## Context

The shared block model refuses to restyle a `page` block into another type, because the block names a subpage and
leaving that subpage behind would orphan it without anyone being told (`page_conversion_required`,
[[2026-10-28-block-model-for-page-documents]]). The product owner decided that the server offers one explicit operation,
`page.convertToBlock`, which trashes the subpage tree and puts a normal block in the page block's place, and that it
refuses to run unless the caller passes the number of pages the user was shown. Trashing a page already removes its
block from the parent's document and records where it stood
([[2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position]]). [[2026-10-28-page-operation-family]]
lists the family of page operations in the generic catalog and leaves the route of this one open;
[[2026-10-29-agent-page-write-policy]] sets the policy for agent writes to pages.

## Decision

### 1. Contract

- `page.convertToBlock` is a catalog operation with the input `{ parentItemId, blockId, type, confirmedPageCount }` and
  the output `{ blockId, trashedPageCount }`. `parentItemId` is the item whose page document holds the block, a host or a
  page. `type` is one of the block types of the block model except `page`. `confirmedPageCount` is an integer from 1 to
  2147483647. `blockId` of the output is the id of the new block, which is not the id of the page block.
- REST: `POST /api/items/:id/page/convert`, where `:id` is the parent and the body is exactly `{ blockId, type,
  confirmedPageCount }`; another body field is a 400 that names it. The answer is 200. The path stays under the
  `/api/items/:id/page` prefix that the family reserves.
- A `blockId` that no block of the parent's document has, a block that is not a `page` block, a `page` block that is not
  the first block of the document naming its page, and a `page` block whose `pageId` is not a live Pages item with the
  parent as its `parentItemId` are each a 400 on `blockId`. The first block naming a page is the one the trash removes
  ([[2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position]]), so converting a later block would
  leave the first block in the document. A missing, trashed or foreign parent is a 404.

### 2. The confirmed count

- The count is the number of pages the trash takes: `collectSubpageTree` of the page, which holds the live pages below
  it, plus the page itself. The impact preview of #1856 counts the same way, so the number a user is shown is the number this operation compares.
- A `confirmedPageCount` that differs from the current count is a 409 with `details.reason = page_count_mismatch` and
  `details.currentPageCount`, and nothing is written. The caller shows the user the new count and asks again.

### 3. What is written, in one transaction

1. The parent's row is locked and checked live, then the page's row, then the rows of the live pages below the page,
   level by level, each level in id order.
2. The count is taken. A mismatch ends the call here.
3. The page is trashed through the choke point's item delete with the caller's writer identity. The Pages delete hook
   trashes the pages below it, removes the page's block from the parent's document and records its place in
   `trashedPages` (the entry stays, so a restore of the page still finds its place).
4. The new block is inserted into the parent's document after the neighbor the hook recorded, with the recorded indent
   and the title of the page block as plain text, in one document update authored by the caller's origin. The title is
   the text of the page block, which is what the parent shows, normalized like a page title and cut to its length limit,
   not the mirrored `title` of the item, which may lag. A document whose recorded entry is missing or names another
   block than the one converted is a 400 on `blockId`; the transaction rolls back.

A failure of any step rolls back every step, so no page is trashed without the new block. When the page block was the
only block of the document, the trash leaves the empty text block that an emptied document keeps, and the new block
stands before it.

Restoring the page later brings back the page, the pages that were trashed with it and the page's block at its recorded
place. The converted block stays; the user removes it.

### 4. Locks

The rows are taken in the order of the trash itself: a page's row, then the rows of its subpages, then the parent's
document last. The parent's row comes first, as in [[2026-11-10-page-rename-writes-the-item-title-and-the-parent-block-together]]
and [[2026-11-10-page-duplication-copies-the-subtree-as-new-pages]]. The rows of the pages below the page are locked
before the count is taken so the count is the number the trash takes: a transaction that creates a page below one of
them takes that page's row first, so it either committed before this one took the row, and the count includes its page,
or it waits for this one and then finds its parent trashed. The
rows of the document are not locked before the trash, because the trash of a page below locks them after its page's row,
and taking them first would reverse that order. A trash of a page below the page holds that page's row and waits only for
rows below it, and this operation locks a level completely before the level below it, so it never holds a row below a
page it waits for.

### 5. Agents

- The operation is a destructive write on `core.item.write` and `reversible`: the trashed pages and their block come
  back through the trash for the retention period. An agent's call is held for approval ([[2026-09-18-exactly-once-execution-of-approved-destructive-operations]]).
- The approval projection rehearses the refusals of the operation: the agent's project needs write access to the
  database that owns the parent page ([[2026-11-13-page-operations-follow-the-owner-database-grant]]), the block has to be
  the page block of a live subpage, and the count has to be current. A call that would be refused creates no request.
  The snapshot holds the parent, block, page, type and count, so an approved request whose page tree changed since ends
  as a conflict. The description names the page by the title its page block shows in the parent's document
  (normalized like a page title), the same text the new block receives and not the mirrored `title` of the item, and
  by the count, and holds no page content.
- The approved request runs as the agent that asked: the trash carries the agent's writer identity, and the new block is
  authored `user`, as the approver's decision is the user's, the same split `page.replace` makes.
- The notification body names the block type as a localised phrase, one catalog entry per type, never as the canonical
  key.

## Consequences

- `GENERIC_OPERATION_NAMES` grows to 49 entries; the catalog, bindings, capability metadata and the JSON schema record
  change together.
- A client shows the count from the impact preview, sends it back with the call, and on a 409 shows the new count.
- A caller that loses the race with a page created below the page gets the 409 instead of a trash of pages nobody saw.
- The new block has a new id; a client that tracks the page block by id learns the new id from the answer.
