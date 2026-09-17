---
status: accepted
date: 2026-09-17
area: [backend]
supersedes: []
superseded-by: null
---

# Two-tier runtime Postgres roles: semprec_data vs. semprec_side

## Context

Every write to item/database state must go through the generic choke-point
API (`backend/packages/data/src/chokePoint/`). That rule is enforced today by
code review and by the choke-point being the only code path that calls the
relevant store functions — nothing stops a bug, or a future service, from
opening its own pool against the choke-point tables (`databases`,
`properties`, `relation_definitions`, `items`, `item_relations`, `views`,
`view_items`, `idempotency_keys`, `rollup_dependencies`) and writing them
directly.

Only one service, `semprec-api`, hosts the choke-point. Every other service
that exists or is planned (`semprec-ai-gateway` today; `semprec-agents`,
`semprec-mailsync`, `semprec-transcribe` later) only ever needs to read the
choke-point tables and read/write its own module side tables and the queue.

## Decision

Connect every service to Postgres as one of two roles, matching the
connection string it is handed:

- **`semprec_data`** — full DML on the choke-point tables, and (via role
  membership) everything `semprec_side` can do. Handed only to `semprec-api`,
  the sole choke-point host, so it can complete a full choke-point
  transaction and its own same-process side-table writes.
- **`semprec_side`** — `SELECT`-only on the choke-point tables, full DML on
  every module side table, and full access to the queue (`graphile_worker`
  schema). Handed to every other service. An `INSERT`/`UPDATE`/`DELETE`
  against a choke-point table under this role fails at the database, so a bug
  that tries to bypass the choke-point from a non-`semprec-api` service is
  caught by Postgres itself, not just by review.

Roles and grants are delivered as an additive migration
(`backend/packages/data/src/db/migrations/0040_least_privilege_roles.sql`);
`semprec_side`'s grant on the queue schema is wired separately, from
application code (`ensureQueueSchema`/`grantQueueSchemaPrivileges` in
`backend/packages/queue/src/index.ts`), because `graphile_worker`'s schema
does not exist until `ensureQueueSchema` creates it — see
`docs/adr/2026-09-10-app-code-post-migration-steps.md` for the pattern of
invoking that kind of step from both `runMigrationsCli.ts` and
`testSupport/globalSetup.ts`.

A new choke-point or side table must extend both grant lists in the same
migration that creates it — there is no default-privilege rule doing this for
tables outside the queue schema, by design, so adding a table is always a
visible, reviewable grant.

## Consequences

- A service is given exactly one of the two connection strings, chosen by
  whether it hosts the choke-point. `semprec-api`'s `.env.example` documents
  `semprec_data`; every other service's documents `semprec_side`.
- The `semprec_data` connection string must never be handed to a service
  other than `semprec-api` — doing so would re-open the direct-write bypass
  this decision exists to close.
- Every future service that does not host the choke-point connects as
  `semprec_side`, without needing a new role or a new ADR.
