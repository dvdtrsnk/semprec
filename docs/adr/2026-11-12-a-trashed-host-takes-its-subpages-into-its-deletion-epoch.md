---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# A trashed host takes its subpages into its deletion epoch

## Context

[[2026-10-29-subpages-are-items-of-a-hidden-pages-database]] decides that deleting a host trashes its subpages through
the hooks that trash a page (decision 5). [[2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position]]
decided those hooks for Pages items only and left a host that is not a page to issue #1763. Until then the trash of a
project, an area, an event or a Journal day left its subpages live and reachable by link, and its restore restored
none of them. The choke point's cascade cannot reach them: it follows inline databases, and a subpage hangs on its
host through the text property `parentItemId`.

Three accepted records describe what this decision builds on or changes. None of them is edited.

- [[2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position]] gives the rules a trashed page
  follows: its block leaves the parent's document, its subpages follow it by deletion epoch (decision 3), who authors
  the writes (decision 7), and which locks are taken in which order (decision 8).
- [[2026-11-09-page-title-mirror-reserves-the-live-host]] states that the trash of a host "does not lock or trash Pages
  items by `parentItemId`" and that trashing a host does not trash or restore its Pages children.
- [[2026-11-10-a-mailbox-removal-job-joins-the-mailbox-trash-epoch]] gave `itemDeleteWithClient` the option
  `deletedAtExact`, with which a trash joins an earlier epoch, and made its caller responsible for reading that epoch
  under a lock. The mailbox removal job trashes Folders and Emails items that way, so the `deleted_at` of a trashed
  host is not always the `now()` of the transaction that trashed it.

The hooks of this decision run for every row of every trash and restore, so the path of a row without subpages has to
stay cheap.

Issue #1763 implements this decision in `backend/packages/data/src/docs/pageTrash.ts`.

## Decision

### 1. Two more hooks, for every row that is not a Pages item

`hostItemDeleteHook` and `hostItemRestoreHook` are registered in `domainWriteHooks.ts`. They act on a row of any
database except the tenant's Pages system database (`system` and owner module id `pages`), whose rows stay with
`pageItemDeleteHook` and `pageItemRestoreHook`. The cascade runs the hooks for every row it trashes or restores, so a
subpage whose host is a row of an inline database follows that row when the cascade reaches it.

Rejected: following `parentItemId` in the cascade's own subtree walk (`collectItemSubtree`). The choke point would then
carry a rule of the docs module, the coupling [[2026-11-07-item-delete-and-restore-domain-hooks]] added the hook
registries to avoid.

### 2. A row without subpages costs reads only

A hook returns before its first statement for a Pages item. For any other row it looks up the tenant's Pages database,
one read, and returns when there is none. It then selects the subpages it acts on (decision 3) in one statement, a
second read, and returns when that statement matches no row. A statement that matches no row locks none. No index and
no column is added for the lookup by `parentItemId`: issue #1763 decides so because a tenant's Pages partition is
small.

### 3. Subpages join the host's epoch

- The delete hook selects the live Pages items whose `parentItemId` is the row and locks them `FOR UPDATE` in that
  statement, in id order. It reads the row's own `deleted_at` at full precision (`itemsStore.lockItemTrashEpoch`) and
  trashes each subpage, in id order, through `itemDeleteWithClient` with that value as `deletedAtExact`. The cascade
  soft-deleted the row in this transaction and holds its row lock, so the value read is the epoch the row keeps. In a
  trash that joins no earlier epoch it is the transaction's `now()`.
- The restore hook selects the Pages items whose `parentItemId` is the row and whose `deleted_at` equals the hook's
  `deletedAtExact`, compared by Postgres, and locks them `FOR UPDATE` in that statement, in id order. It restores each
  through `restoreItemWithClient` in descending id order, the reverse of the order they were trashed in, for the reason
  decision 5 of [[2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position]] gives.
- Each subpage is the root of its own nested trash or restore. Its run of the page hooks takes its block out of the
  host's document or puts it back, and continues with the pages below it.
- A subpage that was trashed on its own at another instant has another `deleted_at` and stays in the Trash when its
  host is restored. Equal timestamps are not a transaction identity: a subpage trashed on its own at exactly the
  host's microsecond is restored with the host.
- The pages below a subpage join the same epoch. `pageItemDeleteHook` reads the deletion epoch of the page it runs for
  with `itemsStore.lockItemTrashEpoch`, when that page has live subpages, and passes it as `deletedAtExact` to the
  nested trash of each of them, so every page of the tree keeps the epoch of the row the trash started at. In a trash
  that joins no earlier epoch that value is the transaction's `now()`, which the nested trash would have used anyway,
  and a page without live subpages makes no extra read. The restore of a subpage then finds the pages below it by the
  epoch it was restored with, also when the host's trash joined an earlier one.

