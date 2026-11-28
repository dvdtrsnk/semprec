// A project's `company` edge change alters what its Events show (derived through the project) without writing
// them. This hook only queues `derivedValuesInvalidate` inside the edge write's transaction, so the job commits or
// rolls back with the edge.
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import type { RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import type { Queryable } from "../db/pool.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { tenantLane } from "../tenancy/tenantLane.js";

const DERIVED_VALUES_INVALIDATE_LANE = "derived-values-invalidate";

const PROJECT_VALUE_PROPERTY_KEYS = ["company"];

const PROJECT_SIDE_ROW = z.object({ project_is_a: z.boolean() });

/** `null` for any relation other than the system Projects `company`. */
async function projectSideOf(client: Queryable, relationDefinitionId: string): Promise<"a" | "b" | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT rd.property_id_a = p.id AS project_is_a
     FROM relation_definitions rd
     JOIN properties p ON p.tenant_id = rd.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
     JOIN databases d ON d.tenant_id = p.tenant_id AND d.id = p.database_id AND d.system
     WHERE rd.tenant_id = app_tenant_default() AND rd.id = $1
       AND d.owner_module_id = $2 AND p.type = 'relation' AND p.key = ANY($3::text[])`,
    [relationDefinitionId, PROJECTS_MODULE_ID, PROJECT_VALUE_PROPERTY_KEYS],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return PROJECT_SIDE_ROW.parse(row).project_is_a ? "a" : "b";
}

/**
 * Keyed by project so changes before the job starts collapse into one job. Metadata-only updates leave the company
 * unchanged and queue nothing.
 */
export const projectDerivedValueEdgeChangedHook: RelationEdgeChangedHook = async ({
  client,
  op,
  relationDefinitionId,
  itemA,
  itemB,
}) => {
  if (op === "update") return;
  const projectSide = await projectSideOf(client, relationDefinitionId);
  if (projectSide === null) return;
  const projectItemId = projectSide === "a" ? itemA : itemB;
  await enqueueJob(
    client,
    CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE,
    { projectItemId },
    {
      jobKey: `derived-values-invalidate:${projectItemId}`,
      maxAttempts: 3,
      queueName: tenantLane(DERIVED_VALUES_INVALIDATE_LANE),
    },
  );
};
