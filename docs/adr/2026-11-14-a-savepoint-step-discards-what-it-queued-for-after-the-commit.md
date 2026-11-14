---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A savepoint step discards what it queued for after the commit

## Context

[[2026-09-10-side-effects-follow-the-commit]] registers an announcement with `runAfterCommit` so that a rolled-back
transaction announces nothing, and [[2026-09-29-withtransaction-is-the-sole-transaction-opener]] keeps the callbacks of
a transaction on its `PoolClient` and has `withTransaction` fire or drop them. Both treat the transaction as one unit.

A request that handles several independent ids in one transaction needs a smaller unit: the bulk restore of
`POST /api/trash/restore` (issue gh-1904) restores each selected database and item, and when a restore hook rejects one
item the others must still restore in the same request. Going back to a PostgreSQL savepoint undoes that item's
writes, but the callbacks it queued with `runAfterCommit` stay on the client and fire at the commit, announcing a
restore that did not happen. The same holds for what the transaction keeps beside the callbacks: the keyed callbacks of
`runAfterCommitKeyed` (a later registration under the same key replaces the callback of a slot whose wrapper is gone,
and nothing is queued) and the search-lane jobs of `registerSearchJob`, which are added to the queue at the pre-commit
flush. One earlier writer, the notification writer of
[[2026-11-10-resolved-guidance-notifications-use-a-writer-savepoint]], opens its savepoint by hand for one statement;
the alternative here is to let each caller do that, with the callbacks left behind.

## Decision

`withSavepoint(client, fn)` in `db/pool.ts` runs `fn` between `SAVEPOINT` and `RELEASE SAVEPOINT` inside the active
managed transaction of `client`, and refuses to run for any other client (outside `withTransaction`, in an after-commit
callback, or on another transaction's client).

- On success the savepoint is released and everything `fn` queued stays queued for the commit.
- On an error the transaction goes back to the savepoint and the savepoint is released, and what was queued since it
  began is discarded: the `runAfterCommit` callbacks and the search-lane jobs registered since are removed, a keyed slot
  created since is removed with its callback, and a keyed slot that already existed gets its earlier callback back.
  What was queued before the savepoint is untouched. The error is rethrown unchanged.
- A caller catches the errors it knows to be a refusal of this step and rethrows every other one. A rethrown error fails
  the whole transaction like any other error of the body of `withTransaction`. The only failure `withSavepoint` catches
  is that of its own cleanup, below.
- The rollback-only mark of `markManagedTransactionRollbackOnly` belongs to the invocation, not to a savepoint, and is
  not undone by going back: a step that marked it makes the transaction fail at its end, whatever the caller does with
  the error. If going back to the savepoint itself fails, the connection is in an unknown state, so the transaction is
  marked rollback-only with the error of `fn`, the cleanup failure is logged by its category, and the error of `fn` is
  what the caller receives.
- The savepoint name is built from a process-wide counter, so a savepoint inside a savepoint never shadows its parent.

Going back to a savepoint undoes the writes of the step, not the sequence values it consumed, and `withSavepoint`
does not catch a failure of `RELEASE SAVEPOINT` after a successful step: that error reaches the caller, and the caller
that treats it as a refusal of one id and carries on is wrong.

## Consequences

- A request can refuse one id and still commit the others, and the realtime announcements, queued jobs and search jobs
  of the refused id never leave the process.
- A new transaction-level queue (another thing registered on the managed transaction to fire or flush at the commit)
  must also be restored by `withSavepoint`, or its entries outlive a step that was undone.
- `withSavepoint` is not a retry: the caller that wants a second attempt makes it with a new call.
