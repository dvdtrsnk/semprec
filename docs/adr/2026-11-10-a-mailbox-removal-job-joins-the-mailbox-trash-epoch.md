---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# A removed mailbox's folders and messages join the mailbox's trash epoch in a chunked job

## Context

[[2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status]] trashes the Mailboxes item and
nothing else: the mailbox's Folders and Emails are not rows of its item subtree, and a mailbox can hold many
thousands of messages. Issue gh-2029 trashes them.

Two earlier decisions meet here:

- [[2026-09-28-chunked-transactions-for-large-background-sweeps]] splits a large sweep into pages that commit
  on their own.
- [[2026-11-07-item-delete-and-restore-domain-hooks]] defines the epoch of a trash cascade as the `deleted_at`
  its rows share, which is the `now()` of the cascade's one transaction, and
  [[2026-11-08-restore-hooks-carry-exact-deletion-epochs]] hands that epoch to restore hooks at full precision.
  Issue gh-2032 will restore a removed mailbox together with the rows the removal trashed, and has to tell them
  from rows the user trashed on their own.

A chunk commits in a later transaction than the removal, so its `now()` is not the mailbox's `deleted_at`.
Nothing in the choke point could give a row another time.

Rejected alternatives:

- Trashing every folder and message inside the removal transaction: one transaction of unbounded size.
- Chunks that keep their own `now()` plus a table listing what the removal trashed: a second record of what the
  epoch already states, to be kept in step with it.
- An `UPDATE items SET deleted_at` from the mail module: it skips the delete hooks, heartbeats and invalidations
  of the trash cascade ([[2026-09-10-choke-point-api-for-state-writes]]).

## Decision

- **The job.** The removal transaction enqueues the core task `mailboxRemoval` (a tenant task of the `api`
  affinity set) with the job key `mailbox-removal-<mailboxItemId>` on the lane `mailbox-removal:<tenantId>`
  ([[2026-10-08-per-tenant-queue-lanes]]). The enqueue is a statement of that transaction, so the job exists
  only when the removal commits.
- **Members.** The job trashes the rows the removal impact report (issue gh-1501) counts: the non-deleted Emails
  in the mailbox's non-deleted Folders, drafts included, and those Folders. Both statements start from the same
  SQL text, `MAILBOX_REMOVAL_MEMBERS_CTE_SQL` in `mail/mailboxRemovalImpact.ts`. Emails go first, because
  membership is read through the live Folders. The job writes no Threads item and no `mail_threads` row: a
  thread leaves the thread list when its last live message is trashed, and a thread that also holds a message of
  another mailbox keeps that message.
- **Chunks.** A chunk is one READ COMMITTED transaction over at most 100 rows, in id order after the last id of
  the previous chunk. A chunk that throws rolls itself back and fails the job; earlier chunks stay committed. A
  rerun selects the rows that are still live.
- **Joining the epoch.** `itemDeleteWithClient` takes an optional `deletedAtExact`. With it, every row the call
  soft-deletes, the root and its inline subtree, gets that `deleted_at` instead of the transaction's `now()`
  (`itemsStore.softDeleteItem` writes `COALESCE($3::timestamptz, now())`). The delete hooks, the `onItemEvent`
  heartbeats, the rollup recomputes and the invalidations run as for any trash, and the hooks receive that
  `deletedAt`. The value is UTC text with six fraction digits, the format of the restore hooks' `deletedAtExact`;
  any other text is refused before a row is written, because text of lower precision would join no epoch
  exactly. No route, agent tool or `/mcp` operation passes the option.
- **The lock.** Each chunk first locks the Mailboxes item `FOR SHARE` and reads the epoch from that row
  (`itemsStore.lockItemTrashEpoch`). When the mailbox is live or the row is gone, the job ends. A restore of
  the mailbox locks the item `FOR UPDATE`, so it waits for a running chunk, and a chunk that meets a running
  restore waits for it and then finds the mailbox live.

## Consequences

- Between the removal's commit and the end of the job the mailbox's folders and messages are still live and
  listed.
- A row a chunk trashes carries a `deleted_at` that is earlier than the transaction that wrote it. The trash
  purge counts its retention from `deleted_at`, so these rows become eligible together with the mailbox.
- A folder or message the user trashed before the removal is not a member. It keeps its own `deleted_at`.
- Equal timestamps are still not a transaction identity, as the two epoch records above say: a row trashed on its
  own at exactly the mailbox's microsecond is indistinguishable from the rows of the job.
- The cascade does not check that `deletedAtExact` is the `deleted_at` of any item. The caller is responsible
  for reading it under a lock, as the job does.
- A mailbox restored before the job finished stops the job at its next chunk. Rows the job had already trashed
  stay in the trash: the restore cascade restores the Mailboxes item's own subtree only. Issue gh-2032 will add
  the restore hook that restores the rows of the epoch.
