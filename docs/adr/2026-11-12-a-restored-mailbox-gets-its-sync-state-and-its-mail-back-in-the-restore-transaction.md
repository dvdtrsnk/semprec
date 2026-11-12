---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# A restored mailbox gets a default sync state and the mail of its trash epoch back in the restore's own transaction

## Context

[[2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status]] removes a mailbox: the Mailboxes
item goes to the trash with `syncStatus` `needsReauthorization`, and its credential, its `mail_account_sync_state`
row, its folder sync state and its server settings are deleted.
[[2026-11-10-a-mailbox-removal-job-joins-the-mailbox-trash-epoch]] then trashes the mailbox's Folders and Emails
in a chunked job and gives each of them the Mailboxes item's own `deleted_at`. They are not rows of the item's
subtree, so the restore cascade does not bring them back, and that record leaves the restore to issue gh-2032.

A mailbox in the trash can be restored with the generic `POST /api/items/:id/restore`. Until this decision the
restored mailbox was live with no sync state, and the rows the job had trashed stayed in the trash.
[[2026-11-07-item-delete-and-restore-domain-hooks]] gives a domain a restore hook inside the restore's
transaction, and [[2026-11-08-restore-hooks-carry-exact-deletion-epochs]] hands the hook the cleared deletion
epoch at full precision and lets it restore a related item through the choke point's own restore.

The product owner decided the outcome in issue gh-2032: a restored mailbox comes back with its messages, with
`syncStatus` `needsReauthorization` and a default sync state for its provider, and the user then signs in again
([[2026-11-11-mailbox-reauthorization-restarts-the-hosted-lifecycle-in-the-live-sync-roots-context]]).

Four things in it had a real alternative:

- **Where the folders and messages are restored.** The removal trashes them in a chunked job, so that no
  transaction grows with the mailbox ([[2026-09-28-chunked-transactions-for-large-background-sweeps]]). The
  restore could queue a job of the same shape. Between the restore's commit and the end of that job the mailbox
  would be live while its folders are in the trash. Sync finds a mailbox's folder among the live Folders only
  (`ensureFolderItem`), so a pass in that window creates every folder a second time, while a message it meets
  again is matched through `mail_message_meta` to its Emails item, which is still in the trash. The job would
  also need the epoch, which the restore clears from the Mailboxes item, and a failure of it could no longer
  leave the mailbox in the trash.
- **Who writes `syncStatus`.** The field is `owner: 'system'` and has two writers, the sync job and the removal.
  The restore could write it as a third.
- **The mailbox sync guard.** The removal and the write transaction of a sync pass take it before any row lock.
- **What a sync pass makes of the missing credential.** A default sync state row is due for the periodic sync
  sweep at once, and a pass of the restored mailbox finds no credential. The sync job
  (`handleSyncMailAccountTask` in `mail/mailSyncJob.ts`) reported a missing credential as an ordinary failure:
  `syncStatus` `error`, failure kind `other` and the `mail_sync_error` notification. The status the product owner
  asked for would then last until the first pass, which the sweep queues within five minutes. The hook could
  insert a row that is not due instead, or the sync job could report a missing credential of every mailbox as a
  need to sign in.

## Decision

`mailboxItemRestoreHook` (`backend/packages/data/src/mail/mailboxRestoreHook.ts`) is registered in
`domainWriteHooks.ts` after `pageItemRestoreHook`. It acts on a restored item of the tenant's system Mailboxes
database and on no other item.

- **Sync state.** The hook reads the mailbox's `mail_account_sync_state` row with `getMailAccountSyncState`,
  without a lock. A mailbox that still has a row keeps it unchanged: the hook then writes nothing to that table.
  Only when there is no row does it call `ensureMailAccountSyncState` with `defaultSyncModeForProvider` of the
  item's `provider`; a `provider` that is not a string counts as `generic`, as in the live-sync root's discovery.
  That statement is `INSERT … ON CONFLICT (item_id) DO NOTHING`, so a row that another transaction inserted
  after the read is kept unchanged as well. The inserted row is the one a newly connected mailbox starts with:
  the sync mode is set and every cursor, activity, error and address column is null.
- **No wait for a sync state row that exists.**
  [[2026-11-11-mailbox-reauthorization-restarts-the-hosted-lifecycle-in-the-live-sync-roots-context]] states the
  lock order of the two rows: the sync state row first, the Mailboxes item second. The sync job's failure record
  and its completed pass, the removal and the reauthorization take them in that order. The hook runs with the
  Mailboxes item already locked, so it reaches the row second and must not wait for it.
  [[2026-11-08-restore-hooks-carry-exact-deletion-epochs]] has a restore hook reserve such a row with
  `FOR UPDATE NOWAIT` when it must lock it. This hook does not have to lock the row, so it reserves nothing. It
  writes nothing to a row that exists, and such a row cannot be deleted before the restore commits: the removal
  and the mail purge hook are the only callers of `deleteMailAccountSyncState`, and both delete the row while
  they hold the Mailboxes item, which the restore holds. The unlocked read waits for nothing, so the restore of
  a mailbox that has a row cannot be the second half of a deadlock on that row, and it does not fail with
  `55P03` when another transaction holds the row either.
- **`syncStatus`.** The hook does not write the Mailboxes item. The removal wrote `needsReauthorization` in the
  transaction that deleted the credential, and the item returns with it. The field keeps its two writers.
