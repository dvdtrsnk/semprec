# Migrations and rollback

Issue #191. Why: [expand/contract](../adr/2026-09-10-expand-contract-forward-only-migrations.md)
and [rollback one release back](../adr/2026-09-24-rollback-one-release-back-with-checked-migrations.md).

## The rule: the previous release must keep working

`deploy.sh` runs a release's migrations while the previous release is still serving, and
`deploy.sh --rollback` starts the previous release again against the migrated schema — nothing is
ever unwound. So every migration must leave the schema usable by the code of the release before it.

| Accepted in one release                                | Rejected: breaks the previous release                       |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `ADD COLUMN` nullable, or `NOT NULL` with a `DEFAULT`  | `ADD COLUMN ... NOT NULL` without a default                 |
| new table (any constraints), new index                 | `DROP TABLE`, `DROP COLUMN`                                 |
| relaxing a constraint (`DROP NOT NULL`, drop a check)  | `SET NOT NULL` on an existing column                        |
| a type change that only widens (with an exemption)     | a type change that narrows (`varchar(200)` → `varchar(10)`) |
| the removal step of an earlier expand (with exemption) | any rename (`RENAME COLUMN`, `RENAME TO`, ...)              |

Each row has at least one concrete file under
[`backend/packages/data/src/db/migrationExamples/`](../../backend/packages/data/src/db/migrationExamples/):
`accepted/*.sql` and `rejected/*.sql`, each applied on top of `previous-release.sql`. The
integration test `migrationCompatibility.test.ts` runs the previous release's queries after each
one: they keep working after every accepted example and the database refuses them after every
rejected one.

## Two releases for a rename or a removal

Rename `notes.title` to `notes.heading`:

1. **Release N** — migration adds `heading` (nullable). Code writes both columns, reads `title`.
   Backfill `heading` from `title` as a separate, idempotent, batched job.
2. **Release N+1** — code reads `heading`, still writes both. No migration.
3. **Release N+2 or later** — code stops writing `title`; a migration drops it, marked
   `-- expand-contract-exemption: contract step, title unused since N+1`.

Removing a column is the same without the new column: stop using it in one release, drop it in a
later one. Making a column required: add it nullable, backfill, then `SET NOT NULL` in a later
release (with the exemption) once every running release writes it.

## The mechanical check

`backend/packages/data/src/__tests__/migrationCompatibility.unit.test.ts` runs
`findIncompatibleStatements` over every file in `backend/packages/data/src/db/migrations/` in the
unit tier, so CI fails on a rejected statement. A file opts out only with a line comment that
states why it is safe:

```sql
-- expand-contract-exemption: contract step. legacy_color unused since v1.4.0.
ALTER TABLE notes DROP COLUMN legacy_color;
```

The check is lexical: it ignores comments and string literals and never flags a table the same
file creates. The reviewer still reads every exemption and every statement the check cannot see.

## Fix forward, never unwind

There are no down migrations. When a migration or the release that shipped it is wrong:

1. `sudo deploy/deploy.sh --rollback <previous-tag>` to get working code back in seconds
   ([deploy/README.md](../../deploy/README.md#rolling-back-issue-191)). The schema stays as it is,
   which the rule above makes safe.
2. Fix the defect in a new commit — including a new migration if the schema itself is wrong — and
   release and deploy it as a new version.
