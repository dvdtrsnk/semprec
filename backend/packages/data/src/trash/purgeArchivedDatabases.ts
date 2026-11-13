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

/** The most items one purge transaction deletes. */
const ITEM_CHUNK_SIZE = 500;

/** What every step of one purge needs; `rootId` is the archived database that expired, the nested ones included. */
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

/** The tenant of the current scope, for log lines; the sweep always runs inside one. */
function currentTenantId(): string | undefined {
  const scope = currentTenantScope();
  return scope?.kind === "tenant" ? scope.tenantId : undefined;
}

/**
 * Removes the bytes of the blob rows a committed chunk deleted, from each distinct configured storage, after the
 * commit and best-effort (docs/adr/2026-09-28-blob-bytes-deleted-best-effort-after-the-commit.md): a failure is
 * logged with the ids and the sweep carries on, since the row is gone and the bytes are unreachable.
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
 * One transaction of the purge: deletes the named items of `databaseId` with everything that depends on them and
 * returns the storage keys of the blob rows that went with them, or `null` when the archived database is no longer
 * past its deadline (a restore committed first). The expiry is read under a row lock held to the commit, so the
 * check and the delete cannot be separated by a restore.
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
 * Removes from the databases that are kept the schema that only made sense with `databaseId`, and returns the
 * ids of those databases. It deletes, each with its dependency rows (they go with their property by foreign key):
 *
 * - the rollup properties of other databases that run over a relation property of `databaseId` or aggregate its
 *   items; a rollup aggregates a plain property, never another rollup or a relation, so no further rollup depends
 *   on one removed here;
 * - the paired side, in another database, of every relation property of `databaseId`; its relation definition and
 *   edges go with it;
 * - every other relation property of another database whose target is `databaseId`: a one-directional relation has
 *   no property in `databaseId`, so the paired side above never meets it, and it would point at a dropped database.
 *
 * `propertiesStore.deletePropertiesOfPurgedDatabase` does not apply the schema lock of the database that holds a
 * paired property: a schema-locked system database refuses a schema change by a user, but the relation property it
 * holds is one side of a relation whose other side is being deleted, so nothing is left for the lock to protect
 * and the property would otherwise point at a database that no longer exists. Values that other items stored for a
 * deleted rollup (`computed`) are left in place.
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

/**
 * The last transaction of the purge of `databaseId`, run when no item is left: removes the schema of other databases
 * that depended on it, drops the database with its partition and announces the schema change of the dropped database
 * and of every database whose schema changed after the commit. Returns false when the archived database is no longer
 * past its deadline.
 */
async function dropDatabase(run: PurgeRun, databaseId: string): Promise<boolean> {
  return withTransaction(run.pool, async (client) => {
    if (!(await databasesStore.lockExpiredArchivedDatabase(client, run.rootId))) return false;
    if ((await itemsStore.listItemIdsForPurge(client, databaseId, 1)).length > 0) {
      throw new Error(`Database ${databaseId} still holds items when its purge reached the drop`);
    }
    const changedDatabaseIds = await removeDependentSchema(client, databaseId);
    await databasesStore.dropDatabaseWithPartition(client, databaseId);
    runAfterCommit(client, () => {
      for (const id of [databaseId, ...changedDatabaseIds]) notifyInvalidation({ scope: "schema", databaseId: id });
    });
    return true;
  });
}

/**
 * Deletes `databaseId`, an expired archived database or an inline database owned by one of its items, and returns
 * false when the archived database stopped being expired before the end. Every step is its own transaction and
 * repeats safely, so an interrupted run continues where it stopped: items are deleted in chunks of at most
 * `ITEM_CHUNK_SIZE` and a database is dropped only after its last item went. The inline databases owned by the
 * items of a chunk are purged first, depth first, by this same procedure; `ancestors` stops a corrupt owner cycle.
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
 * The purge of archived databases (issue gh-1875) for the tenant of the current scope: it deletes every archived user
 * database whose deadline (`databases.purge_at`) has passed, with its items, its edges to other databases, the schema
 * of other databases that depended on it, its blobs and its partition. Call it inside a tenant scope: row-level
 * security limits every statement to that tenant, and `handleItemTrashPurgeSweepTask` calls it once per active tenant
 * after the item purge.
 *
 * First it gives an archived database that has no deadline one, `RETENTION_DAYS` days of 24 hours from now: a database
 * archived before the deadline existed is deleted no earlier than that long after the first sweep that sees it. System
 * databases are never selected. A database whose purge fails is logged with the tenant and database ids and the next
 * database is purged; when the loop ends, the failures are thrown together as one `AggregateError` (its errors are
 * the raw ones and must not be logged) so the task is retried. The bytes of the blobs deleted with the items are
 * removed from `storage` and from `alternateStorage` after each chunk commits, best-effort. Returns how many expired
 * databases it purged completely; the inline databases purged with them are not counted.
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
