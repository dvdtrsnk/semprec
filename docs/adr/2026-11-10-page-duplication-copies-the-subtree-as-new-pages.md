---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Page duplication copies the whole subtree as new pages

## Context

[[2026-10-28-page-operation-family]] lists `page.duplicate` as `POST /api/items/:id/page/duplicate` with an "optional
target" and puts it on `core.page.write`. [[2026-10-29-subpages-are-items-of-a-hidden-pages-database]] makes a subpage an
item of the hidden Pages database whose parent holds a `page` block naming it, and leaves the size limit of a duplication
to #1722 ("Duplication is capped. The cap is set by #1722."). The design copied one level and shared the nested pages
between the original and the copy, so an edit in the copy changed the original. #1722 delivers the operation, and its
Task differs from the family table in the input and the capability. The older records stay as they are.

## Decision

### 1. Contract

- The input is `{ pageItemId }` and nothing else. No target is accepted: the copy always goes next to the original. The
  REST binding is `POST /api/items/:id/page/duplicate`, where `:id` is the Pages item, nothing of the request body is
  used, and the answer is 201 with `{ pageItemId, docId, blockId }` of the root of the copy.
- `page.duplicate` is a non-destructive write on `core.item.write` without approval, as the #1722 Task says. This is an
  exception to the capability table of the family record, the same one
  [[2026-11-09-page-http-routes-and-subpage-paths-follow-delivery-contracts]] records for `page.createSubpage`. An agent
  that holds `core.item.write` can therefore duplicate a page directly. #1844 owns the agent classification of the page
  operations and may change this in a record of its own.
- Only an item of the Pages database can be duplicated. A live item of any other database (a host) is a 400 on
  `pageItemId`; a missing, trashed or foreign item is a 404, and so is a page whose `parentItemId` does not name a live
  item, because the copy is created as a subpage of that parent.

### 2. What is copied

- Every page of the copy is a new Pages item with a new document. The blocks keep their order, type, indent, `done` and
  text runs with their inline attributes, and every block gets a new id.
- A `page` block is followed when its `pageId` names a live item of the Pages database. The page it names is copied as a
  page of its own, nested in the copy, and the copied block names that new page. A page named by two blocks is copied
  once per block, so the copy never holds two blocks that share a page.
- A `page` block is left out of the copy when it names a trashed, purged or missing page, an item that is not a page, or
  the page being copied or one of its ancestors within the copy. The last case is what ends a cycle of references.
- A copy has at most 500 pages, its root included. The whole tree is planned by reading before the first row is created;
  a tree that would need a 501st page is refused with a 400 on `pageItemId` and writes nothing.
- The root of the copy is titled from the source of the original's title
  ([[2026-10-29-subpages-are-items-of-a-hidden-pages-database]], decision 4): the text of the first `page` block of the
  parent's document that names the original, with line breaks turned into spaces and cut to the 500 code points of a
  page title, as the mirror job stores it. Only when no block names the original (an orphan) is it the `title` stored on
  the original's Pages item. A suffix follows, from the docs catalog in the caller's locale
  (`page.duplicate.titleSuffix`, English for every locale but Czech); the original's title is cut at its end where title
  and suffix together would exceed the 500 code points. The root's item and its `page` block carry the same title.
- A nested copy gets no suffix. Its item takes the `title` stored on the Pages item it copies, and its `page` block in
  the copy keeps the text of the block it was copied from.
- The root's `page` block goes into the parent's document right after the first block that names the original, at that
  block's indent, or at the end with indent 0 when no block names the original.
- Every document write of the operation carries the caller's origin (`user` or `ai_agent`).

Rejected: copying a page that is named twice only once. The issue decides for one copy per reference, and it keeps every
copied block the only one that names its page. Rejected: keeping a block that points back to an ancestor and aiming it
at the ancestor's copy. The copy would then hold a `page` block whose page is not its child, a cycle of references that
every later walk over `page` blocks would have to cut again. Rejected: titling the root of the copy from the original's
item. That `title` is a mirror that lags the block by the debounce interval of the mirror job, and the copy's own block
would become the source of the lagging title, which no later job corrects.

### 3. Transaction, locks and what the copy is a snapshot of

- The operation runs in one transaction at the default isolation level, READ COMMITTED.
- It reads the page without a lock, then takes `FOR UPDATE` on the parent's row and then on the page's row, and checks
  under each lock that the row is live. This is the order of
  [[2026-11-09-page-title-mirror-reserves-the-live-host]]: the host before a Pages item. The page's `parentItemId` is
  taken from the unlocked read; [[2026-11-09-page-title-mirror-locks-only-children-it-owns]] states the premise this
  relies on, that only the creation owner sets `parentItemId`.
- The title of the root is read once both row locks are held: the block's text from the parent's document with a plain
  statement, without a lock on that document, and for an orphan the `title` of the locked row. A title typed in the
  parent that commits after this read is not in the copy.
- The nested pages are not locked, and the documents being copied are read with plain statements, without row locks and
  without compaction. Each of these reads sees what was committed when it ran. The copy is therefore not one snapshot of
  the tree: an edit or a trash of a nested page that commits while the copy runs is included or not, depending on whether
  its page had been read. Nothing the operation writes depends on a nested page staying as it was read.
- The parent's document is written last, through `mutateDocWithClient`, which locks that document's stored rows.

Rejected: locking every nested page and loading every copied document through `loadDocWithClient`. That takes up to 500
row locks and can compact, which rewrites the stored rows of the originals, for a consistency no caller needs. Rejected:
creating rows while walking the tree. A tree over the cap would then be refused only after up to 500 pages had been
written and had to be rolled back.

## Consequences

- The family table's "optional target" and `core.page.write` do not describe `page.duplicate`; code and tests follow this
  record.
- A copy of N pages creates N items and N documents in one transaction and writes one update to the parent's document
  and one to each page of the copy that has blocks. Each of these updates enqueues the page-text and title-mirror jobs that
  any page write enqueues.
- A nested page whose mirrored `title` lags its block in the parent (the lag
  [[2026-10-29-subpages-are-items-of-a-hidden-pages-database]] accepts) is copied with the lagging title on its item and
  the current text on its block; the mirror job of the copy's document brings the item in line. The root of the copy
  does not take that lag over: it is titled from the original's block, so its item and its block carry the title the
  parent shows even before the original's item has been mirrored. The copy does not write the original's item, which
  stays for the mirror job.
- An owner that later reparents pages must revisit the lock order above together with the mirror's.
