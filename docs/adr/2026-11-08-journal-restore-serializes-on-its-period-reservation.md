---
status: accepted
date: 2026-11-08
area: [backend]
supersedes: []
superseded-by: null
---

# A restored Journal entry takes its period reservation back, serialized on that reservation

## Context

A Journal entry is found by its period reservation: the `idempotency_keys` row
`journal:<journalDatabaseId>:<type>:<period>` that `getOrCreateJournalItem` (`journal/journalStore.ts`) passes to
`createItemWithClient`. `insertItemWithReplay` (`chokePoint/itemsStore.ts`) takes that row first, inserting it or
locking it `FOR UPDATE`, and only then reads the reserved item; when that item is trashed or purged it deletes the row
and reserves the key again for a new item in the same transaction. Nothing makes `type` and `period` unique.

The restore cascade (`restoreItemWithClient`, `chokePoint/itemTrash.ts`) ignored the reservation. Restoring an old
entry while a newer one was live left two live entries for one period; restoring it while the newer one was trashed
left the reservation on the trashed one, so the next write created a third entry. Issue #1666 asks the restore to refuse
the first case (409) and to point the reservation at the restored entry in the second, in the restore's transaction,
through the restore hooks of [[2026-11-07-item-delete-and-restore-domain-hooks]].

Two restores of two trashed entries of one period each hold their own restored row (the cascade locks its epoch rows
before any hook runs, [[2026-11-08-restore-hooks-carry-exact-deletion-epochs]]). If each then also locked the other's
item, one would wait on a row the other holds while that one waits on the reservation: a cycle.

## Decision

- `journalItemRestoreHook` (`journal/journalRestoreHook.ts`), registered in `domainWriteHooks.ts`, runs for every
  restored item of the system Journal database that has a text `type` and `period`, and calls
  `repointJournalPeriodReservation` in `journal/journalStore.ts`, which builds the key with the same private function as
  `getOrCreateJournalItem`.
- Inside the restore transaction, after the restored rows are locked, that function:
  1. takes the reservation row with one statement, `INSERT … ON CONFLICT (tenant_id, key) DO UPDATE` that changes no
     value: it inserts the row for the restored item when it is missing and otherwise waits for and locks the current
     row, including one that `insertItemWithReplay` deleted and re-inserted concurrently;
  2. holding it, reads with a plain `SELECT` whether another live item of the Journal database has the same `type` and
     `period`; one that exists throws `ConflictError` (409, `details.liveItemId`), and the whole restore rolls back,
     the reservation insert included;
  3. otherwise updates the row to the restored item and checks that it affected one row.
- No peer item row is locked. The period decision is serialized only through the reservation.
- The Journal module writes this one reservation row of the choke point's `idempotency_keys` table for the restore, as
  issue #1666 specifies; Journal reads already join the same row by the same key (`journal/journalRouteHandlers.ts`).
  No other module and no other key is written this way.

## Consequences

- The serialization holds between the writers that take the reservation before they make a period entry live:
  `getOrCreateJournalItem` (through `insertItemWithReplay`) and this restore hook. Once one of them holds the row, an
  entry another one made live earlier is committed and visible to the plain read, and a later one waits for the row.
  An entry made live by any other path is not covered. Journal `type` and `period` are system-owned, so the generic item
  create cannot write them today; this is a statement about those writers, not a uniqueness guarantee.
- A restore of a Journal entry waits while a concurrent `getOrCreateJournalItem` or restore of the same period holds
  the reservation; the loser of two restores gets 409, and a `getOrCreateJournalItem` that waited on a restore returns
  the restored entry instead of creating one. This ADR claims no deadlock freedom beyond the lock order it describes.
- A conflicting restore answers `version_conflict` (409), the code `ConflictError` carries; the live entry is named by
  `liveItemId`, not by the version-conflict `currentItem` envelope.
- Taking an existing row through `DO UPDATE` writes a new row version that changes no value.
- No database constraint on `type` and `period` is added, and duplicates that already exist are not merged; both are
  outside issue #1666.
