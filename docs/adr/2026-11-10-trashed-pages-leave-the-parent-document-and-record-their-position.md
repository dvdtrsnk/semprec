---
status: accepted
date: 2026-11-10
area: [backend, web, mobile]
supersedes: []
superseded-by: null
---

# A trashed page leaves its parent's document and records where its block stood

## Context

[[2026-10-29-subpages-are-items-of-a-hidden-pages-database]] decides that deleting a page is the generic `item.delete`
with domain hooks and that restoring it is the generic item restore with the same hooks (decision 5). It leaves open
what those hooks do with the page's subpages and with the `page` block that shows the page in its parent's document.

The choke point's trash cascade follows inline databases (`databases.parent_item_id`). A subpage hangs on its parent
through the text property `parentItemId`, so the cascade reaches neither the subpages of a page nor its block.
[[2026-11-07-item-delete-and-restore-domain-hooks]] lets a domain act inside the cascade's transaction, and
[[2026-11-08-restore-hooks-carry-exact-deletion-epochs]] gives a restore hook the exact deletion epoch, the caller's
queue routing and the exported `restoreItemWithClient`. A delete hook's context carries no queue routing.

Three facts shape the decision:

- The choke point does not update a trashed row, so the place of a removed block cannot be kept on the Pages item.
- A document keeps being edited through `WS /api/sync` between a trash and a restore, and that path cannot reject part
  of an update ([[2026-10-28-block-model-for-page-documents]], decision 4). The neighbor of a removed block can
  disappear, a block for the page can be written by hand, and anything stored in the document can be malformed.
- [[2026-11-09-page-title-mirror-reserves-the-live-host]] describes the lock order of the page title mirror job with the
  statement that "the trash of a Pages item locks only that item". This decision changes that for pages. That record is
  accepted and is not edited.

Issue #1723 implements this decision in `backend/packages/data/src/docs/pageTrash.ts`.

## Decision

### 1. Two hooks, for Pages items only

`pageItemDeleteHook` and `pageItemRestoreHook` are registered in `domainWriteHooks.ts`. They act on a row only when its
database is the tenant's Pages system database (`system` and owner module id `pages`). Pages get no delete or restore
route of their own: a route would be CRUD over module data ([[2026-09-11-module-manifest-custom-routes]]) and would
bypass the approval an agent's `item.delete` needs.

### 2. The rule is the same for every page

Every page that is trashed, whether it is the item the caller deleted or a subpage trashed with it, has its `page` block
removed from the document of the item its `parentItemId` names. Every page that is restored has its block put back
there. A page restored on its own therefore appears in its parent again, also while that parent is still in the Trash.

### 3. Subpages follow their parent by deletion epoch

- The delete hook selects the live Pages items whose `parentItemId` is the trashed page and locks them `FOR UPDATE` in
  that same statement, in id order. It trashes each, in that order, through the choke point's `itemDeleteWithClient`,
  in the same transaction. That call trashes the row only while it is still live, and runs the delete hooks for it, so
  this hook continues one level down. Every page trashed this way shares the transaction's `deleted_at`. A subpage
  whose own trash commits while the statement waits for its row is no longer live when the lock is granted. It is left
  out and keeps its own `deleted_at`.
- The restore hook selects the Pages items whose `parentItemId` is the restored page and whose `deleted_at` equals the
  hook's `deletedAtExact`, compared by Postgres, and locks them `FOR UPDATE` in that same statement, in id order. It
  restores each through `restoreItemWithClient`, which runs the restore hooks for it, in descending id order: the
  reverse of the order the delete hook trashed them in (decision 5).
- A subpage that was trashed on its own at another instant has another `deleted_at` and stays in the Trash. Equal
  timestamps are not a transaction identity: a subpage trashed on its own at exactly the same microsecond is restored
  with its parent.

Rejected: restoring every trashed subpage with its parent. It would bring back pages the user deleted on purpose.

### 4. The position is recorded in the parent's document, in `trashedPages`

