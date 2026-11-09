import { DatabaseError, type PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { lockItemByIdNowait } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { INBOX_MODULE_ID, PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import type { ItemRow } from "../types.js";

export async function resolveInboxTypeCardConfiguration(client: PoolClient, expectedDatabaseId?: string) {
  const database = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
  if (!database || (expectedDatabaseId !== undefined && database.id !== expectedDatabaseId))
    throw new NotFoundError("Processing proposals configuration not found");
  const property = await getPropertyByKey(client, database.id, "sourceInbox");
  if (!property) throw new NotFoundError("Processing proposals sourceInbox property not found");
  const definition = await getRelationDefinitionByPropertyId(client, property.id);
  const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  const config: unknown = property.config;
  if (
    !inbox ||
    !definition ||
    property.type !== "relation" ||
    typeof config !== "object" ||
    config === null ||
    Array.isArray(config) ||
    !("relationDefinitionId" in config) ||
    config.relationDefinitionId !== definition.id ||
    !("targetDatabaseId" in config) ||
    config.targetDatabaseId !== inbox.id ||
    definition.propertyIdA !== property.id ||
    definition.propertyIdB !== null ||
    definition.cardinality !== "many_to_many"
  )
    throw new NotFoundError("Processing proposals sourceInbox relation not found");
  return { databaseId: database.id, definitionId: definition.id };
}

export async function reserveInboxTypeCards(
  client: PoolClient,
  sourceId: string,
  configuration?: Awaited<ReturnType<typeof resolveInboxTypeCardConfiguration>>,
): Promise<ItemRow[]> {
  const resolved = configuration ?? (await resolveInboxTypeCardConfiguration(client));
  const edges = await listRelationsForItem(client, resolved.definitionId, sourceId);
  const ids = [...new Set(edges.map((edge) => otherSide(edge, sourceId)))].sort();
  const cards: ItemRow[] = [];
  for (const id of ids) {
    await client.query("SAVEPOINT inbox_type_card");
    let card: ItemRow | null;
    try {
      card = await lockItemByIdNowait(client, resolved.databaseId, id);
      await client.query("RELEASE SAVEPOINT inbox_type_card");
    } catch (error) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT inbox_type_card");
        await client.query("RELEASE SAVEPOINT inbox_type_card");
      } catch (cleanupError) {
        // The reservation failure is primary; the cleanup failure remains in the aggregate.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([error, cleanupError], "Inbox card reservation cleanup failed", { cause: error });
      }
      if (error instanceof DatabaseError && error.code === "55P03") {
        throw new ConflictError("Inbox proposal is busy", { field: "type" });
      }
      throw error;
    }
    if (card && !card.deletedAt) cards.push(card);
  }
  return cards;
}
