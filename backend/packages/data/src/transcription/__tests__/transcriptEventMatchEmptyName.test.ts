import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";

// A catalog that renders the fallback name as nothing, which a shipped catalog never does.
vi.mock("../transcriptionLabels.js", () => ({ renderTranscriptionLabel: vi.fn(async () => "  ") }));

const { matchTranscriptToEvent } = await import("../transcriptEventMatch.js");

describe("a proposed new meeting is never nameless (issue #1830)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("throws and writes no card when neither a name, a generated title nor the day-and-month fallback is available", async () => {
    const databases = await pool.query<{ id: string; owner_module_id: string }>(
      "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
      [["transcripts", "processingProposals"]],
    );
    const idOf = (moduleId: string) => {
      const row = databases.rows.find((database) => database.owner_module_id === moduleId);
      if (!row) throw new Error(`Database '${moduleId}' was not seeded`);
      return row.id;
    };
    const transcript = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: idOf("transcripts"), properties: { date: "2024-03-01T12:00:00.000Z" } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      ),
    );

    await expect(
      withTransaction(pool, (client) =>
        matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 3600 }),
      ),
    ).rejects.toThrow("A proposed meeting needs a non-empty name");

    const cards = await pool.query("SELECT 1 FROM items WHERE database_id = $1", [idOf("processingProposals")]);
    expect(cards.rowCount).toBe(0);
  });
});
