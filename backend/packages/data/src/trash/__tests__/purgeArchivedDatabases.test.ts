import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { currentTenantScope, runInTenant } from "@semprec/shared";
import { createBlob } from "../../blobs/blobsStore.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { replaceCoverCandidates } from "../../library/coverCandidatesStore.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import * as realtimeHook from "../../realtimeHook.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { logger } from "../logger.js";
import { purgeExpiredArchivedDatabases } from "../purgeArchivedDatabases.js";
import { handleItemTrashPurgeSweepTask, RETENTION_DAYS } from "../purgeExpiredTrash.js";

// Passthrough spies, so a test can make one step of the purge fail or restore a database in the middle of it.
vi.mock("../../chokePoint/itemsStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../chokePoint/itemsStore.js")>();
  return {
    ...actual,
    findItemsDeletedBefore: vi.fn(actual.findItemsDeletedBefore),
    hardDeleteItemsOfDatabase: vi.fn(actual.hardDeleteItemsOfDatabase),
    listItemIdsForPurge: vi.fn(actual.listItemIdsForPurge),
  };
});
vi.mock("../../realtimeHook.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../realtimeHook.js")>();
  return { ...actual, notifyInvalidation: vi.fn(actual.notifyInvalidation) };
});

let adminPool: Pool;
let dataPool: Pool;
let chokePoint: ChokePoint;
let tenantId: string;

/** The most items one purge transaction deletes; `purgeArchivedDatabases.ts` keeps it private. */
const CHUNK = 500;

function fakeStorage(onDelete: (key: string) => Promise<void> = async () => {}) {
  const deleteMock = vi.fn(onDelete);
  const storage: BlobStorageWriter = {
    writeStream: () => Promise.reject(new Error("not used by the purge")),
    readStream: () => {
      throw new Error("not used by the purge");
    },
    delete: deleteMock,
  };
  return { storage, deleteMock };
}

/** Runs `fn` in the scope of `tenant`, the way the sweep does for each tenant. */
function inTenant<T>(fn: () => Promise<T>, tenant = tenantId): Promise<T> {
  return runInTenant(tenant, fn);
}

async function createDatabase(name: string, tenant = tenantId): Promise<string> {
  return inTenant(async () => (await chokePoint.createDatabase({ name })).id, tenant);
}

async function createItem(databaseId: string, properties: Record<string, unknown> = {}, tenant = tenantId) {
  return inTenant(async () => (await chokePoint.createItem({ databaseId, properties })).id, tenant);
}

/** Archives a database through the production write, then moves its archive time and deadline `days` days back. */
async function archive(databaseId: string, daysAgo: number, tenant = tenantId): Promise<void> {
  await inTenant(() => chokePoint.archiveDatabase(databaseId), tenant);
  // Time travel: the choke point stamps the transaction's now(), so an archive in the past needs raw SQL.
  await adminPool.query(
    `UPDATE databases SET archived_at = archived_at - make_interval(days => $2::int),
                          purge_at = purge_at - make_interval(days => $2::int)
      WHERE id = $1`,
    [databaseId, daysAgo],
  );
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await adminPool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params);
  return Number(rows[0]?.n);
}

const databaseExists = async (id: string): Promise<boolean> => (await count("databases WHERE id = $1", [id])) === 1;
const itemsOf = (databaseId: string): Promise<number> => count("items WHERE database_id = $1", [databaseId]);

async function partitionExists(databaseId: string): Promise<boolean> {
  const { rows } = await adminPool.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [
    `items_p_${databaseId.replace(/-/g, "")}`,
  ]);
  return rows[0]?.present === true;
}

async function purgeAtOf(databaseId: string): Promise<Date | null> {
  const { rows } = await adminPool.query<{ purge_at: Date | null }>("SELECT purge_at FROM databases WHERE id = $1", [
    databaseId,
  ]);
  return rows[0]?.purge_at ?? null;
}

/** A relation from `sourceId` to `targetId` with its inverse; returns both property ids. */
async function relate(sourceId: string, targetId: string, keys: { source: string; inverse: string }) {
  const result = await inTenant(() =>
    chokePoint.createRelationProperty({
      sourceDatabaseId: sourceId,
      key: keys.source,
      name: keys.source,
      targetDatabaseId: targetId,
      inverse: { key: keys.inverse, name: keys.inverse },
    }),
  );
  if (!result.inverseProperty) throw new Error("the relation has no inverse property");
  return { sourcePropertyId: result.property.id, inversePropertyId: result.inverseProperty.id };
}

