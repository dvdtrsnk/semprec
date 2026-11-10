import { randomUUID } from "node:crypto";
import { execFile, type ExecFileOptionsWithBufferEncoding } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createFilesTranscriptionTriggerAction,
  createUser,
  getDatabaseByModuleId,
  getItemAutomation,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  lockItemById,
  login,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { runTranscriptionFixture } from "./transcriptionHttpFixture.js";

const password = "recording-test-password";
const responseSchema = z.object({
  fileItemId: z.uuid(),
  created: z.boolean(),
  transcriptId: z.uuid().nullable(),
  eventId: z.uuid().nullable(),
});
let admin: Pool;
let runtime: Pool;
let server: Server | undefined;
let root: string;
let baseUrl: string;
let tenantA: string;
let tenantB: string;
let authA: string;
let authB: string;

async function session(tenantId: string): Promise<string> {
  const email = `${randomUUID()}@example.com`;
  await createUser(admin, { tenantId, email, passwordHash: await hashPassword(password) });
  const result = await login(admin, { email, password, platform: "ios", ip: "127.0.0.1" });
  return `Bearer ${result.token}`;
}

/** A date-only Event, which has no start, so no transcript is matched to it by time (issue #1663 requires a date). */
async function event(tenantId: string, name: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const database = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "events"));
    if (!database) throw new Error("Missing Events database");
    return (
      await createChokePoint(runtime).createItem({ databaseId: database.id, properties: { name, date: "2026-10-22" } })
    ).id;
  });
}

function upload(
  auth: string,
  content: NonNullable<Parameters<typeof fetch>[1]>["body"],
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return fetch(`${baseUrl}/api/recordings`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "video/mp4", "X-Filename": "recording.mp4", ...headers },
    body: content,
    signal,
  });
}

