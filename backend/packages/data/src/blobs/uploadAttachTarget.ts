// Issue #1645: the one owner of attaching an upload to an item through `POST /api/files`'s
// `X-Attach-To-Item` and `X-Attach-Relation` headers. The target is resolved read-only before the body is
// read, then reserved, re-checked and linked inside the upload's own ingest transaction, through the choke
// point's relation write, so the file and its edge commit or roll back together.
// Constrained by: docs/adr/2026-11-08-upload-attach-reserves-source-and-target.md and
// docs/adr/2026-11-08-upload-attach-rechecks-the-file-blob-binding.md
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

/** A resolved attach target: the Files relation property to write and the item it leads to. */
export interface UploadAttachTarget {
  /** The Files database the uploaded item is filed in. */
  filesDatabaseId: string;
  relationPropertyId: string;
  targetDatabaseId: string;
  targetItemId: string;
}

/** The answer for an unknown, trashed or foreign target: identical for all three, naming no id. */
function attachTargetNotFound(): NotFoundError {
  return new NotFoundError("The attach target was not found", { field: ATTACH_TO_ITEM_HEADER });
}

/**
 * The answer when the target or the uploaded Files item is locked by another transaction at the moment this
 * upload reserves it, and when the deduplicated Files item is gone, or no longer files the uploaded blob, by
 * then: one fixed 409, naming no id. The upload is rolled back and not retried; the caller may send it again.
 */
function uploadAttachConflict(): ChokePointError {
  return new ChokePointError(409, "upload_attach_conflict", "The upload could not be attached; send it again");
}

/**
 * Reserves one item row `FOR UPDATE NOWAIT`. Only PostgreSQL's lock-not-available refusal of that statement
 * (55P03) becomes `uploadAttachConflict`; every other error keeps its identity.
 */
async function reserveItemNowait(client: PoolClient, databaseId: string, itemId: string): Promise<ItemRow | null> {
  try {
    return await lockItemByIdNowait(client, databaseId, itemId);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "55P03") throw uploadAttachConflict();
    throw error;
  }
}

/**
 * Whether a Files item row still files `expectedBlobId`: its `file` property is an object whose `blobId` is a
 * string naming that blob. UUIDs are compared case-insensitively, as blob reference writers accept any case.
 */
function filesBlob(row: ItemRow, expectedBlobId: string): boolean {
  const file = row.properties.file;
  if (typeof file !== "object" || file === null || !Object.hasOwn(file, "blobId")) return false;
  const blobId: unknown = Reflect.get(file, "blobId");
  return typeof blobId === "string" && blobId.toLowerCase() === expectedBlobId.toLowerCase();
}

/**
 * Resolves an upload's attach target with reads only, in the caller's tenant transaction:
 * `relationKey` must be a relation property of the Files database (400 on `X-Attach-Relation`), the
 * target item must be live and visible in this tenant (404, the same for an unknown, trashed or foreign
 * id, since row-level security hides another tenant's row), and the relation must lead to the target's
 * database (400 on `X-Attach-Relation`). The relation key is checked first because it does not depend on
 * the target, so no outcome tells a foreign target from a missing one.
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
 * Links an uploaded Files item to its resolved attach target inside the ingest transaction, which already
 * holds the item's blob `FOR UPDATE`. First the target row, then the Files item row, is reserved
 * `FOR UPDATE NOWAIT` in its own database, never waiting while the blob is held: an item update takes its row
 * before the blob reference lock, so a waiting reservation could close a cycle with it. Either row locked by
 * another transaction answers `uploadAttachConflict`. Under those locks, a target trashed or purged since the
 * pre-check answers the same 404 as an unknown one, and a Files item gone or trashed since the deduplicating
 * lookup, or whose `file` no longer names `expectedBlobId` (the blob the ingest filed, from its own result),
 * answers `uploadAttachConflict`. Only then is an existing edge between the two left as it is, or the
 * edge written by `createRelationWithClient`, so its cardinality check and edge hooks apply and a cardinality
 * violation keeps its 409. Any failure here marks the managed upload transaction rollback-only before it
 * propagates, so a caller that catches it still commits nothing.
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
