import type { AlldotsTickActionConfig } from "./proposalEnvelope.js";
import { PROCESSING_METHODS, type ProcessingMethod } from "./inboxTypesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import type { PoolClient } from "pg";
import type { ItemRow } from "../types.js";
import type { InboxFingerprintV2Input } from "./fingerprint.js";
import { z } from "zod";
/**
 * A blob without a content hash is covered by its id, so adding or removing it still changes the value. Read on the
 * caller's client inside the tick's read transaction, never taken from a job payload.
 */
async function readAttachmentHashes(client: PoolClient, inboxItemId: string): Promise<string[]> {
  const { rows } = await client.query<{ attachment_hash: string }>(
    `SELECT COALESCE(b.content_hash, b.id::text) AS attachment_hash
       FROM inbox_attachments a
       JOIN blobs b ON b.tenant_id = a.tenant_id AND b.id = a.blob_id
      WHERE a.inbox_item_id = $1`,
    [inboxItemId],
  );
  return rows.map((row) => row.attachment_hash);
}

export async function inboxFingerprintInput(
  client: PoolClient,
  item: ItemRow,
  type: ItemRow | null,
): Promise<InboxFingerprintV2Input> {
  const properties = z.record(z.string(), z.unknown()).parse(item.properties);
  return {
    typeId: type?.id ?? "",
    text: typeof properties.text === "string" ? properties.text : "",
    date: typeof properties.date === "string" ? properties.date : "",
    time: typeof properties.time === "string" ? properties.time : "",
    attachmentHashes: await readAttachmentHashes(client, item.id),
    // Inbox audio attachments are not transcribed yet, so there is no transcript text to cover.
    transcribedText: "",
  };
}
export async function getRelationDefinitionByKey(client: PoolClient, databaseId: string, key: string) {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) return null;
  return relationsStore.getRelationDefinitionByPropertyId(client, property.id);
}

/**
 * `null` for every case the tick turns into `needsClarification`: no `type` relation, a dangling or deleted target,
 * or a type without a valid `processingMethod`.
 */
export async function resolveRecognizedType(
  client: PoolClient,
  config: AlldotsTickActionConfig,
  item: ItemRow,
): Promise<{ type: ItemRow; processingMethod: ProcessingMethod } | null> {
  const typeRelationDefinition = await getRelationDefinitionByKey(client, config.inboxDatabaseId, "type");
  if (!typeRelationDefinition) return null;

  const edges = await relationsStore.listRelationsForItem(client, typeRelationDefinition.id, item.id);
  const edge = edges[0];
  if (!edge) return null;

  const typeItemId = relationsStore.otherSide(edge, item.id);
  const type = await itemsStore.getItemById(client, config.inboxItemTypesDatabaseId, typeItemId);
  if (!type || type.deletedAt) return null;

  const properties = z.record(z.string(), z.unknown()).parse(type.properties);
  const processingMethod = z.enum(PROCESSING_METHODS).safeParse(properties.processingMethod);
  if (!processingMethod.success) return null;

  return { type: { ...type, properties }, processingMethod: processingMethod.data };
}
