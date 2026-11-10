import type { PoolClient } from "pg";
import { z } from "zod";
import { GUARDED_DERIVED_VALUE_SOURCES } from "../derived/derivedValueSources.js";
import { ValidationError } from "../errors.js";
import type { PropertyRow } from "../types.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import { loadRelationEdgeContext, type RelationEdgeContext } from "./relationEdgeContext.js";
import { reserveDerivedValueInputs } from "./derivedValueAdmission.js";

interface GuardedSide {
  itemId: string;
  field: string;
  databaseKey: string;
  property: PropertyRow;
  projectContext: RelationEdgeContext;
}

export async function assertNotDerivedValueWrite(
  client: PoolClient,
  input: { edgeContext: RelationEdgeContext; callerItemId: string; targetItemId: string; mutation?: boolean },
): Promise<void> {
  const { edgeContext } = input;
  const otherId =
    edgeContext.reldef.propertyIdA === edgeContext.property.id
      ? edgeContext.reldef.propertyIdB
      : edgeContext.reldef.propertyIdA;
  const other = otherId ? await propertiesStore.getProperty(client, otherId) : null;
  const sides = [
    { property: edgeContext.property, itemId: input.callerItemId },
    ...(other ? [{ property: other, itemId: input.targetItemId }] : []),
  ];
  const guarded: GuardedSide[] = [];
  for (const side of sides) {
    const database = await databasesStore.getDatabase(client, side.property.databaseId);
    const source = GUARDED_DERIVED_VALUE_SOURCES.find(
      (entry) => entry.databaseKey === database?.key && entry.propertyKey === side.property.key,
    );
    if (!source) continue;
    const project = await propertiesStore.getPropertyByKey(client, side.property.databaseId, source.projectPropertyKey);
    if (!project) throw new Error("Guarded relation project property is missing");
    const projectContext = await loadRelationEdgeContext(client, project.id);
    const projectsDatabase = await databasesStore.getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!projectsDatabase || projectsDatabase.id !== projectContext.targetDatabaseId)
      throw new Error("Guarded relation does not target the projects database");
    guarded.push({
      itemId: side.itemId,
      field: source.propertyKey,
      databaseKey: source.databaseKey,
      property: side.property,
      projectContext,
    });
  }
  if (guarded.length === 0) return;
  if (input.mutation) await reserveDerivedValueInputs(client, edgeContext, guarded);
  for (const side of guarded) {
    const project = side.projectContext;
    const callerIsA = project.reldef.propertyIdA === project.property.id;
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT EXISTS (
        SELECT 1 FROM item_relations r JOIN items i ON i.id = ${callerIsA ? "r.item_b" : "r.item_a"}
          AND i.database_id = $3 AND i.tenant_id = r.tenant_id
        WHERE r.tenant_id = app_tenant_default() AND r.relation_definition_id = $1
          AND ${callerIsA ? "r.item_a" : "r.item_b"} = $2 AND i.deleted_at IS NULL
      ) AS present`,
      [project.reldef.id, side.itemId, project.targetDatabaseId],
    );
    if (z.object({ present: z.boolean() }).parse(rows[0]).present)
      throw new ValidationError("Value is derived from the item's project", { field: side.field });
  }
}
