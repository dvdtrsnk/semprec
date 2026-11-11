---
status: accepted
date: 2026-11-11
area: [backend]
supersedes: []
superseded-by: null
---

# The mail purge hook takes the mail-thread guard after the purge's locks, removes an emptied thread with its Threads item, and finds a purged mailbox's folders by their missing mailbox edge

## Context

[[2026-11-10-item-purge-domain-hooks]] added the item purge hook registry and named issue gh-1691 as
its first consumer. The mail tables name an item by its id without a foreign key (`items` is
partitioned), so the permanent purge leaves their rows behind:

- for an Emails item, its `mail_message_meta` row, its `mail_attachments` rows and its
  `mail_message_flag_sync_state` rows, and through the meta row its `mail_threads` row stays
  referenced;
- for a Mailboxes item, whatever the removal of
  [[2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status]] would have deleted
  and a trash without that removal left in place: the `external_credentials` row, the
  `mail_account_sync_state` row, the `mail_folder_sync_state` rows of its folders and the
  `mail_account_server_settings` row. The generic `DELETE /api/items/:id` is such a trash.

gh-1691 registers `mailItemPurgeHook` (`backend/packages/data/src/mail/mailPurgeHook.ts`) in
`domainWriteHooks.ts`. Three things in it had a real alternative:

- **The mail-thread guard.** [[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]]
  makes the decisions and mutations of thread membership take the tenant's guard, before membership
  reads and, in the reconcilers, before item locks. It also says that a new writer or a new lock
  acquisition order needs an explicit compatible contract. Deleting a message's meta row, and its
  thread when no message is left, is such a mutation. A purge hook cannot take the guard first: the
  registry runs it after the purge has taken the tenant's purge lock, locked and deleted the item
  and deleted the item's built-in dependents.
- **The emptied thread.** Since [[2026-11-05-mail-thread-item-merges-transfer-existing-relations]]
  a `mail_threads` row is bound to a Threads item (`mail_threads.item_id`), and that record decided
  what the one existing cleanup of an emptied thread does with the item. The text of gh-1691 is
  older than the binding and names only the row.
- **The folders of a purged mailbox.** The removal finds a mailbox's folders through the
  `Folders.mailbox` relation edges. `deleteItemDependents` deletes every relation edge of the purged
  item before the purge hooks run, so by then no edge names the mailbox.

## Decision

**Scope.** The hook acts on an item of the tenant's system Emails database and of its system
Mailboxes database: `databases.system` is set and `owner_module_id` is `emails` or `mailboxes`. For
any other item it returns before its first statement; a database that is not a system database and
only carries one of these module ids is another database. Each table is written through the store
that owns it. A delete that matches no row is not a failure: an unsent draft has no meta row, a
message without attachments has no attachment row, and a mailbox that never connected has none of
its four kinds of rows.

**Emails, in this order.** The meta row and, when it was the last one naming its thread, the thread
(`deleteMailMessageMetaOfPurgedItem` in `mail/mailMessageMetaStore.ts`); the `mail_attachments` rows
(`deleteMailAttachmentsOfMessage`); the `mail_message_flag_sync_state` rows
(`deleteMailMessageFlagSyncStates`). The `blobs` rows the attachments named, their bytes and the
Files items created from them are not deleted.

**The guard is the hook's first statement on a mail table.** `deleteMailMessageMetaOfPurgedItem`
calls `lockMailThreadMutation` before it reads or deletes anything, so the hook is a participating
writer of that guard. The helper requires a tenant scope and a READ COMMITTED transaction. The sweep
runs each tenant's purge in that tenant's scope, and the purge's transaction is READ COMMITTED.
Under the guard the function runs separate statements, each of which sees what earlier holders of
the guard committed: it deletes the meta row and reads back its thread; it reads the thread row
with `SELECT … FOR UPDATE` on the condition that no `mail_message_meta` row names the thread; when
that returns the row, it removes the thread as described below.

**The purge of an Email therefore takes its locks in this order:** the tenant's purge lock, the
item's row lock, the rows of the item's built-in dependents, the mail-thread guard, the meta row,
the thread row, and the Threads item's row inside the choke point's trash.
[[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]] has ingest and the reconcilers
take the guard at their entry, before item locks. The hook's order is accepted as it is, with the
consequences below, because the registry fixes the point at which a hook runs.

**An emptied thread goes with its Threads item.** A thread is emptied when no `mail_message_meta`
row names it. The row of a message in the trash counts as naming it, because that message can be
restored. The hook then removes the thread the way the failed-claim cleanup of
[[2026-11-05-mail-thread-item-merges-transfer-existing-relations]] does: it soft-deletes the bound
Threads item through `itemDeleteWithClient` as the system writer and then deletes the
`mail_threads` row. The `mail_thread_aliases` rows that point at the thread are removed by their
foreign key (`ON DELETE CASCADE`). A Threads item that is already in the trash is left as it is, as
in that cleanup. Unlike that cleanup, two states do not fail the purge: a Threads item that is
already purged, and a row bound to no item. In both the row is deleted. The reason is that a purge
hook that throws keeps the Email in the trash at every sweep.