- **A pass before the sign-in.** The inserted row keeps the defaults of a newly connected mailbox, as the issue's
  Task says, so it stays due. The sync job fails a pass that finds no stored credential with
  `MailReauthorizationRequiredError`, the error an adapter throws for a revoked credential, when the `syncStatus`
  the pass read at its start is `needsReauthorization`. The removal writes that value because the mailbox has no
  credential any more ([[2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status]]), and the
  pass finds the same fact, so the job keeps the status. With any other status a missing credential stays the
  ordinary failure it was, as for a mailbox that was created and never connected: issue gh-2032 does not ask
  for a change there.
- **What is not written.** The credential, the folder sync state rows and the server settings row stay deleted.
- **Members.** The hook restores the Folders items related to the mailbox through `Folders.mailbox`, and the
  Emails items related through `Emails.folder` to one of those Folders, whose `deleted_at` equals the hook
  context's `deletedAtExact`, compared by Postgres (`deleted_at = $n::timestamptz`). For an Email the trash state
  of its folder does not matter: the job trashes Emails before Folders, so after an interrupted job a message of
  the epoch sits in a folder that is still live. The relation definitions are found by the property key on the
  module-owned database, as `MAILBOX_REMOVAL_MEMBERS_CTE_SQL` finds them.
- **One transaction.** All of it runs in the restore's transaction, at READ COMMITTED. The Folders of the epoch
  are selected and locked `FOR UPDATE` in one statement, in id order, and restored; then the Emails in the same
  way. Each row is restored through `restoreItemWithClient` with the context's queue routing, acting user and
  writer, so its restore hooks, heartbeats, rollup recomputes and invalidations run as for any restore.
- **No sync guard.** The restore cascade has locked the Mailboxes item before any hook runs, and the guard comes
  before every row lock. A hook that took it would wait for a removal or a sync pass that waits for that item.

## Consequences

- The restore is atomic. An error from the hook or from the restore of any folder or message rolls the whole
  restore back: the mailbox, its folders and its messages stay in the trash, and a sync state row the hook
  inserted is gone with it.
- The transaction is as large as the mailbox. Every folder and message of the epoch is one nested restore, and
  the row locks of all of them are held until the commit. The pool's statement timeout bounds each statement,
  not the transaction. This is the size the removal avoided with its job; the restore accepts it for the reasons
  under Context.
- A chunk of the removal job holds the Mailboxes item `FOR SHARE`, so a restore that arrives during a chunk waits
  for it. The job ends at its next chunk, because the mailbox is live then, and the rows it never trashed were
  live all along.
- A folder or message the user trashed at another instant stays in the trash, also when its mailbox returns.
  Equal timestamps are still not a transaction identity, as the epoch records say: a row trashed on its own at
  exactly the mailbox's microsecond returns with it.
- A sync pass that has recorded its failure or its activity on the mailbox's sync state row, and then writes
  `syncStatus` while the mailbox is being restored, waits for the restore's commit and then writes the live
  item. The restore does not wait for the pass. A mailbox in the trash has a row when the generic
  `DELETE /api/items/:id` trashed it, which takes no sync guard and leaves the row, or when the live-sync root's
  discovery inserted one after its removal.
- For a mailbox without a row, the hook's `INSERT` still comes after the lock on the Mailboxes item, and a row
  that does not exist cannot be reserved. The `INSERT` waits only for another transaction's uncommitted insert
  of that mailbox's row, and then keeps the row that transaction committed. The live-sync root's discovery
  inserts the row and takes no lock on the Mailboxes item, so the restore only waits for the end of its page
  transaction. The reauthorization inserts the row and then locks the item, after it read the mailbox as live in
  the same transaction. Its insert can therefore meet the restore only when the mailbox, without a row, was
  trashed and its restore begun inside the reauthorization's transaction, between its unlocked read of the
  mailbox and its lock of the item. PostgreSQL then ends one of the two with `40P01`, and nothing maps or
  retries it. The other two callers of `ensureMailAccountSyncState` have no insert in flight that a restore
  could meet: a sync pass calls it for a mailbox whose row it has read under the sync guard, and a connect flow
  for a mailbox it has just created.
- [[2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status]] has a sync pass read the
  Mailboxes item and the sync state row again under the guard, and says that a removed mailbox that was restored
  has no sync state. That is no longer so. A pass that read the mailbox and its credential, and then reaches its
  write transaction after the mailbox was removed and restored, finds a live item with a row and reconciles with
  the credential it read before the removal deleted it. A pass that reaches its write transaction while the
  mailbox is in the trash still ends without work. That record's body is unchanged.
- The inserted row is due for the periodic sync sweep, because its `next_expected_activity_at` is null. Until the
  user has signed in again, every pass of the restored mailbox fails for want of a stored credential, and the
  sync job records that as it records a revoked credential: `syncStatus` stays `needsReauthorization`, the
  failure kind is `reauthorization`, the mailbox's `mailSyncError` problem is raised as critical and no
  `mail_sync_error` notification is written. `recordSyncError` moves the row's next sweep 15 minutes out, and the
  queue retries the failed job within its three attempts. The mail sync stall check (`checkMailSync`) alerts on
  the stored error as it does for a revoked credential: its `mail_sync_stalled` notification names the reason
  `reauthorization`, and its report joins the same problem. The pass that follows the sign-in writes `ok`, clears
  the failure and resolves the problem. The reauthorize route does not read `syncStatus`.
- The sync job decides this from the `syncStatus` the pass read, not from the missing credential alone. A pass
  that fails before it looks for the credential, on a database error for instance, writes `error` like any
  failed pass, and the passes after it then report the missing credential as an ordinary failure until the user
  signs in. A mailbox that never had a credential is reported as before. Whether a missing credential of every
  mailbox should read as `needsReauthorization` is a decision about the sync job that this record does not make.
- A table that a later mail feature keeps per mailbox and the removal deletes is not written again by this hook.
