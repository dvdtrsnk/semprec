import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { EMAILS_RELATION_CONTEXT } from "../../mail/emailsRelationContext.js";
import { createFilesTranscriptionTriggerAction } from "../transcriptionActions.js";
import { transcriptionJobKey } from "../transcriptionJob.js";
import { recordRecordingIntake } from "../recordingIntake.js";

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

  it("enqueues both tenant-scoped lanes for audio and neither for a non-audio file", async () => {
    const audio = await createFileItem("audio/mpeg");
    const document = await createFileItem("application/pdf");
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const observed: unknown[] = [];
    const originals = new Map<PoolClient, PropertyDescriptor | undefined>();
    const onAcquire = (client: PoolClient) => {
      if (originals.has(client)) return;
      const descriptor = Object.getOwnPropertyDescriptor(client, "query");
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const query = client.query;
      originals.set(client, descriptor);
      Object.defineProperty(client, "query", {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].includes("graphile_worker.add_job")) observed.push(args[1]);
          return Reflect.apply(query, client, args);
        },
      });
    };
    const failures: unknown[] = [];
    runtime.on("acquire", onAcquire);
    try {
      const role = await runAsSystem("check transcription action role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = getTenantZeroId();
      const action = createFilesTranscriptionTriggerAction(runtime);
      await runInTenant(tenant, () =>
        action(actionConfig(), { heartbeatId: "hb", projectItemId: "proj", itemId: document }),
      );
      expect(observed).toEqual([]);
      await runInTenant(tenant, () =>
        action(actionConfig(), { heartbeatId: "hb", projectItemId: "proj", itemId: audio }),
      );
      const keys = [`transcription-create:${audio}`, `transcription-job:${audio}`];
      const jobs = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          client.query<{ key: string; task_identifier: string; queue_name: string | null }>(
            "SELECT key, task_identifier, queue_name FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
            [keys],
          ),
        ),
      );
      expect(jobs.rows).toEqual([
        { key: keys[0], task_identifier: "transcriptionCreate", queue_name: `transcription-create:${tenant}` },
        { key: keys[1], task_identifier: "transcriptionJob", queue_name: `transcription:${tenant}` },
      ]);
      const argsSchema = z.tuple([
        z.string(),
        z.string(),
        z.string().nullable(),
        z.unknown(),
        z.number(),
        z.string(),
        z.string(),
        z.number().int(),
      ]);
      const calls = observed
        .map((entry) => argsSchema.safeParse(entry))
        .filter((entry) => entry.success)
        .map((entry) => entry.data);
      const enqueueCalls = calls.filter((args) => keys.includes(args[5]));
      expect(enqueueCalls).toHaveLength(2);
      for (const args of enqueueCalls) {
        expect(args[7]).toBe(0);
        const envelope: unknown = JSON.parse(args[1]);
        expect(envelope).toMatchObject({ tenantId: tenant, payload: { fileItemId: audio } });
      }
      const documentJobs = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          client.query("SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[])", [
            [`transcription-create:${document}`, `transcription-job:${document}`],
          ]),
        ),
      );
      expect(documentJobs.rowCount).toBe(0);
    } catch (error) {
      failures.push(error);
    } finally {
      runtime.off("acquire", onAcquire);
      for (const [client, descriptor] of originals) {
        if (descriptor) Object.defineProperty(client, "query", descriptor);
        else Reflect.deleteProperty(client, "query");
      }
      try {
        await runtime.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Transcription action test and cleanup failed");
  });

  it("does not replace a recording intake job when the Files heartbeat runs late", async () => {
    const fileItemId = await createFileItem("audio/mpeg");
    await runInTenant(getTenantZeroId(), async () => {
      await withTransaction(pool, (client) =>
        recordRecordingIntake(client, { fileItemId, eventId: null, recordedAt: null }),
      );
      const before = await pool.query<{ id: string; attempts: number }>(
        "SELECT id::text, attempts FROM graphile_worker.jobs WHERE key = $1",
        [transcriptionJobKey(fileItemId)],
      );
      expect(before.rows).toHaveLength(1);
      await createFilesTranscriptionTriggerAction(pool)(actionConfig(), {
        heartbeatId: "hb",
        projectItemId: "proj",
        itemId: fileItemId,
      });
      const after = await pool.query<{ id: string; attempts: number }>(
        "SELECT id::text, attempts FROM graphile_worker.jobs WHERE key = $1",
        [transcriptionJobKey(fileItemId)],
      );
      expect(after.rows).toEqual(before.rows);
    });
  });

  it("enqueues the job with at most three attempts (issue #248)", async () => {
    const fileItemId = await createFileItem("audio/mpeg");
    const handler = createFilesTranscriptionTriggerAction(pool);

    await handler(actionConfig(), { heartbeatId: "hb", projectItemId: "proj", itemId: fileItemId });

    const { rows } = await pool.query<{ max_attempts: number }>(
      `SELECT max_attempts FROM graphile_worker.jobs WHERE key = $1`,
      [transcriptionJobKey(fileItemId)],
    );
    expect(rows).toEqual([{ max_attempts: 3 }]);
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
