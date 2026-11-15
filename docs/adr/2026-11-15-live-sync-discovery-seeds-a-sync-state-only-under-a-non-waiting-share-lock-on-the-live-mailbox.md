---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# Live-sync discovery seeds a sync state only under a non-waiting share lock on the live mailbox

## Context

The live-sync root (`mail/mailLiveSyncRoot.ts`, `createMailLiveSyncRoot`) decides which mail accounts a process
hosts. In `discoverActiveAccounts` it reads, per active tenant, the live Mailboxes items in pages with
`listItems`. In the same page transaction, per item and under its own `SAVEPOINT discover_account`, it seeds the
`mail_account_sync_state` row of an account that has none with `INSERT ... ON CONFLICT (item_id) DO NOTHING`.
Every account for which that returns a row is hosted. An account whose seeding fails is reported through
`onLifecycleError(..., "discover", ...)` and is not part of the pass's active set.

[[2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status]] records the mailbox removal. It takes
the mailbox sync guard, then locks the sync state row `FOR UPDATE`, then the Mailboxes item `FOR UPDATE`, trashes
the item and deletes the credential, the sync state row, the folder sync state rows and the server settings row.
A sync pass takes the same guard and reads the mailbox again under it, so a pass cannot create the deleted rows
again. That record leaves discovery outside the guard and says that a discovery that listed the mailbox just
before the removal committed can insert a row after it. This decision settles that race; it does not edit the
earlier record. The race: discovery's `listItems` statement reads the item as live, the removal commits (the item
is in the trash, the sync state row is deleted), and discovery's insert finds no row and no conflict, so the
removed mailbox has a `mail_account_sync_state` row again, the root hosts a lifecycle for it until a later pass
retires it, and a mailbox restored later finds a row it did not have to be given.

Two constraints rule out the obvious remedies. Discovery cannot take the sync guard: a sync pass holds it across
provider calls, so discovery would wait for passes. And discovery cannot wait for any lock: a seeding that fails
removes the account from the pass's active set, and the pool's `statement_timeout` is 60 seconds, so a discovery
that waited behind a removal that itself waits behind a long sync pass would be cancelled and would stall the
tenant's page and retire hosted accounts.

## Decision

- **No guard.** Discovery does not take the mailbox sync guard.
- **Seed only under a share lock on the live item.** For an account that already has a sync state row, discovery
  uses the row as it is, with no lock and no write. For an account without one, it runs
  `SELECT id FROM items WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE SKIP LOCKED` on the
  account's Mailboxes item, and only when that returns the row does it run the insert. The lock is held until
  the page transaction ends. The function is `ensureMailAccountSyncStateOfLiveMailbox` in
  `mail/mailAccountSyncStateStore.ts`; `ensureMailAccountSyncState` is unchanged.
- **Never wait.** `FOR SHARE` conflicts with the removal's `FOR UPDATE`, and `SKIP LOCKED` makes the statement
  skip a row that conflicts instead of waiting for it. Under READ COMMITTED a row that was trashed before the
  statement started is not returned.
- **An account without a lock is left out of the pass.** When the statement returns no row, the item is in the
  trash, gone, or row-locked by another transaction. Discovery leaves the account out of the pass's active set,
  writes nothing, and reports nothing: it is not an error. A later pass sees the account again if its item is
  live.
- **Outcomes.**
  - A removal that committed before the share-lock statement leaves no live row: nothing is seeded.
  - A removal that starts after discovery took the share lock waits for the end of the discovery page
    transaction at its item lock. It finds the row discovery inserted and deletes it, because its delete of the
    sync state row is a later statement than the lock wait and sees committed rows under READ COMMITTED. The
    mailbox ends removed with no row.
  - A removal in flight holds the item `FOR UPDATE`: discovery skips the account for this pass.

## Consequences

- Lock order: discovery takes only the share lock on one item row and inserts a row of a table on which it holds
  no lock. Its lock statement never waits, and it takes no guard, so it is no part of a cycle with the guard, the
  sync state row and the item row of the removal, whose order is unchanged. A sync pass ends in `enterSyncPass` when
  the row is gone, so its own seeding calls find the row and insert nothing, and the removal only deletes it. The insert itself can wait for another
  transaction's uncommitted insert of the same `item_id`. The mailbox reauthorization
  (`replaceMailboxCredential` in `mail/mailOauthRouteHandlers.ts`) inserts a missing row before it locks the item,
  so in that one interleaving discovery waits at its insert while holding the share lock and the reauthorization
  waits for that lock; Postgres' deadlock detection aborts one of the two statements, which discovery reports for
  the account like any failed seeding. This decision does not remove that interleaving.
- An account that has no row and is skipped is not hosted in that pass. A never-connected mailbox whose item is
  locked by another transaction at that moment is delayed by one discovery interval.
- The share locks of a page's items stay until the page transaction commits. A removal of one of those mailboxes
  waits for that transaction at its item lock, after it has taken the guard and tried to lock the sync state row
  (which did not exist when it looked). That wait is bounded by the length of one discovery page, which makes no
  provider call.
- A restored mailbox is given a row by the first discovery that finds it live without one, as before.
- This decision does not stop the hosted lifecycle of a removed mailbox or bound the removal's wait for the sync
  guard; those are other sources.
