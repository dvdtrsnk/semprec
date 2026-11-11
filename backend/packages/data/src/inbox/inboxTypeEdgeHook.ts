// The choke point's relation-edge-changed hook for the Inbox `type` relation (issue #1718), registered by
// `../domainWriteHooks.ts`. An Inbox item's type is an edge, so writing or deleting it changes neither the item
// nor its card and fires no item event: this hook is what queues the Inbox tick and the recompute of the day's
// cached Inbox summary for such a write. It runs inside the edge write's transaction, after the edge row was
// written or removed, so both jobs commit or roll back with the edge. Whether the type needs a new proposal is
// the tick's decision (its fingerprint), not this hook's.
// See docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md.
import type { RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { enqueueJournalInboxRecomputeForInboxItem } from "./journalInboxCompute.js";

/**
 * Each time the registry reports `op: 'create'` or `op: 'delete'` for an edge of the Inbox `type` relation:
 * fires the Inbox database's `update` heartbeats for the Inbox item and enqueues the recompute of the Journal
 * day that item is linked to. The Inbox item is the stored side of the edge that the Inbox `type` property is
 * on, whichever property the write named.
 *
 * `createRelationWithClient` reports `create` also when the edge already exists: such a repeated create inserts
 * no row, replaces the edge's metadata and leaves the type as it was, and it enqueues both jobs again. So a
 * repeated `PUT` of the type an item already has is not silent. Only `op: 'update'` (`updateRelationWithClient`,
 * the metadata replacement that requires an existing edge) and an edge of any other relation enqueue nothing.
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
