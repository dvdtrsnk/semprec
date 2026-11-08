// Issue #1645: the one owner of attaching an upload to an item through `POST /api/files`'s
// `X-Attach-To-Item` and `X-Attach-Relation` headers. The target is resolved read-only before the body is
// read, then re-checked and linked inside the upload's own ingest transaction, through the choke point's
// relation write, so the file and its edge commit or roll back together.
import type { PoolClient } from "pg";
import { getItemsByIds, lockItemById } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { getItemRelationByTuple, getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { normalizeRelationSides } from "../chokePoint/relationEdgeContext.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { NotFoundError, ValidationError } from "../errors.js";

const ATTACH_TO_ITEM_HEADER = "X-Attach-To-Item";
const ATTACH_RELATION_HEADER = "X-Attach-Relation";

/** A resolved attach target: the Files relation property to write and the item it leads to. */
export interface UploadAttachTarget {
  relationPropertyId: string;
  targetDatabaseId: string;
  targetItemId: string;
}

/** The answer for an unknown, trashed or foreign target: identical for all three, naming no id. */
function attachTargetNotFound(): NotFoundError {
  return new NotFoundError("The attach target was not found", { field: ATTACH_TO_ITEM_HEADER });
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
  return { relationPropertyId: relation.id, targetDatabaseId: target.databaseId, targetItemId: target.id };
}

/**
 * Links an uploaded Files item to its resolved attach target inside the ingest transaction. The target row
 * is re-read under `FOR UPDATE` (`lockItemById`), so a concurrent trash of it waits for this transaction,
 * and a target trashed or purged since the pre-check answers the same 404, which rolls the upload back. An
 * edge that already exists between the two is left as it is; otherwise `createRelationWithClient` writes it,
 * so its cardinality check and edge hooks apply and a cardinality violation keeps its 409.
 */
export async function attachUploadedFileWithClient(
  client: PoolClient,
  target: UploadAttachTarget,
  fileItemId: string,
  options: { writer?: WriterIdentity; actingUserId?: string } = {},
): Promise<void> {
  const locked = await lockItemById(client, target.targetDatabaseId, target.targetItemId);
  if (!locked || locked.deletedAt) throw attachTargetNotFound();
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
}
