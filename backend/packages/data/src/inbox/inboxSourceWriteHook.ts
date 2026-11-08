import type { RelationEdgeDeleteHook, RelationEdgeWriteHook } from "../chokePoint/hooks.js";
import { lockInboxSource, lockInboxSourceIfPresent } from "./inboxSourceGuard.js";

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

async function lockSourceInboxEdge(
  { client, edgeContext, callerItemId, targetItemId, lockMode }: Parameters<RelationEdgeWriteHook>[0],
  deleting: boolean,
): Promise<void> {
  if (callerItemId === NIL_UUID || targetItemId === NIL_UUID) return;
  const result = await client.query<{ database_id: string }>(
    `SELECT p.database_id FROM properties p JOIN databases d ON d.id = p.database_id AND d.tenant_id = p.tenant_id
     WHERE p.id = ANY($1::uuid[]) AND p.key = 'sourceInbox' AND d.owner_module_id = 'processingProposals'`,
    [[edgeContext.reldef.propertyIdA, edgeContext.reldef.propertyIdB]],
  );
  const proposalsDatabaseId = result.rows[0]?.database_id;
  if (!proposalsDatabaseId) return;
  const sourceId = edgeContext.property.databaseId === proposalsDatabaseId ? targetItemId : callerItemId;
  if (deleting) await lockInboxSourceIfPresent(client, sourceId, true, lockMode);
  else await lockInboxSource(client, sourceId, false, lockMode);
}

export const inboxSourceEdgeWriteHook: RelationEdgeWriteHook = (context) => lockSourceInboxEdge(context, false);
export const inboxSourceEdgeDeleteHook: RelationEdgeDeleteHook = (context) => lockSourceInboxEdge(context, true);
