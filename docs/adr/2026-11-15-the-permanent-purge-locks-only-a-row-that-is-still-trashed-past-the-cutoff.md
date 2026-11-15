---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# The permanent purge locks only a row that is still trashed past the cutoff

## Context

[[2026-11-10-item-purge-domain-hooks]] has the delete loop of `purgeExpiredTrashSubtree` read each row
of its walk again under a row lock (`itemsStore.lockItemById`, a `SELECT … FOR UPDATE`) immediately
before `itemsStore.hardDeleteItem`, so that a hook and `deleteItemDependents` receive the row exactly as
it was removed. The walk itself reads without locks and keeps only rows whose `deletedAt` is older than
the `cutoff` of the call. The lock order of the purge is that of
[[2026-11-01-trash-purge-coordinates-roots-and-transactions]]: the tenant's purge lock, then an item row,
then that item's dependents.

This decision narrows three statements of the first record, which is accepted and is not edited:

- "Unlike the delete, the locked read also locks a row of the walk that a restore made live again; the
  purge does not remove that row and holds its lock until the purge transaction ends." A write to that row
  waits for the rest of the call, and a writer that holds another row of the same walk while it waits can
  deadlock with the purge, which aborts one of them.
- "The locked read does not decide whether a row is removed." The delete loop took that decision from
  `hardDeleteItem`, which guards only `deleted_at IS NOT NULL`.
- A row that was restored and trashed again after the walk "is still removed, and `item.deletedAt` is then
  that later instant." Nothing compared the row's current `deletedAt` with the cutoff when the row was
  deleted, so a row with a fresh trash was removed.

The purge hooks of consumers lengthen the per-row work of the purge, and with it the time a needless lock
is held, so this is decided before more consumers register a hook.

## Decision

The delete loop reads each row of the walk with `itemsStore.lockTrashedItemBefore(client, databaseId,
itemId, cutoff)`, which is one statement:

```sql
SELECT … FROM items
 WHERE database_id = $1 AND id = $2 AND deleted_at IS NOT NULL AND deleted_at < $3
   FOR UPDATE
```

It returns the mapped row, or `null` when the row is gone, live, or trashed at or after `cutoff`.
`purgeExpiredTrashSubtree` takes that row as the row it removes, exactly as the first record has it take
the row of `lockItemById`. A row for which the statement returns nothing is skipped with no lock, no
delete, no dependent delete and no hook; `hardDeleteItem` and the rest of the loop are unchanged.
`lockItemById` and its other callers are unchanged.

The predicate is decided by the locking statement itself, not by a read before it. The purge transaction
runs at READ COMMITTED and each statement takes a new snapshot, so a restore, or a fresh trash, that
committed before the statement started makes the row not qualify, and it is not locked. A row that changes
while the statement waits for the lock of another transaction is rechecked against its latest committed
version before it is returned.

## Consequences

- A hook's `item.deletedAt` is always older than the `cutoff` of its call, because the row it receives is
  the row the locking statement returned.
- A row that was restored, or restored and trashed again with a trash at or after the cutoff, after the
  walk is not removed by that call. A restored row keeps its dependents and runs no hook. A row with a fresh
  trash stays in the trash, with its dependents, and a later sweep with a later cutoff removes it. A trash
  made fresh by such a re-trash also reaches the rows of that row's cascade; they are skipped on the same
  condition.
- The predicate is evaluated by the locking statement. A restore that commits before the statement means the
  row is not locked, so a writer of that row does not wait for the purge. When a restore commits during the
  statement's own wait for the row lock, the statement rechecks the row's newest version, which no longer
  qualifies, and returns nothing, but the lock on that newest version has been taken in the meantime and the
  purge holds it until its transaction ends. That is the only case in which a skipped row stays locked.
- The lock order does not change: the tenant's purge lock, then an item row, then that item's dependents.
  What changes is which rows are locked and which are removed, so the deadlock risk of the first bullet of
  the Context shrinks to the one case above and does not grow.
- The walk's own check, the tenant purge lock, the order of the locks, the purge of an archived database,
  `hardDeleteItem`, the hook registry and the hook context are not changed. The tenant erase is unaffected.
