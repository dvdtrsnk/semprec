# Seeding the system databases

Issue #644, per tenant since #1005. `backend/packages/data/dist/db/runSeedCli.js` (source
`src/db/runSeedCli.ts`, body in `src/db/runSeed.ts`) creates, for every tenant, the records every
other part of Semprec assumes exist:

- the "System settings" singleton database and its settings row;
- the Projects database with the Semprec project row;
- the ten hardcoded databases, the Email, Library, Inbox and MCP module databases, and their
  heartbeats;
- then the data migrations declared by every active module.

## Per tenant

The seed visits every tenant whose status is `provisioning`, `active` or `suspended`, one after
another, each inside that tenant's scope (`provisionTenant`). `deleting` tenants are skipped. A
`provisioning` tenant becomes `active` once its seed and data migrations succeed; `active` and
`suspended` tenants keep their status. A failing tenant does not stop the others: the CLI provisions
the rest, then fails with an error naming the failed tenant ids.

It prints one line per tenant:

- `seed: tenant <id> created system databases` when this run wrote the tenant's system databases;
- `seed: tenant <id> already seeded` when it found them present.

It never prints the connection string.

## Runs as `semprec_data`

The CLI connects with `SEMPREC_MIGRATE_DATABASE_URL` (the table owner) but opens its pool with
`createPool(url, { role: "semprec_data" })`, so every connection runs as `semprec_data` and
row-level security applies. `provisionTenant` refuses to run when RLS is not active for its role.
See [the ADR](../adr/2026-10-08-deploy-time-tenant-work-runs-as-the-runtime-role.md).

## Idempotent and lock-protected

The seed is a no-op for a tenant once its system settings database exists. The check runs inside
the seed's own transaction after `pg_advisory_xact_lock(2331, hashtext(<tenant id>))`, so two
concurrent runs for one tenant cannot both seed: the second waits for the first to commit, then
finds its rows and returns. Different tenants do not wait on each other. Module data migrations run
after that transaction and are idempotent on their own.

## When it runs

`deploy/deploy.sh` runs it on every deploy, right after the migrations CLI and under the same
`SEMPREC_MIGRATE_DATABASE_URL`, before the release is activated. A seed failure fails the deploy
with `seed failed` and leaves `current` and the services untouched (see
[`deploy/README.md`](../../deploy/README.md)).

## Running it by hand

Against a local database, after migrating it and building the backend:

```sh
cd backend
DATABASE_URL=postgres://... node packages/data/dist/db/runSeedCli.js
```
