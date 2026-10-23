---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# Application-code post-migration steps for populated-upgrade backfills SQL can't express

## Context

`2026-09-10-expand-contract-forward-only-migrations.md` covers ordinary
backfills: idempotent, batched, row-by-row SQL run as a queued data
migration. Issue #216's retained-history cutover doesn't fit that shape —
computing each doc's cutover baseline means merging Yjs binary CRDT updates
into a current state, which only the `yjs` library can do. Plain SQL cannot
express it, so it can't be a queued SQL backfill, but it still needs to run
once, at deploy time, before any code depends on the new columns being
populated.

## Decision

`docHistoryCutoverMigration.ts` is the canonical pattern for this narrow
case — a one-time step written in application code (not SQL) that runs
immediately after the ordinary SQL migrations:

- **When it's warranted.** Only when the backfill's logic genuinely can't be
  expressed in SQL (binary/CRDT merging, external-library-dependent
  transforms). A backfill that's just row-by-row SQL belongs in a queued
  data migration per the expand/contract decision, not application code run
  at deploy time.
- **Invocation.** Always immediately after `runMigrations`, from both
  `runMigrationsCli.ts` (real deploys) and `testSupport/globalSetup.ts`
  (tests) — never from request-handling code, so it can never race a normal
  read/write.
- **Idempotency guard.** Check the target schema state (e.g. a column's
  `information_schema.columns.is_nullable`, schema-qualified with
  `table_schema = current_schema()` to avoid matching a same-named table in
  another schema) and return early if already migrated. This check must run
  *inside* the same transaction as the destructive work it guards, after
  the transaction's exclusive lock is held — an out-of-transaction
  pre-check has a TOCTOU window where two concurrent invocations (e.g. two
  replicas deploying at once) can both pass the check before either takes
  the lock.
- **Batching vs. a single transaction.** A single transaction under an
  exclusive table lock (as `docHistoryCutoverMigration.ts` does) is
  acceptable only when the table is small/bounded and the step is one-time;
  prefer the queued/batched backfill pattern from the expand/contract
  decision for anything unbounded or per-item, to avoid holding a long
  lock.

## Consequences

- A new populated-upgrade step whose logic can't be expressed in SQL should
  follow this same invocation point, idempotency-guard, and locking
  structure rather than inventing a new one.
- This pattern is only safe for small/bounded tables; introducing it for an
  unbounded table would hold `LOCK TABLE ... IN EXCLUSIVE MODE` for an
  unacceptable duration and is a critical review finding.
