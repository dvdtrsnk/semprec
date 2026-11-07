---
status: accepted
date: 2026-11-07
area: [backend]
supersedes: []
superseded-by: null
---

# The area note cutover reserves the area row without waiting, after the document locks

## Context

The per-tenant cutover of issue #1619 (`docs/areaNoteCutoverMigration.ts`) converts each live area's `note` text
into the area's page document, one area per transaction, under the existing document lock order: the `doc_snapshots`
row, then the `docs` row, both `FOR UPDATE`.

Its first implementation read the area and its note without a lock before it took the document locks. Run A could
read an old note, a client could then write a new one, run B could convert the new note and commit, and A, once it
held the document lock, would replace B's generated blocks and marker with the old note.

Locking the area row before the document locks would oppose an existing owner. The page-text job
(`search/pageTextJob.ts`) locks `doc_snapshots` through `loadDocWithClient` and then the item row through
`indexItem`, so it takes the document before the item. Page restore
([[2026-11-01-page-restore-locks-live-items-and-update-identity]]) takes the item before the document and asks not to
lock the item after its document. Item soft-delete and purge change the item before its dependents. A blocking item
lock in either position would be the reverse of one of these.

## Decision

1. **Order.** For one area, the conversion reads the area without a lock, and that read decides only whether to go on
   (a trashed area or an empty note stops here). It then ensures the page doc (`getOrCreateDoc`), takes
   `doc_snapshots` and then `docs` `FOR UPDATE`, and only then reserves the area row with the existing
   `itemsStore.lockItemByIdNowait` (`FOR UPDATE NOWAIT`). It converts the note read from that reserved row, and
   converts nothing when the reserved row is trashed or its note is empty. The reservation is held until the
   transaction ends.
2. **No waiting on the area row while the document locks are held.** When another transaction holds the area row,
   PostgreSQL raises its lock-not-available error. The conversion does not catch it inside the transaction. The
   area's transaction rolls back, a doc it created included, and the error reaches the per-area loop outside the
   transaction. That loop already logs the area, goes on with the other areas and reports every failure together,
   with the original errors, after all areas ran. There is no retry, timeout, savepoint or error mapping of its own.
   The next run converts the area.
3. **Scope.** This decides the order for this step only. No other document or item owner changes its order.

## Consequences

- An area whose row is held by a concurrent writer is not converted in that run, and the cutover reports it as
  failed. Because the reserved row is re-read after the document locks, a note written while the conversion waited
  for the document lock is the one converted. An older read can no longer overwrite a newer conversion.
- The page-text job and the conversion do not wait on each other in a cycle. The job waits for `doc_snapshots` while
  holding nothing the conversion needs. The conversion never waits for the item row while it holds the document
  locks.
- Restore, soft delete and purge hold the item row while they reach the document, and the conversion fails at once
  instead of waiting for them. This matches the restore ADR's rule against waiting for an item after its document.
- `getOrCreateDoc` for an area that has no page doc yet inserts the `docs` row before the document locks. Its foreign
  key check takes a key-share lock on the area row and can wait for a writer holding that row. That existing
  behaviour is unchanged, and this decision makes no claim of deadlock freedom beyond the orders named here.
- When the reserved row's note is empty or the area is trashed by then, the page doc ensured in that transaction
  stays, empty.
