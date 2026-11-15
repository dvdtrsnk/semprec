---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# A mailbox removal waits a bounded time for the sync guard and answers busy

## Context

[[2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status]] makes the removal of a mailbox take
the mailbox sync guard (`lockMailboxSync` in `mail/mailboxSyncGuard.ts`, a transaction-scoped advisory lock keyed
by tenant and mailbox) before any row lock, the same guard that the write transaction of a sync pass takes first
(`enterSyncPass` in `mail/mailSyncJob.ts`). That record says the wait for the guard is one statement that the
pool's 60-second `statement_timeout` bounds: when the pass runs longer, the database cancels the statement, the
transaction rolls back with nothing written, and the request fails. It leaves open how that failure looks to the
caller and does not say that the holder of the guard can be a pass of another mailbox. This decision settles both
without editing that record.

The wait can be long for another reason than a long pass of this mailbox. A pass takes the sync guard of its own
mailbox first and the tenant's mail-thread mutation guard (`lockMailThreadMutation`) second. The pass of
mailbox B can therefore hold B's guard while it waits for the mutation guard that a long pass of mailbox A holds,
and a removal of B waits for B's guard behind both. When the wait passes 60 seconds, the database cancels the
statement (SQLSTATE 57014) and the route answers a generic 500, which does not say that the request can be
repeated and cannot be told apart from any other cancelled statement.

The second thing that record left open: `lockMailboxSync` checked only that a tenant scope is active.
`lockMailThreadMutation` (`mail/mailThreadMutationGuard.ts`) also checks that its client is inside a READ
COMMITTED transaction of the scope's tenant. The existing `lock_timeout` pattern of
[[2026-11-02-mail-oauth-rotation-holds-the-credential-lock-through-refresh]] (a transaction-local bound on a lock
wait, with the previous setting not leaking to the next pool user) is the one this decision follows.

## Decision

- **The bound.** A mailbox removal waits for the sync guard for at most 15 seconds
  (`MAILBOX_REMOVAL_SYNC_WAIT_MS`). `lockMailboxSync` takes the bound as a per-call option, `maxWaitMs`. With the
  option it reads the current `lock_timeout`, sets it transaction-locally with `set_config(..., true)` for the
  advisory lock statement only, and sets the previous value back in the next statement once the lock is granted,
  so no later statement of the removal, its row locks included, inherits the bound. Without the option the
  statement is exactly as before: the sync pass keeps its unbounded wait, limited only by the statement timeout.
- **The answer.** When the lock wait ends at the bound (SQLSTATE 55P03), `lockMailboxSync` throws
  `MailboxSyncBusyError`, a `ChokePointError` with status 409 and code `mailbox_sync_busy`, with the message "The
  mailbox is being synchronized; try again shortly". The database has aborted the transaction at that point, so
  there is nothing to restore; the error leaves `withTransaction`, which rolls the removal back. The removal has
  written nothing, no cleanup after the commit runs, and the request can be repeated. The error body has no field
  beyond the existing error envelope.
- **A removal that succeeds today now answers 409 when it waited 15 to 60 seconds.** Such a removal waited for
  the guard and then succeeded; with the bound it answers 409 and must be repeated.
- **Why the bound is below the statement timeout.** A lock timeout raises its own SQLSTATE, so the busy answer is
  told apart from every other cancelled statement, and like any error in the transaction it rolls the removal
  back with nothing written. A bound at or above 60 seconds would never fire before the statement timeout.
- **A busy answer does not mean this mailbox is syncing.** The removal can wait for a pass of another mailbox:
  the pass holds its own guard while it waits for the tenant's mail-thread mutation guard. The
  message says that the mailbox is being synchronized, which is the usual case; the decision does not claim that
  it is the only one.
- **The sync pass's wait is not bounded.** A pass keeps waiting for the guard behind a removal, as before. The
  decision does not change what a pass holds while it waits for the mutation guard.
- **The READ COMMITTED precondition.** `lockMailboxSync` refuses a client that is not inside a transaction, that
  is in a transaction of another isolation level than READ COMMITTED, or whose `app_current_tenant()` is not the
  active scope's tenant, with an `Error` and before it takes any lock. Missing tenant scope still throws
  `TenantScopeMissingError` first. A transaction advisory lock taken outside a transaction would be released at
  once, and one taken at a higher isolation level would not order the removal against a pass that committed while
  it waited: the removal's later reads would run against a snapshot taken before the wait and not see what the
  pass committed. Both callers run inside `withTransaction` at its default level, so nothing changes for them.

## Consequences

- A removal of a mailbox that a pass holds for longer than 15 seconds fails with 409 `mailbox_sync_busy` and has
  to be sent again. The removal holds no row lock while it waits, so the busy answer leaves nothing behind.
- The lock order of the removal is unchanged: guard, sync state row, Mailboxes item. This decision claims no
  deadlock freedom beyond that order. The bound only ends a wait for the guard sooner than the statement timeout
  would, and the removal's later statements keep the pool's configured timeouts.
- The restoration of `lock_timeout` is transaction-local: it happens in the statement after the lock is granted,
  and a transaction that ends for any reason discards its transaction-local settings. A pooled connection never
  carries the bound into its next transaction.
- A caller that adds a new use of `lockMailboxSync` must call it inside a READ COMMITTED transaction of the
  tenant, which is how `withTransaction` opens one.
