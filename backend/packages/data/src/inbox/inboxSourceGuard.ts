import { isDeepStrictEqual } from "node:util";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { listActiveInboxTypes } from "./inboxTypesStore.js";
import {
  validRecognitionTypes,
  filterRecognitionCandidates,
  clarificationTypes,
  RECOGNITION_CONFIDENCE_THRESHOLD,
} from "./inboxRecognition.js";
import type { TickSnapshot, ProposalComputationResult } from "./inboxTickSnapshot.js";
import { DatabaseError, type PoolClient } from "pg";
import { NotFoundError } from "../errors.js";
import { runValueLinkAdmissionLock } from "../chokePoint/valueLinkRelationAdmission.js";

/** Lock the tenant's Inbox source in the caller's transaction, optionally including Trash. */
export async function lockInboxSource(
  client: PoolClient,
  itemId: string,
  allowDeleted = false,
  lockMode?: "nowait",
): Promise<void> {
  if (!(await lockInboxSourceIfPresent(client, itemId, allowDeleted, lockMode)))
    throw new NotFoundError("Inbox source not found", { resource: "item", itemId });
}

/** Purge may call this after it has already deleted the source in the same transaction. */
export async function lockInboxSourceIfPresent(
  client: PoolClient,
  itemId: string,
  allowDeleted = false,
  lockMode?: "nowait",
): Promise<boolean> {
  // The interpolated suffix is either the fixed NOWAIT keyword or an empty string.
  const query = () =>
    client.query<{ id: string }>(
      `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
     WHERE i.id = $1 AND d.owner_module_id = 'inbox' AND ($2::boolean OR i.deleted_at IS NULL) FOR UPDATE OF i${lockMode === "nowait" ? " NOWAIT" : ""}`,
      [itemId, allowDeleted],
    );
  const result = lockMode === "nowait" ? await runValueLinkAdmissionLock(query) : await query();
  return result.rowCount === 1;
}

/** Hold a shared type lock, or report a busy type without aborting the caller's transaction. */
export async function tryLockInboxType(client: PoolClient, databaseId: string, itemId: string): Promise<boolean> {
  await client.query("SAVEPOINT inbox_type_lock");
  try {
    await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR SHARE NOWAIT", [
      databaseId,
      itemId,
    ]);
    await client.query("RELEASE SAVEPOINT inbox_type_lock");
    return true;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "55P03") throw error;
    await client.query("ROLLBACK TO SAVEPOINT inbox_type_lock");
    await client.query("RELEASE SAVEPOINT inbox_type_lock");
    return false;
  }
}

/** Reserve the bounded recognition choices and target databases without waiting on other writers. */
export async function tryReserveRecognitionResources(
  client: PoolClient,
  typesDatabaseId: string,
  typeIds: string[],
  databaseIds: string[],
): Promise<boolean> {
  await client.query("SAVEPOINT inbox_recognition_reservation");
  try {
    await client.query(
      "SELECT id FROM items WHERE database_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR SHARE NOWAIT",
      [typesDatabaseId, [...new Set(typeIds)].sort()],
    );
    await client.query("SELECT id FROM databases WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT", [
      [...new Set(databaseIds)].sort(),
    ]);
    await client.query("RELEASE SAVEPOINT inbox_recognition_reservation");
    return true;
  } catch (error) {
    if (!(error instanceof DatabaseError) || error.code !== "55P03") throw error;
    await client.query("ROLLBACK TO SAVEPOINT inbox_recognition_reservation");
    await client.query("RELEASE SAVEPOINT inbox_recognition_reservation");
    return false;
  }
}

/** Resolves only the bound selection after reserving its bounded current resources. */
export async function resolveBoundRecognition(
  client: PoolClient,
  typesDatabaseId: string,
  snapshot: TickSnapshot,
  result: ProposalComputationResult,
) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const originalCatalog = validRecognitionTypes(snapshot.activeTypes ?? []);
  const candidates = filterRecognitionCandidates(result.candidates, originalCatalog);
  const best = candidates[0];
  const offered = clarificationTypes(candidates, originalCatalog);
  const binding = result.recognitionBinding;
  if (
    best &&
    best.confidence >= RECOGNITION_CONFIDENCE_THRESHOLD &&
    (!binding || !isDeepStrictEqual(binding.candidate, best))
  )
    throw new Error("Recognition result lacks its original candidate binding");
  const [page] =
    binding?.type?.processingMethod === "pageContent" && result.target && UUID_RE.test(result.target)
      ? await itemsStore.getItemsByIds(client, [result.target])
      : [];
  const databaseIds = [binding?.targetDatabaseId, page?.databaseId].filter((id): id is string => Boolean(id));
  if (
    !(await tryReserveRecognitionResources(
      client,
      typesDatabaseId,
      offered.map((choice) => choice.typeId),
      databaseIds,
    ))
  )
    return null;
  const fresh = validRecognitionTypes(await listActiveInboxTypes(client, typesDatabaseId));
  const offeredIds = new Set(offered.map((choice) => choice.typeId));
  const catalog = fresh.filter((type) => offeredIds.has(type.id));
  const choices = clarificationTypes(candidates, catalog);
  const selected = best && "typeId" in best ? catalog.find((type) => type.id === best.typeId) : undefined;
  const originallySelected =
    best && "typeId" in best ? originalCatalog.find((type) => type.id === best.typeId) : undefined;
  const targetModule =
    originallySelected?.targetDatabaseKey ?? (best && "targetDatabaseKey" in best ? best.targetDatabaseKey : null);
  const database = targetModule ? await databasesStore.getDatabaseByModuleId(client, targetModule) : null;
  const pageDatabase = page ? await databasesStore.getDatabase(client, page.databaseId) : null;
  const [freshPage] = page ? await itemsStore.getItemsByIds(client, [page.id]) : [];
  const changed =
    !!best &&
    best.confidence >= RECOGNITION_CONFIDENCE_THRESHOLD &&
    (("typeId" in best &&
      (!selected ||
        !originallySelected ||
        !binding?.type ||
        selected.processingMethod !== originallySelected.processingMethod ||
        selected.targetDatabaseKey !== originallySelected.targetDatabaseKey ||
        binding.type.id !== originallySelected.id ||
        binding.type.processingMethod !== originallySelected.processingMethod ||
        binding.type.targetDatabaseKey !== originallySelected.targetDatabaseKey)) ||
      binding?.targetModuleId !== targetModule ||
      (!!targetModule && (!database || !!database.archivedAt || database.id !== binding?.targetDatabaseId)) ||
      (originallySelected?.processingMethod === "pageContent" &&
        (!page ||
          !freshPage ||
          freshPage.databaseId !== page.databaseId ||
          !pageDatabase ||
          !!pageDatabase.archivedAt)));
  return { best, choices, selected, database, targetModule, changed };
}
