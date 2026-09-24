import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient } from "../../chokePoint/chokePoint.js";
import { ensureItemAutomation, type ItemAutomationStatus } from "../../library/itemAutomationStore.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../errors.js";
import {
  createTranscriptionRequeueSweepAction,
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
} from "../transcriptionActions.js";
import { runTranscriptionRequeueHeartbeatCutoverMigration } from "../transcriptionRequeueHeartbeatCutoverMigration.js";
import { createRerunTranscriptionRouteHandler } from "../transcriptionRouteHandlers.js";
import {
  readTranscriptionSourceFileItemId,
  TRANSCRIPTION_OWNER_PROCESS,
  transcriptionJobKey,
  transcriptionSourceLink,
} from "../transcriptionJob.js";

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function readJobs(): Promise<Array<{ key: string | null; attempts: number }>> {
  const { rows } = await pool.query<{ key: string | null; attempts: number }>(
    `SELECT key, attempts FROM graphile_worker.jobs WHERE task_identifier = 'transcriptionJob' ORDER BY key, id`,
  );
  return rows;
}

afterAll(async () => {
  await pool?.end();
});

describe("readTranscriptionSourceFileItemId (issue #186)", () => {
  it("reads the Files item id back out of a link transcriptionSourceLink built", () => {
    const fileItemId = randomUUID();
    expect(readTranscriptionSourceFileItemId(transcriptionSourceLink(fileItemId))).toBe(fileItemId);
  });

  it.each([undefined, null, 42, "", "https://example.test/x", "semprec://items/not-a-uuid"])(
    "returns null for %j",
    (link) => {
      expect(readTranscriptionSourceFileItemId(link)).toBeNull();
    },
  );
});

