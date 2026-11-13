import "../../domainWriteHooks.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, registerTask, runOnce } from "@semprec/queue";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { ingestUploadedFile, ingestUploadedFileWithTransaction } from "../../blobs/fileUploadStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { lockItemById } from "../../chokePoint/itemsStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { LocalFsBlobStorageWriter } from "../../mail/blobStorage.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { readRecordingRequest, recordRecordingIntake } from "../recordingIntake.js";
import { findTranscriptionJobId } from "../transcriptionJob.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let root: string;
describe("recording intake", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    root = await mkdtemp(join(tmpdir(), "semprec-recording-intake-"));
    const role = await runAsSystem("verify recording role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      await runtime?.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (root) await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Fixture cleanup failed");
  });
  it("reads validated recording choices only in the owning tenant", async () => {
    const fileId = await runInTenant(tenant, async () => {
      const files = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files"));
      if (!files) throw new Error("Files database missing");
      const uploaded = await ingestUploadedFileWithTransaction(
        runtime,
        {
          filesDatabaseId: files.id,
          filename: "sample.mp3",
          contentType: "audio/mpeg",
          source: Readable.from(["ID3 reader fixture"]),
          storageKeyPrefix: "files",
          maxBytes: 1024,
          storage: new LocalFsBlobStorageWriter(root),
        },
        (client, result) =>
          recordRecordingIntake(client, { fileItemId: result.item.id, eventId: null, recordedAt: null }),
      );
      // Future intake fields have no production writer yet; this scoped fixture creates that stored shape.
      const updated = await runtime.query(
        "UPDATE recording_requests SET name = $5, language = $2, num_speakers_exact = $3, project_item_id = $4 WHERE tenant_id = app_tenant_default() AND file_item_id = $1",
        [uploaded.result.item.id, "cs", 2, "bdb16414-01ad-4ac4-8453-25e4ba9c86d5", "Pricing call"],
      );
      expect(updated.rowCount).toBe(1);
      expect(await withTransaction(runtime, (client) => readRecordingRequest(client, uploaded.result.item.id))).toEqual(
        {
          eventId: null,
          recordedAt: null,
          name: "Pricing call",
          language: "cs",
          numSpeakersExact: 2,
          numSpeakersMin: null,
          projectItemId: "bdb16414-01ad-4ac4-8453-25e4ba9c86d5",
        },
      );
      return uploaded.result.item.id;
    });
    await runInTenant(foreign, async () => {
      expect(await withTransaction(runtime, (client) => readRecordingRequest(client, fileId))).toBeNull();
      expect(
        await withTransaction(runtime, (client) =>
          readRecordingRequest(client, "b23fa8f2-e184-4315-89ab-fc45b2b1b56b"),
        ),
      ).toBeNull();
    });
    await runInTenant(tenant, async () => {
      const updated = await runtime.query(
        "UPDATE recording_requests SET num_speakers_min = 3 WHERE tenant_id = app_tenant_default() AND file_item_id = $1",
        [fileId],
      );
      expect(updated.rowCount).toBe(1);
      await expect(withTransaction(runtime, (client) => readRecordingRequest(client, fileId))).rejects.toThrow();
    });
  });

  it("deduplicates filing and retains its first time and event", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtime);
      const databases = await cp.listDatabases();
      const files = databases.find((d) => d.ownerModuleId === "files");
      const events = databases.find((d) => d.ownerModuleId === "events");
      if (!files || !events) throw new Error("Missing recording databases");
      const event = await cp.createItem({ databaseId: events.id, properties: { name: "Event", date: "2026-10-16" } });
      const other = await cp.createItem({ databaseId: events.id, properties: { name: "Other", date: "2026-10-16" } });
      const upload = (eventId: string | null, recordedAt: string | null) =>
        ingestUploadedFileWithTransaction(
          runtime,
          {
            filesDatabaseId: files.id,
            filename: "recording.mp3",
            contentType: "audio/mpeg",
            source: Readable.from(["ID3 recording fixture"]),
            storageKeyPrefix: "files",
            maxBytes: 1024,
            storage: new LocalFsBlobStorageWriter(root),
          },
          (client, result) => recordRecordingIntake(client, { fileItemId: result.item.id, eventId, recordedAt }),
        );
      const first = await upload(event.id, "2026-01-01T10:00:00Z");
      expect(first.result.created).toBe(true);
      expect(first.value).toMatchObject({ eventId: event.id, transcriptId: null });
      const job = await withTransaction(runtime, (client) => findTranscriptionJobId(client, first.result.item.id));
      expect(job).not.toBeNull();
      const repeat = await upload(event.id, "2027-01-01T10:00:00Z");
      expect(repeat.result.created).toBe(false);
      expect(repeat.result.item.id).toBe(first.result.item.id);
      expect(await withTransaction(runtime, (client) => readRecordingRequest(client, first.result.item.id))).toEqual({
        eventId: event.id,
        recordedAt: "2026-01-01T10:00:00.000000Z",
        name: null,
        language: null,
        numSpeakersExact: null,
        numSpeakersMin: null,
        projectItemId: null,
      });
      expect(await withTransaction(runtime, (client) => findTranscriptionJobId(client, first.result.item.id))).toBe(
        job,
      );
      await expect(upload(other.id, null)).rejects.toMatchObject({ status: 409, code: "recording_linked_elsewhere" });
      expect(
        await withTransaction(runtime, (client) => readRecordingRequest(client, first.result.item.id)),
      ).toMatchObject({ eventId: event.id });
    });
  });

  it("preserves queued and running fast-create jobs across duplicate intake", async () => {
    const cp = createChokePoint(runtime);
    const files = await runInTenant(tenant, async () =>
      (await cp.listDatabases()).find((db) => db.ownerModuleId === "files"),
    );
    if (!files) throw new Error("Files database missing");
    const upload = (content: string) =>
      runInTenant(tenant, () =>
        ingestUploadedFileWithTransaction(
          runtime,
          {
            filesDatabaseId: files.id,
            filename: "recording.mp3",
            contentType: "audio/mpeg",
            source: Readable.from([content]),
            storageKeyPrefix: "files",
            maxBytes: 1024,
            storage: new LocalFsBlobStorageWriter(root),
          },
          (client, result) =>
            recordRecordingIntake(client, { fileItemId: result.item.id, eventId: null, recordedAt: null }),
        ),
      );
    const readFast = (fileId: string) =>
      admin.query<{
        id: string;
        key: string | null;
        attempts: number;
        locked_at: Date | null;
        run_at: Date;
        revision: number;
      }>(
        "SELECT id::text, key, attempts, locked_at, run_at, revision FROM graphile_worker.jobs WHERE task_identifier = $1 AND (key = $2 OR key IS NULL) ORDER BY id",
        [CORE_TASK_NAMES.TRANSCRIPTION_CREATE, `transcription-create:${fileId}`],
      );
    const queued = await upload("ID3 queued fast job");
    const taskName = CORE_TASK_NAMES.TRANSCRIPTION_CREATE;
    await runOnce({
      pgPool: runtime,
      taskList: {
        [taskName]: registerTask(taskName, async () => {
          throw new Error("fixture fast failure");
        }),
      },
    });
    const before = (await readFast(queued.result.item.id)).rows;
    expect(before).toHaveLength(1);
    expect(before[0]?.attempts).toBe(1);
    expect(before[0]?.locked_at).toBeNull();
    await upload("ID3 queued fast job");
    expect((await readFast(queued.result.item.id)).rows).toEqual(before);
    const mainKey = `transcription-job:${queued.result.item.id}`;
    const fastKey = `transcription-create:${queued.result.item.id}`;
    await admin.query("SELECT graphile_worker.remove_job($1)", [mainKey]);
    await upload("ID3 queued fast job");
    expect((await readFast(queued.result.item.id)).rows).toEqual(before);
    const main = await admin.query<{ id: string }>("SELECT id::text FROM graphile_worker.jobs WHERE key = $1", [
      mainKey,
    ]);
    expect(main.rows).toHaveLength(1);
    await admin.query("SELECT graphile_worker.remove_job($1)", [fastKey]);
    await upload("ID3 queued fast job");
    const restored = (await readFast(queued.result.item.id)).rows;
    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).not.toBe(before[0]?.id);
    expect(
      (await admin.query<{ id: string }>("SELECT id::text FROM graphile_worker.jobs WHERE key = $1", [mainKey])).rows,
    ).toEqual(main.rows);
    await admin.query("SELECT graphile_worker.remove_job($1)", [fastKey]);

    const running = await upload("ID3 running fast job");
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = runOnce({
      pgPool: runtime,
      taskList: {
        [taskName]: registerTask(taskName, async () => {
          started();
          await gate;
        }),
      },
    });
    const failures: unknown[] = [];
    try {
      await Promise.race([
        entered,
        worker.then(() => {
          throw new Error("Worker exited before the running-job barrier");
        }),
      ]);
      const held = (await readFast(running.result.item.id)).rows;
      expect(held).toHaveLength(1);
      expect(held[0]?.locked_at).not.toBeNull();
      await upload("ID3 running fast job");
      expect((await readFast(running.result.item.id)).rows).toEqual(held);
    } catch (error) {
      failures.push(error);
    }
    release();
    try {
      await worker;
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Fast-job test and worker cleanup failed");
  });
  it("does not expose a foreign request or accept a foreign file", async () => {
    const foreignId = await runInTenant(foreign, async () => {
      const files = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files"));
      if (!files) throw new Error("Missing Files");
      const result = await ingestUploadedFileWithTransaction(
        runtime,
        {
          filesDatabaseId: files.id,
          filename: "foreign.mp3",
          contentType: "audio/mpeg",
          source: Readable.from(["ID3 foreign"]),
          storageKeyPrefix: "files",
          maxBytes: 1024,
          storage: new LocalFsBlobStorageWriter(root),
        },
        (client, upload) =>
          recordRecordingIntake(client, { fileItemId: upload.item.id, eventId: null, recordedAt: null }),
      );
      return result.result.item.id;
    });
    await runInTenant(tenant, async () => {
      expect(await withTransaction(runtime, (client) => readRecordingRequest(client, foreignId))).toBeNull();
      await expect(
        withTransaction(runtime, (client) =>
          recordRecordingIntake(client, { fileItemId: foreignId, eventId: null, recordedAt: null }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        withTransaction(runtime, (client) =>
          recordRecordingIntake(client, {
            fileItemId: "00000000-0000-4000-8000-000000000000",
            eventId: null,
            recordedAt: null,
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  it("keeps a first null timestamp while allowing only the first live Event claim", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtime);
      const databases = await cp.listDatabases();
      const files = databases.find((entry) => entry.ownerModuleId === "files");
      const events = databases.find((entry) => entry.ownerModuleId === "events");
      if (!files || !events) throw new Error("Missing recording databases");
      const firstEvent = await cp.createItem({
        databaseId: events.id,
        properties: { name: "First", date: "2026-10-16" },
      });
      const secondEvent = await cp.createItem({
        databaseId: events.id,
        properties: { name: "Second", date: "2026-10-16" },
      });
      const upload = (eventId: string | null, recordedAt: string | null) =>
        ingestUploadedFileWithTransaction(
          runtime,
          {
            filesDatabaseId: files.id,
            filename: "first-null.mp3",
            contentType: "audio/mpeg",
            source: Readable.from(["ID3 first null fixture"]),
            storageKeyPrefix: "files",
            maxBytes: 1024,
            storage: new LocalFsBlobStorageWriter(root),
          },
          (client, result) => recordRecordingIntake(client, { fileItemId: result.item.id, eventId, recordedAt }),
        );
      const first = await upload(null, null);
      const claimed = await upload(firstEvent.id, "2026-01-01T10:00:00Z");
      expect(claimed.result.item.id).toBe(first.result.item.id);
      expect(claimed.value.eventId).toBe(firstEvent.id);
      expect(await withTransaction(runtime, (client) => readRecordingRequest(client, first.result.item.id))).toEqual({
        eventId: firstEvent.id,
        recordedAt: null,
        name: null,
        language: null,
        numSpeakersExact: null,
        numSpeakersMin: null,
        projectItemId: null,
      });
      await expect(upload(secondEvent.id, null)).rejects.toMatchObject({
        status: 409,
        code: "recording_linked_elsewhere",
      });
      await cp.softDeleteItem(events.id, secondEvent.id);
      const trashed = await upload(secondEvent.id, null);
      expect(trashed.result.created).toBe(false);
      expect(trashed.value.eventId).toBe(firstEvent.id);
    });
  });
  it("removes the request when the owning Files item is purged", async () => {
    await runInTenant(tenant, async () => {
      const files = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files"));
      if (!files) throw new Error("Missing Files database");
      const uploaded = await ingestUploadedFileWithTransaction(
        runtime,
        {
          filesDatabaseId: files.id,
          filename: "purge.mp3",
          contentType: "audio/mpeg",
          source: Readable.from(["ID3 purge fixture"]),
          storageKeyPrefix: "files",
          maxBytes: 1024,
          storage: new LocalFsBlobStorageWriter(root),
        },
        (client, result) =>
          recordRecordingIntake(client, { fileItemId: result.item.id, eventId: null, recordedAt: null }),
      );
      expect(
        await withTransaction(runtime, (client) => readRecordingRequest(client, uploaded.result.item.id)),
      ).not.toBeNull();
      const cp = createChokePoint(runtime);
      await cp.softDeleteItem(files.id, uploaded.result.item.id);
      const purged = await cp.purgeExpiredTrashSubtree(uploaded.result.item.id, new Date(Date.now() + 60_000));
      expect(purged.purgedItemIds).toContain(uploaded.result.item.id);
      expect(
        await withTransaction(runtime, (client) => readRecordingRequest(client, uploaded.result.item.id)),
      ).toBeNull();
    });
  });
  it("returns recording_busy and rolls back the managed owner after a caught savepoint failure", async () => {
    await runInTenant(tenant, async () => {
      const files = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files"));
      const projects = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "projects"));
      if (!files || !projects) throw new Error("Missing recording databases");
      const uploaded = await ingestUploadedFile(runtime, {
        filesDatabaseId: files.id,
        filename: "busy.mp3",
        contentType: "audio/mpeg",
        source: Readable.from(["ID3 busy fixture"]),
        storageKeyPrefix: "files",
        maxBytes: 1024,
        storage: new LocalFsBlobStorageWriter(root),
      });
      let unlock!: () => void;
      let ready!: (pid: number) => void;
      const gate = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const locked = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const holder = withTransaction(runtime, async (client) => {
        const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const item = await lockItemById(client, files.id, uploaded.item.id);
        if (!item || !result.rows[0]) throw new Error("Missing locked Files item or backend");
        ready(result.rows[0].pid);
        await gate;
      });
      let primary: unknown;
      let failed = false;
      try {
        const holderPid = await Promise.race([
          locked,
          holder.then(() => {
            throw new Error("Files lock holder exited early");
          }),
        ]);
        let markerId = "";
        await expect(
          withTransaction(runtime, async (client) => {
            const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            expect(pid.rows[0]?.pid).not.toBe(holderPid);
            markerId = (
              await createItemWithClient(client, { databaseId: projects.id, properties: { name: "Must roll back" } })
            ).id;
            await client.query("SAVEPOINT before_busy");
            try {
              await recordRecordingIntake(client, { fileItemId: uploaded.item.id, eventId: null, recordedAt: null });
              throw new Error("Expected recording_busy");
            } catch (error) {
              expect(error).toMatchObject({ status: 409, code: "recording_busy" });
              await client.query("ROLLBACK TO SAVEPOINT before_busy");
            }
          }),
        ).rejects.toMatchObject({ status: 409, code: "recording_busy" });
        const marker = await withTransaction(runtime, (client) =>
          client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM items WHERE database_id = $1 AND id = $2",
            [projects.id, markerId],
          ),
        );
        expect(marker.rows[0]?.count).toBe("0");
        expect(await withTransaction(runtime, (client) => readRecordingRequest(client, uploaded.item.id))).toBeNull();
        expect(await withTransaction(runtime, (client) => findTranscriptionJobId(client, uploaded.item.id))).toBeNull();
      } catch (error) {
        primary = error;
        failed = true;
      }
      unlock();
      let holderError: unknown;
      let holderFailed = false;
      try {
        await holder;
      } catch (error) {
        holderError = error;
        holderFailed = true;
      }
      if (failed && holderFailed)
        throw new AggregateError([primary, holderError], "Recording test and holder both failed", { cause: primary });
      if (holderFailed) throw holderError;
      if (failed) throw primary;
    });
  });
});
