# Seeding the system databases

Issue #644. `backend/packages/data/dist/db/runSeedCli.js` (source `src/db/runSeedCli.ts`, body in
`src/db/runSeed.ts`) creates the records every other part of Semprec assumes exist:

- the "System settings" singleton database and its settings row;
- the Projects database with the Semprec project row;
- the ten hardcoded databases, the Email, Library, Inbox and MCP module databases, and their
  heartbeats;
- then the data migrations declared by every active module.

It prints one line: `seed: created system databases` when this run wrote the system databases,
`seed: already seeded` when it found them present. The outcome is decided under the seed's advisory
lock (below), so of two concurrent runs exactly one prints `created`. It never prints the connection string.

## Idempotent and lock-protected

The seed is a no-op once the system settings database exists. The check runs inside the seed's
own transaction after `pg_advisory_xact_lock(2331)`, so two concurrent runs cannot both seed: the
second waits for the first to commit, then finds its rows and returns. Module data migrations run
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
