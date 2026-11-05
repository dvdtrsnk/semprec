import { PassThrough, Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase, getTenantZeroId } from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import {
  createChokePoint,
  ingestUploadedFileWithTransaction,
  LocalFsBlobStorageWriter,
  recordRecordingIntake,
  seedSystem,
  type BlobStorageWriter,
} from "@semprec/data";
import { ModuleRegistry } from "@semprec/module-registry";
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
    try {
      runtime = await createTranscribeQueueRuntime(pool, registry, blockedStorage);
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
      do {
        const result = await runInTenant(tenant, async () => {
          const databases = await cp.listDatabases();
          const transcripts = databases.find((database) => database.ownerModuleId === "transcripts");
          if (!transcripts) throw new Error("Transcripts database missing");
          const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
            "SELECT properties FROM items WHERE database_id = $1 AND properties->>'link' = $2",
            [transcripts.id, `semprec://items/${second.result.item.id}`],
          );
          return rows[0];
        });
        if (result?.properties.status === "processing") {
          found = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      expect(found).toBe(true);
      expect(reads).toBe(1);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await runtime?.stop();
      runtime = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an active transcribe-affinity module task without a local handler", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-transcribe-queue-runtime"]));
    await registry.loadModule(fixturePath("transcribeFixtureModule.js"));

    await expect(createTranscribeQueueRuntime(pool, registry)).rejects.toThrow(
      /missing handler\(s\) for: transcribeFixture.doThing/,
    );
  });
});
