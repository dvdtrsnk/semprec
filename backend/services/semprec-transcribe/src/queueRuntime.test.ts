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

  it("starts three runners of one slot, each with the task list of its own kind", async () => {
    const registry = new ModuleRegistry(() => new Set());
    const started: Array<{ tasks: string[]; concurrency: number | undefined }> = [];

    await createTranscribeQueueRuntime(pool, registry, undefined, {
      startWorker: async (options) => {
        started.push({ tasks: Object.keys(options.taskList ?? {}), concurrency: options.concurrency });
        return { stop: async () => {} };
      },
    });

    expect(started).toEqual([
      { tasks: ["transcriptionJob"], concurrency: 1 },
      { tasks: ["transcriptionCreate"], concurrency: 1 },
      { tasks: ["transcriptCardRecompute", "transcriptSpeakerSuggestion"], concurrency: 1 },
    ]);
  });

  it.each([
    { failingStart: 2, cleanupFails: false },
    { failingStart: 2, cleanupFails: true },
    { failingStart: 3, cleanupFails: false },
    { failingStart: 3, cleanupFails: true },
  ])(
    "preserves a start failure and stops the started runners: $failingStart, cleanup fails: $cleanupFails",
    async ({ failingStart, cleanupFails }) => {
      const registry = new ModuleRegistry(() => new Set());
      const startup = new Error("a worker failed to start");
      const cleanup = new Error("a started worker failed to stop");
      let starts = 0;
      let stops = 0;
      let thrown: unknown;
      try {
        await createTranscribeQueueRuntime(pool, registry, undefined, {
          startWorker: async (options) => {
            starts++;
            expect(options.concurrency).toBe(1);
            if (starts === failingStart) throw startup;
            return {
              async stop() {
                stops++;
                if (cleanupFails) throw cleanup;
              },
            };
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(starts).toBe(failingStart);
      expect(stops).toBe(failingStart - 1);
      if (!cleanupFails) expect(thrown).toBe(startup);
      else {
        expect(thrown).toBeInstanceOf(AggregateError);
        if (!(thrown instanceof AggregateError)) throw new Error("Missing aggregate failure");
        expect(thrown.errors).toEqual([startup, ...Array.from({ length: failingStart - 1 }, () => cleanup)]);
        expect(thrown.cause).toBe(startup);
      }
    },
  );

  it.each([
    { failedStops: [] },
    { failedStops: [0] },
    { failedStops: [1] },
    { failedStops: [2] },
    { failedStops: [0, 1] },
    { failedStops: [0, 1, 2] },
  ])("stops all three worker handles once and preserves failures: $failedStops", async ({ failedStops }) => {
    const registry = new ModuleRegistry(() => new Set());
    const errors = [new Error("pipeline stop failed"), new Error("create stop failed"), new Error("model stop failed")];
    const calls: number[] = [];
    let starts = 0;
    const result = await createTranscribeQueueRuntime(pool, registry, undefined, {
      startWorker: async () => {
        const index = starts++;
        return {
          async stop() {
            calls.push(index);
            if (failedStops.includes(index)) {
              const error = errors[index];
              if (!error) throw new Error("Missing stop failure fixture");
              throw error;
            }
          },
        };
      },
    });
    const first = result.stop();
    expect(result.stop()).toBe(first);
    if (failedStops.length === 0) await expect(first).resolves.toBeUndefined();
    else {
      let thrown: unknown;
      try {
        await first;
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      if (!(thrown instanceof AggregateError)) throw new Error("Missing aggregate stop failure");
      expect(thrown.errors).toEqual(failedStops.map((index) => errors[index]));
      expect(thrown.cause).toBe(errors[failedStops[0]!]);
    }
    expect(starts).toBe(3);
    expect(calls).toEqual([0, 1, 2]);
  });
});
