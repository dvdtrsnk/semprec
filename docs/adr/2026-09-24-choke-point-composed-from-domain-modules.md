---
status: accepted
date: 2026-09-24
area: [backend]
supersedes: []
superseded-by: null
---

# The choke point is composed from per-domain modules

## Context

[[2026-09-10-choke-point-api-for-state-writes]] made
`backend/packages/data/src/chokePoint/chokePoint.ts` the single entry point for
item and database state writes. By September 2026 that file held every
domain's helpers plus one `createChokePoint()` returning a 660-line object
literal — over 2,000 lines in total. Parallel issues touching different domains
kept editing the same file, and one object literal gave no structure to say
which method belonged to which domain.

Splitting the file had one real alternative: keep one module and group it only
by comments, or re-export everything from a barrel so callers keep a single
import path. Both keep every domain in one place, which is what made the file
hard to change in parallel. Object spread (`{ ...a, ...b }`) was also an option
for combining sections, but a later section's method would then silently
overwrite an earlier one with the same name.

Several accepted ADRs cite `chokePoint.ts` for a helper or method. Their
bodies are immutable, so a reader following such a citation needs a map from
each declaration of the pre-split file to where it lives now.

## Decision

- **Composition through `mergeOps`.** `createChokePoint` builds one
  `ChokePointDeps` (`chokePoint/chokePointDeps.ts`: `pool`,
  `computedKeyRegistry`, `viewTypeRegistry`, `queueAffinity`) from its
  parameters and returns `mergeOps(...)` over nine per-domain section
  factories. `mergeOps` (`chokePoint/mergeOps.ts`) merges the section objects
  and throws an `Error` naming any key that appears in more than one of them.
  Each factory takes `deps: Pick<ChokePointDeps, …>` with exactly the fields
  its methods use, so a section's dependencies are visible in its signature.
