import type { RelationEdgeDeleteHook, RelationEdgeWriteHook } from "../chokePoint/hooks.js";
import { lockInboxSource } from "./inboxSourceGuard.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

async function lockTypeEdgeSource(
  { client, edgeContext, callerItemId, targetItemId, lockMode }: Parameters<RelationEdgeWriteHook>[0],
  allowDeleted: boolean,
): Promise<void> {
  if (callerItemId === NIL_UUID || targetItemId === NIL_UUID) return;
  const result = await client.query<{ database_id: string }>(
    `SELECT p.database_id FROM properties p JOIN databases d ON d.id = p.database_id AND d.tenant_id = p.tenant_id
     WHERE p.id = ANY($1::uuid[]) AND p.key = 'type' AND d.owner_module_id = 'inbox'`,
    [[edgeContext.reldef.propertyIdA, edgeContext.reldef.propertyIdB]],
  );
  const inboxDatabaseId = result.rows[0]?.database_id;
  if (!inboxDatabaseId) return;
  const sourceId = edgeContext.property.databaseId === inboxDatabaseId ? callerItemId : targetItemId;
  await lockInboxSource(client, sourceId, allowDeleted, lockMode);
}

export const inboxTypeEdgeWriteHook: RelationEdgeWriteHook = (context) => lockTypeEdgeSource(context, false);
export const inboxTypeEdgeDeleteHook: RelationEdgeDeleteHook = (context) => lockTypeEdgeSource(context, true);
