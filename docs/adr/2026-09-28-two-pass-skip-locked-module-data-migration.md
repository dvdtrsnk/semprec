---
status: accepted
date: 2026-09-28
area: [backend]
supersedes: []
superseded-by: null
---

# Module data migrations run in two row-locked passes over idempotent converters

## Context

A module manifest declares data migrations (`ModuleManifest.dataMigrations`),
each a pure converter `(properties) => properties` for one
`(moduleId, databaseKey, fromVersion, toVersion)` transition.
`runModuleDataMigration` applies one to every item of the database. It
already holds a session-level advisory lock per transition and commits in
id-ordered batches so a crashed run can resume.

The single-pass runner it replaces (issue #663) had three defects:

- **Lost concurrent writes.** It read a batch without a row lock, converted
  it in memory and wrote the whole `properties` object back. A choke-point
  update that committed between the read and the write was overwritten.
- **Missed rows.** The resume cursor is the last converted `id`, and item ids
  are random UUIDs. So a row inserted during the run with an id below the
  cursor was never visited. Skipping locked rows to avoid waiting on a busy
  row would miss rows the same way.
- **Shared progress.** The cursor lived in `databases.migration_cursor`, one
  per database, but the lock is per transition. Two transitions on the same
  database overwrote each other's cursor.

Alternatives considered:

- **One pass with `FOR UPDATE` that waits on locked rows.** This fixes lost
  writes, but a row inserted below the cursor is still never visited.
- **A snapshot read (`REPEATABLE READ`, or one transaction for the whole
  database).** A snapshot never shows rows inserted after it starts, and it
  does not stop a concurrent update from being overwritten. One transaction
  over the whole database would also hold every item's lock for the whole
  run and give up resumability.
- **Scanning by a monotonic key (a sequence or `created_at`) instead of
  `id`.** Late inserts would then always sort above the cursor, but this
  needs a new indexed column on `items` and a backfill. That is a bigger
  schema change than the problem justifies.

## Decision

The runner makes two passes over the database's items. Each page is read
with `lockItemBatch` (`SELECT ... FOR UPDATE`), converted and written back
inside one transaction. That transaction also records the transition's
progress.

- **Pass 1** reads with `SKIP LOCKED`, so a row held by another transaction
  does not stall the run.
- **Pass 2** starts again from the first id and reads with plain
  `FOR UPDATE`, which waits on held rows. It visits every row skipped in
  pass 1 or inserted below its cursor during pass 1.

A full-replace write is allowed only because the row is locked for the whole
batch transaction. The write is guarded with
`properties IS DISTINCT FROM $converted`. So a row whose stored shape is
already the target is read but never rewritten, and its `updated_at` (the
`ifVersion` token) stays the same.

Progress is stored per transition in `module_migration_progress`
(`pass`, `cursor`), keyed like the advisory lock and the `module_migrations`
row. It is deleted in the same transaction that records the transition as
done. A resumed run continues from the recorded pass and cursor.

**Converter contract.** Every `ModuleDataMigrationConverter` must be
idempotent: `converter(converter(p))` deep-equals `converter(p)`. Pass 2, a
retried batch and a resumed run all feed already-converted rows back into
the converter. The contract is stated on the converter type.

## Consequences

- Every future converter must be written to be idempotent. A converter that
  appends, increments or otherwise transforms its own output again (such as
  "prefix the title") corrupts data under this runner. Such a change must
  record in the properties that it has already been applied, or not be a
  data migration.
- Each migration reads every item twice. Rows that were already converted
  cost a locked read only, not a write.
- Pass 2 waits on rows other transactions hold locked, so a long-running
  writer delays the end of a migration instead of being overwritten by it.
- Pass 2 has the same cursor shape as pass 1. A row inserted during pass 2
  with an id below its cursor is not visited by this run. The design narrows
  the miss window to pass 2 but does not close it. Closing it needs the
  monotonic-key alternative above, which would supersede this decision.
- `databases.migration_cursor` is unused from this release on. It is dropped
  in a later contract step under
  [[2026-09-10-expand-contract-forward-only-migrations]].
- `lockItemBatch` is the shared helper for any other batched rewrite of item
  properties, such as the single-property type migration, so those rewrites
  get the same locking.
