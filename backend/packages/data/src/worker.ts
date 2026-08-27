import type { Pool } from "pg";
import { CORE_TASK_NAMES, type TaskList } from "@semprec/queue";
import { handleHeartbeatSweepTask, createHeartbeatFireTask } from "./scheduler/sweep.js";
import { handleRollupRecomputeTask, handleRollupRecomputeFullTask } from "./rollup/recompute.js";
import { handlePropertyTypeMigrationTask } from "./migrationJob/propertyTypeMigration.js";
import type { ActionRegistry } from "./scheduler/actions.js";
import type { PropertyType } from "./types.js";
import { PROPERTY_TYPES } from "./types.js";

function requireString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string") throw new Error(`Job payload missing string field '${field}'`);
  return value;
}

function requirePropertyType(payload: unknown, field: string): PropertyType {
  const value = requireString(payload, field);
  if (!PROPERTY_TYPES.includes(value as PropertyType)) throw new Error(`Job payload field '${field}' is not a known property type`);
  return value as PropertyType;
}

/** Composes every core task handler this issue implements into one graphile-worker TaskList. */
export function createCoreTaskList(pool: Pool, actionRegistry: ActionRegistry): TaskList {
  return {
    [CORE_TASK_NAMES.HEARTBEAT_SWEEP]: async () => {
      await handleHeartbeatSweepTask(pool);
    },
    [CORE_TASK_NAMES.HEARTBEAT_FIRE]: createHeartbeatFireTask(pool, actionRegistry),
    [CORE_TASK_NAMES.ROLLUP_RECOMPUTE]: async (payload) => {
      await handleRollupRecomputeTask(pool, { rollupPropertyId: requireString(payload, "rollupPropertyId"), itemId: requireString(payload, "itemId") });
    },
    [CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL]: async (payload) => {
      await handleRollupRecomputeFullTask(pool, { rollupPropertyId: requireString(payload, "rollupPropertyId") });
    },
    [CORE_TASK_NAMES.PROPERTY_TYPE_MIGRATION]: async (payload) => {
      await handlePropertyTypeMigrationTask(pool, {
        propertyId: requireString(payload, "propertyId"),
        fromType: requirePropertyType(payload, "fromType"),
      });
    },
  };
}
