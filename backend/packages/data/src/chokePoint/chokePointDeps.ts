import type { Pool } from "pg";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import type { ComputedKeyRegistry } from "./computedKeyRegistry.js";
import type { ViewTypeRegistry } from "./viewTypeRegistry.js";

/** Everything `createChokePoint` hands its section factories; each factory takes a `Pick` of what it uses. */
export interface ChokePointDeps {
  pool: Pool;
  computedKeyRegistry: ComputedKeyRegistry;
  viewTypeRegistry: ViewTypeRegistry;
  queueAffinity: ActionQueueAffinity;
}
