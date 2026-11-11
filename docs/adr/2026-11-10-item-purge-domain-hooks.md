---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# A domain reaches the permanent item purge through an item purge hook registry

## Context

[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] gave the choke point
per-process hook registries in `chokePoint/hooks.ts`, which `domainWriteHooks.ts` fills.
[[2026-11-07-item-delete-and-restore-domain-hooks]] added registries for the trash and restore
cascades of `chokePoint/itemTrash.ts` and left the permanent purge open on purpose: "Hooks on the
permanent purge and on database or property archive and delete remain undecided; a consumer that
needs one needs its own decision." This record decides what that record left undecided, for the
permanent purge only. Both records are accepted and are not edited. The sentence of the latter that
the permanent purge runs no hook describes the purge before this decision; the purge still runs no
delete hook and no restore hook.

The permanent purge, `purgeExpiredTrashSubtree`, removes a trashed row with
`itemsStore.hardDeleteItem` and then calls `deleteItemDependents`, which deletes the rows the choke
point knows to depend on an item. `items` is partitioned with a composite key, so none of the tables
that name an item by its id carries a foreign key to it, and a row that names a purged item stays
unless the purge deletes it. For `deleteItemDependents`, `itemTrash.ts` imports seven listed-domain
modules directly, under its exemption from the `chokepoint-knows-no-domain` boundary rule, and the
rule `item-trash-domain-imports-are-purge-only` refuses any further listed-domain import in that
file.

The mail module is the first domain that needs the purge and is not one of those imports: purging an
Emails or a Mailboxes item must remove the mail rows that belong to it. Issue #1691 will register
that hook; it presupposes the registry this record decides.

## Decision

**A registry, not an import.** A domain reaches the permanent purge through an item purge hook of
the same registry module, not through a new import in `itemTrash.ts`. `chokePoint/hooks.ts` gains
`registerItemPurgeHook` / `runItemPurgeHooks` with the `Set` semantics of the other registries:
registering a function twice is a no-op, hooks run sequentially in registration order, the first
rejection propagates, and `clearHooksForTests` clears the registry. A domain registers its hook in
`domainWriteHooks.ts`. The seven existing direct imports of `deleteItemDependents` stay as they are.

**Inside the purge transaction, once per removed row.** `purgeExpiredTrashSubtree` runs the purge
hooks once for every row for which its `hardDeleteItem` call reported a removal, in the same
transaction, after `deleteItemDependents` for that row. A row that call did not remove, for example
because a concurrent restore committed first, runs no hook. A hook receives
`{ client, database, item, rootItemId }`, and it receives the removed row because the row can no
longer be read:

- `client` is the client of the purge transaction.
- `item` is the `ItemRow` the purge read under a row lock (`itemsStore.lockItemById`, a
  `SELECT … FOR UPDATE`) in this transaction, immediately before it deleted the row.
- `database` is the `DatabaseRow` of the row's database.
- `rootItemId` is the item the `purgeExpiredTrashSubtree` call was started for; it equals `item.id`
  for that item itself.

`purgeExpiredTrashSubtree` does not catch a hook's error. A hook that throws fails that call's
transaction: the error propagates to the caller and the transaction rolls back, so no row of the
subtree, none of their dependents and nothing an earlier hook call deleted through `client` is
removed.

**The tenant erase runs no purge hook.** The erase of
[[2026-10-18-tenant-purge-erases-outside-the-choke-point]] stays outside the choke point and deletes
a deleting tenant's rows itself.

**What a hook may rely on:**

- The transaction and the tenant scope of the purge. What the hook writes through `client` commits
  or rolls back with the purge. `purgeExpiredTrashSubtree` refuses to run without a tenant scope,
  and the hook runs with the same `app.tenant_id` as the purge's own statements: for a role subject
  to row-level security, the hook's statements on tenant tables see and change only that tenant's
  rows.
- The removed row. `item` is the row exactly as it was when the purge deleted it, every field of it.
  The purge walks the subtree with unlocked reads, which only select the rows to try. In the delete
  loop it reads each of them again under a row lock, immediately before the delete, and passes that
  locked row. The purge transaction runs at READ COMMITTED, where a locking read returns the latest
  committed version of the row, and the lock is the one the delete itself takes: a write another
  transaction committed before the lock was granted is in `item`, and none can change or remove the
  row between that read and the delete.
- The row and its built-in dependents are already gone: a query through `client` no longer finds the
  item, nor any row `deleteItemDependents` deletes for it. `deleteItemDependents` receives the same
  locked row, so what it derives from the row's own fields, the blobs the row names, is derived from
  the row as it was removed.

Hooks on database or property archive and delete stay undecided.

## Consequences

- A domain that must clean up after a permanently deleted item registers a purge hook in
  `domainWriteHooks.ts` next to its own code; `itemTrash.ts` gains no domain import. The boundary
  rules match what they matched before; only their comments name the purge hook.
  `item-trash-domain-imports-are-purge-only` refuses a new import from a listed domain folder. A
  folder the rules do not list is held to this decision by review only.
- Soft delete and restore run no purge hook, and the purge runs no delete or restore hook. A domain
  that reacts to all three registers three hooks.
- Rows are purged root first in the order of the subtree walk. When a row's hook runs, the call has
  not yet removed the rows later in that walk, its descendants among them.
- The locked read takes the row lock the delete takes, one statement earlier, so the purge still
  takes its locks in the order of [[2026-11-01-trash-purge-coordinates-roots-and-transactions]]:
  the tenant's purge lock, then an item, then that item's dependents. Unlike the delete, the locked
  read also locks a row of the walk that a restore made live again; the purge does not remove that
  row and holds its lock until the purge transaction ends, so a write to it waits for the purge.
- The locked read does not decide whether a row is removed. `itemsStore.hardDeleteItem` removes a
  row that is in the trash and skips one that is live, and a row that is gone by the time of the
  locked read is skipped; this record does not change which rows the purge removes. A row that was
  restored and trashed again after the walk is still removed, and `item.deletedAt` is then that
  later instant.
- `rootItemId` is not necessarily the item a user trashed. The sweep (`purgeExpiredTrash`) starts
  a call for each expired trashed item it reads, nested rows included, unless an earlier call of the
  same page already purged it. A nested row can therefore be purged as the root of its own call
  before the call for its parent runs.
- The sweep logs a failed call and continues with the next candidate, and the failed root is a
  candidate again on the next sweep. A hook that keeps throwing for a row keeps that row in the
  trash. Other rows of its subtree that are expired candidates of their own are purged by their own
  calls when the hooks for them succeed.
- The purge transaction takes the tenant's purge lock of
  [[2026-11-01-trash-purge-coordinates-roots-and-transactions]] before it reads or deletes any item
  and holds it until it ends, so a hook runs under it: its work delays every other purge call of
  that tenant. A hook also runs inside the transaction for which that record decided that no storage
  or provider I/O is added.
- The hook returns nothing. This decision adds no channel for work after the commit; the sweep still
  removes blob bytes for the storage keys `deleteItemDependents` returns and for nothing else.
- The tenant erase does not call a purge hook. What a purge hook would clean up is erased with the
  tenant when it sits in a table classified `semprec:tenancy=tenant`, which the erase deletes on its
  own.
- This decision registers no consumer hook; each consumer registers its own.