The parent's document gets a top-level shared type `doc.getMap('trashedPages')`. It is separate from `blocks` and
`order` of the block model and is not a block.

| Part | Encoding |
|---|---|
| key | the id of the trashed Pages item |
| value | a plain JSON object, not a nested Yjs type |
| `blockId` | non-empty string: the id of the removed `page` block |
| `afterBlockId` | string or `null`: the id of the block before it in the block model's normalized order; `null` when it was the first block |
| `indent` | integer 0-5: the block's indent as the block model reads it |

- The delete hook writes the entry in the same Yjs transaction that removes the block, so both are one stored update.
- The restore hook deletes the entry, whether or not it inserts a block.
- The permanent purge runs no hook ([[2026-11-07-item-delete-and-restore-domain-hooks]]), so the entry of a purged
  page stays in the document. Removing it waits for a product decision.
- On the server only these two hooks write the map. It still arrives through sync like the rest of the document, so
  the restore hook validates an entry before using it and treats one that does not match the table as absent.

Rejected: keeping the position on the Pages item. The choke point does not update a trashed row, and a second writer of
a trashed row would break that rule for every other reader of the Trash.

### 5. Where a restored block goes

The restore hook inserts nothing when the parent's document already holds a `page` block whose `pageId` is the page.
Otherwise it inserts one `page` block with the Pages item's current `title` as its text (empty text when the stored
title is not a string):

- with a valid entry whose `afterBlockId` is `null`: as the first block;
- with a valid entry whose `afterBlockId` names a block that still exists: right after that block;
- otherwise (the neighbor is gone, or there is no valid entry): after the last block of the document.

The block gets the recorded `indent`, or 0 without a valid entry. It gets the recorded `blockId`, or a new random UUID
when there is no valid entry or another block already has that id.

The recorded neighbor is the block that stood before the page's block at the moment that page was trashed. The trash of
a page removes the blocks of its subpages one after another, so a subpage trashed later records its neighbor in a
document that has already lost the blocks of the subpages trashed before it. The restore hook therefore restores the
subpages of a page in the reverse of that order (decision 3). Each block is then put back into the document exactly as
its own trash left it, with its recorded id, so page blocks that stood next to each other return in their order.

Rejected: always appending at the end. The editor's Undo of a deleted page block is this restore, and Undo has to put
the block back where it was.

Rejected: restoring the subpages in the order they were trashed in. Two page blocks that stood next to each other
would return swapped when the upper one was trashed first. When the lower one was trashed first it would go to the end
of the document, because its recorded neighbor is the upper block, which is not back yet.

### 6. What a hook leaves alone

- A page whose `parentItemId` is not a UUID string, or whose parent has no document of kind `page` (never written, or
  purged with the parent), is trashed and restored without a document write.
- A trash whose parent document holds no block for the page stores no update and writes no entry. When several blocks
  name the page, the first in document order is removed and recorded; the others stay.

### 7. Authorship and queue routing

- A hook's document update is authored by the writer kind of the trash or restore: `user` for `user`, `ai_agent` for
  `agent`, `system` for `system`. The approved replay of an agent's `item.delete` runs with the writer kind `agent`, so
  its updates are authored `ai_agent`.
- The nested trash of a subpage runs with the writer kind, agent run and acting user of the hook's context, and with the
  production queue routing table (`createActionQueueAffinity()`), since a delete hook's context carries none. The nested
  restore passes the context's own `queueAffinity`, writer and acting user.

### 8. Locks

No new lock kind, `NOWAIT`, retry or catch is added. The hooks take blocking `FOR UPDATE` row locks and hold the locks
of the calls they make. Both run in the cascade's transaction, which every path that trashes or restores a page opens
at READ COMMITTED, the default of `withTransaction`.

