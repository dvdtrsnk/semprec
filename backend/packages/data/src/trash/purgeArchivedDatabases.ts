import type { Pool, PoolClient } from "pg";
import { currentTenantScope } from "@semprec/shared";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { runItemPurgeHooks } from "../chokePoint/hooks.js";
import { deleteItemDependents } from "../chokePoint/itemTrash.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { findRollupPropertiesOfOtherDatabasesDependingOn } from "../rollup/purgeDependencies.js";
import { RETENTION_DAYS } from "../trashRetention.js";
import { logger } from "./logger.js";

const ITEM_CHUNK_SIZE = 500;

/** `rootId` is the expired archived database; nested inline ones are purged under it. */
interface PurgeRun {
  pool: Pool;
  storage: BlobStorageWriter;
  alternateStorage: BlobStorageWriter | undefined;
  rootId: string;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** For log lines; the sweep always runs inside a tenant scope. */
function currentTenantId(): string | undefined {
  const scope = currentTenantScope();
  return scope?.kind === "tenant" ? scope.tenantId : undefined;
}

/**
 * After the commit and best-effort: a failure is logged and the sweep carries on, since the row is gone and the
 * bytes are unreachable.
 */
async function removeBlobBytes(run: PurgeRun, databaseId: string, keys: readonly string[]): Promise<void> {
  const targets =
    run.alternateStorage && run.alternateStorage !== run.storage ? [run.storage, run.alternateStorage] : [run.storage];
  for (const key of keys) {
    for (const target of targets) {
      try {
        await target.delete(key);
      } catch (err) {
        logger.error(
          { tenantId: currentTenantId(), databaseId, errorName: errorName(err), errCode: errorCode(err) },
          "Failed to delete blob bytes of a purged database",
        );
      }
    }
  }
}

/**
 * Returns the deleted blob rows' storage keys, or `null` when a restore committed first. The expiry is read under a
 * row lock held to the commit, so a restore cannot slip between check and delete.
 */
async function deleteItemChunk(
  run: PurgeRun,
  databaseId: string,
  itemIds: readonly string[],
): Promise<string[] | null> {
  return withTransaction(run.pool, async (client) => {
    if (!(await databasesStore.lockExpiredArchivedDatabase(client, run.rootId))) return null;
    const database = await databasesStore.getDatabase(client, databaseId);
    if (!database) throw new Error(`Database ${databaseId} disappeared during its purge`);
    const blobStorageKeys: string[] = [];
    for (const item of await itemsStore.hardDeleteItemsOfDatabase(client, databaseId, itemIds)) {
      blobStorageKeys.push(...(await deleteItemDependents(client, item)).blobStorageKeys);
      await runItemPurgeHooks({ client, database, item, rootItemId: item.id });
    }
    return blobStorageKeys;
  });
}

/**
 * Removes kept databases' schema that only made sense with `databaseId`: rollups over its relations or items, the
 * paired side of each of its relation properties, and one-directional relations targeting it. Returns the affected
 * database ids. The schema lock of a system database is not applied: the other side is being deleted, so nothing is
 * left for it to protect. Stored `computed` values of deleted rollups are left in place.
 */
async function removeDependentSchema(client: PoolClient, databaseId: string): Promise<Set<string>> {
  const rollups = await findRollupPropertiesOfOtherDatabasesDependingOn(client, databaseId);
  const paired = await relationsStore.listPairedPropertiesOfOtherDatabases(client, databaseId);
  const targeting = await relationsStore.listRelationPropertiesTargetingDatabase(client, databaseId);
  const doomed = [
    ...new Map([...rollups, ...paired, ...targeting].map((property) => [property.propertyId, property])).values(),
  ];
  await propertiesStore.deletePropertiesOfPurgedDatabase(
    client,
    doomed.map((property) => property.propertyId),
  );
  return new Set(doomed.map((property) => property.databaseId));
}

/** Runs when no item is left. Announces schema changes after the commit; false when no longer past the deadline. */
async function dropDatabase(run: PurgeRun, databaseId: string): Promise<boolean> {
  return withTransaction(run.pool, async (client) => {
    if (!(await databasesStore.lockExpiredArchivedDatabase(client, run.rootId))) return false;
    if ((await itemsStore.listItemIdsForPurge(client, databaseId, 1)).length > 0) {
      throw new Error(`Database ${databaseId} still holds items when its purge reached the drop`);
    }
    const changedDatabaseIds = await removeDependentSchema(client, databaseId);
    await databasesStore.deleteDatabaseWithItems(client, databaseId);
    runAfterCommit(client, () => {
      for (const id of [databaseId, ...changedDatabaseIds]) notifyInvalidation({ scope: "schema", databaseId: id });
    });
    return true;
  });
}

/**
 * Every step is its own idempotent transaction, so an interrupted run resumes: items go in chunks, inline databases
 * owned by a chunk's items first (depth first), and the database is dropped after its last item. `ancestors` stops
 * a corrupt owner cycle. False when the database stopped being expired.
 */
async function purgeDatabase(run: PurgeRun, databaseId: string, ancestors: ReadonlySet<string>): Promise<boolean> {
  if (ancestors.has(databaseId)) throw new Error(`Database ${databaseId} owns itself through its items`);
  const lineage = new Set(ancestors).add(databaseId);
  for (;;) {
    const itemIds = await itemsStore.listItemIdsForPurge(run.pool, databaseId, ITEM_CHUNK_SIZE);
    if (itemIds.length === 0) break;
    const inlineIds = await withTransaction(run.pool, (client) =>
      databasesStore.listInlineDatabaseIds(client, itemIds),
    );
    for (const inlineId of inlineIds) {
      if (!(await purgeDatabase(run, inlineId, lineage))) return false;
    }
    const blobStorageKeys = await deleteItemChunk(run, databaseId, itemIds);
    if (blobStorageKeys === null) return false;
    await removeBlobBytes(run, databaseId, blobStorageKeys);
  }
  return dropDatabase(run, databaseId);
}

/**
 * Purges every archived user database of the current tenant whose `purge_at` has passed, with items, edges,
 * dependent schema and blobs. Must run in a tenant scope (RLS limits every statement). A database
 * without a deadline first gets one `RETENTION_DAYS` 24-hour days from now. A failed database is logged and the
 * rest continue; failures are thrown together as one `AggregateError` (raw errors, must not be logged) so the task
 * retries. Returns how many root databases were fully purged.
 */
export async function purgeExpiredArchivedDatabases(
  pool: Pool,
  storage: BlobStorageWriter,
  alternateStorage?: BlobStorageWriter,
): Promise<number> {
  await withTransaction(pool, (client) => databasesStore.assignMissingPurgeDeadlines(client, RETENTION_DAYS));
  const expiredIds = await withTransaction(pool, (client) => databasesStore.listExpiredArchivedDatabaseIds(client));
  const failures: unknown[] = [];
  let purged = 0;
  for (const databaseId of expiredIds) {
    try {
      if (await purgeDatabase({ pool, storage, alternateStorage, rootId: databaseId }, databaseId, new Set()))
        purged += 1;
    } catch (err) {
      logger.error(
        { tenantId: currentTenantId(), databaseId, errorName: errorName(err), errCode: errorCode(err) },
        "Failed to purge an archived database",
      );
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `purgeExpiredArchivedDatabases: ${failures.length} databases failed`);
  }
  return purged;
}
