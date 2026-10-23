---
status: accepted
date: 2026-10-05
area: [backend]
supersedes: []
superseded-by: null
---

# Tenant scope propagation

## Context

[[2026-10-03-tenant-isolation-through-row-level-security]] makes Postgres enforce tenant isolation
from the `app.tenant_id` setting, read by `app_current_tenant()`. Nothing set that setting, and
nothing in the code knew which tenant it was working for. Every later piece of tenancy work
(authentication, listeners, the queue, per-tenant fan-out) has to say "this work is for tenant T",
and that statement has to reach the database on every connection the work uses.

## Decision

**Scope API** (`@semprec/shared`, `tenantScope.ts`), carried in an `AsyncLocalStorage`:

| Current scope | `runInTenant(T)` | `runAsSystem(r)` |
|---|---|---|
| none | enters T | enters system `r` |
| system | enters T | enters system, the inner reason wins |
| tenant T | runs `fn` | `TenantScopeConflictError` |
| tenant U | `TenantScopeConflictError` | `TenantScopeConflictError` |

`runInTenant` accepts only a canonical UUID. A system scope reads as no tenant in Postgres, and it
cannot be used to leave one tenant for another. `runDetachedAsSystem` starts a fresh system scope
regardless of the current one; it exists only for opening shared I/O resources (below), never to run work.

**Pool paths** (`createPool`, `withTransaction` in `db/pool.ts`). With a scope active, the GUC
`app.tenant_id` is set to the tenant id (`''` for system):
- `withTransaction` runs `set_config(..., true)` right after `BEGIN`, for every isolation level;
- `pool.query` (promise forms) runs `BEGIN`, a transaction-local `set_config`, the statement and
  `COMMIT` on one client;
- `pool.connect()` sets the GUC for the session, and the client's `release` resets it before
  returning to the pool. A failed reset destroys the connection.

Without a scope, all three paths behave as before. `withTransaction` already has `BEGIN`/`COMMIT`,
so it pays one extra statement (`set_config`); `pool.query` wraps the statement in a transaction
solely to make the GUC transaction-local, so it pays three (`BEGIN`, `set_config`, `COMMIT`).

**Modes.** `enforceTenantScope(site)` runs at every access site. `SEMPREC_TENANT_SCOPE` is read on
each call: unset, empty or `warn` logs `tenant_scope_missing` (`site`, `stack`) once per distinct
stack and continues; `strict` throws `TenantScopeMissingError` before any connection is taken. The
default moves to `strict` once every entry point enters a scope.

**Containment rules.**
- Long-lived loops, listeners and registries start inside `runAsSystem` and re-enter a tenant
  explicitly per message or job.
- Tenant identity never comes from request bodies, model output, or headers set by untrusted callers.
- `AsyncLocalStorage.enterWith` is never used; only `run`. `enterWith` mutates the current execution
  context in place, so the scope would leak back into the surrounding async context instead of
  being confined to the callback, letting one request's tenant bleed into unrelated continuations.
- Physical connections are opened inside `runDetachedAsSystem`. A socket's callbacks run in the
  async context that opened it, so a pooled connection first opened inside one request's tenant
  would otherwise deliver its `LISTEN` notifications and errors in that tenant for its whole life.

**Autocommit `pool.query` and `runAfterCommit`.** The scoped `pool.query` is a single-statement
transaction opened inside `pool.ts`. Its client never escapes, so no `runAfterCommit` callback can
attach to it; this does not weaken
[[2026-09-29-withtransaction-is-the-sole-transaction-opener]], which stays in force for every
transaction a caller can see.

## Alternatives rejected

An explicit tenant database handle passed on every call. It touches nearly every file and every
in-flight issue, and it would still need a runtime guard for call sites that bypass it.

## Consequences

- Entering a scope is the caller's job; later issues add it at each entry point.
- A scoped `pool.query` costs three extra round trips (`BEGIN`, `set_config`, `COMMIT`); a scoped
  `pool.connect()` checkout costs two (`set_config`, `RESET`).
- Callback-form `pool.query` is not scoped per statement; its checkout goes through the scoped `connect`.
