---
name: db-migrations
description: Expand/contract discipline for every Postgres schema change in the Semprec backend. Use this skill whenever writing or editing a migration, adding/renaming/dropping a column or table, changing a column type or nullability, adding an index or constraint, or writing a data backfill — even if the change looks trivially safe.
---

# Migrations: expand/contract, forward-only

Deploys flip a symlink and restart services; rollback flips the symlink back
**without unwinding schema**. That single operational fact dictates every rule
here: the previous release's code must keep working against the new schema,
because after a rollback it will.

## The discipline

Write every migration as **additive and backward-compatible** (the *expand* step).
Destructive cleanup (the *contract* step) ships in a later release, after no
running code references the old shape.

Allowed in one migration:
- `ADD COLUMN` (nullable, or with a `DEFAULT`)
- new table, new index (`CREATE INDEX CONCURRENTLY` on large tables), new enum value
- widening a type, relaxing a constraint

Never in the same release as the code that stops using the old shape:
- `DROP COLUMN` / `DROP TABLE`
- column/table rename (see below)
- type narrowing, adding `NOT NULL` to an existing column without a default

## Recipes

**Rename a column** — a rename is a drop in disguise:
1. Release N: add the new column; write to both, read from the old.
2. Backfill (idempotent, batched — as a queue job for large tables).
3. Release N+1: read from the new column, keep dual-write.
4. Release N+2 (or later): drop the old column.

**Make a column required**: add nullable → backfill → add a `CHECK (col IS NOT
NULL) NOT VALID` → `VALIDATE CONSTRAINT` → only then `SET NOT NULL`.

**Backfills**: separate from DDL, idempotent (re-runnable with the same `jobKey`),
batched so they don't hold long locks or bloat one transaction.

## Structural vs data migrations

The module contract distinguishes structural migrations (DDL, run at deploy) from
data migrations (backfills with a cursor, run by the queue). Keep them in separate
files; a deploy must never block on a long backfill.

## Escape hatch

An intentionally breaking change is allowed only when the linked issue's Task
explicitly calls for it — say so in the migration's comment and in the PR
description, otherwise the review bot flags it as critical.
