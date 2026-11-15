---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# The journal method cutover converts trashed Inbox item types with one SQL statement

## Context

Issue gh-1975 adds the `journal` processing method and makes the pairing `processingMethod: 'database'` with
`targetDatabase: 'journal'` a state the Inbox item type write rules refuse (`assertValidProcessingConfig`). The per-tenant
cutover `inbox/inboxJournalMethodCutoverMigration.ts` converts every existing type that holds the pairing to
`processingMethod: 'journal'` without a target.

[[2026-09-10-choke-point-api-for-state-writes]] routes item writes through the choke point. The choke point refuses an
item that is in the Trash, so a trashed type holding the pairing cannot be converted through it. Left as it is, a type
restored from the Trash would come back as the pairing the rules now refuse, and its next write would be refused for a
property the user did not touch. [[2026-11-07-task-series-cutover-uses-bounded-owner-backfill]] is the precedent for a
cutover step that writes item properties with SQL as a narrow, stated exception.

The choke point also has no operation that removes a property key: an update merges the patch into the stored
`properties` (`properties || patch`), and `null` is how it clears a key.

## Decision

1. **Live types go through the choke point.** The cutover selects at most 100 live types that hold the pairing, `FOR
UPDATE`, in one transaction and rewrites each with `updateItemWithClient` and the patch
   `{ processingMethod: 'journal', targetDatabase: null }`, so the write is recorded, versioned and announced after
   commit like any other type write. The stored `targetDatabase` is a JSON `null`. The Task wording "`targetDatabase`
   removed" is read as "unset": the type-write rules and every reader take `null` as unset, and the existing type-write
   tests already expect `null` after a clearing patch.
2. **Narrow exception for trashed types.** This step, and only this step, writes with SQL the `processingMethod` and
   `targetDatabase` keys of the trashed Inbox item types that hold the pairing. The rows are selected `FOR UPDATE` first
   and updated by one statement over exactly those ids, `properties || {processingMethod: 'journal',
targetDatabase: null}`, and the affected-row count must equal the locked count or the step throws. The statement
   leaves `updated_at` and the trash state as they are and emits no event, job or invalidation: no user changed the
   type, and a trashed type is in no list. It is not a writer other code may call, and it writes no other key.
3. **One stored shape.** The trashed statement stores `targetDatabase: null` too, so a converted type has the same keys
   whether it was live or trashed when the cutover ran.
4. **Idempotent.** A converted row no longer matches either selection, so a second run writes nothing.

## Alternatives rejected

- **Skip the trashed types.** A restored type would be refused on its next write for a pairing it holds from before the
  rule. The Trash is a place a person expects to restore from.
- **Restore, convert through the choke point, trash again.** It would write `updated_at`, run the restore and delete
  hooks and announce a type that no list shows, to avoid one statement over a locked set of rows.
- **Drop the key from live types with SQL after the choke point write.** It would change stored state behind the record
  the choke point just wrote, for a key every reader treats the same as `null`.

## Consequences

- The next cutover that must convert trashed rows of a table has this boundary to follow: an ADR naming the step, the
  keys, the locks and the affected-row check, not a comment.
- A converted type carries `targetDatabase: null` rather than lacking the key. Code that tests for the key's presence
  instead of its value would treat a converted type as targeted; nothing in this repository does.
