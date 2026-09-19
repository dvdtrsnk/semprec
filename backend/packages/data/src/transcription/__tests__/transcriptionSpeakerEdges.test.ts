import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient } from "../../chokePoint/chokePoint.js";
import { NotFoundError } from "../../errors.js";
import { getSpeakersRelationDefinitionId, writeTranscriptSpeakerEdge } from "../transcriptionSpeakerEdges.js";

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/** Issue #180's catalog contract: the `speakers` relation's edges carry `{speaker}` metadata. */
describe("writeTranscriptSpeakerEdge (issue #180)", () => {
  let transcriptsId: string;
  let peopleId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    transcriptsId = await databaseIdFor("transcripts");
    peopleId = await databaseIdFor("people");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createTranscriptItem(): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: transcriptsId, properties: { name: "Recording" } }),
    );
    return item.id;
  }

  async function createPersonItem(): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: peopleId, properties: { name: "Alice" } }),
    );
    return item.id;
  }

  it("resolves the speakers relation definition seeded by seedTenDatabases.ts", async () => {
    const relationDefinitionId = await withTransaction(pool, (client) => getSpeakersRelationDefinitionId(client));
    expect(typeof relationDefinitionId).toBe("string");
  });

  it("writes a valid {speaker} edge between a Transcripts item and a People item", async () => {
    const transcriptItemId = await createTranscriptItem();
    const personItemId = await createPersonItem();

    const edge = await withTransaction(pool, (client) =>
      writeTranscriptSpeakerEdge(client, { transcriptItemId, personItemId, speaker: "SPEAKER_00" }),
    );

    expect(edge.metadata).toEqual({ speaker: "SPEAKER_00" });
  });

  it("rejects an empty speaker label", async () => {
    const transcriptItemId = await createTranscriptItem();
    const personItemId = await createPersonItem();

    await expect(
      withTransaction(pool, (client) =>
        writeTranscriptSpeakerEdge(client, { transcriptItemId, personItemId, speaker: "" }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a personItemId that doesn't exist in People", async () => {
    const transcriptItemId = await createTranscriptItem();

    await expect(
      withTransaction(pool, (client) =>
        writeTranscriptSpeakerEdge(client, {
          transcriptItemId,
          personItemId: "00000000-0000-0000-0000-000000000000",
          speaker: "SPEAKER_00",
        }),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it("rejects a transcriptItemId that doesn't exist in Transcripts", async () => {
    const personItemId = await createPersonItem();

    await expect(
      withTransaction(pool, (client) =>
        writeTranscriptSpeakerEdge(client, {
          transcriptItemId: "00000000-0000-0000-0000-000000000000",
          personItemId,
          speaker: "SPEAKER_00",
        }),
      ),
    ).rejects.toThrow(NotFoundError);
  });
});
