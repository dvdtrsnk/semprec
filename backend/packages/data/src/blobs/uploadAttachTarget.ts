// Attaching an upload to an item via `POST /api/files`'s `X-Attach-*` headers. The target is resolved read-only
// before the body is read, then reserved, re-checked and linked inside the ingest transaction, so the file and its
// edge commit or roll back together.
import { DatabaseError, type PoolClient } from "pg";
import { getItemsByIds, lockItemByIdNowait } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { getItemRelationByTuple, getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { normalizeRelationSides } from "../chokePoint/relationEdgeContext.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import type { ItemRow } from "../types.js";
import { markManagedTransactionRollbackOnly, requireManagedTransaction } from "../db/pool.js";
import { ChokePointError, NotFoundError, ValidationError } from "../errors.js";

const ATTACH_TO_ITEM_HEADER = "X-Attach-To-Item";
const ATTACH_RELATION_HEADER = "X-Attach-Relation";

export interface UploadAttachTarget {
  filesDatabaseId: string;
  relationPropertyId: string;
  targetDatabaseId: string;
  targetItemId: string;
}

/** Identical for unknown, trashed and foreign targets, so none can be told apart. */
function attachTargetNotFound(): NotFoundError {
  return new NotFoundError("The attach target was not found", { field: ATTACH_TO_ITEM_HEADER });
}

/** Lock contention or a changed Files item; the upload rolls back and the client may resend. Names no id. */
function uploadAttachConflict(): ChokePointError {
  return new ChokePointError(409, "upload_attach_conflict", "The upload could not be attached; send it again");
}

/** Only lock-not-available (55P03) becomes `uploadAttachConflict`; other errors keep their identity. */
async function reserveItemNowait(client: PoolClient, databaseId: string, itemId: string): Promise<ItemRow | null> {
  try {
    return await lockItemByIdNowait(client, databaseId, itemId);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "55P03") throw uploadAttachConflict();
    throw error;
  }
}

/** Case-insensitive, as blob reference writers accept any case. */
function filesBlob(row: ItemRow, expectedBlobId: string): boolean {
  const file = row.properties.file;
  if (typeof file !== "object" || file === null || !Object.hasOwn(file, "blobId")) return false;
  const blobId: unknown = Reflect.get(file, "blobId");
  return typeof blobId === "string" && blobId.toLowerCase() === expectedBlobId.toLowerCase();
}

/**
 * Read-only. The relation key is checked first because it does not depend on the target, so no outcome tells a
 * foreign target (hidden by RLS) from a missing one.
 */
export async function resolveUploadAttachTarget(
  client: PoolClient,
  input: { filesDatabaseId: string; targetItemId: string; relationKey: string },
): Promise<UploadAttachTarget> {
  const relation = (await listPropertiesByDatabase(client, input.filesDatabaseId)).find(
    (property) => property.type === "relation" && property.key === input.relationKey,
  );
  if (!relation) {
    throw new ValidationError(`'${ATTACH_RELATION_HEADER}' is not a relation of the Files database`, {
      field: ATTACH_RELATION_HEADER,
    });
  }
  const [target] = await getItemsByIds(client, [input.targetItemId]);
  if (!target) throw attachTargetNotFound();
  if (relation.config.targetDatabaseId !== target.databaseId) {
    throw new ValidationError(`'${ATTACH_RELATION_HEADER}' does not lead to the target's database`, {
      field: ATTACH_RELATION_HEADER,
    });
  }
  return {
    filesDatabaseId: input.filesDatabaseId,
    relationPropertyId: relation.id,
    targetDatabaseId: target.databaseId,
    targetItemId: target.id,
  };
}

/**
 * The ingest transaction already holds the blob `FOR UPDATE`. The target and Files item rows are reserved `NOWAIT`
 * because an item update takes its row before the blob reference lock, so waiting here could deadlock. Under those
 * locks the target and the Files item's blob binding are re-checked. The edge goes through `createRelationWithClient`
 * so cardinality and edge hooks apply. Any failure marks the transaction rollback-only, so a caller that catches it
 * still commits nothing.
 */
export async function attachUploadedFileWithClient(
  client: PoolClient,
  target: UploadAttachTarget,
  fileItemId: string,
  expectedBlobId: string,
  options: { writer?: WriterIdentity; actingUserId?: string } = {},
): Promise<void> {
  requireManagedTransaction(client);
  try {
    const targetRow = await reserveItemNowait(client, target.targetDatabaseId, target.targetItemId);
    if (!targetRow || targetRow.deletedAt) throw attachTargetNotFound();
    const fileRow = await reserveItemNowait(client, target.filesDatabaseId, fileItemId);
    if (!fileRow || fileRow.deletedAt || !filesBlob(fileRow, expectedBlobId)) throw uploadAttachConflict();
    const definition = await getRelationDefinitionByPropertyId(client, target.relationPropertyId);
    if (!definition) throw new Error("The attach relation has no relation definition");
    const { itemA, itemB } = normalizeRelationSides(
      definition,
      target.relationPropertyId,
      fileItemId,
      target.targetItemId,
    );
    if (await getItemRelationByTuple(client, definition.id, itemA, itemB)) return;
    await createRelationWithClient(
      client,
      { relationPropertyId: target.relationPropertyId, callerItemId: fileItemId, targetItemId: target.targetItemId },
      undefined,
      options.writer,
      options.actingUserId,
    );
  } catch (error) {
    markManagedTransactionRollbackOnly(client, error);
    throw error;
  }
}
