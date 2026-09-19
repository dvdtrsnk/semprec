import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient, createRelationWithClient } from "../../chokePoint/chokePoint.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { EMAILS_RELATION_CONTEXT } from "../../mail/emailsRelationContext.js";
import { createFilesTranscriptionTriggerAction } from "../transcriptionActions.js";
import { transcriptionJobKey } from "../transcriptionJob.js";

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function jobExists(key: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM graphile_worker.jobs WHERE key = $1`, [key]);
  return rows.length > 0;
}

async function jobCount(key: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE key = $1`, [key]);
  return rows[0]?.count ?? 0;
}

/**
 * Issue #180's Files `onItemEvent:create` trigger, exercised directly against the action
 * handler (the same pattern `inboxTickAction`'s own tests use) rather than through the queue's
 * heartbeat-fire machinery, which is covered separately.
 */
describe("Files transcription trigger (issue #180)", () => {
  let viewTypeRegistry: ViewTypeRegistry;
  let filesId: string;
  let emailsId: string;
  let attachmentsPropertyId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    filesId = await databaseIdFor("files");
    emailsId = await databaseIdFor("emails");
    const attachmentsProperty = await withTransaction(pool, (client) =>
      propertiesStore.getPropertyByKey(client, emailsId, "attachments"),
    );
    if (!attachmentsProperty) throw new Error("Emails.attachments property was not seeded");
    attachmentsPropertyId = attachmentsProperty.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  function actionConfig() {
    return { filesDatabaseId: filesId, attachmentsRelationPropertyId: attachmentsPropertyId };
  }

  async function createFileItem(mimeType: string): Promise<string> {
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType, byteSize: 1024, storageKey: `test/${mimeType}/${Math.random()}` }),
    );
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: filesId,
        properties: { name: "recording", file: { blobId: blob.id } },
      }),
    );
    return item.id;
  }

  it("enqueues a transcription job once for a standalone audio recording", async () => {
    const fileItemId = await createFileItem("audio/mpeg");
    const handler = createFilesTranscriptionTriggerAction(pool);

    await handler(actionConfig(), { heartbeatId: "hb", projectItemId: "proj", itemId: fileItemId });

    expect(await jobExists(transcriptionJobKey(fileItemId))).toBe(true);
  });

  it("does not enqueue for a file with an Emails.attachments edge", async () => {
    const fileItemId = await createFileItem("audio/mpeg");
    const emailItem = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: emailsId, properties: {} }),
    );
    await withTransaction(pool, (client) =>
      createRelationWithClient(
        client,
        { relationPropertyId: attachmentsPropertyId, callerItemId: emailItem.id, targetItemId: fileItemId },
        EMAILS_RELATION_CONTEXT,
      ),
    );
    const handler = createFilesTranscriptionTriggerAction(pool);

    await handler(actionConfig(), { heartbeatId: "hb", projectItemId: "proj", itemId: fileItemId });

    expect(await jobExists(transcriptionJobKey(fileItemId))).toBe(false);
  });

  it("does not enqueue for a non-audio file", async () => {
    const fileItemId = await createFileItem("application/pdf");
    const handler = createFilesTranscriptionTriggerAction(pool);

    await handler(actionConfig(), { heartbeatId: "hb", projectItemId: "proj", itemId: fileItemId });

    expect(await jobExists(transcriptionJobKey(fileItemId))).toBe(false);
  });

  it("converges repeated delivery on one job", async () => {
    const fileItemId = await createFileItem("audio/mpeg");
    const handler = createFilesTranscriptionTriggerAction(pool);

    await handler(actionConfig(), { heartbeatId: "hb", projectItemId: "proj", itemId: fileItemId });
    await handler(actionConfig(), { heartbeatId: "hb", projectItemId: "proj", itemId: fileItemId });

    expect(await jobCount(transcriptionJobKey(fileItemId))).toBe(1);
  });
});
