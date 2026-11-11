// Issue #1710: the edge-changed hook that starts the derived-value fan-out. An item's derived area and an
// Event's derived company are read through its project (`derivedValueReads.ts`), so a change of a project's
// `area` or `company` edge changes what the project's items show while none of those items is written. The
// hook runs inside the edge write's transaction and only queues `derivedValuesInvalidate` for the project
// there, so the job commits or rolls back with the edge; the job announces the items when it runs
// (`projectDerivedValueInvalidation.ts`). Registered in `../domainWriteHooks.ts`
// (docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md).
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import type { Queryable } from "../db/pool.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { tenantLane } from "../tenancy/tenantLane.js";

const DERIVED_VALUES_INVALIDATE_LANE = "derived-values-invalidate";

/** The Projects relation properties whose targets the project's items show as derived values. */
const PROJECT_VALUE_PROPERTY_KEYS = ["area", "company"];

const PROJECT_SIDE_ROW = z.object({ project_is_a: z.boolean() });

/**
 * Which end of the edges of `relationDefinitionId` is the project, when that definition is the one behind
 * `area` or `company` of the current tenant's system Projects database; `null` for any other relation.
 * Row-level security and the explicit tenant filter confine the read to the current tenant.
 */
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
 * After an edge of `Projects.area` or `Projects.company` is created or deleted (issue #1530's hook),
 * whichever of the definition's two properties the write named: queues one `derivedValuesInvalidate` job for
 * the project on the tenant's `derived-values-invalidate` lane. The key names the project, so changes that
 * arrive before the job starts collapse into that one job. A metadata update of such an edge queues nothing,
 * because it leaves the project's area and company as they were.
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
