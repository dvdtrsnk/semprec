import type { Pool } from "pg";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import { createComputedKeyRegistry, type ComputedKeyRegistry } from "./computedKeyRegistry.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "./viewTypeRegistry.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { mergeOps } from "./mergeOps.js";
import { createDatabaseOps } from "./databaseOps.js";
import { createItemReadOps } from "./itemReads.js";
import { createViewQueryOps } from "./viewQueryOps.js";
import { createViewOps } from "./viewOps.js";
import { createPropertyOps } from "./propertyOps.js";
import { createRelationPropertyOps } from "./relationPropertyOps.js";
import { createRelationOps } from "./relationOps.js";
import { createItemWriteOps } from "./itemWrites.js";
import { createItemTrashOps } from "./itemTrash.js";

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
