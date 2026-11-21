import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
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

/** Every executed (`Actual Loops` > 0) scan of `items` in an `EXPLAIN ANALYZE` plan tree, as `Node Type` and index. */
function collectExecutedItemsScans(plan: Record<string, unknown>, acc: string[]): void {
  const actualLoops = plan["Actual Loops"];
  if (plan["Relation Name"] === "items" && typeof actualLoops === "number" && actualLoops > 0) {
    const parts = [plan["Node Type"], plan["Index Name"]].filter((part) => typeof part === "string");
    acc.push(parts.join(" "));
  }
  const subPlans = plan.Plans;
  if (Array.isArray(subPlans)) {
    for (const sub of subPlans) collectExecutedItemsScans(sub as Record<string, unknown>, acc);
  }
}

describe("itemRelationFilter related-item lookup (issue #262)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("probes the related item by index instead of scanning items", async () => {
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

    const { itemId: emailItemId } = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          arrival: "live",
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: inbox.id,
          mailboxItemId: randomUUID(),
          messageId: "<pruning1@example.com>",
          subject: "Hello",
          envelope: { from: { address: "alice@example.com", name: "Alice" }, to: [{ address: "bob@example.com" }] },
          bodyText: "hi",
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
        }),
      ),
    );

    // A seeded tenant holds too few items for the planner to prefer an index; with sequential scans disabled it
    // shows the probe it takes once items grow.
    const explainRows = await withTransaction(pool, async (client) => {
      await client.query("SET LOCAL enable_seqscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${ITEM_RELATION_FILTER_QUERY}`,
        [folderProperty.id, "specialPurpose", emailItemId],
      );
      return rows;
    });
    const plan = explainRows[0]!["QUERY PLAN"][0]!.Plan;
    const scans: string[] = [];
    collectExecutedItemsScans(plan, scans);
    expect(scans).toEqual([expect.stringMatching(/^Index Scan items_(pkey|database_id_id_idx)$/)]);

    const { rows } = await pool.query<{ value: string | null }>(ITEM_RELATION_FILTER_QUERY, [
      folderProperty.id,
      "specialPurpose",
      emailItemId,
    ]);
    expect(rows).toEqual([{ value: "inbox" }]);
  });
});
