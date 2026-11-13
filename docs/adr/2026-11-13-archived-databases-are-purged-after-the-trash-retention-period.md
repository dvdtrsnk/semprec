---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Archived databases are purged after the trash retention period

## Context

`DELETE /api/databases/:id` (the approved `database.archive` operation) only sets `databases.archived_at`. The
archive is reversible and had no time limit, so an archived database was never deleted. The product treats archiving
a database as moving it to the trash, with the same 30 days to restore as a trashed item has
(`RETENTION_DAYS`, `trashRetention.ts`), after which it is deleted for good. The nightly item sweep
(`handleItemTrashPurgeSweepTask`) already purges items 30 days after they were trashed.

Deleting a database is wider than deleting an item. Besides its items it has edges to items of other databases,
relation properties whose paired side lives in another database, rollup properties of other databases that
aggregate it, blobs and an `items` partition. The sweep has to delete all of it for every tenant in a bounded
number of transactions, so it follows [[2026-10-06-system-work-fans-out-per-tenant]] and
[[2026-09-28-chunked-transactions-for-large-background-sweeps]], and removes blob bytes after the commit as
[[2026-09-28-blob-bytes-deleted-best-effort-after-the-commit]] decides.

## Decision

**Archiving is moving to the trash; the deadline is a column.** `databases.purge_at` is set to `now()` plus
`RETENTION_DAYS` times 24 hours in the same statement that sets `archived_at`, and cleared by a restore. It is 24-hour
days, as an item's deadline is, so a daylight-saving change does not move it. `GET /api/trash/databases` reports it
and the calendar days left, counted to the day of the stored deadline in the tenant's zone. That is the calendar-day
rule of the item listing, except that the day comes from the deadline and not from the archive day plus 30 calendar
days: a database stamped by the first sweep after the deployment has an old archive day and a deadline 30 days away,
and the deadline is 24-hour days after the archive, so across a daylight-saving change it can fall on another
calendar day than that sum (the listing then shows one day more or less than an item deleted at the same moment). The REST database envelope does not carry it.

**A deadline is assigned to a database that has none, or a stale one.** A database archived by a release before this
column, or by a release rolled back to, has `archived_at` and no `purge_at`. A release rolled back to also restores a
database and archives it again without touching `purge_at`, so a database this release archived (deadline `d`),
restored and archived again by the older release carries the deadline `d` next to a later `archived_at`. This release
only ever writes a deadline that is at least `archived_at + RETENTION_DAYS * 24 h` (the archive stamps exactly that, the
assignment below stamps a later time), so a deadline earlier than that cannot be one of its own and counts as missing.
At the start of each sweep run for a tenant, every archived user database whose `purge_at` is null or earlier than
`archived_at + RETENTION_DAYS * 24 h` gets `purge_at = now() + RETENTION_DAYS * 24 h`. The database is deleted no
earlier than 30 days after the first sweep that sees it, never right after the deployment or right after a rolled-back
release archived it again. The assignment is part of the sweep and repeats safely: a deadline this release wrote is
never touched. The expiry selection and the row lock of the purge apply the same condition, so a stale deadline that
appears after the assignment (a restore and a new archive by an older release while a purge runs) stops the purge at
its next transaction instead of deleting the database.

**Only user databases.** The sweep selects `archived_at IS NOT NULL AND NOT system AND purge_at < now()`. A system
database cannot be archived, and one that has a deadline anyway (a hand edit) is never selected or stamped.

**Order and transactions.** For each expired database, every step is its own transaction and can be repeated, so an
interrupted run continues on the next run:

1. The first 500 items of the database by id, deleted ones included, are read. The inline databases owned by those
   items are purged first, recursively and depth first, by this same procedure.
2. In one transaction those items are deleted and each gets `deleteItemDependents` (edges to other databases, view
   membership, docs, search index rows, automation state, blobs) and the item purge hooks of
   [[2026-11-10-item-purge-domain-hooks]], called with the item as its own `rootItemId`. After the commit the bytes
   of the blobs deleted with them are removed from both storage roots, best-effort.
3. Steps 1 and 2 repeat until no item is left.
4. In one final transaction the schema of other databases that depended on the database is removed, then the
   database is dropped with its partition (`dropDatabaseWithPartition`), and a schema invalidation is announced after
   the commit for the dropped database and for every other database whose schema changed.

The schema removed in step 4 is exactly: the rollup properties of other databases that run over a relation property
of this database or aggregate its items, the paired side, in another database, of every relation property of this
database, and every other relation property of another database whose `config.targetDatabaseId` is this database (a
one-directional relation, created without an inverse, has no property here and so no paired side to find). A relation definition, its edges and a rollup dependency go with their property by foreign key. No other
property of another database changes. A rollup aggregates a plain property, never a rollup or a relation, so no further
rollup depends on a property removed here. The delete does not apply the schema lock of the database that holds the
paired property: a schema-locked system database refuses a schema change by a user, but the property is one side of
a relation whose other side is gone. Values other items stored for a deleted rollup (`computed`) stay; nothing reads
them once the property is gone, and nothing else removes them. Because the schema is removed last, an interrupted run
leaves the other databases' schema as it was and no property points at a missing database.

**What a restore loses.** A restore before the deadline loses nothing: no step deletes before `purge_at`, and the
restore clears the deadline. Every transaction of the purge that deletes from the database or drops it first takes `FOR NO KEY UPDATE` on the
expired archived database's row and checks that it is still archived, a user database and past its current deadline, so a restore that
committed earlier is seen and the purge stops, and one that comes later waits for the transaction (an archive or a
restore `UPDATE`s that row). After the deadline the purge is not protected from a restore: a restore committed between
two chunks keeps the items the earlier chunks did not delete, and the purge stops at the next transaction. The
database is then restored without the items already deleted. This is accepted: after the deadline the product treats
the database as deleted.

**Stages and failures.** The purge runs in the existing daily task, after the item purge of the same tenant, in that
tenant's scope. A failure of one database is logged with the tenant and database ids and the error's class, does not
skip the others, and fails the call at its end. A failure of the item stage does not skip the database stage, or the
reverse; the task fails after both ran, so graphile-worker retries it.

## Consequences

- The sweep does not take the tenant advisory lock that `purgeExpiredTrashSubtree` takes
  ([[2026-11-01-trash-purge-coordinates-roots-and-transactions]]). The two stages of one task run one after the
  other. Nothing here keeps a second sweep of the same tenant from running at the same time, and this purge does not
  serialize against the transactions of the item purge.
- The search documents of other databases are not rebuilt when a paired property or a rollup leaves them.
- The items of an archived database are left to this purge by the item sweep; stopping that sweep from trying them is
  the job of issue gh-1878.
- Another release that reads `databases` ignores the new column; a rollback leaves the deadline in place. The next
  forward release uses it when it is still consistent with `archived_at`, and replaces it when the older release
  restored and archived the database again in between.
- A deadline that is shorter than `archived_at + RETENTION_DAYS * 24 h` is replaced whenever the sweep sees it, so a
  future release that lengthens `RETENTION_DAYS` extends the deadline of the databases archived under the shorter
  one by restamping them from the next sweep.
