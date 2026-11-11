---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Page rename writes the item title and the parent's block together

## Context

A subpage's title lives in two places. [[2026-10-29-subpages-are-items-of-a-hidden-pages-database]] makes the text of the
`page` block in the parent's document the source and the `title` of the Pages item a mirror, and says `page.rename`
writes both. A client that has only the subpage open does not hold the parent's document, so it cannot write the block
itself. [[2026-10-28-page-operation-family]] lists `page.rename` as `PATCH /api/items/:id/page/title` on
`core.page.write` and, in its section 6, as the writer of `meta.title` of a root page. #1725 delivers the operation for
subpages. Its Task differs from the family table in the capability, and it leaves root pages out. The older records
stay as they are.

The `pageTitleMirror` job writes the same `title` from the parent's document. Its lock order is the host's row, the
host's document, then the Pages items ([[2026-11-09-page-title-mirror-reserves-the-live-host]]). `page.duplicate` takes
the parent's row and then the page's row ([[2026-11-10-page-duplication-copies-the-subtree-as-new-pages]]).

## Decision

### 1. Contract

- The input is `{ pageItemId, title }` and the output `{ pageItemId, title }` with the title as stored. The REST binding
  is `PATCH /api/items/:id/page/title`, where `:id` is the Pages item and the body is exactly `{ title }`; another body
  field is a 400 that names it.
- The title goes through `normalizePageTitle`: every run of line breaks becomes one space, the result is trimmed, and
  more than 500 code points is a 400 on `title`. An empty title is valid.
- `page.rename` is a non-destructive write on `core.item.write` without approval, as the #1725 Task says. This is the
  exception to the family's capability table that
  [[2026-11-09-page-http-routes-and-subpage-paths-follow-delivery-contracts]] records for `page.createSubpage`. #1844
  owns the agent classification of the page operations and may change this in a record of its own.
- Only an item of the Pages database can be renamed. A live item of any other database (a host) is a 400 on
  `pageItemId`, checked before the title; a missing, trashed or foreign item is a 404. Renaming the root page of a host
  (`meta.title`, section 6 of the family record) is not delivered by #1725.

### 2. What is written

- One transaction stores the title on the Pages item and as the text of a block of the parent's document. If the
  document write fails, the item keeps its old title.
- The item's `title` is written through the choke point's `updateItemWithClient` under the `pages` owner process, the
  owner of that system property.
- In the document of the item that `parentItemId` names, the first `page` block in document order that names the page
  gets the new title as plain text. It is the block the mirror job reads when several blocks name one page; any other
  block that names the page keeps its own caption. The block is written through the block model's `writeBlock` with its
  current indent and `pageId`, in one document update authored by the caller (`user` or `ai_agent`).
- A block that already reads the new title is not written again, so no update is stored for it.
- A page that no block of the parent's document names (an orphan) has only its item renamed, and the call succeeds. The
  same holds when `parentItemId` is not an id, names no item, or names an item without a document.
- The document of a parent that is in the trash is written like any other, so block and item agree when the parent is
  restored.
- A title equal to the stored one writes nothing and answers with that title.

Rejected: writing every block that names the page. Two blocks may name one page with different captions, and the mirror
job takes the title from the first.

### 3. Locks

- The page is first read without a lock, which decides the 404 and the 400 on `pageItemId`.
- Then the operation takes `FOR UPDATE` on the row of the item `parentItemId` names, when that item exists (live or
  trashed), and then on the page's row. Under the page's lock it checks again that the page is live and compares the
  stored title with the new one. The item update and the document write follow, the document last.
- This is the order of [[2026-11-09-page-title-mirror-reserves-the-live-host]] and of
  [[2026-11-10-page-duplication-copies-the-subtree-as-new-pages]]: the host's row before a Pages item. The #1725 Task
  names only the row lock that the item update takes. Taking the page's row and then the parent's document without the
  parent's row first would be the reverse of the mirror job's document-then-item order, and the two could wait for each
  other. With the parent's row first, a rename and a mirror job or a duplicate of the same parent run one after the
  other.
- The page's `parentItemId` is taken from the unlocked read;
  [[2026-11-09-page-title-mirror-locks-only-children-it-owns]] states the premise this relies on, that only the creation
  owner sets `parentItemId`.

## Consequences

- The family table's `core.page.write` does not describe `page.rename`; code and tests follow this record.
- Breadcrumbs, the trash and item reads show the new title as soon as the rename commits, without waiting for the
  mirror job, because they read the item.
- The document update of a rename enqueues the mirror job of the parent like any page write. When that job runs it
  finds the block and the item equal and writes nothing.
- A rename waits while a mirror job, a duplicate or a subpage creation holds the row of the same parent.
- An owner that later reparents pages must revisit the lock order above together with the mirror's.