function rejectBeforeBody(auth: string, eventId: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/api/recordings`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "video/mp4",
        "X-Filename": "recording.mp4",
        "X-Event-Id": eventId,
        "Transfer-Encoding": "chunked",
      },
    });
    req.setTimeout(5000, () => req.destroy(new Error("Recording pre-body rejection timed out")));
    req.on("error", reject);
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.flushHeaders();
  });
}

describe("POST /api/recordings through the dispatcher", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check recording test role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    root = await mkdtemp(join(tmpdir(), "semprec-recordings-http-"));
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    for (const tenant of [tenantA, tenantB]) await runInTenant(tenant, () => seedSystem(runtime));
    authA = await session(tenantA);
    authB = await session(tenantB);
    const moduleRegistry = await loadFullModuleRegistry();
    const dispatch = await createDispatcher(runtime, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "https://app.example.test",
      setupToken: "recording-test-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(root),
      maxFileSizeBytes: 2_000_000,
    });
    const currentServer = createServer(dispatch);
    server = currentServer;
    await new Promise<void>((resolve) => currentServer.listen(0, "127.0.0.1", resolve));
    const address = currentServer.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    const currentServer = server;
    server = undefined;
    if (currentServer)
      await new Promise<void>((resolve, reject) => currentServer.close((error) => (error ? reject(error) : resolve())));
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

  it("rejects foreign and random event ids identically before storing bytes", async () => {
    const foreign = await event(tenantA, "Foreign Event");
    const before = await runAsSystem("count blobs before rejected upload", () =>
      admin.query<{ count: string }>("SELECT count(*)::text AS count FROM blobs"),
    );
    const a = await rejectBeforeBody(authB, foreign);
    const b = await rejectBeforeBody(authB, randomUUID());
    expect(a.status).toBe(404);
    expect(b).toEqual(a);
    const after = await runAsSystem("count blobs after rejected upload", () =>
      admin.query<{ count: string }>("SELECT count(*)::text AS count FROM blobs"),
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("deduplicates video uploads and preserves the first event", async () => {
    const firstEvent = await event(tenantA, "First Event");
    const secondEvent = await event(tenantA, "Second Event");
    const first = await upload(authA, "one recording", {
      "X-Event-Id": firstEvent,
      "X-Recorded-At": "2026-01-01T10:00:00Z",
    });
    expect(first.status).toBe(201);
    const firstBody = responseSchema.parse(await first.json());
    expect(firstBody).toMatchObject({ created: true, eventId: firstEvent, transcriptId: null });
    const repeated = await upload(authA, "one recording", { "X-Event-Id": firstEvent });
    expect(repeated.status).toBe(200);
    expect(responseSchema.parse(await repeated.json())).toMatchObject({
      fileItemId: firstBody.fileItemId,
      created: false,
      eventId: firstEvent,
    });
    const conflict = await upload(authA, "one recording", { "X-Event-Id": secondEvent });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "recording_linked_elsewhere" } });
  });

  it("enqueues both tenant-scoped transcription lanes for an accepted recording and none for a refused upload", async () => {
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
    runtime.on("acquire", onAcquire);
    try {
      const foreignEvent = await event(tenantA, "Foreign event");
      const beforeRefusal = observed.length;
      const refused = await upload(authB, "refused recording", { "X-Event-Id": foreignEvent });
      expect(refused.status).toBe(404);
      expect(observed).toHaveLength(beforeRefusal);

      const response = await upload(authA, "accepted recording");
      expect(response.status).toBe(201);
      const uploaded = responseSchema.parse(await response.json());
      const keys = [`transcription-create:${uploaded.fileItemId}`, `transcription-job:${uploaded.fileItemId}`];
      const jobs = await runInTenant(tenantA, () =>
        withTransaction(runtime, (client) =>
          client.query<{ key: string; task_identifier: string; queue_name: string | null }>(
            "SELECT key, task_identifier, queue_name FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
            [keys],
          ),
        ),
      );
      expect(jobs.rows).toEqual([
        { key: keys[0], task_identifier: "transcriptionCreate", queue_name: `transcription-create:${tenantA}` },
        { key: keys[1], task_identifier: "transcriptionJob", queue_name: `transcription:${tenantA}` },
      ]);
      const readState = () =>
        runInTenant(tenantA, () =>
          withTransaction(runtime, (client) =>
            client.query<{ id: string; key: string; attempts: number; run_at: Date }>(
              "SELECT id::text, key, attempts, run_at FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
              [keys],
            ),
          ),
        );
      const beforeDuplicate = (await readState()).rows;
      const duplicate = await upload(authA, "accepted recording");
      expect(duplicate.status).toBe(200);
      expect(responseSchema.parse(await duplicate.json()).fileItemId).toBe(uploaded.fileItemId);
      expect((await readState()).rows).toEqual(beforeDuplicate);
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
        expect(envelope).toMatchObject({ tenantId: tenantA, payload: { fileItemId: uploaded.fileItemId } });
      }
    } finally {
      runtime.off("acquire", onAcquire);
      for (const [client, descriptor] of originals) {
        if (descriptor) Object.defineProperty(client, "query", descriptor);
        else Reflect.deleteProperty(client, "query");
      }
    }
  });

  it("treats a trashed event as absent and rejects invalid headers", async () => {
    const eventId = await event(tenantA, "Trashed");
    await runInTenant(tenantA, async () => {
      const events = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "events"));
      if (!events) throw new Error("Missing Events database");
      await createChokePoint(runtime).softDeleteItem(events.id, eventId);
    });
    const response = await upload(authA, "trashed event recording", { "X-Event-Id": eventId });
    expect(response.status).toBe(201);
    expect(responseSchema.parse(await response.json()).eventId).toBeNull();
    const invalidHeaders: readonly Record<string, string>[] = [
      { "Content-Type": "text/plain" },
      { "X-Event-Id": "not-a-uuid" },
      { "X-Recorded-At": "2026-01-01T10:00:00" },
    ];
    for (const headers of invalidHeaders) {
      const invalid = await upload(authA, "invalid input", headers);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed" } });
    }
  });

  it("rolls back a busy duplicate upload, including its temporary bytes", async () => {
    const first = await upload(authA, "busy recording bytes");
    expect(first.status).toBe(201);
    const uploaded = responseSchema.parse(await first.json());
    const files = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files")),
    );
    if (!files) throw new Error("Missing Files database");
    const before = (await readdir(root, { recursive: true })).sort();
    let release!: () => void;
    let signal!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<number>((resolve) => {
      signal = resolve;
    });
    const holder = runInTenant(tenantA, () =>
      withTransaction(runtime, async (client) => {
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const item = await lockItemById(client, files.id, uploaded.fileItemId);
        if (!item || !pid.rows[0]) throw new Error("Missing Files row or holder PID");
        signal(pid.rows[0].pid);
        await gate;
      }),
    );
    const failures: unknown[] = [];
    try {
      const pid = await Promise.race([
        locked,
        holder.then(() => {
          throw new Error("Lock holder exited early");
        }),
      ]);
      expect(pid).toBeGreaterThan(0);
      const busy = await upload(authA, "busy recording bytes", {}, AbortSignal.timeout(5000));
      expect(busy.status).toBe(409);
      expect(await busy.json()).toMatchObject({ error: { code: "recording_busy" } });
      expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
    } catch (error) {
      failures.push(error);
    }
    release();
    try {
      await holder;
    } catch (error) {
      if (!failures.includes(error)) failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Busy upload or holder cleanup failed");
    const repeat = await upload(authA, "busy recording bytes");
    expect(repeat.status).toBe(200);
    expect(responseSchema.parse(await repeat.json())).toMatchObject({
      fileItemId: uploaded.fileItemId,
      created: false,
    });
  });

  it("runs the queued production transcription of uploaded video with its recording date", async () => {
    const video = await new Promise<Buffer>((resolve, reject) => {
      const spawnRequestedAt = new Date().toISOString();
      const options = {
        encoding: "buffer",
        maxBuffer: 2_000_000,
        timeout: 25_000,
        detached: true,
      } satisfies ExecFileOptionsWithBufferEncoding & { detached: boolean };
      const child = execFile(
        "ffmpeg",
        [
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=64x64:rate=5:duration=1",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          "-f",
          "mp4",
          "-movflags",
          "frag_keyframe+empty_moov+default_base_moof",
          "pipe:1",
        ],
        options,
        (error: Error | null, stdout: Buffer, stderr: Buffer) => {
          process.stdout.write(
            `${JSON.stringify({ fixture: "recording-video", pid: child.pid, derivedPgid: child.pid, spawnRequestedAt, executable: "ffmpeg", argv: child.spawnargs, exitCode: child.exitCode, signal: child.signalCode, stderr: stderr.toString("utf8") })}\n`,
          );
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
    const response = await upload(authA, new Uint8Array(video), { "X-Recorded-At": "2026-01-01T10:00:00Z" });
    expect(response.status).toBe(201);
    const uploaded = responseSchema.parse(await response.json());
    expect(uploaded.created).toBe(true);
    const consumed = await runTranscriptionFixture(
      { mode: "consume", tenantId: tenantA, storageRoot: root, fileItemId: uploaded.fileItemId },
      admin,
      true,
    );
    expect(consumed.result.diarizeCalls).toBeGreaterThan(0);
    expect(consumed.result.transcribeCalls).toBeGreaterThan(0);
    const transcript = await runInTenant(tenantA, () =>
      withTransaction(runtime, async (client) => {
        const database = await getDatabaseByModuleId(client, "transcripts");
        if (!database) throw new Error("Missing Transcripts database");
        return client.query<{ date: string }>(
          "SELECT properties ->> 'date' AS date FROM items WHERE database_id = $1 AND id = $2",
          [database.id, consumed.result.transcriptId],
        );
      }),
    );
    expect(new Date(transcript.rows[0]?.date ?? "").toISOString()).toBe("2026-01-01T10:00:00.000Z");
    await runInTenant(tenantA, async () => {
      const cp = createChokePoint(runtime);
      const databases = await cp.listDatabases();
      const files = databases.find((entry) => entry.ownerModuleId === "files");
      const emails = databases.find((entry) => entry.ownerModuleId === "emails");
      if (!files || !emails) throw new Error("Missing recording heartbeat databases");
      const attachments = (await cp.listProperties(emails.id)).find((property) => property.key === "attachments");
      if (!attachments) throw new Error("Missing Emails attachments relation");
      const before = await withTransaction(runtime, (client) =>
        getItemAutomation(client, consumed.result.transcriptId),
      );
      if (!before) throw new Error("Missing transcription automation");
      await createFilesTranscriptionTriggerAction(runtime)(
        { filesDatabaseId: files.id, attachmentsRelationPropertyId: attachments.id },
        { heartbeatId: "fixture", projectItemId: "fixture", itemId: uploaded.fileItemId },
      );
      const after = await withTransaction(runtime, (client) => getItemAutomation(client, consumed.result.transcriptId));
      expect(after?.attempts).toBe(before.attempts);
      const jobs = await withTransaction(runtime, (client) =>
        client.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE key = $1", [
          `transcription-job:${uploaded.fileItemId}`,
        ]),
      );
      expect(jobs.rows[0]?.count).toBe("0");
    });
    const linkedEvent = await event(tenantA, "Later Event");
    const linked = await upload(authA, new Uint8Array(video), { "X-Event-Id": linkedEvent });
    expect(linked.status).toBe(200);
    expect(responseSchema.parse(await linked.json())).toMatchObject({
      fileItemId: uploaded.fileItemId,
      created: false,
      transcriptId: consumed.result.transcriptId,
      eventId: linkedEvent,
    });
    const detail = await fetch(`${baseUrl}/api/transcripts/${consumed.result.transcriptId}`, {
      headers: { Authorization: authA },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ event: { id: linkedEvent } });
    const otherEvent = await event(tenantA, "Other Event");
    const conflict = await upload(authA, new Uint8Array(video), { "X-Event-Id": otherEvent });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "recording_linked_elsewhere" } });
  });
});
