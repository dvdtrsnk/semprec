# Migrations and seeding

How the Postgres schema, the per-tenant system data and module data are created and changed.
Operator procedures are in [docs/operations/migrations.md](../operations/migrations.md) and
[docs/operations/seeding.md](../operations/seeding.md); row-level security, database roles and
runtime DDL through security-definer functions are in
[tenancy-and-security.md](tenancy-and-security.md#security-definer-functions).

## Policy

### Before the first production release: one editable baseline

No production database exists yet. Until the first production release:

- The SQL files under `backend/packages/data/src/db/migrations/` are a **baseline**, not a
  history. A schema change edits the file that defines the table, index, policy or function
  directly; it does not append an `ALTER` migration to reshape something defined earlier.
- The seed (`backend/packages/data/src/seed/`) and the module manifests are edited **alongside**
  the baseline, so a freshly migrated and seeded database is always in the target shape.
- No cutover, backfill, data conversion, compatibility shim or post-migration step is written for
  development data. Local and test databases are recreated from the baseline instead.
- Expand/contract sequencing does not apply yet; the lexical compatibility check accepts a file
  that creates the table it changes, so baseline edits pass it.

### After the first production release: forward-only, expand/contract

From the first production release on, the schema is a history and these rules apply:

- **Forward-only.** A migration that has been released is never edited, renamed or renumbered.
  Every change is a new file with the next ordinal. There are no down migrations; a defect is
  fixed forward in a new release.
- **Expand/contract.** Every migration leaves the schema usable by the code of the previous
  release, because a deploy migrates while the previous release still serves and a rollback
  never unwinds schema. Allowed in one release: new table, new index, nullable column or column
  with a default, widening a type, relaxing a constraint. A drop, rename, narrowing type change,
  `SET NOT NULL` or new required column without a default is a later *contract* step, after no
  running release uses the old shape. A rename takes three releases: add and dual-write, read
  the new column, drop the old one.
- **Mechanical check.** `findIncompatibleStatements`
  (`backend/packages/data/src/db/migrationCompatibility.ts`) runs over every migration file in
  the unit tier (`src/__tests__/migrationCompatibility.unit.test.ts`). A file that needs a
  rejected statement carries `-- expand-contract-exemption: <reason>` (a contract step, a
  widening, or a break the issue explicitly asks for), which review judges. Accepted and
  rejected examples live in `backend/packages/data/src/db/migrationExamples/`.
- **Backfills are separate from DDL**: idempotent, batched in bounded transactions, resumable,
  and never holding a table lock across a batch. A table-wide constraint that depends on a
  backfill is added only after the backfill has completed.
- **New stored values need a compatible reader first.** A writer that persists a new enum value,
  status or error code ships only after a release whose readers accept it is deployed, so a
  rollback one release back never meets a value it cannot decode. Widening a `CHECK` alone does
  not make an old reader compatible.
- **Deploy-time tenant data work** runs per tenant on a runtime-role pool (see
  [Deploy-time tenant work](#deploy-time-tenant-work)); the migrating role keeps only DDL and
  schema-guarded global steps.

## Migration mechanism

### Runner

- `runMigrations(pool)` (`backend/packages/data/src/db/migrate.ts`) applies every `.sql` file in
  the migrations directory in filename order. Applied files are recorded by full filename in
  `schema_migrations`; each file runs in its own transaction with its record.
- Files are named `NNNN_<name>.sql`. `backend/packages/data/scripts/check-migration-numbering.mjs`
  (part of `pnpm run verify` and CI) fails on a file without a leading ordinal and on a duplicate
  ordinal, because the runner would otherwise apply two same-ordinal files silently.
- Migrations are structural (DDL plus the grants and policies that go with it). Data that
  depends on tenants, modules or application code is not written from SQL migrations.
- The build copies the SQL files into `dist/db/migrations/` next to the compiled runner.

### Migrations CLI

`backend/packages/data/src/db/runMigrationsCli.ts` (compiled to
`packages/data/dist/db/runMigrationsCli.js`) is the only production entry point:

- It reads `DATABASE_URL` (the migrating role) and opens two pools without a statement
  timeout: an owner pool for DDL and global steps, and a `createPool(url, { role: "semprec_data" })`
  pool for tenant work.
- Everything runs inside `runAsSystem("deploy migrations", ...)`, in this order: `runMigrations`;
  host-asset activation; `ensureQueueSchema` and `grantQueueSchemaPrivileges` (graphile-worker's
  schema and `semprec_side`'s grants on it, which SQL migrations cannot create); then the
  tenant-scoped steps on the runtime-role pool.
- Both pools are closed on every outcome; a failure to close is logged and never replaces the
  real error.
- `backend/packages/data/src/testSupport/globalSetup.ts` runs the same sequence for the test
  database. A step added to one is added to the other.

### Host-asset-dependent features

A database feature that needs files installed on the host (the Czech Hunspell dictionary in
Postgres' `tsearch_data`, installed by `deploy/provision.sh`) is activated by an idempotent SQL
function created in the baseline:

- The function takes a transaction-scoped advisory lock, returns early when the feature is
  already active, and when the assets are missing catches only that specific error, raises a
  `WARNING` and returns `false`, keeping the fallback. Every other error propagates.
- The migrations CLI and `globalSetup` call it on every run right after `runMigrations`
  (`activateCzechHunspellSearch` in `backend/packages/data/src/mail/czechHunspellSearch.ts`), so the
  feature arrives with whichever of provisioning and deploy runs second.
- The function is revoked from `PUBLIC`; only the migrating role runs it.
- Once active, the feature depends on the host assets; `deploy/README.md` documents each such
  dependency.

### In the deploy

`deploy/deploy.sh` runs the migrations CLI, then the seed CLI, then
`verifyTenancyCli.js` (catalog tenancy invariants, `backend/packages/data/src/db/tenancyInvariants.ts`),
each in a transient `systemd-run` unit that loads `/opt/semprec/shared/env/migrate.env`, before
the new release is activated. Any failure leaves `current` and the running services untouched.
See [delivery-and-operations.md](delivery-and-operations.md#deploy).

## Seeding

### What the seed creates

`provisionTenant(pool, tenantId)` (`backend/packages/data/src/tenancy/provisionTenant.ts`)
creates, for one tenant, the records the rest of the system assumes exist:

- the system databases and their rows (`seed/seedSystem.ts`: System settings singleton,
  Projects with the Semprec project, the hardcoded databases, the module databases and their
  heartbeats, via the `seed/seed*.ts` functions);
- then the data migrations of every active module (`runModuleDataMigrations`);
- then the default Inbox item types (`seedDefaultInboxItemTypes`).

A `provisioning` tenant becomes `active` only after all of it succeeded.

### How it runs

- `runSeedCli.ts` → `runSeed(pool)` (`backend/packages/data/src/db/runSeed.ts`) visits every
  tenant whose status is `provisioning`, `active` or `suspended` (`forEachMaintainedTenant`;
  `deleting` is never visited), one at a time, each inside its tenant scope. A failing tenant
  does not stop the others; the run ends with one `AggregateError` naming every failed tenant.
- The CLI connects with the migrating URL but opens its pool with
  `createPool(url, { role: "semprec_data" })`: the pg startup option `-c role=semprec_data` makes
  every connection run as the runtime role from the moment it opens, so row-level security
  applies to every statement. `provisionTenant` calls `assertRowSecurityActive` first and
  refuses an owner or superuser pool before writing anything.
- The seed is idempotent and serialized per tenant: `lockTenantSeedInTransaction`
  (`seed/seedSystem.ts`) takes `pg_advisory_xact_lock(2331, hashtext(<tenant id>))`, then the
  tenant row `FOR SHARE` (refusing a missing or `deleting` tenant), then checks whether the system
  databases exist. A concurrent seed of the same tenant waits and finds them; other tenants do
  not wait. Any other structural seeding of a tenant takes the same lock first.

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
- A module adds a default by appending a row with a new key to `DEFAULT_INBOX_TYPES`. Keys are
  never renamed, reused or removed from the marker.

## Module data migrations

A module manifest declares versioned data transitions in `ModuleManifest.dataMigrations`; each is
a converter `(properties, context) => properties` for one
`(moduleId, databaseKey, fromVersion, toVersion)`. Before the first production release a module
changes its seeded schema directly instead of adding a converter; converters exist for data that
production already holds.

- `runModuleDataMigration` (`backend/packages/data/src/migrationJob/moduleDataMigration.ts`)
  applies one transition to every item of the database for one tenant, under a per-transition,
  per-tenant advisory lock.
- **Two passes.** Pass 1 reads id-ordered pages with `lockItemBatch`
  (`migrationJob/itemBatch.ts`, `SELECT … FOR UPDATE SKIP LOCKED`); pass 2 restarts from the first
  id with plain `FOR UPDATE`, waiting on held rows, so rows skipped or inserted below the cursor
  in pass 1 are visited.
- Each page is converted and written in one transaction under the row locks, with
  `properties IS DISTINCT FROM $converted`, so an already-converted row is never rewritten and
  its `updated_at` is unchanged. `lockItemBatch` is the shared helper for any batched rewrite of
  item properties.
- Progress (`pass`, `cursor`) is stored per transition in `module_migration_progress`, written in
  each batch transaction and deleted in the transaction that records the transition as done in
  `module_migrations`. A resumed run continues from it.
- **Converters must be idempotent**: `converter(converter(p))` deep-equals `converter(p)`. A
  transformation that would change its own output again is not a data migration.
- **Converter context** (`ModuleDataMigrationConverterContext` in
  `backend/packages/module-registry/src/registry.ts`) is `{ timezone, itemId, log }`: the tenant's
  time zone read once per run, the item id, and `log(reason)`, which writes one `info` entry with
  the item id and a short reason code. A reason never contains a property value. The context has
  no database access; adding a field is additive, changing one is a contract change.

## Deploy-time tenant work

- Any deploy-time step that reads or writes tenant rows runs once per tenant, inside that
  tenant's scope, on a `createPool(url, { role: "semprec_data" })` pool, enumerated with
  `forEachMaintainedTenant`. It never runs on the owner pool, which bypasses row-level security.
- The only exception is a step whose final statement is table-wide DDL that the runtime role
  cannot run; it runs on the owner pool in one transaction with its backfill, and every
  statement in it that reads another row joins it by explicit `tenant_id` equality.
- `forEachMaintainedTenant` (deploy: `provisioning`, `active`, `suspended`) and
  `forEachActiveTenant` (scheduled sweeps: `active` only) differ deliberately.