Rejected: trashing the subpages without an epoch. A host whose trash joined an earlier epoch would then never find its
subpages again: the restore of a removed mailbox restores its Emails by that epoch, and the restore of an Email would
match none of the subpages trashed with it.

Rejected: leaving the page hook as it was, so that the pages below a subpage get the transaction's `now()`. When the
host's trash joins an earlier epoch, the subpage and the pages below it would carry two epochs, and the restore of the
host would return the subpage and leave the pages below it in the Trash with their blocks out of the subpage's
document.

Rejected: trashing the whole tree below the host from this hook (`collectSubpageTree`). The page hook already
continues below every page, and two walks over one tree would have to agree on the order and on the locks.

### 4. Writer and queue routing

The nested trash of a subpage runs with the writer kind, agent run and acting user of the hook's context and with the
production queue routing table (`createActionQueueAffinity()`), since a delete hook's context carries none. The nested
restore passes the context's own `queueAffinity`, writer and acting user. These are the rules of decision 7 of
[[2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position]]; the document writes are those of the
page hooks and are authored as that decision says.

### 5. Locks

No new lock kind, `NOWAIT`, retry or catch is added. Both hooks run in the cascade's transaction.

- The cascade holds the host's row lock before a hook runs for it. In a trash the root is locked through
  `lockItemById` and a row of an inline database by its soft delete. In a restore the root is locked through
  `lockItemById` and the rows of its epoch by the cascade's epoch statement, before the first of them is restored.
- The hook then locks the rows of the direct subpages it acts on in one statement, in id order, before it trashes or
  restores the first of them.
- The nested trash or restore of each subpage then takes the locks decision 8 of
  [[2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position]] names for a page. The last of them
  is the lock on the document of the page's parent, which here is the host's document.

For one host the order is therefore: the host's row; the rows of its direct subpages; then, subpage by subpage,
everything below that subpage followed by the host's document. This is the order of a page with its subpages, with the
host in the place of the page. The page title mirror job, `page.rename`, `page.duplicate` and `page.createSubpage`
also lock the host's row before the row of one of its pages and before its document.

- The mirror job of a host and a trash or restore of that host both lock the host's row before the host's document
  and before any of its Pages items. Whichever of the two gets the row first, the other waits for it while it holds
  neither that document nor one of those rows.
- The trash or restore of a subpage on its own still locks the subpage's row first and the host's document last. The
  wait cycle with the mirror job of the host that
  [[2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position]] records, which PostgreSQL ends with
  `40P01`, is unchanged.

This covers the locks named in this decision, not those of other hooks that run for the same rows.

Rejected: locking each subpage's row only when its turn to be trashed comes. The trash of the first subpage locks the
host's document for its block. The trash of the host would then hold that document while it waits for the row of a
later subpage, and a trash of that subpage on its own holds the row while it waits for the document.

## Consequences

- Every trash and restore of a row that is not a Pages item issues one more read, and a second one in a tenant that
  has a Pages database.
- The trash of a page that has live subpages issues one more read, the page's deletion epoch, and takes a share lock on
  its own row, which the cascade already holds `FOR UPDATE`. The trash of a page without live subpages issues the same
  statements as before.
- `DELETE /api/items/:id` of a host trashes every live page below it, and `POST /api/items/:id/restore` restores the
  pages of its epoch below it. Both write the documents that hold the blocks of those pages, the host's among them, in
  the cascade's transaction. An error from any of those writes rolls the whole trash or restore back.
- The blocks of a trashed host's subpages are no longer in its document while it is in the Trash. They are recorded in
  its `trashedPages` map and return with the restore.
- The statements of [[2026-11-09-page-title-mirror-reserves-the-live-host]] that the trash of a host does not lock or
  trash Pages items, and that it does not trash or restore its Pages children, no longer hold. Its lock order and its
  reservation of the host still hold.
- The consequence of [[2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position]] that trashing a
  host that is not a page leaves its subpages live no longer holds.
- A page can still be live below a trashed host: one that was restored on its own after the host's trash, and the
  subpages of a host that was trashed before this decision was implemented. This decision changes no stored row, so
  those subpages stay live, and restoring that host finds no subpage of its epoch.
- An Emails or Folders item that the mailbox removal job trashes takes its subpages into the mailbox's epoch, and the
  restore of the mailbox brings them back with the item, together with the pages below those subpages.
- The permanent purge runs neither hook.
