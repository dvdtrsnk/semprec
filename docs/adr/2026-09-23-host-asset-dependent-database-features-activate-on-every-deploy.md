---
status: accepted
date: 2026-09-23
area: [backend, cross-cutting]
supersedes: []
superseded-by: null
---

# Host-asset-dependent database features activate idempotently on every deploy

## Context

Issue #207 upgrades the `czech` text search configuration to a Hunspell
dictionary. PostgreSQL loads that dictionary from files in its
`tsearch_data` directory, which `deploy/provision.sh` installs (#206) — an
operating-system step no SQL migration can perform. A migration is applied
once and recorded in `schema_migrations`, so a migration that ran before
provisioning installed the files can never retry on its own; and requiring
the files would make every migration run on a host (and in CI) without them
fail.

The alternatives were: require the files and fail the migration without
them; have `provision.sh` reach into the database itself (it holds no
database credentials and may run before the first deploy has created the
schema); or a manual operator step.

## Decision

A database feature that depends on host-installed assets is activated by an
idempotent SQL function created in the migration that introduces it:

- **The migration** creates the function and calls it once. Without the
  assets the function catches only the specific error that reports them
  missing, raises a `WARNING`, and returns `false`, leaving the previous
  behavior intact; the migration still succeeds and is recorded. Every other
  error propagates.
- **The migrations CLI** (`runMigrationsCli.ts`) calls the function again on
  every deploy, immediately after `runMigrations`, and
  `testSupport/globalSetup.ts` mirrors it. A database migrated before the
  assets existed is upgraded by the first deploy after they are installed.
- **Idempotency.** The function takes a transaction-scoped advisory lock,
  then returns early without writing to the catalogs when the feature is
  already active, so repeated deploys are a no-op.
- **Revoked from `PUBLIC`**: only the migrating role runs it.

`activate_czech_hunspell_search()` in
`0046_czech_hunspell_search.sql` is the first instance.

## Consequences

- Deploy order between provisioning and migrations stops mattering; the
  feature arrives with whichever of the two runs second, followed by a
  deploy.
- Once active, the feature depends on the host assets at runtime. Losing
  them (e.g. recreating the container they were copied into) breaks the
  feature until provisioning reinstalls them — the deployment docs must say
  so for each such feature.
- Activation changes only configuration. Data derived under the fallback
  (such as existing search vectors) is not rewritten by the activation
  function; any rebuild is a separate backfill under the expand/contract
  decision.
