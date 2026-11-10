import { markManagedTransactionRollbackOnly } from "../db/pool.js";
import type { PoolClient } from "pg";
import type { RelationEdgeChangedHook, RelationEdgeWriteHook } from "../chokePoint/hooks.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { CardinalityViolationError, ProposalLockedError } from "../errors.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { reserveInboxTypeCards } from "./inboxTypeCardReservation.js";
import { LOCKED_PROPOSAL_STATUSES } from "./inboxTypesStore.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

async function typeDefinition(client: PoolClient) {
  const database = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  const property = database && (await getPropertyByKey(client, database.id, "type"));
  return property && (await getRelationDefinitionByPropertyId(client, property.id));
}

async function assertUnlocked(client: PoolClient, sourceId: string): Promise<void> {
  const cards = await reserveInboxTypeCards(client, sourceId);
  if (
    cards.some(
      (card) => typeof card.properties.status === "string" && LOCKED_PROPOSAL_STATUSES.has(card.properties.status),
    )
  ) {
    throw new ProposalLockedError();
  }
}

export const inboxTypeLockWriteHook: RelationEdgeWriteHook = async ({
  client,
  edgeContext,
  callerItemId,
  targetItemId,
}) => {
  if (callerItemId === NIL_UUID || targetItemId === NIL_UUID) return;
  const definition = await typeDefinition(client);
  if (!definition || definition.id !== edgeContext.reldef.id) return;
  const sourceId = edgeContext.property.id === definition.propertyIdA ? callerItemId : targetItemId;
  const targetId = sourceId === callerItemId ? targetItemId : callerItemId;
  await assertUnlocked(client, sourceId);
  const edges = await listRelationsForItem(client, definition.id, sourceId);
  if (edges.some((edge) => otherSide(edge, sourceId) !== targetId)) {
    throw new CardinalityViolationError("Inbox item already has a type", { field: "type" });
  }
};

export const inboxTypeLockChangedHook: RelationEdgeChangedHook = async ({
  client,
  op,
  relationDefinitionId,
  itemA,
}) => {
  if (op === "create") return;
  const definition = await typeDefinition(client);
  if (!definition || definition.id !== relationDefinitionId) return;
  try {
    await assertUnlocked(client, itemA);
  } catch (error) {
    markManagedTransactionRollbackOnly(client, error);
    throw error;
  }
};
