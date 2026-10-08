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
   migrating role and the pg startup option `-c role=semprec_data` makes `semprec_data` the session's
   role from the moment the socket opens, so RLS applies to every statement, including any a
   connection-init hook or pooled `connect()` would otherwise run before an application-issued
   `SET ROLE`. `RESET ROLE` returns to that startup value rather than to the owner. It is not a
   hard lock: a statement can still issue `SET ROLE`, which is why item 2 verifies the effective role.
   The option is typed as the literal union `"semprec_data"` because that is the only role the
   migrating login is granted membership in for this purpose; a new role needs its own decision.
   Callers that must use a role-scoped pool: the seed CLI (`runSeedCli`) and every deploy-time
   per-tenant step (`provisionTenant`, `forEachMaintainedTenant` bodies). Request-serving and
   worker pools log in as the runtime role directly and do not need it.
   `forEachMaintainedTenant` enumerates `provisioning`, `active` and `suspended` tenants (never
   `deleting`), continues past a failing tenant and throws one `AggregateError` naming the failures.
2. `provisionTenant` refuses a role RLS does not apply to (`assertRowSecurityActive`) before writing
   anything, so a misconfigured caller (a plain owner pool, or a superuser) fails closed instead of
   seeing every tenant. This runtime check is the guarantee for callers that pass an unsupported pool.
3. The migrating role keeps only DDL and schema-guarded global steps. Anything that reads or writes
   tenant rows moves to a per-tenant step on the runtime-role pool.

## Consequences

- The seed's advisory lock is `(2331, hashtext(tenant id))`, so tenants seed independently.
- A `provisioning` tenant becomes `active` only after its seed and module data migrations succeed.
- Other deploy-time steps that touch tenant rows (module data migration locks, post-migration cutovers)
  adopt the same pattern in their own issues.
- `forEachMaintainedTenant` and `forEachActiveTenant` differ deliberately in the statuses they visit.

## Alternatives considered

- **`SET ROLE` per session or `SET LOCAL ROLE` per transaction.** Needs a hook on every checkout and
  transaction path, and a path that misses it silently runs as the owner; the startup option covers
  the whole pool by construction.

- **Running the seed as the owner with an explicit tenant filter in every query.** One missed filter
  leaks across tenants, and nothing fails closed.
- **Reusing `forEachActiveTenant`.** It skips `provisioning` tenants, which the deploy must finish.
