---
status: accepted
date: 2026-10-17
area: [backend]
supersedes: []
superseded-by: null
---

# The admin role manages accounts and never reads tenant content

## Context

Every user owns one tenant ([[2026-10-03-tenant-isolation-through-row-level-security]]), and an
operator needs to manage accounts, invitations, AI caps and operational health. Authentication alone
gates every adapter route, so without a decision an admin feature could read a tenant's items or act
as that tenant's user. Tenant scope is propagated through `runInTenant` and `runAsSystem`
([[2026-10-05-tenant-scope-propagation]]).

## Decision

- **Role and gate.** Admin is `users.role = 'admin'`. A route opts in with `admin: true` on its
  `RouteDefinition`; `createAdapterRequestListener` then answers a caller whose role is not `admin`
  with `403 { error: { code: "admin_required" } }` after authentication and before the body is read.
  `mountRoutes` throws at construction for any `/api/admin/` path without the flag, so a forgotten
  flag fails at startup rather than leaving an open route. Members always get `admin_required`.
- **System scope, no content.** An admin route's body parsing, parameter extraction and handler run
  in `runAsSystem("adminRoute", …)`, never in `runInTenant`. Admin handlers read global tables and
  `semprec_router` aggregate functions only, never tenant rows, and there is no impersonation route.
- **Sanctioned exception.** Account deletion's data-layer function (#1049, outside the
  ESLint-restricted files) enters the target tenant only for the deletion transaction (status,
  revocations, deleting the tenant's key row) and reads no tenant content.
- **Import restriction.** `eslint.config.mjs` forbids importing `runInTenant` from `@semprec/shared`
  in `adminHandler.ts` and `accountsAdminStore.ts`. dependency-cruiser rules are file-level and
  `@semprec/shared` resolves to the single entry file `src/index.ts`, so a rule cannot forbid one
  named export; ESLint's `no-restricted-imports` with `importNames` can.
- **Audit log.** `admin_audit_log` is append-only for the runtime roles (`semprec_data` has `INSERT`,
  `semprec_side` has `SELECT`; nobody has `UPDATE` or `DELETE`), holds ids and scalars only (no
  content, no email address) and has no foreign keys, so rows outlive deleted users and tenants.
  `recordAdminAction` inserts on the caller's own client, so the row commits or rolls back with the
  mutation it records.

## Consequences

- Every admin mutation issue calls `recordAdminAction` inside its transaction and adds its action to
  `ADMIN_AUDIT_ACTIONS`.
- The restriction covers the two named files only; an admin store in another file needs its own entry
  in the ESLint override.
- The audit log is not tamper-proof against a database superuser or the table owner.
