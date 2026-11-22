# Migrations

Rules: [migrations and seeding](../architecture/migrations-and-seeding.md). The backend assumes it
is the first version: the schema is one baseline that is edited in place, and every database is
created from it. Production rules for a database that keeps its data are introduced at the owner's
first production deployment.

## What a deploy runs

`backend/packages/data/dist/db/runMigrationsCli.js` (source `src/db/runMigrationsCli.ts`) does two
things, as the migrating role:

1. `runMigrations` (`src/db/migrate.ts`) applies `0001_baseline.sql` to the empty database, in one
   transaction together with its `schema_migrations` row.
2. `installQueueSchema` (`src/db/queueSchema.ts`) installs graphile-worker's own schema and gives the
   runtime roles their grants on it; that schema does not exist before graphile-worker creates it, so
   its grants cannot live in a SQL file. Every queue runtime runs the same step at start.

The seed CLI runs next ([seeding](seeding.md)), then the tenancy verifier. Integration tests build
their database the same way (`src/testSupport/globalSetup.ts`).

## The baseline

`0001_baseline.sql` is the whole schema of a fresh database: roles, extensions, functions, text
search configurations, tables with their keys, indexes, triggers and grants, foreign keys,
row-level security policies, default privileges, and tenant zero with its default AI budget.

Every object belongs to the migrating role, except the cross-tenant router functions, which belong
to `semprec_router` ([database roles](database-roles.md)). The `semprec:tenancy=` table comments are
read by the deploy-time tenancy verifier (`src/db/tenancyInvariants.ts`).

## Changing the schema

Edit the statement in `0001_baseline.sql` that defines the table, column, index, policy or function,
and change the seed and module manifests in the same change. Add no second migration file, no
backfill, no data conversion and no reader branch for an older shape: no database with data from an
earlier version is carried.

A local database is recreated from the baseline after a schema change. On the deployed host the
operator wipes the database before every deploy; `deploy.sh` itself never drops data.

## Rollback

`sudo deploy/deploy.sh --rollback <previous-tag>` repoints `current` to the previous release
without touching the database ([deploy/README.md](../../deploy/README.md#rolling-back-issue-191)).
Nothing keeps the schema compatible with an older release, so a rollback is safe only when the two
releases have the same baseline. Otherwise the way forward is a fixed release, deployed onto a
wiped database.
