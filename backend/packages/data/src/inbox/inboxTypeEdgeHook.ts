// An Inbox item's type is an edge, so changing it fires no item event: this hook queues the Inbox tick and the day's
// Inbox summary recompute, inside the edge write's transaction so both jobs commit or roll back with the edge. Whether
// a new proposal is needed is the tick's decision (fingerprint).
import type { RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { enqueueJournalInboxRecomputeForInboxItem } from "./journalInboxCompute.js";

/**
 * `createRelationWithClient` reports `create` also for an existing edge, so a repeated `PUT` of the same type still
 * enqueues both jobs. `op: 'update'` (metadata only) and other relations enqueue nothing.
 */
export const inboxTypeEdgeChangedHook: RelationEdgeChangedHook = async ({
  client,
  op,
  relationDefinitionId,
  itemA,
  itemB,
}) => {
  if (op === "update") return;
  const { rows } = await client.query<{ inbox_database_id: string; inbox_is_side_a: boolean }>(
    `SELECT p.database_id AS inbox_database_id, r.property_id_a = p.id AS inbox_is_side_a
     FROM relation_definitions r
     JOIN properties p ON p.tenant_id = r.tenant_id AND p.id IN (r.property_id_a, r.property_id_b)
     JOIN databases d ON d.tenant_id = p.tenant_id AND d.id = p.database_id
     WHERE r.id = $1 AND p.key = 'type' AND d.system AND d.owner_module_id = $2`,
    [relationDefinitionId, INBOX_MODULE_ID],
  );
  const typeRelation = rows[0];
  if (!typeRelation) return;
  const inboxItemId = typeRelation.inbox_is_side_a ? itemA : itemB;
  await triggerOnItemEventHeartbeats(client, typeRelation.inbox_database_id, "update", inboxItemId);
  await enqueueJournalInboxRecomputeForInboxItem(client, inboxItemId);
};
