---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# Migrations are additive/backward-compatible; destructive cleanup ships later

## Context

Deploys flip a symlink and restart services; a rollback flips the symlink
back **without unwinding schema**. If a migration ships a destructive change
(drop column, rename, type narrowing, `NOT NULL` without a default) in the
same release as the code that depends on it, a rollback leaves the previous
release's code running against a schema it can't read.

## Decision

Every migration is additive and backward-compatible (the *expand* step);
destructive cleanup (the *contract* step) ships in a later release, once no
running code references the old shape. Allowed in one migration: `ADD
COLUMN` (nullable or with a default), new table, new index, new enum value,
widening a type, relaxing a constraint. Never in the same release as the
code that stops using the old shape: `DROP COLUMN`/`DROP TABLE`, a
rename, type narrowing, or adding `NOT NULL` to an existing column without a
default.

A rename is handled as: add the new column (release N, dual-write) →
backfill → read from the new column, keep dual-write (release N+1) → drop
the old column (release N+2 or later). Backfills are separate from DDL,
idempotent, and batched.

The only exception is an intentionally breaking change explicitly called
for by the linked issue's Task — stated in the migration's comment and the
PR description.

## Consequences

- A migration that isn't additive/backward-compatible on a table the PR
  didn't just create is a critical review finding
  (`review-rules/rules.md`, `review-rules/tasks/architecture.md`) unless
  the issue explicitly calls for the breaking change.
- Every schema change that removes or narrows something costs an extra
  release cycle (expand, then contract) instead of landing in one migration
  — the cost of keeping rollback safe without a schema-unwind step.

## Addendum (issue #216): application-code post-migration steps

Plain SQL can't do everything a populated-upgrade backfill needs — issue
#216's history cutover has to merge Yjs binary CRDT updates per doc, which
only the `yjs` library can do. `docHistoryCutoverMigration.ts` is the
canonical pattern for this narrow case:

- **When it's warranted.** Only when the backfill's logic genuinely can't be
  expressed in SQL (binary/CRDT merging, external-library-dependent
  transforms). A backfill that's just row-by-row SQL belongs in a queued
  data migration per the `db-migrations` skill, not application code run at
  deploy time.
- **Invocation.** Always immediately after `runMigrations`, from both
  `runMigrationsCli.ts` (real deploys) and `testSupport/globalSetup.ts`
  (tests) — never from request-handling code, so it can never race a normal
  read/write.
- **Idempotency guard.** Check the target schema state (e.g. a column's
  `information_schema.columns.is_nullable`) and return early if already
  migrated. This check needs to run *inside* the same transaction as the
  destructive work it guards, after the transaction's exclusive lock is
  held — an out-of-transaction pre-check has a TOCTOU window where two
  concurrent invocations (e.g. two replicas deploying at once) can both pass
  the check before either takes the lock.
- **Batching vs. a single transaction.** A single transaction under an
  exclusive table lock (as `docHistoryCutoverMigration.ts` does) is
  acceptable only when the table is small/bounded and the step is one-time;
  prefer the queued/batched backfill pattern from the main decision above
  for anything unbounded or per-item, to avoid holding a long lock.
