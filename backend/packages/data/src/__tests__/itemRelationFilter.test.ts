import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, createItemWithClient, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { ITEM_RELATION_FILTER_QUERY } from "../scheduler/itemRelationFilter.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";

let pool: Pool;
let chokePoint: ChokePoint;

const noopStorage: BlobStorageWriter = {
  async writeStream(_key, source) {
    let byteSize = 0;
    const hash = createHash("sha256");
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      byteSize += (chunk as Buffer).length;
    }
    return { byteSize, contentHash: hash.digest("hex") };
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/**
 * Recursively collects every base-table scan actually executed (`Actual Loops` > 0) anywhere in
 * an `EXPLAIN ANALYZE` plan tree, keyed by `Relation Name`. Partitions the planner statically
 * lists as candidates but the executor skips at runtime (partition pruning) report `Actual
 * Loops: 0` and are excluded — this is why the test needs ANALYZE rather than a plain EXPLAIN:
 * the `related.database_id = op.database_id` join value isn't known until execution, so the
 * planner can only prune at runtime, not at plan time.
 */
function collectExecutedRelationNames(plan: Record<string, unknown>, acc: Set<string>): void {
  const relationName = plan["Relation Name"];
  const actualLoops = plan["Actual Loops"];
  if (typeof relationName === "string" && typeof actualLoops === "number" && actualLoops > 0) {
    acc.add(relationName);
  }
  const subPlans = plan.Plans;
  if (Array.isArray(subPlans)) {
    for (const sub of subPlans) collectExecutedRelationNames(sub as Record<string, unknown>, acc);
  }
}

describe("itemRelationFilter partition pruning (issue #262)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("only scans the related item's own items_p_* partition, not every database's partition", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;

    const inbox = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "inbox", behavior: "folder", specialPurpose: "inbox" } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      ),
    );

    const { itemId: emailItemId } = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: inbox.id,
        messageId: "<pruning1@example.com>",
        subject: "Hello",
        envelope: { from: { address: "alice@example.com", name: "Alice" }, to: [{ address: "bob@example.com" }] },
        bodyText: "hi",
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
      }),
    );

    const { rows: partitionRows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'items\\_p\\_%'`,
    );
    // Every module seedSystem sets up (Folders, Emails, Files, People, Projects, ...) got its own
    // partition — several distinct `items_p_*` tables exist here, so pruning down to one is a
    // meaningful assertion, not a vacuous one.
    expect(partitionRows.length).toBeGreaterThan(1);
    const foldersPartition = `items_p_${foldersId.replace(/-/g, "")}`;
    expect(partitionRows.map((r) => r.tablename)).toContain(foldersPartition);

    const { rows: explainRows } = await pool.query<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${ITEM_RELATION_FILTER_QUERY}`,
      [folderProperty.id, "specialPurpose", emailItemId],
    );
    const plan = explainRows[0]!["QUERY PLAN"][0]!.Plan;
    const relationNames = new Set<string>();
    collectExecutedRelationNames(plan, relationNames);

    const scannedItemsPartitions = [...relationNames].filter((name) => name.startsWith("items_p_"));
    expect(scannedItemsPartitions).toEqual([foldersPartition]);
  });
});
