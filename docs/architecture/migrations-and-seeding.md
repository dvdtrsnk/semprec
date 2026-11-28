# Migrations and seeding

How the Postgres schema, the per-tenant system data and module data are created and changed.
Operator procedures are in [docs/operations/migrations.md](../operations/migrations.md) and
[docs/operations/seeding.md](../operations/seeding.md); row-level security, database roles and
runtime DDL through security-definer functions are in
[tenancy-and-security.md](tenancy-and-security.md#security-definer-functions).

## Policy

### One baseline, no versions

Alldots has not been released. The backend assumes it is the first version of itself, and every
database it runs against was created from the current baseline:

- The schema is one file, `backend/packages/data/src/db/migrations/0001_baseline.sql`. A schema
  change edits the statement that defines the table, index, policy or function in place; no second
  migration file is added and nothing is appended to reshape an earlier definition.
- The seed (`backend/packages/data/src/seed/`) and the module manifests change in the same change
  as the baseline, so a freshly migrated and seeded database is in the target shape.
- There are no schema versions, upgrade paths, backfills, data cutovers, reconciles of already
  seeded tenants or reader branches for data an older code version wrote. Every database — local,
  test and the deployed one — is recreated from the baseline; the operator wipes the deployed
  database before a deploy, outside `deploy.sh`.
- Production rules (versioned migrations of a database that keeps its data) are introduced at the
  owner's first production deployment, as a separate change.

## Migration mechanism

### Runner

- `runMigrations(pool)` (`backend/packages/data/src/db/migrate.ts`) applies the `.sql` files of the
  migrations directory in filename order, each in its own transaction together with its row in
  `schema_migrations`; a file listed there is skipped, so a repeated run on the same database is a
  no-op.
- The baseline is structural (DDL plus the grants and policies that go with it) and ends with
  tenant zero, its default AI budget and the Hunspell activation below. Data that depends on
  tenants, modules or application code is written by the seed.
- The build copies the SQL files into `dist/db/migrations/` next to the compiled runner.

### Migrations CLI

`backend/packages/data/src/db/runMigrationsCli.ts` (compiled to
`packages/data/dist/db/runMigrationsCli.js`) is the only production entry point:

- It reads `DATABASE_URL` (the migrating role) and opens one owner pool without a statement
  timeout.
- Inside `runAsSystem("deploy migrations", ...)` it runs `runMigrations`, then `installQueueSchema`
  (`data/db/queueSchema.ts`: graphile-worker's schema, then `alldots_side`'s grants on it, which the
  SQL file cannot create).
- Every queue runtime (alldots-api, alldots-agents, alldots-transcribe) also runs `installQueueSchema`
  at start, so several processes run it at once on a fresh database. graphile-worker's own migration
  tolerates that. The grants run in one `withTransaction` that first takes the advisory lock
  `(2335, 0)`, because Postgres refuses concurrent updates of one catalog row
  (`tuple concurrently updated`); the second process waits and re-grants what is already granted.
- The pool is closed on every outcome; a failure to close is logged and never replaces the real
  error.
- `backend/packages/data/src/testSupport/globalSetup.ts` runs the same sequence for the test
  database. A step added to one is added to the other.

### Host-asset-dependent features

A database feature that needs files installed on the host (the Czech Hunspell dictionary in
Postgres' `tsearch_data`, installed by `deploy/provision.sh`) is activated by an idempotent SQL
function created in the baseline:

- The function takes a transaction-scoped advisory lock, returns early when the feature is
  already active, and when the assets are missing catches only that specific error, raises a
  `WARNING` and returns `false`, keeping the fallback. Every other error propagates.
- The baseline calls it as its last statement, so a database created on a provisioned host has the
  feature from its first row.
- The function is revoked from `PUBLIC`; only the migrating role runs it.
- Once active, the feature depends on the host assets; `deploy/README.md` documents each such
  dependency.

### In the deploy

`deploy/deploy.sh` runs the migrations CLI, then the seed CLI, then
`verifyTenancyCli.js` (catalog tenancy invariants, `backend/packages/data/src/db/tenancyInvariants.ts`),
each in a transient `systemd-run` unit that loads `/opt/alldots/shared/env/migrate.env`, before
the new release is activated. On the wiped database this creates the schema, provisions tenant
zero and verifies the catalog. Any failure leaves `current` and the running services untouched.
See [delivery-and-operations.md](delivery-and-operations.md#deploy).

## Seeding

### What the seed creates

`provisionTenant(pool, tenantId)` (`backend/packages/data/src/tenancy/provisionTenant.ts`)
creates, for one tenant, the records the rest of the system assumes exist:

- the system databases and their rows (`seed/seedSystem.ts`: System settings singleton,
  Projects with the Alldots project, the hardcoded databases, the module databases and their
  heartbeats, via the `seed/seed*.ts` functions);
- then the default Inbox item types (`seedDefaultInboxItemTypes`).

A `provisioning` tenant becomes `active` only after all of it succeeded.

### How it runs

- `runSeedCli.ts` → `runSeed(pool)` (`backend/packages/data/src/db/runSeed.ts`) visits every
  tenant whose status is `provisioning`, `active` or `suspended` (`forEachMaintainedTenant`;
  `deleting` is never visited), one at a time, each inside its tenant scope. A failing tenant
  does not stop the others; the run ends with one `AggregateError` naming every failed tenant.
- The CLI connects with the migrating URL but opens its pool with
  `createPool(url, { role: "alldots_data" })`: the pg startup option `-c role=alldots_data` makes
  every connection run as the runtime role from the moment it opens, so row-level security
  applies to every statement. `provisionTenant` calls `assertRowSecurityActive` first and
  refuses an owner or superuser pool before writing anything.
- The seed is idempotent and serialized per tenant: `lockTenantSeedInTransaction`
  (`seed/seedSystem.ts`) takes `pg_advisory_xact_lock(2331, hashtext(<tenant id>))`, then the
  tenant row `FOR SHARE` (refusing a missing or `deleting` tenant), then checks whether the system
  databases exist. A concurrent seed of the same tenant waits and finds them; other tenants do
  not wait.
- A tenant whose system databases exist is left as it is: the seed never compares, extends or
  repairs an existing tenant's definitions.

### Defaults a user may delete

Defaults the user may delete or rename (such as the default Inbox item types in
`backend/packages/data/src/inbox/defaultInboxTypes.ts`) are seeded once per default, never by an
existence check:

- A per-tenant marker on the System settings item (`seededDefaultInboxTypes`, a list of stable
  default keys) records what has been created. A listed default is never created again, whether
  or not its record still exists.
- The marker has one owner process and one writer (`seedDefaultInboxItemTypes`, through the
  choke point with `allowedSystemKeys`); the types and the marker keys commit in one transaction.
  The settings item's row lock (`lockItemById`) serializes concurrent seeders.
- Nothing is written when nothing is created; a default whose target database is absent is
  skipped without recording, so it is created once that database exists.
- Names come from the Inbox catalog in the tenant user's locale at seeding time; a later locale
  change does not rename a seeded type.
- A module adds a default by appending a row with a new key to `DEFAULT_INBOX_TYPES`.

## Deploy-time tenant work

- The seed is the only deploy-time step that writes tenant rows. It runs once per tenant, inside
  that tenant's scope, on a `createPool(url, { role: "alldots_data" })` pool, enumerated with
  `forEachMaintainedTenant`, never on the owner pool, which bypasses row-level security.
- `forEachMaintainedTenant` (deploy: `provisioning`, `active`, `suspended`) and
  `forEachActiveTenant` (scheduled sweeps: `active` only) differ deliberately.
