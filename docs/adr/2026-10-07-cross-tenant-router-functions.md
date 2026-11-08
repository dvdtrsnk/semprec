---
status: accepted
date: 2026-10-07
area: [backend]
supersedes: []
superseded-by: null
---

# Cross-tenant lookups go through router-owned SECURITY DEFINER functions

## Context

Tenant tables sit under a RESTRICTIVE row-level security policy keyed on `app.tenant_id`. Some
requests arrive with no tenant yet and carry only an external identifier that names one: a Microsoft
Graph webhook's `subscriptionId`, later a Gmail Pub/Sub address. With two tenants, or under strict
tenant scope, a plain lookup under any runtime role finds nothing, so the identifier cannot be
mapped to its tenant. The DDL functions of
[[2026-09-27-runtime-ddl-through-security-definer-functions]] are owned by the migrating superuser
and so cannot serve here: a superuser owner ignores column-level limits.

## Decision

An external identifier that must be mapped to a tenant before any tenant is known goes through a
`SECURITY DEFINER` function owned by the role `semprec_router`:

- `semprec_router` is `NOLOGIN` and `BYPASSRLS`.
- It has column-level `SELECT` on exactly the columns the function reads.
- The function has a pinned `search_path` and schema-qualified objects.
- `EXECUTE` is revoked from `PUBLIC` and granted to exactly one runtime role.
- The function returns only ids or numbers, never content.

The caller then enters `runInTenant(<returned tenant>)` and re-reads everything else under RLS. No
runtime role ever gets `BYPASSRLS`. The Gmail Pub/Sub address uses the same pattern: one
process-wide dispatcher routes each message to every matching mailbox in its own tenant and
acknowledges it once. Later admin aggregates (global AI spend, per-tenant counts) are router
functions too. The first one is `route_graph_subscription(text)`.

## Alternatives rejected

- **A `BYPASSRLS` runtime role.** It puts a cross-tenant reader in every process that uses it.
- **A global routing table copying tenant keys out of RLS.** It is a second writer that has to be
  kept in sync by hand.
- **Superuser-owned definer functions.** Column limits do not apply to a superuser owner.

## Consequences

- Every router function needs its own migration, a row in `docs/operations/database-roles.md`, and
  a privilege test.
- A router function can only reveal what its returned ids reveal; anything else is read under RLS
  after entering the tenant.
