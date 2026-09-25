import type { Pool, PoolClient } from "pg";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import * as viewsStore from "./viewsStore.js";
import { assertRelationDeletable } from "../rollup/mirror.js";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import { createComputedKeyRegistry, type ComputedKeyRegistry } from "./computedKeyRegistry.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "./viewTypeRegistry.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { mergeOps } from "./mergeOps.js";

// Temporary scaffolding for the choke-point split: the `// ==== block: <file> ====` markers group each
// future module's declarations into one contiguous block. The blocks and markers are removed by #528.

// ==== block: authorization.ts ====
import { assertViewWritable, type Actor } from "./authorization.js";
export type { Actor } from "./authorization.js";

// ==== block: databaseGuards.ts ====

// ==== block: computedKeyRegistry.ts ====

// ==== block: rollup/recompute.ts ====
export { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";

// ==== block: rollup/config.ts ====

// ==== block: relationEdgeContext.ts ====
import {
  assertRelationDatabasesNotArchived,
  assertRelationPropertyWritable,
  loadRelationEdgeContext,
  normalizeRelationSides,
} from "./relationEdgeContext.js";
export type { SystemRelationWriteContext } from "./relationEdgeContext.js";

// ==== block: databaseOps.ts ====
import { createDatabaseOps } from "./databaseOps.js";
export { databaseArchiveWithClient } from "./databaseOps.js";

// ==== block: itemReads.ts ====
import { createItemReadOps } from "./itemReads.js";
export type { ListItemsInput, CountItemsInput } from "./itemReads.js";

// ==== block: viewQueryOps.ts ====
import { createViewQueryOps } from "./viewQueryOps.js";

// ==== block: viewOps.ts ====
import { createViewOps } from "./viewOps.js";
export { viewDeleteWithClient } from "./viewOps.js";

// ==== block: propertyOps.ts ====
import { createPropertyOps } from "./propertyOps.js";
export { propertyDeleteWithClient } from "./propertyOps.js";

// ==== block: relationPropertyOps.ts ====
import { createRelationPropertyOps } from "./relationPropertyOps.js";
export { createRelationPropertyWithClient } from "./relationPropertyOps.js";
export type { CreateRelationPropertyInput, RelationPropertySideInput } from "./relationPropertyOps.js";

// ==== block: relationOps.ts ====
import { createRelationOps } from "./relationOps.js";
export {
  assertRelationCreatableWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
  updateRelationWithClient,
} from "./relationOps.js";
export type { CreateRelationInput, DeleteRelationInput, RelationEdge, UpdateRelationInput } from "./relationOps.js";

// ==== block: itemWrites.ts ====
import { createItemWriteOps } from "./itemWrites.js";
export { createItemWithClient, updateItemWithClient, writeComputedAndAnnounce } from "./itemWrites.js";
export type {
  CreateItemWithClientOptions,
  CreateItemInput,
  UpdateItemInput,
  UpdateItemWithClientOptions,
} from "./itemWrites.js";

// ==== block: itemTrash.ts ====
import { createItemTrashOps } from "./itemTrash.js";
export { itemDeleteWithClient } from "./itemTrash.js";

// ==== block: destructiveProjection.ts ====
export { computeDestructiveResourceProjection } from "./destructiveProjection.js";
export type {
  ResourceSnapshotKind,
  ResourceSnapshot,
  DestructiveResourceProjection,
  DestructiveOperationCheck,
} from "./destructiveProjection.js";

// ==== block: chokePoint.ts ====
export function createChokePoint(
  pool: Pool,
  computedKeyRegistry: ComputedKeyRegistry = createComputedKeyRegistry(),
  viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry(),
  queueAffinity: ActionQueueAffinity = createActionQueueAffinity(),
) {
  const deps: ChokePointDeps = { pool, computedKeyRegistry, viewTypeRegistry, queueAffinity };
  return mergeOps(
    createDatabaseOps(deps),
    createPropertyOps(deps),
    createRelationPropertyOps(deps),
    createRelationOps(deps),
    createItemWriteOps(deps),
    createItemReadOps(deps),
    createItemTrashOps(deps),
    createViewOps(deps),
    createViewQueryOps(deps),
  );
}

export type ChokePoint = ReturnType<typeof createChokePoint>;
