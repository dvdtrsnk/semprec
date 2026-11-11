import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  createBlob,
  createFilesTranscriptionTriggerAction,
  createItemWithClient,
  createRelationWithClient,
  createViewTypeRegistry,
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  getDatabaseByModuleId,
  getItemById,
  listPropertiesByDatabase,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { CORE_TASK_NAMES, registerTask, runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createTranscriptionCreateTask } from "../transcriptionTask.js";

/**
 * Issue #1698, from the Files trigger to the Transcriptions row: the seeded `Files transcription trigger`
 * heartbeat's action is fired for an audio file, then the `transcriptionCreate` jobs it queued are run by
 * the real create task. The fixtures, the trigger, the task and the assertions use a `semprec_data` pool
 * inside the tenant.
 */
describe("Transcriptions row for an audio file attached to an Event (issue #1698)", () => {
  let admin: Pool;
  let runtime: Pool;
  let tenant: string;
  let ids: { files: string; events: string; transcripts: string; filesEventsProperty: string };

  function inTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runInTenant(tenant, () => withTransaction(runtime, fn));
  }

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check event attachment transcription role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = getTenantZeroId();
    await runInTenant(tenant, () => seedSystem(runtime, createViewTypeRegistry()));
    ids = await inTenant(async (client) => {
      const databaseId = async (moduleId: string): Promise<string> => {
        const database = await getDatabaseByModuleId(client, moduleId);
        if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
        return database.id;
      };
      const files = await databaseId("files");
      const filesEvents = (await listPropertiesByDatabase(client, files)).find((property) => property.key === "events");
      if (!filesEvents) throw new Error("Files.events was not seeded");
      return {
        files,
        events: await databaseId("events"),
        transcripts: await databaseId("transcripts"),
        filesEventsProperty: filesEvents.id,
      };
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  /**
   * An audio Files item. With `attachedToEvent`, a new Event and the file's `Files.events` edge are
   * written in the transaction that creates the file, as the upload attach of issue #1645 does.
   */
  function createAudioFile(options: { attachedToEvent: boolean }): Promise<string> {
    return inTenant(async (client) => {
      const blob = await createBlob(client, {
        mimeType: "audio/mpeg",
        byteSize: 1024,
        storageKey: `test/audio/${randomUUID()}`,
      });
      const file = await createItemWithClient(client, {
        databaseId: ids.files,
        properties: { name: "voice memo", file: { blobId: blob.id } },
      });
      if (options.attachedToEvent) {
        const event = await createItemWithClient(client, {
          databaseId: ids.events,
          properties: { name: "Client meeting", date: "2026-10-16" },
        });
        await createRelationWithClient(client, {
          relationPropertyId: ids.filesEventsProperty,
          callerItemId: file.id,
          targetItemId: event.id,
        });
      }
      return file.id;
    });
  }

  /** Fires the seeded trigger heartbeat's action for the file, then runs the queued `transcriptionCreate` jobs. */
  async function fireTriggerAndRunCreate(fileItemId: string): Promise<void> {
    const { rows } = await inTenant((client) =>
      client.query<Record<string, unknown>>(
        "SELECT id, project_item_id, action_config FROM project_heartbeats WHERE action_id = $1",
        [FILES_TRANSCRIPTION_TRIGGER_ACTION_ID],
      ),
    );
    expect(rows).toHaveLength(1);
    const heartbeat = z
      .object({ id: z.uuid(), project_item_id: z.uuid(), action_config: z.record(z.string(), z.unknown()) })
      .parse(rows[0]);
    await runInTenant(tenant, () =>
      createFilesTranscriptionTriggerAction(runtime)(heartbeat.action_config, {
        heartbeatId: heartbeat.id,
        projectItemId: heartbeat.project_item_id,
        itemId: fileItemId,
      }),
    );
    const taskName = CORE_TASK_NAMES.TRANSCRIPTION_CREATE;
    await runOnce({
      pgPool: runtime,
      taskList: { [taskName]: registerTask(taskName, createTranscriptionCreateTask(runtime)) },
    });
  }

  /** The ids of every Transcriptions row of the tenant, and the transcript id the file's `create` checkpoint names. */
  async function transcriptsFor(fileItemId: string): Promise<{ rows: string[]; checkpoint: unknown }> {
    return inTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [
        ids.transcripts,
      ]);
      const file = await getItemById(client, ids.files, fileItemId);
      if (!file) throw new Error("The Files item is gone");
      return { rows: rows.map((row) => row.id), checkpoint: file.computed.create };
    });
  }

  it("creates no Transcriptions row for an audio file created with a Files.events edge", async () => {
    const fileItemId = await createAudioFile({ attachedToEvent: true });

    await fireTriggerAndRunCreate(fileItemId);

    expect(await transcriptsFor(fileItemId)).toEqual({ rows: [], checkpoint: undefined });
  });

  it("creates one Transcriptions row for a standalone audio file", async () => {
    const fileItemId = await createAudioFile({ attachedToEvent: false });

    await fireTriggerAndRunCreate(fileItemId);

    const transcripts = await transcriptsFor(fileItemId);
    expect(transcripts.rows).toHaveLength(1);
    expect(transcripts.checkpoint).toBe(transcripts.rows[0]);
  });
});
