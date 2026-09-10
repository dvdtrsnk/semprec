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
