---
status: accepted
date: 2026-09-17
area: [backend]
supersedes: []
superseded-by: null
---

# packages/shared mirrors, rather than imports, packages/data's row types

## Context

Issue #252 introduces `packages/shared/src/genericOperations`: a
transport-independent catalog of schemas, a port, and bindings for the 28
generic operations, meant to be importable by every consumer (REST in #219,
AgentTool/MCP in #220) without pulling in a concrete implementation package.

The row and result shapes that catalog's port returns —
`Database`/`Property`/`View`/`Item`/`RelationEdge` and `PROPERTY_TYPES` —
already exist as the authoritative types in `packages/data/src/types.ts`,
which is where `@semprec/data`'s choke-point implementation defines them.

`packages/shared/src/genericOperations/rows.ts` does not import those types
from `packages/data`. It re-declares equivalent shapes by hand, kept in sync
manually, with `Item` pinned verbatim to this issue's Task and `RelationEdge`
pinned to issue #82. Until now this constraint was documented only in a code
comment at the top of `rows.ts`, with nothing enforcing it and no ADR
recording why the duplication is deliberate rather than an oversight.

## Decision

`packages/shared` never imports `packages/data`. Row/result shapes that
`packages/shared/src/genericOperations` exposes are maintained as
hand-written mirrors of `packages/data`'s types, not as re-exports or
type-level imports of them.

This is enforced statically: `backend/dependency-cruiser.rules.json` carries
a `no-shared-data-import` rule forbidding any import from
`^packages/shared/` to `^packages/data/`, alongside the existing
`no-shared-services-import` rule that forbids `packages/shared` from
importing a `services/*` composition root.

The alternative — importing `packages/data`'s types directly — was rejected
because `packages/data` is a concrete implementation package (the choke-point
SQL layer), and importing it would make the transport-independent operation
catalog depend on a specific implementation. That defeats the catalog's
purpose: it must stay importable by every consumer, including a future
consumer that does not use `packages/data`'s choke-point at all, without
bundling that package's runtime dependencies (its SQL client, connection
pooling, etc.) into callers that only need the shapes.

## Consequences

- `packages/shared`'s row/result types and `packages/data`'s row types must
  be kept in sync by hand whenever one changes. A change to a core row shape
  in `packages/data/src/types.ts` requires a matching manual edit to
  `packages/shared/src/genericOperations/rows.ts` in the same pull request;
  nothing catches a drift automatically beyond code review and the type
  errors it would eventually cause at each shape's actual call sites.
- The dependency-cruiser rule makes the "don't import" half of the
  constraint mechanical: a future edit that reaches for
  `packages/data`'s types out of convenience fails CI instead of silently
  reintroducing the dependency the catalog exists to avoid.
- This is deliberately narrow: only `packages/shared` → `packages/data` is
  forbidden. `packages/data` may still depend on `packages/shared` (e.g. to
  validate against Shared's schemas), and other `packages/*` are unaffected.