- The cascade has locked the page's row before a hook runs. The hook then locks the rows of the direct subpages it
  acts on in one statement, in id order, before it trashes or restores the first of them (decision 3): the delete hook
  the live ones, the restore hook the ones of the page's deletion epoch. `itemDeleteWithClient` and
  `restoreItemWithClient` lock each of those rows again, which the transaction that already holds it is granted at
  once. A page's row is therefore locked before the rows of its subpages, the same host-before-child order the page
  title mirror job uses.
- Writing a document loads it through `loadDocWithClient`, which locks its `doc_snapshots` row and its pending
  `doc_updates` rows `FOR UPDATE`.
- The hooks lock a page's own document for the first time when the first of its subpages removes or inserts its block.
  That is after the rows of all the direct subpages the hook acts on are locked.
- Within one trash or restore of a page the order is: the page's row; the rows of its direct subpages; then, subpage by
  subpage, everything below that subpage in this same order, followed by the page's own document; and the document of
  the page's parent last. The row of the page's parent is not locked.
- The trash or restore of a subpage on its own locks the subpage's row first, then what is below the subpage, and the
  document of the subpage's parent last. The trash or restore of that parent, or of a page further up, locks the
  subpage's row before it locks anything below the subpage and before it locks that document. Whichever of the two
  gets the row first, the other waits for it while it holds none of the locks the first still needs. This covers the
  locks named in this decision, not those of other hooks that run for the same rows.

Rejected: reserving the parent's row or document with `NOWAIT`, as
[[2026-11-08-restore-hooks-carry-exact-deletion-epochs]] does for a transcript's source file. Every load of the
document through `loadDocWithClient` and every write of the parent item holds those locks for a moment, so a page's
trash would fail whenever any of them was in flight.

Rejected: locking each subpage's row only when its turn to be trashed comes. The trash of the first subpage locks the
page's own document for its block. The trash of the page would then hold that document while it waits for the row of
a later subpage, and a trash of that subpage on its own holds the row while it waits for the document. PostgreSQL
would abort one of the two with `40P01`.

## Consequences

- `DELETE /api/items/:id` and `POST /api/items/:id/restore` of a page change up to one document per trashed or restored
  page, all in the cascade's transaction. A failing document write rolls the whole trash or restore back.
- The statement of [[2026-11-09-page-title-mirror-reserves-the-live-host]] that the trash of a Pages item locks only
  that item no longer holds: it also locks the page's subpages and the document rows named in decision 8. The premise of
  [[2026-11-09-page-title-mirror-locks-only-children-it-owns]] still holds, because these hooks never write
  `parentItemId`.
- The mirror job of a parent locks the parent's row, then the parent's document, then the rows of its subpages. The
  trash or restore of one of those subpages locks the subpage's row and then the parent's document. When both run at
  once each can wait for the other; PostgreSQL ends that by aborting one of the two transactions with `40P01`
  (`deadlock_detected`). The aborted transaction changes nothing, and the error propagates unchanged from it. This
  decision does not claim that the hooks are free of deadlocks.
- A block returns to its exact place when pages are restored in the reverse of the order they were trashed in. The
  restore hook keeps that order for the subpages restored with their page. Pages of one parent that were trashed by
  separate calls and are restored in another order, or a subpage restored on its own before its page, are placed
  against the document as it is at each restore: after the recorded neighbor when it exists, otherwise at the end.
- A page block that was the only block of its parent leaves one empty `text` block behind when it is removed, because
  the block model's delete keeps one empty `text` block in a document it emptied. That block stays when the page is
  restored before it.
- A subpage restored on its own is live below a trashed parent. `collectSubpageTree`, which walks from an item down
  through live pages only, does not reach it.
- `collectSubpageTree(client, rootItemId)` returns the ids of the live pages below an item at any depth. Below a page
  these are the pages its trash takes with it. The delete impact preview (#1856) and the restyling of a page block
  (#1876) will count with it.
- Trashing a host that is not a page (a project, an area, an event, a Journal day) still leaves its subpages live.
  #1763 will trash them with the host.
- `trashedPages` grows by one small entry for every page that is trashed and later purged.