- **One module per domain under `chokePoint/`.** Domain modules never import
  one another (enforced by #496). There are no import cycles in `chokePoint/`
  or `rollup/` (enforced by #497).
- **No barrel.** A caller imports a symbol from the module that owns it.
  `chokePoint.ts` only composes; it does not re-export domain symbols.
- **A size cap.** Production source files are capped at 900 lines by lint
  (#529 for `backend/`, #530 for `web/`), so no module grows back into the
  shape this decision removes.

### Where things moved

Every top-level declaration of the pre-split `chokePoint.ts`, plus the
declarations this decision introduces, mapped to its destination. Paths are
relative to `backend/packages/data/src/`.

| Declaration | Destination |
|---|---|
| `Actor` | `chokePoint/authorization.ts` |
| `ownerViolation` | `chokePoint/authorization.ts` |
| `assertAuthenticatedAgentIdentity` | `chokePoint/authorization.ts` |
| `assertViewWritable` | `chokePoint/authorization.ts` |
| `assertDatabaseNotArchived` | `chokePoint/databaseGuards.ts` |
| `assertNoComputedKeyCollision` | `chokePoint/computedKeyRegistry.ts` |
| `resolveRollupRecomputeTargets` | `rollup/recompute.ts` |
| `enqueueRollupRecomputeForEdge` | `rollup/recompute.ts` |
| `applyRollupConfig` | `rollup/config.ts` |
| `SystemRelationWriteContext` | `chokePoint/relationEdgeContext.ts` |
| `RelationEdgeContext` | `chokePoint/relationEdgeContext.ts` |
| `loadRelationEdgeContext` | `chokePoint/relationEdgeContext.ts` |
| `normalizeRelationSides` | `chokePoint/relationEdgeContext.ts` |
| `assertRelationPropertyWritable` | `chokePoint/relationEdgeContext.ts` |
| `assertRelationDatabasesNotArchived` | `chokePoint/relationEdgeContext.ts` |
| `databaseArchiveWithClient` | `chokePoint/databaseOps.ts` |
| `buildFilterSqlForDatabase` | `chokePoint/itemReads.ts` |
| `ListItemsInput` | `chokePoint/itemReads.ts` |
| `CountItemsInput` | `chokePoint/itemReads.ts` |
| `resolveFilterSql` | `chokePoint/itemReads.ts` |
| `assertItemExists` | `chokePoint/viewOps.ts` |
| `adoptIfUserWrite` | `chokePoint/viewOps.ts` |
| `viewDeleteWithClient` | `chokePoint/viewOps.ts` |
| `propertyDeleteWithClient` | `chokePoint/propertyOps.ts` |
| `updatePropertyConfigWithClient` | `chokePoint/propertyOps.ts` |
| `changePropertyTypeWithClient` | `chokePoint/propertyOps.ts` |
| `RelationPropertySideInput` | `chokePoint/relationPropertyOps.ts` |
| `CreateRelationPropertyInput` | `chokePoint/relationPropertyOps.ts` |
| `assertValidOwnerSide` | `chokePoint/relationPropertyOps.ts` |
| `assertRelationSideCreatable` | `chokePoint/relationPropertyOps.ts` |
| `createRelationPropertyWithClient` | `chokePoint/relationPropertyOps.ts` |
| `RelationEdge` | `chokePoint/relationOps.ts` |
| `CreateRelationInput` | `chokePoint/relationOps.ts` |
| `UpdateRelationInput` | `chokePoint/relationOps.ts` |
| `DeleteRelationInput` | `chokePoint/relationOps.ts` |
| `assertRelationEndpointValid` | `chokePoint/relationOps.ts` |
| `assertRelationEndpointsValid` | `chokePoint/relationOps.ts` |
| `loadCreatableRelationEdgeContext` | `chokePoint/relationOps.ts` |
| `assertRelationEdgeMetadataValid` | `chokePoint/relationOps.ts` |
| `assertRelationCreatableWithClient` | `chokePoint/relationOps.ts` |
| `createRelationWithClient` | `chokePoint/relationOps.ts` |
| `updateRelationWithClient` | `chokePoint/relationOps.ts` |
| `deleteRelationWithClient` | `chokePoint/relationOps.ts` |
| `AssertWritablePropertiesOptions` | `chokePoint/itemWrites.ts` |
| `assertWritableProperties` | `chokePoint/itemWrites.ts` |
| `assertDatabaseWritableForCreate` | `chokePoint/itemWrites.ts` |
| `CreateItemWithClientOptions` | `chokePoint/itemWrites.ts` |
| `CreateItemInput` | `chokePoint/itemWrites.ts` |
| `createItemWithClient` | `chokePoint/itemWrites.ts` |
| `writeComputedAndAnnounce` | `chokePoint/itemWrites.ts` |
| `UpdateItemInput` | `chokePoint/itemWrites.ts` |
| `UpdateItemWithClientOptions` | `chokePoint/itemWrites.ts` |
| `updateItemWithClient` | `chokePoint/itemWrites.ts` |
| `itemDeleteWithClient` | `chokePoint/itemTrash.ts` |
| `collectItemSubtree` | `chokePoint/itemTrash.ts` |
| `ResourceSnapshotKind` | `chokePoint/destructiveProjection.ts` |
| `ResourceSnapshot` | `chokePoint/destructiveProjection.ts` |
| `DestructiveResourceProjection` | `chokePoint/destructiveProjection.ts` |
| `DestructiveOperationCheck` | `chokePoint/destructiveProjection.ts` |
| `buildResourceSnapshot` | `chokePoint/destructiveProjection.ts` |
| `detailsObject` | `chokePoint/destructiveProjection.ts` |
| `computeDestructiveResourceProjection` | `chokePoint/destructiveProjection.ts` |
| `createChokePoint` | `chokePoint/chokePoint.ts` |
| `ChokePoint` | `chokePoint/chokePoint.ts` |
| `ChokePointDeps` | `chokePoint/chokePointDeps.ts` |
| `mergeOps` | `chokePoint/mergeOps.ts` |
| `createDatabaseOps` | `chokePoint/databaseOps.ts` |
| `createPropertyOps` | `chokePoint/propertyOps.ts` |
| `createRelationPropertyOps` | `chokePoint/relationPropertyOps.ts` |
| `createRelationOps` | `chokePoint/relationOps.ts` |
| `createItemWriteOps` | `chokePoint/itemWrites.ts` |
| `createItemReadOps` | `chokePoint/itemReads.ts` |
| `createItemTrashOps` | `chokePoint/itemTrash.ts` |
| `createViewOps` | `chokePoint/viewOps.ts` |
| `createViewQueryOps` | `chokePoint/viewQueryOps.ts` |

The choke-point methods themselves (`createItem`, `patchView`, …) moved with
their section factory; the factory's row gives their module.

## Consequences

- Adding a domain means adding one module and one `mergeOps` argument. A
  method name reused across two sections fails at `createChokePoint()` time
  instead of shadowing the earlier method.
- `ChokePoint` stays `ReturnType<typeof createChokePoint>`, so the public
  type is derived from the composition and needs no hand-maintained interface.
- Callers that imported a helper from `chokePoint.ts` must import it from its
  owning module once that module exists; there is no barrel to fall back on.
- A helper that two domains both need cannot live in either of them. It goes
  into a shared module that neither domain owns (the guard, context and
  projection modules in the table above).
