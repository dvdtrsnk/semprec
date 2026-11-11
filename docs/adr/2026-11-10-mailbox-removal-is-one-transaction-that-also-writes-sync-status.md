---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# A mailbox removal is one transaction under the mailbox's sync guard, and it is the second writer of the mailbox's `syncStatus`

## Context

Until issue gh-1690 a mailbox could only be soft-deleted with the generic `DELETE /api/items/:id`. That trash
leaves the mailbox's `external_credentials` row, its `mail_account_sync_state` row, the `mail_folder_sync_state`
rows of its folders and its `mail_account_server_settings` row in place, so a deleted mailbox keeps a usable
secret. None of these tables has a foreign key to `items` (`items` is partitioned), so nothing removes the rows
with the item.

gh-1690 adds `DELETE /api/mail/mailboxes/:id` and `removeMailbox` (`backend/packages/data/src/mail/mailboxRemoval.ts`).
Three things in it had a real alternative:

- **Granularity.** The item and the four kinds of rows could be removed in separate steps, the secret first
  and the rest after it. A step that fails then leaves either a trashed mailbox with a live secret or a live
  mailbox without one.
- **`syncStatus`.** `Mailboxes.syncStatus` is `owner: 'system'`. Its only writer was the mail sync job
  (`handleSyncMailAccountTask` in `mail/mailSyncJob.ts`, the task `mailAccountSync`). A removed mailbox can be
  restored from the trash, and it then has no credential. [[2026-09-10-single-writer-ownership-model]] asks for
  an explicit handoff before a second writer of a system-owned field appears.
- **A sync pass of the same mailbox.** One run of the sync job is a pass. It first reads the mailbox, its sync
  state and its credential, in separate transactions. Its reconcile then runs in one transaction that also talks
  to the provider. In that transaction it inserts the `mail_account_sync_state` row when there is none, an IMAP
  pass inserts and updates the `mail_folder_sync_state` row of each folder as it finishes that folder, and the
  pass records its activity on the account row at the end. Row locks cannot order the removal against this.
  The pass takes the folder rows one at a time, in the provider's folder order, and keeps them to its end. A
  removal that locks the account row first and deletes the folder rows afterwards can therefore deadlock with it.
  And a pass that read the mailbox before the removal committed inserts the rows again after it. Making the
  pass lock the account row for its whole length was rejected: the observability check locks that row every
  minute (`checkMailSync`) and the Gmail watch and Graph subscription lifecycles update it, so all of them
  would wait for every pass.

## Decision

- **One transaction.** `removeMailbox` runs every write below in one `withTransaction` at READ COMMITTED, in the
  caller's tenant scope. A failure of any statement rolls all of them back.
- **The sync guard.** The removal and the write transaction of a sync pass both take the mailbox's sync guard
  before any row lock and before any other guard, and hold it until their transaction ends. The guard is a
  transaction-scoped advisory lock (`lockMailboxSync` in `mail/mailboxSyncGuard.ts`) with the key
  `mailbox-sync:v1:<lowercase tenant UUID>:<lowercase mailbox UUID>`, hashed with
  `hashtextextended($1::text, 0)`. This is the form of the guards of
  [[2026-11-01-gmail-pseudo-folder-cleanup-label-evidence]] and
  [[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]]. The key names the tenant because
  row-level security does not apply to advisory locks: without it, a request of another tenant that passes the
  mailbox's id would wait for this mailbox's pass. A missing or system tenant scope fails before the lock query.
  In a pass the guard is the first statement of the write transaction (`enterSyncPass` in `mail/mailSyncJob.ts`).
  It comes before the tenant's mail-thread mutation guard, which reconciliation still acquires at its entry,
  before Gmail's folder-state guard and before any state, folder or item row. An IMAP pass opens its provider
  connection before that statement, as it did before. A transaction that waits for the sync guard therefore
  holds no row lock and no other guard, so the removal and a pass of the mailbox cannot wait for each other.
