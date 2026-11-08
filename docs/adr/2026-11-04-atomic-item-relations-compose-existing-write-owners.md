---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# An atomic item-and-relations command composes existing write owners

## Context

Gh-1590 creates an item and its initial edges atomically. Calling relationOps from itemWrites fails the existing domain-cross-import boundary. [[2026-09-24-choke-point-composed-from-domain-modules]] keeps domain modules independent and chokePoint.ts composition-only; [[2026-09-17-generic-application-service-port]] assigns atomic persisted-state orchestration to the data choke point. Moving business logic into chokePoint.ts or introducing a process-global injected writer would obscure these owners. Splitting the item and edges into separate transactions would violate gh-1590.

## Decision

Add only `chokePoint/itemCreateWithRelations.ts`, a compound-command coordinator, not another domain module or a general orchestration framework. It owns `createItemWithRelationsWithClient` and its `createItemWithRelations` section factory. The factory takes exactly `Pick<ChokePointDeps, "pool" | "queueAffinity">`, opens the existing withTransaction, calls the coordinator and applies the existing read projection. `createChokePoint` merges that factory through mergeOps; chokePoint.ts contains no new business logic and re-exports no domain symbols.

The coordinator calls the item owner's existing `createItemReportingReplay` implementation, exported internally from itemWrites without adding it to the data public barrel. That owner retains all database, property/default/transform, reservation, insert, hook and replay ordering. If it reports `created:false`, return the committed item immediately and do not validate or write the requested initial edges. For a real insert, preserve the deferred unresolved-key result, relation property/type/definition/owner and exact-one checks, then call the existing `createRelationWithClient` per target. All calls use the same supplied managed client and existing options/writer/acting user. Any failure rolls back the enclosing existing transaction and its callbacks. No new locks, admission bypass, transaction owner, before-replay lookup or partial commits are introduced.

Neither itemWrites nor relationOps imports the other or this coordinator. Existing cross-domain and import-cycle rules remain unchanged; a reverse import into this coordinator would create an already-forbidden cycle. There is no dynamic module registry, mutable global dependency or callback injection API. This is permission for the single required compound command, not for domain-to-domain imports or an unlisted shared-domain workaround.

Move the existing `InitialItemRelation` type with the command. The data public barrel keeps the same function/type names, signatures and runtime export set, sourcing them from the coordinator. Existing internal imports move to their actual owner rather than making itemWrites re-export the coordinator. The item-only facade and exported `createItemWithClient` retain their behavior; itemWrites no longer owns the compound facade.

## Consequences

The API, agent, MCP and supplied-client entry point share the same compound command and existing write owners. Existing transaction/replay/owner/cardinality/rollback/notification behavior remains binding. Check the actual unchanged dependency boundary command and existing boundary controls, plus the real runtime-role facade/public-function and adapter scenarios. Public export-list expectations and input/result schemas do not change. This adds no release, provider or production-security acceptance.
