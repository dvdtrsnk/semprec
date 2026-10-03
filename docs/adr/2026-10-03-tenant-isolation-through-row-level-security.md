---
status: accepted
date: 2026-10-03
area: [backend]
supersedes: []
superseded-by: null
---

# Tenant isolation through row-level security

## Context

Semprec moves from one human account per deployment to one isolated tenant per user: a tenant is one
user's complete Semprec environment, 1:1 with its user, with no sharing between users now or planned.
Until now `users` carried no role and no owner, and the only account path outside tests,
`bootstrapFirstAccount`, refuses once any user exists. This ADR records the foundation that the later
tenancy work (review rules, table classification, `tenant_id` columns, row-level security,
tenant-leading uniqueness) implements.

## Decision

**Isolation.** One shared schema, a `tenant_id` on every tenant-owned row, and Postgres row-level
security (RLS). Rejected:
- schema per tenant — migrations ×N per deploy break one-pass deploys and one-release rollback, and a
  `search_path` slip fails open;
- database per tenant — pools, `LISTEN` and crons ×N;
- application-only `WHERE tenant_id` — about 434 query sites, where one miss is a silent leak;
- an instance per user — not one system.

**Tenant entity.** A global `tenants(id, status ∈ provisioning|active|suspended|deleting, created_at,
status_changed_at)`; `users.tenant_id` is UNIQUE (1:1) and `users.role ∈ admin|member`. Rejected:
`tenant_id = user_id` (deletion must outlive the PII-bearing user row, and a tenant exists in
`provisioning` before its user can log in) and memberships (sharing is excluded).

**Fail closed, rollback safe.**
- `app_current_tenant()` is `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. The `NULLIF` is
  load-bearing: after a transaction-local `set_config` ends the placeholder reads `''`, not NULL.
- `app_sole_tenant()` is the tenant id when exactly one `tenants` row exists, else NULL.
- `app_tenant_default()` is `COALESCE(app_current_tenant(), app_sole_tenant())` during the transition.
- Every tenant table gets `tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id)`,
  RLS enabled, a RESTRICTIVE policy `tenant_isolation USING/WITH CHECK (tenant_id = (SELECT
  app_tenant_default()))` and a PERMISSIVE `tenant_rows USING (true) WITH CHECK (true)`. Restrictive, so
  no future permissive policy can widen it.
- While exactly one tenant exists, scope-less code — including the previous release — behaves as today.
  A later strict switch redefines `app_tenant_default()` as `app_current_tenant()` only, flipping every
  default and policy atomically. The functions are `STABLE` so a later `ADD COLUMN ... DEFAULT
  app_tenant_default()` is a fast default with no table rewrite.

**Guard.** `CREATE UNIQUE INDEX tenants_single_tenant_guard ON tenants ((true))`. Only the go-live
issue drops it, after a maintainer security sign-off; test databases drop it in their setup only.

**No `FORCE ROW LEVEL SECURITY`.** Tables are owned by the migrating superuser, which bypasses RLS
anyway. Instead every service asserts at startup that its role is not superuser, not `BYPASSRLS` and
owns no table, and a catalog test asserts the runtime roles hold no privilege on any `items_p_*`
partition (RLS on the partitioned `items` parent is bypassable by addressing a partition).

**Classification.** Every table carries `COMMENT ON TABLE <t> IS 'semprec:tenancy=tenant'` or
`'semprec:tenancy=global'`, written by the migration that creates it; a catalog test fails on an
unclassified table. There is no TypeScript registry.

**Uniqueness.** Every unique index on a tenant table leads with `tenant_id`, except a server-generated
surrogate key or a key scoped by the server-generated id of a parent row in the same tenant (e.g.
`properties (database_id, key)`: a collision then needs another tenant's unguessable id, and later
composite tenant-consistent foreign keys bind parent and child to one tenant). FK and unique checks
ignore RLS, so a global unique key is an existence oracle, a collision and a cross-link. Kept global:
`users.email`, token hashes, `graph_subscription_id`, push endpoint/device token, process and check keys.

## Consequences

- Decisions resting on a single human account, e.g. the earliest-user owner in
  [[2026-09-12-per-process-agent-run-watch-registry]] and
  [[2026-09-12-thin-user-scoped-realtime-invalidations]], are superseded one by one by the issues that
  change that code.
- An operator with database superuser access can read every tenant. This is accepted; there is no
  per-user content encryption.
- Migrations stay additive ([[2026-09-10-expand-contract-forward-only-migrations]]): `users.tenant_id`
  is nullable until a later contract step.
