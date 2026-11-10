import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { getItemById, writeComputed } from "../../chokePoint/itemsStore.js";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { runTranscriptDurationBackfillCutoverMigration } from "../transcriptDurationBackfillCutoverMigration.js";

describe("transcript duration backfill", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = getTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
  });
  afterAll(async () => {
    await pool.end();
  });

  it("copies a linked checkpoint, skips missing checkpoints, preserves existing values and is idempotent", async () => {
    const fixture = await withTransaction(pool, async (client) => {
      const files = await getDatabaseByModuleId(client, "files");
      const transcripts = await getDatabaseByModuleId(client, "transcripts");
      if (!files || !transcripts) throw new Error("Missing seeded databases");
      const file = await createItemWithClient(client, { databaseId: files.id, properties: {} });
      await writeComputed(client, files.id, file.id, "prepare", { durationSeconds: 42 });
      const ids: string[] = [];
      for (const link of [
        `semprec://items/${file.id}`,
        "semprec://items/00000000-0000-4000-8000-000000000000",
        `semprec://items/${file.id}`,
      ]) {
        const item = await createItemWithClient(
          client,
          { databaseId: transcripts.id, properties: { link } },
          { allowedSystemKeys: ["link"], systemOwnerProcess: "transcribe" },
        );
        ids.push(item.id);
      }
      await writeComputed(client, transcripts.id, ids[2]!, "durationSeconds", 99);
      return { databaseId: transcripts.id, ids };
    });
    async function read() {
      return withTransaction(pool, async (client) =>
        Promise.all(fixture.ids.map((id) => getItemById(client, fixture.databaseId, id))),
      );
    }
    await runTranscriptDurationBackfillCutoverMigration(pool);
    const first = await read();
    expect(first.map((item) => item?.computed.durationSeconds)).toEqual([42, undefined, 99]);
    await runTranscriptDurationBackfillCutoverMigration(pool);
    expect(await read()).toEqual(first);
  });

  it("skips a tenant without seeded databases", async () => {
    await resetDatabase(pool);
    await expect(runTranscriptDurationBackfillCutoverMigration(pool)).resolves.toBeUndefined();
  });
});