describe("transcription requeue sweep and rerun route (issue #186)", () => {
  let transcriptsId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    transcriptsId = await databaseIdFor("transcripts");
  });

  /** A Transcriptions row as the pipeline's step 0 leaves it, with its `item_automation` set to `status`. */
  async function createTranscription(
    status: ItemAutomationStatus,
    link: string = transcriptionSourceLink(randomUUID()),
  ): Promise<{ transcriptId: string; link: string }> {
    const transcript = await withTransaction(pool, async (client) => {
      const item = await createItemWithClient(
        client,
        { databaseId: transcriptsId, properties: { name: "recording", status: "processing", link } },
        { allowedSystemKeys: ["status", "link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      await ensureItemAutomation(client, item.id);
      return item;
    });
    await pool.query("UPDATE item_automation SET status = $2 WHERE item_id = $1", [transcript.id, status]);
    return { transcriptId: transcript.id, link };
  }

  function fileItemIdOf(link: string): string {
    const fileItemId = readTranscriptionSourceFileItemId(link);
    if (!fileItemId) throw new Error(`not a source link: ${link}`);
    return fileItemId;
  }

  async function runSweep(): Promise<void> {
    await createTranscriptionRequeueSweepAction(pool)(
      { transcriptsDatabaseId: transcriptsId },
      { heartbeatId: randomUUID(), projectItemId: randomUUID() },
    );
  }

  describe("daily requeue sweep", () => {
    it("requeues only the error row under its original key, and repeated runs collapse onto one job", async () => {
      const errored = await createTranscription("error");
      await createTranscription("done");
      await createTranscription("pending");
      await createTranscription("locked");

      await runSweep();
      await runSweep();

      expect(await readJobs()).toEqual([{ key: transcriptionJobKey(fileItemIdOf(errored.link)), attempts: 0 }]);
    });

    it("gives an exhausted job a fresh batch under the same key", async () => {
      const errored = await createTranscription("error");
      const key = transcriptionJobKey(fileItemIdOf(errored.link));
      await runSweep();
      await pool.query("UPDATE graphile_worker._private_jobs SET attempts = max_attempts WHERE key = $1", [key]);

      await runSweep();

      // graphile-worker detaches the exhausted job from the key (it never runs again) and queues
      // the fresh batch under it, so exactly one runnable job holds the key.
      expect(await readJobs()).toEqual([
        { key, attempts: 0 },
        { key: null, attempts: 3 },
      ]);
    });

    it("never touches the row's item_automation, so it never sets locked", async () => {
      const errored = await createTranscription("error");

      await runSweep();

      const { rows } = await pool.query("SELECT status, attempts FROM item_automation WHERE item_id = $1", [
        errored.transcriptId,
      ]);
      expect(rows).toEqual([{ status: "error", attempts: 0 }]);
    });

    it("skips a row with no Files item link and still requeues the rest", async () => {
      await createTranscription("error", "https://example.test/not-a-source");
      const errored = await createTranscription("error");

      await runSweep();

      expect(await readJobs()).toEqual([{ key: transcriptionJobKey(fileItemIdOf(errored.link)), attempts: 0 }]);
    });

    it("skips a trashed row", async () => {
      const errored = await createTranscription("error");
      await pool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [errored.transcriptId]);

      await runSweep();

      expect(await readJobs()).toEqual([]);
    });
  });

  describe("requeue heartbeat", () => {
    async function readSweepHeartbeats() {
      const { rows } = await pool.query<{ project_item_id: string; rule: unknown; action_config: unknown }>(
        `SELECT project_item_id, rule, action_config FROM project_heartbeats WHERE action_id = $1`,
        [TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID],
      );
      return rows;
    }

    async function readTriggerProjectId(): Promise<string> {
      const { rows } = await pool.query<{ project_item_id: string }>(
        `SELECT project_item_id FROM project_heartbeats WHERE action_id = $1`,
        [FILES_TRANSCRIPTION_TRIGGER_ACTION_ID],
      );
      if (!rows[0]) throw new Error("expected the seeded Files transcription trigger");
      return rows[0].project_item_id;
    }

    it("is seeded as one daily heartbeat on the Semprec project, scheduled from now", async () => {
      const { rows } = await pool.query<{ next_fire_at: Date | null }>(
        `SELECT next_fire_at FROM project_heartbeats WHERE action_id = $1`,
        [TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID],
      );
      expect(await readSweepHeartbeats()).toEqual([
        {
          project_item_id: await readTriggerProjectId(),
          rule: { kind: "dailyTime", at: "04:30" },
          action_config: { transcriptsDatabaseId: transcriptsId },
        },
      ]);
      expect(rows[0]?.next_fire_at?.getTime()).toBeGreaterThan(Date.now());
    });

    it("is backfilled once onto a populated install seeded without it", async () => {
      const seeded = await readSweepHeartbeats();
      await pool.query(`DELETE FROM project_heartbeats WHERE action_id = $1`, [TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID]);

      await runTranscriptionRequeueHeartbeatCutoverMigration(pool);
      await runTranscriptionRequeueHeartbeatCutoverMigration(pool);

      expect(await readSweepHeartbeats()).toEqual(seeded);
    });

    it("backfills nothing when there is no Files transcription trigger to anchor it to", async () => {
      await pool.query(`DELETE FROM project_heartbeats WHERE action_id = ANY($1::text[])`, [
        [TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID, FILES_TRANSCRIPTION_TRIGGER_ACTION_ID],
      ]);

      await runTranscriptionRequeueHeartbeatCutoverMigration(pool);

      expect(await readSweepHeartbeats()).toEqual([]);
    });

    it("is a no-op on a database that has not been seeded yet", async () => {
      await resetDatabase(pool);

      await runTranscriptionRequeueHeartbeatCutoverMigration(pool);

      expect(await readSweepHeartbeats()).toEqual([]);
    });
  });

  describe("POST /api/transcriptions/:id/rerun", () => {
    async function readUpdatedAt(itemId: string): Promise<string> {
      const { rows } = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM items WHERE id = $1", [itemId]);
      if (!rows[0]) throw new Error("expected the item");
      return rows[0].updated_at.toISOString();
    }

    it.each(["done", "error"] as const)(
      "enqueues the original key for a %s row without writing the item",
      async (status) => {
        const row = await createTranscription(status);
        const updatedAt = await readUpdatedAt(row.transcriptId);
        const fileItemId = fileItemIdOf(row.link);

        const result = await createRerunTranscriptionRouteHandler(pool)({
          params: { id: row.transcriptId },
          body: undefined,
        });

        expect(result).toEqual({ status: 202, body: { id: row.transcriptId, fileItemId } });
        expect(await readJobs()).toEqual([{ key: transcriptionJobKey(fileItemId), attempts: 0 }]);
        expect(await readUpdatedAt(row.transcriptId)).toBe(updatedAt);
      },
    );

    it("accepts a pending row by replacing its queued job under the same key with a fresh batch", async () => {
      const row = await createTranscription("pending");
      const key = transcriptionJobKey(fileItemIdOf(row.link));
      const handler = createRerunTranscriptionRouteHandler(pool);
      await handler({ params: { id: row.transcriptId }, body: undefined });
      await pool.query("UPDATE graphile_worker._private_jobs SET attempts = 1 WHERE key = $1", [key]);

      const result = await handler({ params: { id: row.transcriptId }, body: undefined });

      expect(result).toEqual({ status: 202, body: { id: row.transcriptId, fileItemId: fileItemIdOf(row.link) } });
      expect(await readJobs()).toEqual([{ key, attempts: 0 }]);
    });

    it("collapses a repeated rerun onto one job", async () => {
      const row = await createTranscription("error");
      const handler = createRerunTranscriptionRouteHandler(pool);

      await handler({ params: { id: row.transcriptId }, body: undefined });
      await handler({ params: { id: row.transcriptId }, body: undefined });

      expect(await readJobs()).toHaveLength(1);
    });

    it("refuses a locked row with 403 transcription_locked and enqueues nothing", async () => {
      const row = await createTranscription("locked");

      const promise = createRerunTranscriptionRouteHandler(pool)({ params: { id: row.transcriptId }, body: undefined });

      await expect(promise).rejects.toThrow(ForbiddenError);
      await expect(promise).rejects.toMatchObject({ status: 403, code: "transcription_locked" });
      expect(await readJobs()).toEqual([]);
    });

    it("rejects a malformed id with a 400", async () => {
      await expect(
        createRerunTranscriptionRouteHandler(pool)({ params: { id: "not-a-uuid" }, body: undefined }),
      ).rejects.toThrow(ValidationError);
    });

    it("returns 404 for an unknown id", async () => {
      await expect(
        createRerunTranscriptionRouteHandler(pool)({ params: { id: randomUUID() }, body: undefined }),
      ).rejects.toThrow(NotFoundError);
    });

    it("returns 404 for a Transcripts item with no transcription job behind it", async () => {
      const manual = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: transcriptsId, properties: { name: "typed by hand" } }),
      );

      await expect(
        createRerunTranscriptionRouteHandler(pool)({ params: { id: manual.id }, body: undefined }),
      ).rejects.toMatchObject({ status: 404, details: { resource: "transcription", itemId: manual.id } });
      expect(await readJobs()).toEqual([]);
    });

    it("returns 404 for a row whose link is not a Files item link", async () => {
      const row = await createTranscription("error", "https://example.test/not-a-source");

      await expect(
        createRerunTranscriptionRouteHandler(pool)({ params: { id: row.transcriptId }, body: undefined }),
      ).rejects.toThrow(NotFoundError);
      expect(await readJobs()).toEqual([]);
    });
  });
});
