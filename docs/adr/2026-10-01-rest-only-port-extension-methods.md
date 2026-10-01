---
status: accepted
date: 2026-10-01
area: [backend]
supersedes: []
superseded-by: null
---

# REST-only extension methods on `GenericApplicationPort`

## Context

Issue #789 needs `PATCH /api/properties/:id` to resolve the patched
property's owning `Database` row (for catalog/locale resolution) using the
exact row the patch transaction itself just read and wrote, not a second,
independently-committed `database.get` read taken after the patch has
already returned. [[2026-09-17-generic-application-service-port]] put every
invariant that must be checked atomically against persisted state in the
choke-point's own transaction; by that same reasoning, a result that must
reflect that transaction's own view of a row cannot be assembled from two
separately-dispatched catalog operations (`property.patch` then
`database.get`) without reopening the gap between them that the choke-point
boundary exists to close.

[[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]]
established "one dispatch path, three transports": every transport
(REST, MCP, AgentTool) calls the same `GenericApplicationPort` operation set
through `dispatchGenericOperation`, and no transport gets a parallel
business-logic path. `patchPropertyWithDatabase`, added to
`GenericApplicationPort` and called directly by
`services/semprec-api/src/propertiesHandler.ts` instead of through
`dispatchGenericOperation`, is a new shape neither ADR anticipated: a port
method that exists to serve one transport's response shape and is never
reachable from the catalog's 29 dispatchable operation names. Left
undocumented, nothing would stop a future port method like this from
drifting into an uncontrolled escape hatch — skipping input validation,
returning catalog results to MCP/AgentTool, or becoming the default way to
avoid adding a real catalog operation.

## Decision

A `GenericApplicationPort` method may exist outside the closed catalog only
to aggregate two or more catalog operations' results from a single
choke-point transaction, when the caller's response shape needs a row read
inside that transaction and a second, separately-dispatched catalog call
would read it outside that transaction's commit boundary. Such a method
must satisfy every one of:

- **REST-only.** Only a `services/semprec-api` REST handler calls it
  directly; `mcpHandler.ts` and the AgentTool composition root never call a
  catalog-external port method — they only ever call
  `dispatchGenericOperation` against the 29 named operations. Its doc
  comment states this scope explicitly, the way
  `patchPropertyWithDatabase`'s does.
- **Validated the same way the catalog would.** The REST handler validates
  its input with `parseOperationInput` against an existing catalog
  operation's own Zod schema (`GENERIC_OPERATION_BINDINGS`) before calling
  the port method — never a hand-rolled or looser check.
- **Implemented by composing existing choke-point calls, not a new write
  path.** The service's implementation (`genericApplicationService.ts`) must
  call the same `packages/data` choke-point method(s) the equivalent catalog
  operation(s) already call (directly, or a choke-point method that itself
  extends one of them to read the extra row in the same transaction), never
  a parallel SQL path the catalog doesn't also use.
- **Named after the catalog operation it extends**, suffixed with what it
  adds (`<operation>With<Extra>`), so the relationship to the catalog
  operation it stands in for is visible at the call site and in the port
  interface.

This is a narrow exception for transaction-scope coupling the catalog's
operation-per-call contract can't express, not a general escape hatch from
the catalog: a new transport-exposed capability, or a result shape that
doesn't come from composing existing choke-point calls, still needs a real
catalog operation. "One dispatch path, three transports" continues to hold
for everything reachable from MCP or AgentTool — a catalog-external port
method is reachable from neither.

## Consequences

- `patchPropertyWithDatabase` is the first instance of this pattern; its
  existing doc comment on `GenericApplicationPort` already states the
  REST-only scope this ADR formalizes.
- A reviewer checking a new `GenericApplicationPort` method against the
  closed catalog can cite this ADR's four conditions instead of re-deriving
  them; a method that fails any of them belongs in the catalog as a real
  operation instead.
- If a second transport (beyond REST) ever needs the same aggregated result
  shape, that is a sign that the aggregation belongs as a real catalog
  operation rather than a REST-only extension, since this pattern is only
  justified while exactly one transport needs the shape.
