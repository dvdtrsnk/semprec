# Migrations and rollback

Rules: [migrations and seeding](../architecture/migrations-and-seeding.md) and
[rollback one release back](../architecture/delivery-and-operations.md#rollback). Before the
first production release the schema is a baseline edited in place; the rule below applies
from that release on.

## What a deploy runs

`backend/packages/data/dist/db/runMigrationsCli.js` (source `src/db/runMigrationsCli.ts`) does two
things, as the migrating role:

1. `runMigrations` (`src/db/migrate.ts`) applies every file of
   `backend/packages/data/src/db/migrations/` that `schema_migrations` does not list yet, in file
   name order, each in its own transaction together with its `schema_migrations` row.
2. `ensureQueueSchema` and `grantQueueSchemaPrivileges` (`@semprec/queue`) install graphile-worker's
   own schema and give the runtime roles their grants on it; that schema does not exist before
   graphile-worker creates it, so its grants cannot live in a SQL file.

Nothing else runs at deploy time: there are no application-code upgrade steps. The seed CLI runs
next ([seeding](seeding.md)). Integration tests build their database the same way
(`src/testSupport/globalSetup.ts`).

## The baseline

`0001_baseline.sql` is the whole schema of a fresh database: roles, extensions, functions, text
search configurations, tables with their keys, indexes, triggers and grants, foreign keys,
row-level security policies, default privileges, and tenant zero with its default AI budget. It
replaced the 177 development-era migrations before the first production release, when no database
with data existed; it was generated from a `pg_dump` of a database those migrations built and
proven to produce the same schema. Edit it only to regroup or comment it; a schema change is a new
file.

Every object belongs to the migrating role, except the cross-tenant router functions, which belong
to `semprec_router` ([database roles](database-roles.md)). The `semprec:tenancy=` table comments are
read by the deploy-time tenancy verifier (`src/db/tenancyInvariants.ts`).

## Adding a migration

Add the next numbered file, `NNNN_short_name.sql`. `pnpm --filter @semprec/data run
check-migration-numbering` fails when two files share an ordinal. A module that owns the new file
lists it in its manifest's `migrations` field; the baseline is listed by `schemaCore`.

A migration contains DDL and, at most, a data change plain SQL can express. A change that needs
application code to rewrite stored data is a queue job, not part of the deploy.

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
