import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient } from "../../chokePoint/chokePoint.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import { createCreateTranscriptionRouteHandler } from "../transcriptionRouteHandlers.js";

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/** Issue #180's `POST /api/transcriptions` handler, exercised directly (same pattern as `inboxRouteHandlers.test.ts`). */
describe("createCreateTranscriptionRouteHandler (issue #180)", () => {
  let filesId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    filesId = await databaseIdFor("files");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createFileItem(mimeType: string): Promise<string> {
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType, byteSize: 2048, storageKey: `test/${mimeType}/${Math.random()}` }),
    );
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: filesId,
        properties: { name: "clip", file: { blobId: blob.id } },
      }),
    );
    return item.id;
  }

  it("enqueues a transcription job for an explicitly requested video file", async () => {
    const fileItemId = await createFileItem("video/mp4");
    const handler = createCreateTranscriptionRouteHandler(pool);

    const result = await handler({ params: {}, body: { fileItemId } });

    expect(result.status).toBe(202);
  });

  it("returns 409 transcription_exists with the job id on a repeat request", async () => {
    const fileItemId = await createFileItem("video/mp4");
    const handler = createCreateTranscriptionRouteHandler(pool);

    await handler({ params: {}, body: { fileItemId } });
    const result = await handler({ params: {}, body: { fileItemId } });

    expect(result.status).toBe(409);
    const body = "body" in result ? (result.body as { error: { code: string; details: { id: string } } }) : undefined;
    expect(body?.error.code).toBe("transcription_exists");
    expect(typeof body?.error.details.id).toBe("string");
  });

  it("rejects a request missing fileItemId", async () => {
    const handler = createCreateTranscriptionRouteHandler(pool);
    await expect(handler({ params: {}, body: {} })).rejects.toThrow(ValidationError);
  });

  it("rejects an unknown file item id", async () => {
    const handler = createCreateTranscriptionRouteHandler(pool);
    await expect(handler({ params: {}, body: { fileItemId: "00000000-0000-0000-0000-000000000000" } })).rejects.toThrow(
      NotFoundError,
    );
  });
});
