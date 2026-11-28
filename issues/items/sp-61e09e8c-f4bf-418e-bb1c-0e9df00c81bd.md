---
schemaVersion: 1
id: "sp-61e09e8c-f4bf-418e-bb1c-0e9df00c81bd"
title: "[internet-accounts 19/19] Add the seed's missing system definitions to carried tenants"
kind: "implementation"
state: "closed"
stateReason: "completed"
labels: ["spec:approved"]
parent: "sp-85e6cbc4-7de7-4385-81a9-a493c421b817"
assignees: []
milestone: null
createdAt: "2026-11-20T19:03:12.643Z"
updatedAt: "2026-11-20T20:24:02.258Z"
closedAt: "2026-11-20T20:24:02.258Z"
source: null
approval: {"specSha256":"d50a07fe1b05e327929579d46fd983742f5af71f2b595c8178e7a8a532184b6d","source":"repository","actor":"claude-delegated-by-david","at":"2026-11-20T19:03:22.405Z"}
resolution: {"pullRequests":[],"commit":"80d818e6d0e9dec00cc20eb2fbc742b5626d6841","at":"2026-11-20T20:24:02.258Z"}
---
**Blocked by:** sp-cb9c39d0-a4a6-45c2-9ba8-39b72f56e0bf
**Model tier:** high

## Context

Model tier rationale: Writes schema-level rows (properties, relation definitions) into existing tenants during a production cutover and every later release; a mistake corrupts system databases for every tenant.

The production cutover runbook (sp-cb9c39d0-a4a6-45c2-9ba8-39b72f56e0bf) carries production data into a develop database by copying tables. The develop seed skips an already seeded tenant, so carried system databases keep their v0.1.x shape. The dry run against a v0.1.12-shaped dump reports 11 system properties the develop seed defines that carried data lacks: `mailboxes.mailEnabled`, `mailboxes.calendarsEnabled`, `mailboxes.calendars`, `calendars.account`, `calendars.readOnly`, `calendars.remoteColor`, `calendars.remoteName`, `events.exceptionDates`, `events.recurrenceId`, `events.recurrenceRule`, `events.timeZone`. Without them the internet-accounts features do not work on production data.

Decision: the seed gains an additive reconcile for already seeded tenants: properties and relation definitions of system (module-owned, schema-locked) databases that the current seed defines and a tenant lacks are created with the seed's definition (key, name, type, owner, owner process, config, relation cardinality and both sides). Nothing existing is changed or removed. Values of existing items are not written; readers already treat a missing value as the seed default (`mailEnabled` unset reads as on, `calendarsEnabled` as off, the new Event and Calendar fields as null).

## Task

Load `state-writes`, `db-migrations`, `error-handling`, `canonical-keys`, `testing` and `adr-conventions`.

1. Make the seed definitions of system databases usable as data (key, properties with their full definition, relation definitions) without running the creating code, or add a reconcile pass that reuses the seed's definition helpers in a "create if missing" mode. Choose the form that keeps one source of truth for each definition.
2. In the seed CLI (`runSeedCli.js` and the code it calls), for a tenant that is already seeded, run the reconcile for every system database: create each missing property and relation definition through the same choke-point/schema writes the seed uses, in one transaction per tenant, under the seed's existing locks. Log the count of created definitions per tenant with fixed tags only.
3. A property that exists with a different type, owner or config is not changed; it is reported (fixed tag, keys only) and the CLI exits non-zero only with an explicit `--strict` flag.
4. Teach `deploy/scripts/cutover-dry-run.sh` to run the reconcile between load and seed and to report the seed delta after it; a carried v0.1.12-shaped dump then reports no delta (exit 0 instead of 3).
5. Update `docs/architecture/migrations-and-seeding.md` with the additive seed reconcile rule and `docs/operations/production-cutover-to-develop.md` (option 1 taken, procedure step, go/no-go row for the seed delta).

## Touches

- backend/packages/data/src/seed/ (reconcile and definition reuse)
- backend/packages/data/src/db/runSeedCli.ts
- deploy/scripts/cutover-dry-run.sh
- docs/architecture/migrations-and-seeding.md
- docs/operations/production-cutover-to-develop.md
- backend/packages/data/src/__tests__/seedReconcile.test.ts (new)

## Scope

### In scope

- Additive reconcile of system property and relation definitions for seeded tenants, the CLI integration and the dry-run step.

### Out of scope

- Backfilling item values.
- Removing or changing existing definitions (forward-only expand/contract migrations).
- Running anything against production (owner).

## Acceptance criteria

- A tenant seeded by an older seed that lacks the 11 listed properties has all of them after the seed CLI runs, with the same definitions as a freshly seeded tenant, and its existing items and values are unchanged.
- Running the seed CLI twice creates nothing the second time.
- A property with a conflicting definition is left unchanged and reported; `--strict` makes the CLI fail.
- The cutover dry run against a v0.1.12-shaped dump reports no seed delta and exits 0.
- Tenants are reconciled independently: one tenant's failure rolls back only that tenant and is reported.
