import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, runOnce, type TaskList } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createActionRegistry,
  createCoreTaskList,
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  type BlobStorageWriter,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { createAccountExportDownloadListener } from "../accountHandler.js";

const PASSWORD = "s3cret-password";
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

interface ExportSummary {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  byteSize: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExportSummary(value: unknown): value is ExportSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    typeof value.createdAt === "string" &&
    (value.completedAt === null || typeof value.completedAt === "string") &&
    (value.expiresAt === null || typeof value.expiresAt === "string") &&
    (value.byteSize === null || typeof value.byteSize === "number")
  );
}

/** Checks a `{ export }` response body and returns the export. */
function readExport(body: unknown): ExportSummary {
  if (!isRecord(body) || !isExportSummary(body.export)) throw new Error("expected an { export } body");
  return body.export;
}

/** Checks a `{ exports }` response body and returns the list. */
function readExports(body: unknown): ExportSummary[] {
  if (!isRecord(body) || !Array.isArray(body.exports) || !body.exports.every(isExportSummary)) {
    throw new Error("expected an { exports } body");
  }
  return body.exports;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A `BlobStorageWriter` whose read stream the test controls, to observe it being destroyed. */
class RecordingBlobStorage implements BlobStorageWriter {
  lastReadStream: PassThrough | undefined;

  async writeStream(): Promise<{ byteSize: number; contentHash: string }> {
    throw new Error("not used");
  }

  async delete(): Promise<void> {
    throw new Error("not used");
  }

  readStream(): Readable {
    const passThrough = new PassThrough();
    passThrough.write("chunk-one");
    this.lastReadStream = passThrough;
    return passThrough;
  }
}

describe("account export routes (issue #1043)", () => {
  let adminPool: Pool;
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  let filesDir: string;
  let filesStorage: LocalFsBlobStorageWriter;
  let tenantA: string;
  let tenantB: string;

  async function signInTo(tenantId: string): Promise<{ Authorization: string }> {
    const email = `${randomUUID()}@example.com`;
    await createUser(adminPool, { email, passwordHash: await hashPassword(PASSWORD), tenantId });
    const { token } = await login(adminPool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    return { Authorization: `Bearer ${token}` };
  }

  async function postExport(headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}/api/account/exports`, { method: "POST", headers });
    return { status: res.status, body: await res.json() };
  }

  async function download(
    headers: Record<string, string>,
    exportId: string,
  ): Promise<{ status: number; body: Buffer; headers: Headers }> {
    const res = await fetch(`${baseUrl}/api/account/exports/${exportId}/download`, { headers });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }

  /** Runs every queued `tenantExport` job through the production task list, writing archives to `files`. */
  async function runExportJobs(files: BlobStorageWriter = filesStorage): Promise<void> {
    const coreTasks = createCoreTaskList(
      pool,
      createActionRegistry(),
      undefined,
      undefined,
      new LocalFsBlobStorageWriter(join(filesDir, "..", "mail")),
      undefined,
      undefined,
      undefined,
      undefined,
      files,
    );
    const exportTask = coreTasks[CORE_TASK_NAMES.TENANT_EXPORT];
    if (!exportTask) throw new Error("createCoreTaskList has no tenantExport task");
    const taskList: TaskList = { [CORE_TASK_NAMES.TENANT_EXPORT]: exportTask };
    await runOnce({ pgPool: pool, taskList });
  }

  /** A storage whose writes stop after 64 bytes, so the export job fails. */
  function failingFiles(): BlobStorageWriter {
    return {
      writeStream: (key, source) => filesStorage.writeStream(key, source, { maxBytes: 64 }),
      delete: (key) => filesStorage.delete(key),
      readStream: (key, range) => filesStorage.readStream(key, range),
    };
  }

  async function readyExport(headers: Record<string, string>): Promise<string> {
    const { body } = await postExport(headers);
    const exportId = readExport(body).id;
    await runExportJobs();
    return exportId;
  }

  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    filesDir = join(tmpdir(), `semprec-test-account-exports-${randomUUID()}`, "files");
    filesStorage = new LocalFsBlobStorageWriter(filesDir);
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "account-handler-setup-token",
      moduleRegistry,
      blobStorage: filesStorage,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("creates one pending export with one job stamped with the caller's tenant, then returns it again without a second job", async () => {
    const headersA = await signInTo(tenantA);

    const first = await postExport(headersA);
    expect(first.status).toBe(202);
    const created = readExport(first.body);
    expect(created).toEqual({
      id: expect.any(String),
      status: "pending",
      createdAt: expect.any(String),
      completedAt: null,
      expiresAt: null,
      byteSize: null,
    });
    expect(await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.TENANT_EXPORT)).toEqual([
      expect.objectContaining({ tenantId: tenantA, payload: { exportId: created.id } }),
    ]);

    const second = await postExport(headersA);
    expect(second.status).toBe(200);
    expect(readExport(second.body).id).toBe(created.id);
    expect(await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.TENANT_EXPORT)).toHaveLength(1);
  });

  it("keeps each tenant's exports apart: B gets its own export and lists only its own", async () => {
    const headersA = await signInTo(tenantA);
    const headersB = await signInTo(tenantB);
    const exportA = readExport((await postExport(headersA)).body).id;

    const postedB = await postExport(headersB);
    expect(postedB.status).toBe(202);
    const exportB = readExport(postedB.body).id;
    expect(exportB).not.toBe(exportA);

    const listB = await fetch(`${baseUrl}/api/account/exports`, { headers: headersB });
    expect(listB.status).toBe(200);
    expect(readExports(await listB.json()).map((e) => e.id)).toEqual([exportB]);
    const payloads = await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.TENANT_EXPORT);
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: tenantA, payload: { exportId: exportA } }),
        expect.objectContaining({ tenantId: tenantB, payload: { exportId: exportB } }),
      ]),
    );
  });

  it("lists the caller's unexpired exports newest first", async () => {
    const headersA = await signInTo(tenantA);
    const older = await readyExport(headersA);
    const expired = await readyExport(headersA);
    const newer = readExport((await postExport(headersA)).body).id;
    // Nothing in production moves an expiry into the past; the expiry sweep's tests do the same.
    await adminPool.query("UPDATE tenant_exports SET expires_at = now() - interval '1 second' WHERE id = $1", [
      expired,
    ]);

    const res = await fetch(`${baseUrl}/api/account/exports`, { headers: headersA });

    expect(res.status).toBe(200);
    const ids = readExports(await res.json()).map((e) => e.id);
    expect(ids).toEqual([newer, older]);
  });

  it("streams a ready export with the archive's bytes and the download headers", async () => {
    const headersA = await signInTo(tenantA);
    const exportId = await readyExport(headersA);

    const res = await download(headersA, exportId);

    expect(res.status).toBe(200);
    const stored = readFileSync(join(filesDir, `${tenantA}/exports/${exportId}.zip`));
    expect(res.body.equals(stored)).toBe(true);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-length")).toBe(String(stored.length));
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { rows } = await adminPool.query<{ day: string }>(
      "SELECT to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM tenant_exports WHERE id = $1",
      [exportId],
    );
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="semprec-export-${rows[0]?.day}.zip"`);
  });

  it("answers a foreign, random, pending, failed or expired export with the identical 404", async () => {
    const headersA = await signInTo(tenantA);
    const headersB = await signInTo(tenantB);

    const pending = readExport((await postExport(headersA)).body).id;
    const pendingRes = await download(headersA, pending);
    await runExportJobs(failingFiles());
    const failedRes = await download(headersA, pending);

    const ready = await readyExport(headersA);
    const foreignRes = await download(headersB, ready);
    const randomRes = await download(headersA, randomUUID());
    // Nothing in production moves an expiry into the past.
    await adminPool.query("UPDATE tenant_exports SET expires_at = now() - interval '1 second' WHERE id = $1", [ready]);
    const expiredRes = await download(headersA, ready);

    for (const res of [pendingRes, failedRes, foreignRes, randomRes, expiredRes]) {
      expect(res.status).toBe(404);
      expect(res.body.toString("utf8")).toBe('{"error":{"code":"not_found"}}');
      expect(res.headers.get("content-disposition")).toBeNull();
    }
  });

  it("answers a non-uuid id with 400, a request without a session with 401 and an unknown path with 404", async () => {
    const headersA = await signInTo(tenantA);
    const exportId = await readyExport(headersA);

    const malformed = await download(headersA, "not-a-uuid");
    const anonymous = await download({}, exportId);
    const unknownPath = await download(headersA, `${exportId}/extra`);

    expect(malformed.status).toBe(400);
    expect(anonymous.status).toBe(401);
    expect(unknownPath.status).toBe(404);
    expect(unknownPath.body.toString("utf8")).toBe('{"error":{"code":"not_found"}}');
  });

  it("destroys the read stream when the client aborts mid-download", async () => {
    const headersA = await signInTo(tenantA);
    const exportId = await readyExport(headersA);
    const storage = new RecordingBlobStorage();
    const listener = createServer(createAccountExportDownloadListener(pool, { storage }));
    await new Promise<void>((resolve) => listener.listen(0, resolve));
    try {
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
      const controller = new AbortController();
      // The archive is larger than the one chunk the recording stream holds, so the download never completes.
      const res = await fetch(`http://127.0.0.1:${address.port}/api/account/exports/${exportId}/download`, {
        headers: headersA,
        signal: controller.signal,
      });
      expect(res.status).toBe(200);

      controller.abort();

      await waitUntil(() => storage.lastReadStream?.destroyed === true, 2000);
      expect(storage.lastReadStream?.destroyed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
