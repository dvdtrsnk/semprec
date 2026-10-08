---
status: accepted
date: 2026-10-08
area: [backend, cross-cutting]
supersedes: []
superseded-by: null
---

# Deploy-time tenant work runs as the runtime role

## Context

The deploy runs the seed under `SEMPREC_MIGRATE_DATABASE_URL`, which authenticates as the role that
owns the tables. Row-level security ([[2026-10-03-tenant-isolation-through-row-level-security]]) does
not apply to an owner, so every "already seeded?" read, `getDatabaseByModuleId` and `module_migrations`
check made under it sees all tenants. Every tenant needs its own system databases, so the seed must
decide per tenant. [[2026-10-06-system-work-fans-out-per-tenant]] covers scheduled sweeps over `active`
tenants only; a deploy must also finish `provisioning` tenants and keep `suspended` tenants' data shape
current.

## Decision

1. Deploy-time steps that read or write tenant rows run once per tenant, inside that tenant's scope, on
   a pool created with `createPool(url, { role: "semprec_data" })`. The connection logs in as the
   migrating role and runs `SET ROLE semprec_data` through the startup option, so RLS applies.
   `forEachMaintainedTenant` enumerates `provisioning`, `active` and `suspended` tenants (never
   `deleting`), continues past a failing tenant and throws one `AggregateError` naming the failures.
2. `provisionTenant` refuses a role RLS does not apply to (`assertRowSecurityActive`) before writing
   anything, so a misconfigured caller fails closed instead of seeing every tenant.
3. The migrating role keeps only DDL and schema-guarded global steps. Anything that reads or writes
   tenant rows moves to a per-tenant step on the runtime-role pool.

## Consequences

- The seed's advisory lock is `(2331, hashtext(tenant id))`, so tenants seed independently.
- A `provisioning` tenant becomes `active` only after its seed and module data migrations succeed.
- Other deploy-time steps that touch tenant rows (module data migration locks, post-migration cutovers)
  adopt the same pattern in their own issues.
- `forEachMaintainedTenant` and `forEachActiveTenant` differ deliberately in the statuses they visit.

## Alternatives considered

- **Running the seed as the owner with an explicit tenant filter in every query.** One missed filter
  leaks across tenants, and nothing fails closed.
- **Reusing `forEachActiveTenant`.** It skips `provisioning` tenants, which the deploy must finish.
