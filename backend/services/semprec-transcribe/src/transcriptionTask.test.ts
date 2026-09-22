import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createBlob,
  createItemWithClient,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  getItemById,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createTranscriptionTask } from "./transcriptionTask.js";

let pool: Pool;

describe("transcription step 0", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates one pending transcript with the source values and skips its checkpoint on replay", async () => {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    if (!files) throw new Error("Files database was not seeded");
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "audio/mpeg", byteSize: 1, storageKey: "test/recording" }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "recording.mp3", file: { blobId: blob.id } },
      }),
    );
    const task = createTranscriptionTask(pool);

    await task({ fileItemId: file.id });
    await task({ fileItemId: file.id });

    const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
    if (!transcripts) throw new Error("Transcripts database was not seeded");
    const { rows } = await pool.query<{ id: string; properties: Record<string, unknown> }>(
      "SELECT id, properties FROM items WHERE database_id = $1",
      [transcripts.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.properties).toMatchObject({
      name: "recording.mp3",
      status: "processing",
      link: `semprec://items/${file.id}`,
    });
    const source = await withTransaction(pool, (client) => getItemById(client, files.id, file.id));
    expect(source?.computed.create).toBe(rows[0]?.id);
    const { rows: automationRows } = await pool.query<{ status: string }>(
      "SELECT status FROM item_automation WHERE item_id = $1",
      [rows[0]?.id],
    );
    expect(automationRows).toEqual([{ status: "pending" }]);
  });
});