async function createRollup(databaseId: string, key: string, config: Record<string, unknown>): Promise<string> {
  return inTenant(
    async () => (await chokePoint.createProperty({ databaseId, key, name: key, type: "rollup", config })).id,
  );
}

const propertyExists = async (id: string): Promise<boolean> => (await count("properties WHERE id = $1", [id])) === 1;

/** Runs the purge for `tenant` as the sweep does, through the runtime-role pool. */
async function sweep(storage: BlobStorageWriter, alternate?: BlobStorageWriter, tenant = tenantId): Promise<number> {
  return inTenant(() => purgeExpiredArchivedDatabases(dataPool, storage, alternate), tenant);
}

describe("purgeExpiredArchivedDatabases (issue gh-1875)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    chokePoint = createChokePoint(dataPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    await inTenant(() => seedSystem(dataPool));
    // A reset returns each passthrough spy to the real function and forgets what a test queued on it.
    vi.mocked(itemsStore.findItemsDeletedBefore).mockReset();
    vi.mocked(itemsStore.hardDeleteItemsOfDatabase).mockReset();
    vi.mocked(itemsStore.listItemIdsForPurge).mockReset();
    vi.mocked(realtimeHook.notifyInvalidation).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("deletes a database archived 31 days ago with its items, edges, paired properties, dependent rollups and blobs", async () => {
    const doomedId = await createDatabase("Doomed");
    const otherId = await createDatabase("Other");
    const { sourcePropertyId: doomedSidePropertyId, inversePropertyId: pairedPropertyId } = await relate(
      doomedId,
      otherId,
      { source: "others", inverse: "doomed" },
    );
    const relationDefinitionId = (
      await adminPool.query<{ id: string }>("SELECT id FROM relation_definitions WHERE property_id_a = $1", [
        doomedSidePropertyId,
      ])
    ).rows[0]?.id;
    const rollupId = await createRollup(otherId, "doomedCount", {
      relationPropertyKey: "doomed",
      aggregation: "count",
    });
    const ownRollupId = await createRollup(doomedId, "otherCount", {
      relationPropertyKey: "others",
      aggregation: "count",
    });
    const liveItemId = await createItem(doomedId);
    const trashedItemId = await createItem(doomedId);
    await inTenant(() => chokePoint.softDeleteItem(doomedId, trashedItemId));
    const otherItemId = await createItem(otherId);
    await inTenant(() =>
      chokePoint.createRelation({
        relationPropertyId: pairedPropertyId,
        callerItemId: otherItemId,
        targetItemId: liveItemId,
      }),
    );
    const blob = await inTenant(() =>
      createBlob(dataPool, { mimeType: "text/plain", byteSize: 3, storageKey: "doomed-key" }),
    );
    const fileItemId = await createItem(doomedId);
    // A Files-shaped property the API cannot set on a user database's item, so raw SQL.
    await adminPool.query(
      `UPDATE items SET properties = jsonb_build_object('file', jsonb_build_object('blobId', $2::text)) WHERE id = $1`,
      [fileItemId, blob.id],
    );
    await archive(doomedId, RETENTION_DAYS + 1);
    const { storage, deleteMock } = fakeStorage();

    const purged = await sweep(storage);

    expect(purged).toBe(1);
    expect(await databaseExists(doomedId)).toBe(false);
    expect(await partitionExists(doomedId)).toBe(false);
    expect(await count("items WHERE id = ANY($1::uuid[])", [[liveItemId, trashedItemId, fileItemId]])).toBe(0);
    expect(await count("item_relations WHERE item_a = $1 OR item_b = $1", [liveItemId])).toBe(0);
    expect(await count("relation_definitions WHERE id = $1", [relationDefinitionId])).toBe(0);
    expect(
      await count("rollup_dependencies WHERE rollup_property_id = ANY($1::uuid[])", [[rollupId, ownRollupId]]),
    ).toBe(0);
    expect(await propertyExists(pairedPropertyId)).toBe(false);
    expect(await propertyExists(rollupId)).toBe(false);
    expect(await propertyExists(ownRollupId)).toBe(false);
    expect(await count("blobs WHERE id = $1", [blob.id])).toBe(0);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith("doomed-key");
    // What belongs to the other database stays.
    expect(await databaseExists(otherId)).toBe(true);
    expect(await count("items WHERE id = $1", [otherItemId])).toBe(1);
    // Its paired relation property and its rollup were its only properties.
    expect(await count("properties WHERE database_id = $1", [otherId])).toBe(0);
  });

  it("announces a schema change for the dropped database and for each database whose schema changed, after the commit", async () => {
    const doomedId = await createDatabase("Doomed");
    const otherId = await createDatabase("Other");
    const untouchedId = await createDatabase("Untouched");
    await relate(doomedId, otherId, { source: "others", inverse: "doomed" });
    await archive(doomedId, RETENTION_DAYS + 1);
    vi.mocked(realtimeHook.notifyInvalidation).mockClear();

    await sweep(fakeStorage().storage);

    const announced = vi
      .mocked(realtimeHook.notifyInvalidation)
      .mock.calls.flatMap(([event]) => (event.scope === "schema" ? [event.databaseId] : []));
    expect(announced.sort()).toEqual([doomedId, otherId].sort());
    expect(announced).not.toContain(untouchedId);
  });

  it("keeps a database archived 29 days ago with everything, and a restore brings it back whole", async () => {
    const databaseId = await createDatabase("Recent");
    const itemId = await createItem(databaseId);
    await archive(databaseId, RETENTION_DAYS - 1);

    expect(await sweep(fakeStorage().storage)).toBe(0);

    expect(await databaseExists(databaseId)).toBe(true);
    expect(await count("items WHERE id = $1", [itemId])).toBe(1);
    await inTenant(() => chokePoint.restoreDatabase(databaseId));
    expect(await purgeAtOf(databaseId)).toBeNull();
  });

  it("stamps the deadline now plus RETENTION_DAYS days when a database is archived and clears it when it is restored", async () => {
    const databaseId = await createDatabase("Stamped");

    await inTenant(() => chokePoint.archiveDatabase(databaseId));
    const { rows } = await adminPool.query<{ days: number }>(
      "SELECT (extract(epoch FROM purge_at - archived_at) / 86400)::int AS days FROM databases WHERE id = $1",
      [databaseId],
    );
    expect(rows[0]?.days).toBe(RETENTION_DAYS);

    await inTenant(() => chokePoint.restoreDatabase(databaseId));
    expect(await purgeAtOf(databaseId)).toBeNull();
    expect(await count("databases WHERE id = $1 AND archived_at IS NULL", [databaseId])).toBe(1);
  });

  it("gives a database archived before the deadline existed one 30 days from the first sweep and deletes it no earlier", async () => {
    const databaseId = await createDatabase("Legacy");
    await inTenant(() => chokePoint.archiveDatabase(databaseId));
    // A database archived by the previous release has an archive time long ago and no deadline.
    await adminPool.query(
      "UPDATE databases SET archived_at = now() - interval '200 days', purge_at = NULL WHERE id = $1",
      [databaseId],
    );
    const before = Date.now();

    expect(await sweep(fakeStorage().storage)).toBe(0);

    const stamped = await purgeAtOf(databaseId);
    expect(stamped).not.toBeNull();
    const firstSweepToDeadlineDays = ((stamped?.getTime() ?? 0) - before) / 86_400_000;
    expect(firstSweepToDeadlineDays).toBeGreaterThan(RETENTION_DAYS - 0.01);
    expect(firstSweepToDeadlineDays).toBeLessThan(RETENTION_DAYS + 0.01);
    expect(await databaseExists(databaseId)).toBe(true);

    // The next sweep keeps the stamped deadline and still does not delete the database.
    expect(await sweep(fakeStorage().storage)).toBe(0);
    expect(await purgeAtOf(databaseId)).toEqual(stamped);
    expect(await databaseExists(databaseId)).toBe(true);

    // Once the stamped deadline has passed, the next sweep deletes it.
    await adminPool.query("UPDATE databases SET purge_at = now() - interval '1 minute' WHERE id = $1", [databaseId]);
    expect(await sweep(fakeStorage().storage)).toBe(1);
    expect(await databaseExists(databaseId)).toBe(false);
  });

  it("replaces a deadline that an older release left behind a restore and a new archive, instead of purging at once", async () => {
    // Archived under this release 40 days ago (deadline 10 days ago), then restored and archived again by a release
    // rolled back to, which writes `archived_at` only: the stale deadline is in the past, the new archive is minutes old.
    const pastId = await createDatabase("Re-archived, deadline past");
    const pastItemId = await createItem(pastId);
    await archive(pastId, RETENTION_DAYS + 10);
    await adminPool.query("UPDATE databases SET archived_at = NULL WHERE id = $1", [pastId]);
    await adminPool.query("UPDATE databases SET archived_at = now() - interval '5 minutes' WHERE id = $1", [pastId]);
    // The same, with a stale deadline that is still ahead but earlier than the new archive plus the retention.
    const aheadId = await createDatabase("Re-archived, deadline ahead");
    await archive(aheadId, RETENTION_DAYS - 10);
    await adminPool.query("UPDATE databases SET archived_at = NULL WHERE id = $1", [aheadId]);
    await adminPool.query("UPDATE databases SET archived_at = now() WHERE id = $1", [aheadId]);
    // A deadline this release stamped is not touched.
    const validId = await createDatabase("Archived by this release");
    await archive(validId, 3);
    const validDeadline = await purgeAtOf(validId);
    const before = Date.now();

    expect(await sweep(fakeStorage().storage)).toBe(0);

    expect(await databaseExists(pastId)).toBe(true);
    expect(await count("items WHERE id = $1", [pastItemId])).toBe(1);
    expect(await databaseExists(aheadId)).toBe(true);
    for (const id of [pastId, aheadId]) {
      const days = (((await purgeAtOf(id))?.getTime() ?? 0) - before) / 86_400_000;
      expect(days).toBeGreaterThan(RETENTION_DAYS - 0.01);
      expect(days).toBeLessThan(RETENTION_DAYS + 0.01);
    }
    expect(await purgeAtOf(validId)).toEqual(validDeadline);
  });

  it("stops a purge that is running when an older release restores and archives the database again", async () => {
    const databaseId = await createDatabase("Re-archived during its purge");
    const itemId = await createItem(databaseId);
    await archive(databaseId, RETENTION_DAYS + 1);
    const actualList = vi.mocked(itemsStore.listItemIdsForPurge).getMockImplementation();
    vi.mocked(itemsStore.listItemIdsForPurge).mockImplementationOnce(async (...args) => {
      // Committed after the selection: the deadline of the first archive is in the past, the new archive is now.
      await adminPool.query("UPDATE databases SET archived_at = NULL WHERE id = $1", [databaseId]);
      await adminPool.query("UPDATE databases SET archived_at = now() WHERE id = $1", [databaseId]);
      return actualList ? actualList(...args) : [];
    });

    expect(await sweep(fakeStorage().storage)).toBe(0);

    expect(await databaseExists(databaseId)).toBe(true);
    expect(await count("items WHERE id = $1", [itemId])).toBe(1);
    expect(itemsStore.hardDeleteItemsOfDatabase).not.toHaveBeenCalled();
  });

  it("removes a one-directional relation property of a kept database that targets the purged database, and its rollup", async () => {
    const doomedId = await createDatabase("Doomed");
    const keptId = await createDatabase("Kept");
    const thirdId = await createDatabase("Third");
    const oneWay = await inTenant(() =>
      chokePoint.createRelationProperty({
        sourceDatabaseId: keptId,
        key: "doomed",
        name: "doomed",
        targetDatabaseId: doomedId,
      }),
    );
    expect(oneWay.inverseProperty).toBeNull();
    const oneWayDefinitionId = (
      await adminPool.query<{ id: string }>("SELECT id FROM relation_definitions WHERE property_id_a = $1", [
        oneWay.property.id,
      ])
    ).rows[0]?.id;
    const rollupId = await createRollup(keptId, "doomedCount", { relationPropertyKey: "doomed", aggregation: "count" });
    const { sourcePropertyId: keptRelationId } = await relate(keptId, thirdId, { source: "third", inverse: "kept" });
    const doomedItemId = await createItem(doomedId);
    const keptItemId = await createItem(keptId);
    await inTenant(() =>
      chokePoint.createRelation({
        relationPropertyId: oneWay.property.id,
        callerItemId: keptItemId,
        targetItemId: doomedItemId,
      }),
    );
    await archive(doomedId, RETENTION_DAYS + 1);
    vi.mocked(realtimeHook.notifyInvalidation).mockClear();

    expect(await sweep(fakeStorage().storage)).toBe(1);

    expect(await databaseExists(doomedId)).toBe(false);
    expect(await propertyExists(oneWay.property.id)).toBe(false);
    expect(await count("relation_definitions WHERE id = $1", [oneWayDefinitionId])).toBe(0);
    expect(await count("item_relations WHERE item_a = $1 OR item_b = $1", [doomedItemId])).toBe(0);
    expect(await propertyExists(rollupId)).toBe(false);
    expect(await count("rollup_dependencies WHERE rollup_property_id = $1", [rollupId])).toBe(0);
    // No property of a kept database names the dropped database any more; the relation between kept ones stays.
    expect(await count("properties WHERE config->>'targetDatabaseId' = $1", [doomedId])).toBe(0);
    expect(await propertyExists(keptRelationId)).toBe(true);
    expect(await databaseExists(keptId)).toBe(true);
    expect(await count("items WHERE id = $1", [keptItemId])).toBe(1);
    const announced = vi
      .mocked(realtimeHook.notifyInvalidation)
      .mock.calls.flatMap(([event]) => (event.scope === "schema" ? [event.databaseId] : []));
    expect(announced.sort()).toEqual([doomedId, keptId].sort());
  });

  it("resumes an interrupted purge on the next run and leaves no dangling schema in between", async () => {
    const doomedId = await createDatabase("Big");
    const otherId = await createDatabase("Other");
    const { inversePropertyId: pairedPropertyId } = await relate(doomedId, otherId, {
      source: "others",
      inverse: "doomed",
    });
    // One more item than a chunk holds. Raw SQL, because 501 production writes would only slow the test down.
    await adminPool.query(
      "INSERT INTO items (database_id, tenant_id, properties) SELECT $1, $2, '{}'::jsonb FROM generate_series(1, $3::int)",
      [doomedId, tenantId, CHUNK + 1],
    );
    await archive(doomedId, RETENTION_DAYS + 1);
    const actualDelete = vi.mocked(itemsStore.hardDeleteItemsOfDatabase).getMockImplementation();
    vi.mocked(itemsStore.hardDeleteItemsOfDatabase)
      .mockImplementationOnce((...args) => (actualDelete ? actualDelete(...args) : Promise.resolve([])))
      .mockRejectedValueOnce(new Error("interrupted after the first chunk"));
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    const interrupted: unknown = await sweep(fakeStorage().storage).catch((err: unknown) => err);

    expect(interrupted).toBeInstanceOf(AggregateError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, databaseId: doomedId, errorName: "Error" }),
      "Failed to purge an archived database",
    );
    expect(await itemsOf(doomedId)).toBe(1);
    expect(await databaseExists(doomedId)).toBe(true);
    // The schema of the other database is removed only in the last transaction, so nothing dangles yet.
    expect(await propertyExists(pairedPropertyId)).toBe(true);

    expect(await sweep(fakeStorage().storage)).toBe(1);

    expect(await databaseExists(doomedId)).toBe(false);
    expect(await partitionExists(doomedId)).toBe(false);
    expect(await propertyExists(pairedPropertyId)).toBe(false);
  });

  it("purges the inline databases of the items first, with their items", async () => {
    const doomedId = await createDatabase("Pages");
    const pageId = await createItem(doomedId);
    const inlineId = await inTenant(
      async () => (await chokePoint.createInlineDatabase({ name: "Notes", parentItemId: pageId })).id,
    );
    const noteId = await createItem(inlineId);
    const nestedPageId = await createItem(inlineId);
    const nestedInlineId = await inTenant(
      async () => (await chokePoint.createInlineDatabase({ name: "Nested", parentItemId: nestedPageId })).id,
    );
    const nestedNoteId = await createItem(nestedInlineId);
    await archive(doomedId, RETENTION_DAYS + 1);

    expect(await sweep(fakeStorage().storage)).toBe(1);

    for (const id of [doomedId, inlineId, nestedInlineId]) {
      expect(await databaseExists(id)).toBe(false);
      expect(await partitionExists(id)).toBe(false);
    }
    expect(await count("items WHERE id = ANY($1::uuid[])", [[pageId, noteId, nestedPageId, nestedNoteId]])).toBe(0);
  });

  it("removes the paired property of a schema-locked database and keeps the relations and rollups between kept databases", async () => {
    const doomedId = await createDatabase("Doomed");
    const lockedId = await createDatabase("Locked");
    const thirdId = await createDatabase("Third");
    const { inversePropertyId: pairedPropertyId } = await relate(doomedId, lockedId, {
      source: "others",
      inverse: "doomed",
    });
    const { sourcePropertyId: keptRelationId, inversePropertyId: keptInverseId } = await relate(thirdId, lockedId, {
      source: "locked",
      inverse: "third",
    });
    const keptRollupId = await createRollup(thirdId, "lockedCount", {
      relationPropertyKey: "locked",
      aggregation: "count",
    });
    // A system database is schema-locked and a user's relation write cannot reach it, so the lock is set directly.
    await adminPool.query("UPDATE databases SET schema_locked = true WHERE id = $1", [lockedId]);
    await archive(doomedId, RETENTION_DAYS + 1);

    expect(await sweep(fakeStorage().storage)).toBe(1);

    expect(await propertyExists(pairedPropertyId)).toBe(false);
    for (const id of [keptRelationId, keptInverseId, keptRollupId]) expect(await propertyExists(id)).toBe(true);
    expect(await databaseExists(lockedId)).toBe(true);
    expect(await databaseExists(thirdId)).toBe(true);
  });

  it("runs the item purge hooks for each deleted item", async () => {
    const databaseId = await createDatabase("Books");
    const itemId = await createItem(databaseId);
    await inTenant(() =>
      withTransaction(dataPool, (client) =>
        replaceCoverCandidates(client, itemId, [
          { source: "openLibrary", title: "Cover", subtitle: null, imageUrl: "https://covers.example.test/a.jpg" },
        ]),
      ),
    );
    expect(await count("library_cover_candidates WHERE item_id = $1", [itemId])).toBe(1);
    await archive(databaseId, RETENTION_DAYS + 1);

    expect(await sweep(fakeStorage().storage)).toBe(1);

    expect(await count("library_cover_candidates WHERE item_id = $1", [itemId])).toBe(0);
  });

  it("stops at an inline database whose owner chain leads back to a database it is purging, and deletes nothing", async () => {
    const doomedId = await createDatabase("Cycle");
    const pageId = await createItem(doomedId);
    const inlineId = await inTenant(
      async () => (await chokePoint.createInlineDatabase({ name: "Notes", parentItemId: pageId })).id,
    );
    const noteId = await createItem(inlineId);
    // The cycle no write produces: the inline database's note owns the database that owns the inline database.
    await adminPool.query("UPDATE databases SET parent_item_id = $2 WHERE id = $1", [doomedId, noteId]);
    await archive(doomedId, RETENTION_DAYS + 1);
    vi.spyOn(logger, "error").mockImplementation(() => {});

    const error: unknown = await sweep(fakeStorage().storage).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AggregateError);
    expect(await databaseExists(doomedId)).toBe(true);
    expect(await databaseExists(inlineId)).toBe(true);
    expect(await count("items WHERE id = ANY($1::uuid[])", [[pageId, noteId]])).toBe(2);
  });

  it("does not delete an inline database or its owner when the archived database is restored while the inline one is purged", async () => {
    const doomedId = await createDatabase("Pages");
    const pageId = await createItem(doomedId);
    const inlineId = await inTenant(
      async () => (await chokePoint.createInlineDatabase({ name: "Notes", parentItemId: pageId })).id,
    );
    const noteId = await createItem(inlineId);
    await archive(doomedId, RETENTION_DAYS + 1);
    const actualList = vi.mocked(itemsStore.listItemIdsForPurge).getMockImplementation();
    // The first read lists the page; the second, of the inline database, is where the restore commits.
    vi.mocked(itemsStore.listItemIdsForPurge).mockImplementationOnce((...args) =>
      actualList ? actualList(...args) : Promise.resolve([]),
    );
    vi.mocked(itemsStore.listItemIdsForPurge).mockImplementationOnce(async (...args) => {
      await inTenant(() => chokePoint.restoreDatabase(doomedId));
      return actualList ? actualList(...args) : [];
    });

    expect(await sweep(fakeStorage().storage)).toBe(0);

    expect(await databaseExists(inlineId)).toBe(true);
    expect(await count("items WHERE id = ANY($1::uuid[])", [[pageId, noteId]])).toBe(2);
  });

  it("does not delete a database that is restored between the selection and its first chunk", async () => {
    const databaseId = await createDatabase("Restored in time");
    const itemId = await createItem(databaseId);
    await archive(databaseId, RETENTION_DAYS + 1);
    const actualList = vi.mocked(itemsStore.listItemIdsForPurge).getMockImplementation();
    vi.mocked(itemsStore.listItemIdsForPurge).mockImplementationOnce(async (...args) => {
      await inTenant(() => chokePoint.restoreDatabase(databaseId));
      return actualList ? actualList(...args) : [];
    });

    expect(await sweep(fakeStorage().storage)).toBe(0);

    expect(await count("items WHERE id = $1", [itemId])).toBe(1);
    expect(await databaseExists(databaseId)).toBe(true);
    expect(itemsStore.hardDeleteItemsOfDatabase).not.toHaveBeenCalled();
  });

  it("does not drop a database that is restored after its last item went and before the drop", async () => {
    const databaseId = await createDatabase("Restored late");
    const otherId = await createDatabase("Other");
    const { inversePropertyId: pairedPropertyId } = await relate(databaseId, otherId, {
      source: "others",
      inverse: "late",
    });
    await archive(databaseId, RETENTION_DAYS + 1);
    const actualList = vi.mocked(itemsStore.listItemIdsForPurge).getMockImplementation();
    vi.mocked(itemsStore.listItemIdsForPurge).mockImplementationOnce(async (...args) => {
      // The first read finds no item, so the next step is the drop; a restore commits before it.
      await inTenant(() => chokePoint.restoreDatabase(databaseId));
      return actualList ? actualList(...args) : [];
    });

    expect(await sweep(fakeStorage().storage)).toBe(0);

    expect(await databaseExists(databaseId)).toBe(true);
    expect(await partitionExists(databaseId)).toBe(true);
    expect(await propertyExists(pairedPropertyId)).toBe(true);
  });

  it("never selects a system database, even one with an expired deadline, and leaves another tenant's databases alone", async () => {
    const tasks = (
      await adminPool.query<{ id: string }>("SELECT id FROM databases WHERE tenant_id = $1 AND key = 'tasks'", [
        tenantId,
      ])
    ).rows[0]?.id;
    if (!tasks) throw new Error("no tasks database");
    // A system database cannot be archived through the choke point; raw SQL builds the state the filter guards against.
    await adminPool.query(
      "UPDATE databases SET archived_at = now() - interval '90 days', purge_at = now() - interval '60 days' WHERE id = $1",
      [tasks],
    );
    const otherTenantId = await createTestTenant(adminPool);
    await inTenant(() => seedSystem(dataPool), otherTenantId);
    const foreignId = await createDatabase("Foreign", otherTenantId);
    const foreignItemId = await createItem(foreignId, {}, otherTenantId);
    await archive(foreignId, RETENTION_DAYS + 1, otherTenantId);
    const ownId = await createDatabase("Own");
    await archive(ownId, RETENTION_DAYS + 1);

    // The selection itself leaves the system database out; the row lock repeats the filter, so the outcome alone
    // would not show a missing filter in the selection.
    const selected = await inTenant(() =>
      withTransaction(dataPool, (client) => databasesStore.listExpiredArchivedDatabaseIds(client)),
    );
    expect(selected).toEqual([ownId]);

    expect(await sweep(fakeStorage().storage)).toBe(1);

    expect(vi.mocked(itemsStore.listItemIdsForPurge).mock.calls.map(([, databaseId]) => databaseId)).not.toContain(
      tasks,
    );
    expect(await databaseExists(ownId)).toBe(false);
    expect(await databaseExists(tasks)).toBe(true);
    expect(await purgeAtOf(tasks)).not.toBeNull();
    expect(await databaseExists(foreignId)).toBe(true);
    expect(await count("items WHERE id = $1", [foreignItemId])).toBe(1);
    // A system database's missing deadline is not stamped either.
    await adminPool.query("UPDATE databases SET purge_at = NULL WHERE id = $1", [tasks]);
    await sweep(fakeStorage().storage);
    expect(await purgeAtOf(tasks)).toBeNull();
  });

  it("completes the purge when removing the bytes of a blob fails, and logs the ids only", async () => {
    const databaseId = await createDatabase("Files");
    const blob = await inTenant(() =>
      createBlob(dataPool, { mimeType: "text/plain", byteSize: 3, storageKey: "secret-key" }),
    );
    const itemId = await createItem(databaseId);
    await adminPool.query(
      `UPDATE items SET properties = jsonb_build_object('file', jsonb_build_object('blobId', $2::text)) WHERE id = $1`,
      [itemId, blob.id],
    );
    await archive(databaseId, RETENTION_DAYS + 1);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { storage, deleteMock } = fakeStorage(async () => {
      throw new Error("storage down");
    });
    const alternate = fakeStorage();

    expect(await sweep(storage, alternate.storage)).toBe(1);

    expect(await databaseExists(databaseId)).toBe(false);
    expect(deleteMock).toHaveBeenCalledWith("secret-key");
    // A failure of one storage does not skip the other.
    expect(alternate.deleteMock).toHaveBeenCalledWith("secret-key");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, databaseId, errorName: "Error" }),
      "Failed to delete blob bytes of a purged database",
    );
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain("secret-key");
    expect(logged).not.toContain("storage down");
  });

  it("purges the other databases and fails the call at the end when one database cannot be purged", async () => {
    const brokenId = await createDatabase("Broken");
    await createItem(brokenId);
    const fineId = await createDatabase("Fine");
    await archive(brokenId, RETENTION_DAYS + 2);
    await archive(fineId, RETENTION_DAYS + 1);
    const actualDelete = vi.mocked(itemsStore.hardDeleteItemsOfDatabase).getMockImplementation();
    vi.mocked(itemsStore.hardDeleteItemsOfDatabase).mockImplementation((client, databaseId, itemIds) =>
      databaseId === brokenId
        ? Promise.reject(new Error("cannot delete"))
        : actualDelete
          ? actualDelete(client, databaseId, itemIds)
          : Promise.resolve([]),
    );
    vi.spyOn(logger, "error").mockImplementation(() => {});

    const error: unknown = await sweep(fakeStorage().storage).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AggregateError);
    expect(await databaseExists(fineId)).toBe(false);
    expect(await databaseExists(brokenId)).toBe(true);
  });

  describe("handleItemTrashPurgeSweepTask", () => {
    async function trashedItemOfLiveDatabase(tenant: string): Promise<{ databaseId: string; itemId: string }> {
      const databaseId = await createDatabase("Live", tenant);
      const itemId = await createItem(databaseId, {}, tenant);
      await inTenant(() => chokePoint.softDeleteItem(databaseId, itemId), tenant);
      // Time travel for the trash, as for the archive.
      await adminPool.query("UPDATE items SET deleted_at = now() - interval '40 days' WHERE id = $1", [itemId]);
      return { databaseId, itemId };
    }

    it("purges expired items and expired archived databases of every active tenant, one stage after the other", async () => {
      const otherTenantId = await createTestTenant(adminPool);
      await inTenant(() => seedSystem(dataPool), otherTenantId);
      const trashed = await trashedItemOfLiveDatabase(tenantId);
      const ownId = await createDatabase("Archived");
      await archive(ownId, RETENTION_DAYS + 1);
      const foreignId = await createDatabase("Foreign archived", otherTenantId);
      await archive(foreignId, RETENTION_DAYS + 1, otherTenantId);

      await handleItemTrashPurgeSweepTask(dataPool, fakeStorage().storage);

      expect(await count("items WHERE id = $1", [trashed.itemId])).toBe(0);
      expect(await databaseExists(trashed.databaseId)).toBe(true);
      expect(await databaseExists(ownId)).toBe(false);
      expect(await databaseExists(foreignId)).toBe(false);
    });

    it("purges the archived databases of a tenant whose item purge failed, and fails the task", async () => {
      const ownId = await createDatabase("Archived");
      await archive(ownId, RETENTION_DAYS + 1);
      const actualFind = vi.mocked(itemsStore.findItemsDeletedBefore).getMockImplementation();
      // The tenants run in a rotating order, so the failure is bound to this test's tenant and not to the first call.
      vi.mocked(itemsStore.findItemsDeletedBefore).mockImplementation((...args) => {
        const scope = currentTenantScope();
        if (scope?.kind === "tenant" && scope.tenantId === tenantId)
          return Promise.reject(new Error("item stage down"));
        return actualFind ? actualFind(...args) : Promise.resolve([]);
      });
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

      const error: unknown = await handleItemTrashPurgeSweepTask(dataPool, fakeStorage().storage).catch(
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(AggregateError);
      expect(await databaseExists(ownId)).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith({ tenantId, errorName: "Error" }, "Item purge stage failed");
    });

    it("purges the expired items of a tenant whose archived database purge failed, and fails the task", async () => {
      const trashed = await trashedItemOfLiveDatabase(tenantId);
      const brokenId = await createDatabase("Broken");
      await createItem(brokenId);
      await archive(brokenId, RETENTION_DAYS + 1);
      vi.mocked(itemsStore.hardDeleteItemsOfDatabase).mockRejectedValue(new Error("database stage down"));
      vi.spyOn(logger, "error").mockImplementation(() => {});

      const error: unknown = await handleItemTrashPurgeSweepTask(dataPool, fakeStorage().storage).catch(
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(AggregateError);
      expect(await count("items WHERE id = $1", [trashed.itemId])).toBe(0);
      expect(await databaseExists(brokenId)).toBe(true);
    });
  });
});
