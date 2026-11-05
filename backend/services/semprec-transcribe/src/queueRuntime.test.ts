import { PassThrough, Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getTestPool, resetDatabase, getTenantZeroId } from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import {
  createChokePoint,
  ingestUploadedFileWithTransaction,
  LocalFsBlobStorageWriter,
  recordRecordingIntake,
  seedSystem,
  setAgentRunEventHook,
  setDocUpdateHook,
  setInvalidationHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  setSempThreadInvalidationHook,
  setSessionRevokedHook,
  type BlobStorageWriter,
} from "@semprec/data";
import { ModuleRegistry } from "@semprec/module-registry";
import { wireRealtimeHooks } from "@semprec/realtime";
import { createTranscribeQueueRuntime, type TranscribeQueueRuntime } from "./queueRuntime.js";

function fixturePath(name: string): string {
  return new URL(`./__tests__/fixtures/${name}`, import.meta.url).href;
}

let pool: Pool;
let runtime: TranscribeQueueRuntime | undefined;

describe("createTranscribeQueueRuntime", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("runs the fast creation worker while the media worker is occupied", async () => {
    await seedSystem(pool);
    const tenant = getTenantZeroId();
    const directory = await mkdtemp(join(tmpdir(), "semprec-fast-create-"));
    const storage = new LocalFsBlobStorageWriter(directory);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const occupied = new Promise<void>((resolve) => {
      started = resolve;
    });
    let gated = false;
    let reads = 0;
    const blockedStorage: BlobStorageWriter = {
      writeStream: (...args) => storage.writeStream(...args),
      delete: (key) => storage.delete(key),
      readStream: (key, range) => {
        reads += 1;
        if (gated) return storage.readStream(key, range);
        gated = true;
        const stream = new PassThrough();
        started();
        void gate.then(() => storage.readStream(key, range).pipe(stream));
        return stream;
      },
    };
    const registry = new ModuleRegistry(() => new Set());
    const cp = createChokePoint(pool);
    const upload = async (name: string, bytes: string) =>
      runInTenant(tenant, async () => {
        const files = (await cp.listDatabases()).find((database) => database.ownerModuleId === "files");
        if (!files) throw new Error("Files database missing");
        return ingestUploadedFileWithTransaction(
          pool,
          {
            filesDatabaseId: files.id,
            filename: name,
            contentType: "audio/mpeg",
            source: Readable.from([bytes]),
            storageKeyPrefix: "files",
            maxBytes: 1024,
            storage,
          },
          (client, result) =>
            recordRecordingIntake(client, { fileItemId: result.item.id, eventId: null, recordedAt: null }),
        );
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: PoolClient | undefined;
    const events: unknown[] = [];
    const failures: unknown[] = [];
    try {
      wireRealtimeHooks(pool);
      listener = await pool.connect();
      await listener.query("LISTEN semprec_events");
      listener.on("notification", (message) => {
        const envelope = z
          .object({ tenantId: z.uuid(), message: z.unknown() })
          .parse(JSON.parse(message.payload ?? "null"));
        events.push(envelope);
      });
      runtime = await createTranscribeQueueRuntime(pool, registry, blockedStorage, {
        audio: {
          async diarize() {
            throw new Error("Unexpected gateway call while storage is blocked");
          },
          async transcribe() {
            throw new Error("Unexpected gateway call while storage is blocked");
          },
        },
        summary: {
          async complete() {
            throw new Error("Unexpected gateway call while storage is blocked");
          },
        },
      });
      await upload("first.mp3", "ID3 first recording");
      await Promise.race([
        occupied,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Media worker did not start")), 10000);
        }),
      ]);
      clearTimeout(timer);
      const second = await upload("second.mp3", "ID3 second recording");
      const deadline = Date.now() + 5000;
      let found = false;
      let transcriptId: string | undefined;
      let transcriptsId: string | undefined;
      do {
        const result = await runInTenant(tenant, async () => {
          const databases = await cp.listDatabases();
          const transcripts = databases.find((database) => database.ownerModuleId === "transcripts");
          if (!transcripts) throw new Error("Transcripts database missing");
          const page = await cp.queryDatabaseItems(transcripts.id, {});
          return {
            databaseId: transcripts.id,
            item: page.items.find((item) => item.properties.link === `semprec://items/${second.result.item.id}`),
          };
        });
        if (result.item?.properties.status === "processing") {
          found = true;
          transcriptId = result.item.id;
          transcriptsId = result.databaseId;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      expect(found).toBe(true);
      expect(reads).toBe(1);
      expect(transcriptId).toBeDefined();
      await vi.waitFor(() => {
        expect(events).toContainEqual(
          expect.objectContaining({
            message: expect.objectContaining({
              type: "invalidation",
              scope: "item",
              op: "create",
              databaseId: transcriptsId,
              itemId: transcriptId,
            }),
          }),
        );
      });
    } catch (error) {
      failures.push(error);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      try {
        await runtime?.stop();
      } catch (error) {
        failures.push(error);
      } finally {
        runtime = undefined;
      }
      try {
        listener?.release(true);
      } catch (error) {
        failures.push(error);
      }
      setInvalidationHook(() => {});
      setDocUpdateHook(() => {});
      setNotificationCreatedHook(() => {});
      setNotificationReadStateHook(() => {});
      setSessionRevokedHook(() => {});
      setSempThreadInvalidationHook(() => {});
      setAgentRunEventHook(() => {});
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Fast create test and cleanup failed");
  });

  it("rejects an active transcribe-affinity module task without a local handler", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-transcribe-queue-runtime"]));
    await registry.loadModule(fixturePath("transcribeFixtureModule.js"));

    await expect(createTranscribeQueueRuntime(pool, registry)).rejects.toThrow(
      /missing handler\(s\) for: transcribeFixture.doThing/,
    );
  });
});