**Mailboxes, in the removal's order.** The credential (`deleteCredential`), the
`mail_account_sync_state` row (`deleteMailAccountSyncState`), the folder sync state described next,
and the server settings row (`deleteMailServerSettings`). The hook takes no mailbox sync guard.

**The folders of a purged mailbox are found by their missing mailbox edge.**
`deleteMailFolderSyncStatesOfFoldersWithoutMailbox` deletes the `mail_folder_sync_state` row of
every Folders item of the tenant that no `Folders.mailbox` edge relates to a mailbox, trashed
folders included. `Folders.mailbox` is the single-valued side of a one-to-many relation, so the
folders of the purged mailbox have no edge once the purge has deleted the mailbox's edges. The same
statement also matches a folder that had no mailbox before: one the Gmail pseudo-folder cleanup
detached and trashed, one of a mailbox purged before this hook existed, and one created without a
mailbox. A Folders item without that edge is not a folder of any mailbox: folder discovery finds a
mailbox's folders by the edge and creates a new Folders item when it finds none
(`ensureFolderItem`), and the IMAP reconcile creates the sync state of the folder it is given when
the row is missing (`ensureMailFolderSyncState`). When the database the function is given has no
`mailbox` relation, the statement deletes nothing.

## Alternatives rejected

- **No guard in the hook.** The emptiness check and the thread delete would then run beside the
  resolvers the guard serializes. The foreign key of `mail_message_meta.thread_id` would still
  prevent a dangling reference, but by failing one of the two transactions: this is the pair of
  failures [[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]] describes for the
  claim cleanup.
- **`pg_try_advisory_xact_lock`.** It would fail the purge of every Email for as long as any
  transaction of the tenant holds the guard, instead of waiting for that transaction to end.
- **Deleting only the `mail_threads` row.** It would leave a live Threads item that no thread row is
  bound to, with the relations the user set on it.
- **Removing the Threads item permanently in the same purge.** The choke point's only permanent
  delete is the purge of an expired trashed item; this would add a second one.
- **Finding the folders through the mailbox's messages** (`mail_message_meta.mailbox_item_id` and
  the messages' folder edges). It misses every folder that holds no message.
- **A purge hook that runs before the dependents are deleted, or a hook context that carries the
  deleted edges.** Either changes the registry of [[2026-11-10-item-purge-domain-hooks]], which
  gh-1691 puts out of scope.

## Consequences

- A reply that joins a thread while the purge of that thread's last other message waits for the
  guard keeps the thread: the purge reads the membership after the reply committed.
- The purge of an Email waits at the guard while another transaction of the tenant holds it. A sync
  pass holds it for its reconcile transaction, across that transaction's provider calls. While it
  waits, the purge holds the tenant's purge lock, so every other purge call of the tenant waits
  behind it, and the item's row lock. The wait is one statement, so the pool's 60-second statement
  timeout bounds it. Then the purge call fails with nothing of that item purged, and the sweep logs
  it, continues with its next candidate and tries the item again at its next run.
- The hook's lock order can deadlock with a holder of the guard that then needs a row lock the purge
  holds. An ingest that observes an already-known message again together with its flags locks that
  message's Emails item under the guard (`applyObservedMailMessageFlags`); when the purge of that
  item is waiting for the guard, the two wait for each other. PostgreSQL's deadlock detection
  aborts one of them. An aborted purge call is tried again at the next sweep, and an aborted sync
  job is retried by the queue.
- The same holds for a purged mailbox. The purge holds the Mailboxes item's row lock when the hook
  deletes the `mail_account_sync_state` row; the removal and the sync job's failure writes take
  that row first and the item second. A removal request for a mailbox whose purge is running can
  therefore wait for the purge while the purge waits for it, and PostgreSQL aborts one of them.
- The hook needs no mailbox sync guard because of what
  [[2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status]] decided for a pass:
  under its guard a pass reads the Mailboxes item again and ends without writing when the item is in
  the trash or gone. A row that some other code writes for the mailbox after its purge committed is
  not removed by this decision.
- The Threads item of an emptied thread is trashed, not purged. It stays in the trash for the
  retention and is purged by a later sweep. Restoring it from the trash is not refused; it is then a
  live Threads item that no thread row is bound to, as a restored loser of a thread merge is.
- A thread whose Threads item the user trashed and the sweep purged keeps its `mail_threads` row,
  bound to an item that is gone, until its last message is purged. This decision does not change
  the purge of a Threads item.
- The hook deletes the rows named above and no others. Rows that other mail tables keep for a
  message or a mailbox (`mail_drafts`, `mail_message_move_sync_state`), the access log of a
  credential (`credential_access_log`) and the `mail_folder_sync_state` row of a purged Folders item
  are outside this decision. A draft's `mail_drafts.thread_id` is not a reference that keeps a
  thread: the emptiness condition is the one the existing cleanup uses.
- The sweep logs a failed purge call with the raw error. The hook adds one error of its own, the
  affected-row check of the thread delete, and its text is fixed; every other error comes from
  PostgreSQL or from the functions the hook calls.