- **The pass reads the mailbox again under the guard.** The reads a pass made before its write transaction are
  older than the guard, and a removal may have committed since. With the guard held the pass reads the
  Mailboxes item and the `mail_account_sync_state` row again. When the item is in the trash or gone, or the
  row is gone, the pass ends there: it makes no reconcile call to the provider and writes nothing. The row is
  checked as well as the item because a removed mailbox can be restored from the trash. It is then live, and
  it has no sync state and no credential.
- **Row locks.** Under the guard the removal takes the mailbox's `mail_account_sync_state` row `FOR UPDATE`
  (when there is one) and then the Mailboxes item `FOR UPDATE`. This orders it against the writes the sync job
  makes without the guard. When a pass fails, the job records the failure in a new transaction: first on the
  state row, with `recordConnectionLimitBackoff` for a provider connection limit and `recordSyncError` for
  every other failure, and then in `syncStatus`. A completed pass writes the two in the same order inside its
  guarded transaction: its activity on the state row, then `syncStatus`. Whether the mailbox is live is
  decided by that locking read of the item: an unknown id, a mailbox hidden by row-level security and a
  mailbox already in the trash write nothing.
- **Writes, in this order.** `syncStatus` becomes `needsReauthorization` through `updateItemWithClient` with
  `allowedSystemKeys: ["syncStatus"]`. The item is trashed through the choke point's trash cascade
  (`itemDeleteWithClient`) as the system writer, so its delete hooks, heartbeats and invalidations run as for any
  trash. Then the credential (`deleteCredential`), the sync state row, the folder sync state rows of every Folders
  item related to the mailbox through `Folders.mailbox` (trashed folders included) and the server settings row
  are deleted, each through the store that owns its table.
- **The handoff.** The removal is the second writer of `Mailboxes.syncStatus`. It writes one value,
  `needsReauthorization`, and only in the transaction that deletes the credential. The reason is that the value
  states a fact this transaction creates: the mailbox has no credential any more. Every other value stays with the
  sync job.
- **A delete that matches no row is not a failure.** A mailbox that never connected has no credential and no sync
  state, only a mailbox with stored IMAP or SMTP settings has a server settings row, and only folders the IMAP
  adapter synced have a folder sync state row. The removal establishes that none of the four is left; it does not
  require that each existed.

## Consequences

- A removal that arrives while a pass of the mailbox is in its write transaction waits at the guard until the
  pass ends, and then deletes the sync state the pass wrote. The wait is one statement, so the pool's 60-second
  statement timeout bounds it. When the pass runs longer, the removal is cancelled: it has written nothing, the
  request fails and can be repeated. A pass makes provider calls inside its transaction, so the guard inherits
  that existing lifetime, as the two guards named above do. This decision adds no network work to a
  transaction.
- A pass that reaches its write transaction while the removal runs waits for the removal and then ends without
  work. So does a pass that read the mailbox before the removal committed: it finds the item in the trash, and
  it inserts no sync state row.
- The guard is per mailbox. The removal of another mailbox of the tenant takes another key, and so does a
  request of another tenant. Ordinary hash collisions of the key can make unrelated work wait.
- A second removal of the same mailbox that arrives while the first is running waits at the guard, then reads
  the committed item, finds it in the trash and answers 404 without writing.
- The guard coordinates the removal and the write transaction of a pass, and nothing else. Three things stay
  outside it:
  - Before its write transaction a pass replays the user's pending message moves at the provider. That phase
    takes no sync guard. It writes no sync state row.
  - The live-sync root's discovery (`mail/mailLiveSyncRoot.ts`) inserts a `mail_account_sync_state` row for
    every live mailbox it lists. A restored mailbox therefore gets a row again at the next discovery. A
    discovery that listed the mailbox just before the removal committed can also insert a row after it. Issue
    gh-2030 will stop the hosted lifecycle of a removed mailbox; it does not change what discovery inserts.
  - The generic `DELETE /api/items/:id` can still trash a Mailboxes item, without the guard and without this
    cleanup. Issue gh-2031 will refuse it.
- The mailbox's Folders and Emails items are not children of the Mailboxes item in the item tree, so this
  transaction does not trash them. Issue gh-2029 will soft-delete them in a chunked background job.
- The transaction deletes these four kinds of rows and no others. Rows that other mail features keep per mailbox
  are outside this decision.
