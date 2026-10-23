---
status: accepted
date: 2026-10-08
area: [backend]
supersedes: []
superseded-by: null
---

# Per-tenant queue lanes

## Context

Graphile Worker runs jobs that share a `queue_name` one at a time and jobs without one in parallel, up
to the worker's concurrency. Inbox ticks were serialized on one global queue, `semprec-tick`, and bulk
work (rollup recompute and backfill, property type migration, transcription) had no queue at all. With
several tenants ([[2026-10-03-tenant-isolation-through-row-level-security]],
[[2026-10-05-tenant-scope-propagation]]), one tenant's tick backlog would delay every other tenant's
ticks, and one tenant's bulk jobs could occupy every worker slot.

## Decision

Serialized work and bulk or heavy work run on a `<lane>:<tenantId>` queue. The name comes from
`tenantLane(lane)` (`backend/packages/data/src/tenancy/tenantLane.ts`), which reads the enqueuing
scope and never payload data. A task of either kind picks a lane when it is added.

Lanes created so far: `semprec-tick` (Inbox ticks), `rollup-recompute` (per-cell), `rollup-backfill`
(separate so a running backfill does not hold back per-cell recomputes), `property-type-migration`
and `transcription`.

Outside a tenant scope (system scope or none) `tenantLane` returns `undefined` and the enqueue keeps
today's naming: the global `semprec-tick` name for ticks, no queue name for bulk work. Fallback keeps
scope-less producers working during the transition.

## Consequences

- Within one tenant, serialization is unchanged; across tenants, lanes run independently.
- Jobs queued before deploy keep their old queue name and drain; no job migration. A tick running on
  `semprec-tick` at deploy time can briefly race a new-lane tick for the same Inbox item, and a
  rollback opens the same window in reverse. Both are accepted.
- Job keys are unchanged.

## Rejected alternatives

- Taking the tenant from the job payload: payload data is not a trusted tenant source.
- Rewriting the queue name of already queued jobs: not worth a migration for a drain-out window.
