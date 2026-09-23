import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { createComputedKeyRegistry, type ComputedKeyRegistry } from "../../chokePoint/computedKeyRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import {
  TRANSCRIPTION_CREATE_COMPUTED_KEY,
  TRANSCRIPTION_PREPARE_COMPUTED_KEY,
  TRANSCRIPTION_DIARIZE_COMPUTED_KEY,
  TRANSCRIPTION_ASR_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
  TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY,
} from "../transcriptionComputedKeys.js";

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/**
 * Issue #180's declared `items.computed` keys: registering them (seed/seedSystem.ts) must
 * actually reserve them against collision with a future property of the same name, on any
 * database — the guard `assertNoComputedKeyCollision` enforces is global, not Transcripts-only.
 */
describe("Transcripts computed key registration (issue #180)", () => {
  let computedKeyRegistry: ComputedKeyRegistry;
  let transcriptsId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    computedKeyRegistry = createComputedKeyRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry, computedKeyRegistry);
    transcriptsId = await databaseIdFor("transcripts");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it.each([
    TRANSCRIPTION_CREATE_COMPUTED_KEY,
    TRANSCRIPTION_PREPARE_COMPUTED_KEY,
    TRANSCRIPTION_DIARIZE_COMPUTED_KEY,
    TRANSCRIPTION_ASR_COMPUTED_KEY,
    TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
    TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY,
  ])("rejects a new property named %s as a computed-key collision", async (key) => {
    const chokePoint = createChokePoint(pool, computedKeyRegistry);
    await expect(
      chokePoint.createProperty({ databaseId: transcriptsId, key, name: key, type: "text", owner: "user" }),
    ).rejects.toThrow(/declared module cache key/i);
  });
});
