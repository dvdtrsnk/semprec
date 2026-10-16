---
status: accepted
date: 2026-10-16
area: [backend]
supersedes: []
superseded-by: null
---

# A column-tightening cutover backfills as the owner, in one transaction

## Context

[[2026-10-08-deploy-time-tenant-work-runs-as-the-runtime-role]] item 3 moves every deploy-time step
that reads or writes tenant rows to a per-tenant step on a `semprec_data` pool, and keeps only DDL and
schema-guarded global steps on the migrating role. `runTenantCutoverMigrations` does this for the
cutovers that only rewrite data.

`runAgentRunsActorUserIdCutoverMigration` is different. Its last statement is DDL,
`ALTER TABLE agent_runs ALTER COLUMN actor_user_id SET NOT NULL`, and the backfill before it exists only
so that DDL can succeed. Issue #1020 replaced its earliest-account fallback with a set-based backfill
that attributes each run to the user of its own tenant, and prescribed running it as the table owner.

A per-tenant split does not work for this step:

- `semprec_data` does not own `agent_runs`, so it cannot run the `SET NOT NULL`. That statement has to
  run on the owner pool, in a different session from any per-tenant backfill.
- The cutover takes `LOCK TABLE agent_runs IN EXCLUSIVE MODE` so that no row can be inserted with a NULL
  actor between the backfill and the `SET NOT NULL`. Split across sessions, that lock is released
  between the two, and the gap it closes reopens.
- The column constraint covers the whole table. One tenant that cannot be backfilled leaves the column
  nullable for every tenant either way. "Continue past a failing tenant" would commit other tenants'
  backfill without reaching the only outcome the step exists for.

## Decision

1. A post-migration cutover whose final statement is DDL that constrains a tenant table as a whole
   (here `SET NOT NULL`) may backfill that table on the migrating (owner) pool. The backfill, the
   remaining-row check and the DDL run in one transaction that holds a lock excluding concurrent
   inserts.
2. Every statement in that backfill that reads a value from any row other than the target row joins
   that source row to the target row by explicit `tenant_id` equality. This covers joins to another
   table (`u.tenant_id = r.tenant_id`) and the target table's own self-joins alike
   (`child.tenant_id = parent.tenant_id`), including a self-join through a foreign key such as
   `parent_run_id` that carries no tenant. This filter is the only thing that confines the step to each
   row's own tenant, because row-level security does not apply to the owner.
3. The step fails as a whole. If any row cannot be backfilled, it throws and the transaction rolls back,
   so no tenant's rows change and the column stays nullable.
4. Cutovers that only rewrite data, with no table-wide DDL to finish, still follow
   [[2026-10-08-deploy-time-tenant-work-runs-as-the-runtime-role]] item 3.

## Consequences

- `runAgentRunsActorUserIdCutoverMigration` stays on the owner pool in `runMigrationsCli.ts` and
  `globalSetup.ts`.
- A deploy with a NULL-actor run in a tenant that has no user fails the cutover for every tenant until
  that tenant has a user or the run is removed.
- A missing `tenant_id` join in such a backfill is not caught by row-level security. Its test has to
  cover at least two tenants, for every join the backfill makes, a same-table self-join included: a
  source row in one tenant and a target row in another must not exchange a value.

## Alternatives considered

- **Per-tenant backfill on `semprec_data`, then an owner-pool `SET NOT NULL`.** The lock does not span
  the two sessions, and per-tenant progress cannot tighten the column for anyone.
- **Granting `semprec_data` ownership or `ALTER` on `agent_runs`.** It would let the runtime role change
  the schema of a tenant table, which no other decision allows.
