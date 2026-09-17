---
status: accepted
date: 2026-09-17
area: [backend]
supersedes: []
superseded-by: null
---

# A neutral GenericApplicationPort layer between transports and the choke-point

## Context

Issue #252 turned the 28-operation generic catalog into transport-independent
data in `packages/shared`: the closed operation names, strict Zod input
schemas, the `GenericApplicationPort` interface, `GENERIC_OPERATION_BINDINGS`,
and the `AuthenticatedActor` shape. Nothing implemented the port or called
into it yet.

Issue #219 gives the port its first implementation and its first caller
(`semprec-api`'s REST adapter). Issue #220 adds a second caller (AgentTool/MCP)
over the same descriptors. Without a documented layer boundary, an
implementer under either issue could plausibly have each transport adapter
call `packages/data`'s choke-point directly per operation, duplicating command
assembly and validation per transport, or could fold the port's logic into
`semprec-api` itself, making it unavailable to a future non-REST transport
without extracting it later under time pressure.

## Decision

`packages/application/src/genericApplicationService.ts` is the sole
implementation of `GenericApplicationPort`. It is a neutral, transport-ignorant
package (`core-knows-nobody` in `dependency-cruiser.rules.json`): it imports
only `packages/data`'s public choke-point facade (`createChokePoint`) and
`packages/shared`'s types, never a store, SQL, or anything from a
`services/*` transport. It is not owned by `semprec-api`: `semprec-api`
imports from `packages/application`, never the reverse.

A composition root constructs exactly one instance per injected `Pool`
(`createGenericApplicationService(pool)`) and threads that single instance
through every binding dispatch it makes for the lifetime of the process.
`semprec-api`'s `app.ts` is the first composition root; #220's AgentTool/MCP
composition root will construct and own its own instance the same way, over
its own injected `Pool` — there is exactly one execution path into the
28-operation catalog's business logic per process, never a second write path
around it.

Ownership split between the two layers:

- **The service (`genericApplicationService.ts`) owns**: mapping each
  operation's already-validated input onto the choke-point calls it takes to
  satisfy it (including multi-call operations like the relation branch of
  `createProperty`), actor-shape translation (`AuthenticatedActor` →
  `packages/data`'s `Actor`), and the handful of input-shape rejections that
  are about the operation's own contract rather than persisted state (e.g.
  empty-patch rejection).
- **The choke-point (`packages/data`) owns**: everything that has to be
  atomic against persisted state — idempotency, event emission, ownership and
  locked/archived enforcement, and any invariant that must be checked against
  the same transaction that performs the write it protects. A service-level
  read followed by a separate choke-point write call is not equivalent: the
  row can change between the two, letting a concurrent write slip past a
  check that appeared to guard it. The service must never split a guarded
  write into a pre-check call plus a write call; the choke-point method
  itself re-checks the invariant against the row its own transaction just
  fetched.

A transport adapter's own responsibility stops at assembling a canonical
command object from its own request shape (route params, query, headers,
body for REST; tool-call arguments for AgentTool/MCP) and validating it with
the binding's own Zod schema before dispatch — it never re-implements a
business rule the service or choke-point already owns.

## Consequences

- `packages/application` has no dependency on any `services/*` package; the
  same instance-per-`Pool` construction pattern applies verbatim when #220
  adds its own composition root, without needing a second ADR.
- A check that gates whether a write is allowed must live in the choke-point
  transaction that performs the write, not as a separate call the service
  makes beforehand — a violation of this is a correctness bug, not a style
  preference.
- `semprec-api` (or any future transport service) must never construct its
  own `createChokePoint(pool)` for an operation the 28-operation catalog
  already covers; doing so would reopen the second-write-path this layer
  exists to close.
