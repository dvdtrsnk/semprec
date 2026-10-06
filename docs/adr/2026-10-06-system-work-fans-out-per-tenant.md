---
status: accepted
date: 2026-10-06
area: [backend]
supersedes: []
superseded-by: null
---

# System work fans out per tenant

## Context

Every scheduled sweep (heartbeat, doc compaction and history cleanup, trash purge, run-event
retention, MCP credential expiry, the mail sweeps, the observability check) runs once over the whole
database. Row-level security ([[2026-10-03-tenant-isolation-through-row-level-security]]) hides every
tenant row unless the current tenant matches. During the transition a scope-less or system-scope query
falls back to the sole tenant; once enforcement is strict, system scope sees no tenant rows at all. A
sweep must therefore visit each tenant in that tenant's own scope, using the scope primitives of
[[2026-10-05-tenant-scope-propagation]]. Sweeps already commit in chunks and stop at a per-tick cap
([[2026-09-28-chunked-transactions-for-large-background-sweeps]]) and re-select their due rows by
predicate, so re-running a sweep for a tenant that already succeeded is safe.

## Decision

Scheduled system work runs in a system scope, enumerates active tenants with `forEachActiveTenant`
(`backend/packages/data/src/tenancy/forEachActiveTenant.ts`) and does its existing per-tenant work
inside `runInTenant`, sequentially, starting at a rotating offset so no tenant is always first. One
tenant's failure never skips the others: each failure is logged with its `tenantId` and collected, and
after the loop the original errors are rethrown as one `AggregateError`, so the job fails and
graphile-worker retries it.

## Consequences

- Each sweep keeps its own per-tenant chunk cap, so one tenant's backlog delays the others by at most
  one chunk. Each sweep's conversion owns that cap.
- Suspended, provisioning and deleting tenants are skipped.
- Calling the helper from inside a tenant scope throws `TenantScopeConflictError`.
- Cross-tenant identifiers and operator aggregates do not fan out; they go through router functions.

## Rejected alternatives

- **A runtime role with `BYPASSRLS` sweeping all tenants at once.** One bug becomes a full
  cross-tenant leak.
- **One queued job per tenant per tick.** More queue rows and contention for no isolation gain over a
  per-tenant transaction.
