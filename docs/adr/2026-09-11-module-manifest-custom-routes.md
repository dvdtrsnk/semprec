---
status: accepted
date: 2026-09-11
area: [backend]
supersedes: []
superseded-by: null
---

# Named custom routes are declared in a module manifest, never hand-wired into app.ts

## Context

Issue #238 establishes the generic REST adapter and the item model it serves
(`GET`/`POST`/`PATCH /api/items`, the relation endpoint, `confirm`/`revise`).
A handful of existing endpoints don't fit that shape at all: `POST
/api/proposals/:id/confirm` has its own transactional semantics beyond a
generic item write, `GET /api/inbox-types` and `GET /api/ai-usage` are read
shortcuts shaped for exactly one consumer, and `POST /api/push-subscriptions`
binds a new row to the caller's session in the same transaction as its
upsert. Before this issue, each of these was its own hand-wired
`createXRequestListener` imported and prefix-routed directly inside
`services/semprec-api/src/app.ts`, with no structural link back to the
module that owns the underlying data, and no check preventing two modules
from silently claiming the same path.

The alternative considered was to keep growing `app.ts`'s hand-wired list:
cheap in the short term, but it lets any module reach into `semprec-api` and
claim any path with no ownership record, no collision check, and no
structural signal distinguishing "route with real transactional semantics"
from "CRUD over module data that should have gone through the generic item
endpoints instead."

## Decision

A module manifest may declare `customRoutes`: named entries with an HTTP
method, a path under `/api`, a handler export, and one of exactly two
justifications — `transactional-semantics` or `single-consumer-read`. Zod
validation rejects any entry missing a justification or using a third value.
`ModuleRegistry` mounts these the same way it mounts every other manifest
declaration — resolving `handlerExport` to the module's actual export at
`loadModule` time — and rejects, at startup, two modules claiming the same
method+path, naming both owning module ids in the failure. `semprec-api`
resolves the active set through `getCustomRouteDefinitions()` and mounts each
one through the same shared adapter (`createAdapterRequestListener`) every
generic route uses: authentication, request validation, status mapping, and
the closed error contract are not reimplemented per route.

The two justifications are deliberately the only two. A custom route is an
escape hatch for a shape the generic item model can't express, not a way to
avoid using it — CRUD over module data belongs on the generic endpoints,
never behind a custom route.

## Consequences

- Every custom route has one, and only one, owning module, checked the same
  way cross-module identifier collisions already are (agent tool names,
  worker names, catalog keys) — a collision is a startup crash, not a
  runtime 404 or a silently-shadowed route.
- A module cannot add a custom route without stating why the generic item
  endpoints don't cover its case; a reviewer (human or automated) checks that
  justification against the two allowed values, not free-form prose.
- `app.ts` no longer hand-imports a listener per exception; it mounts
  whatever the active module set declares, so adding or removing a custom
  route is a manifest change, not an `app.ts` change.
- This does not replace or loosen `docs/adr/2026-09-10-choke-point-api-for-state-writes.md`:
  a custom route's handler still may not write item/database state outside
  the choke point it wraps.
