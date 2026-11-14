import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce, type TaskList } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import {
  createActionRegistry,
  createCoreTaskList,
  createItemWithClient,
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  provisionTenant,
  raiseProblem,
  recordTokenGatewayCall,
  resolveMailModuleIds,
  updateItemWithClient,
  withTransaction,
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

describe("account deletion route (issue #1049)", () => {
  let adminPool: Pool;
  let pool: Pool;
  let server: Server;
  let baseUrl: string;

  async function signUp(
    tenantId: string,
    role: "admin" | "member",
  ): Promise<{ id: string; email: string; headers: { Authorization: string } }> {
    const email = `${randomUUID()}@example.com`;
    const user = await createUser(adminPool, { email, passwordHash: await hashPassword(PASSWORD), tenantId, role });
    const { token } = await login(adminPool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    return { id: user.id, email, headers: { Authorization: `Bearer ${token}` } };
  }

  function postDelete(headers: Record<string, string>, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/account/delete`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function tenantStatus(tenantId: string): Promise<string> {
    const { rows } = await adminPool.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId]);
    return rows[0]!.status;
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
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "account-delete-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-account-delete-${randomUUID()}`)),
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

  it("answers 202 deleting for the correct password, then 401 for the old session; tenant A is untouched", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(adminPool);
    const a = await signUp(tenantA, "admin");
    const b = await signUp(tenantB, "member");

    const res = await postDelete(b.headers, { password: PASSWORD });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "deleting" });
    expect(await tenantStatus(tenantB)).toBe("deleting");
    expect((await fetch(`${baseUrl}/api/account/exports`, { headers: b.headers })).status).toBe(401);
    expect(await tenantStatus(tenantA)).toBe("active");
    expect((await fetch(`${baseUrl}/api/account/exports`, { headers: a.headers })).status).toBe(200);
    const audit = await adminPool.query("SELECT 1 FROM admin_audit_log");
    expect(audit.rowCount).toBe(0);
  });

  it("answers 403 reauthentication_failed for a wrong password and records the attempt from the socket address", async () => {
    const b = await signUp(await createTestTenant(adminPool), "member");

    const res = await postDelete(b.headers, { password: "wrong-password" });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "reauthentication_failed" } });
    const attempts = await adminPool.query<{ ip: string }>(
      "SELECT host(ip) AS ip FROM login_attempts WHERE email = $1 AND succeeded = false",
      [b.email],
    );
    expect(attempts.rows).toHaveLength(1);
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1"]).toContain(attempts.rows[0]!.ip);
    expect((await fetch(`${baseUrl}/api/account/exports`, { headers: b.headers })).status).toBe(200);
  });

  it("answers 409 last_admin for the only active admin", async () => {
    const only = await signUp(await createTestTenant(adminPool), "admin");

    const res = await postDelete(only.headers, { password: PASSWORD });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "last_admin" } });
  });

  it("answers 400 with field password for a missing, empty or non-string password and for a non-object body", async () => {
    const b = await signUp(await createTestTenant(adminPool), "member");
    for (const body of [{}, { password: "" }, { password: 42 }]) {
      const res = await postDelete(b.headers, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "validation_failed", details: { field: "password" } } });
    }
    expect((await postDelete(b.headers, null)).status).toBe(400);
    expect(
      await tenantStatus(
        (await adminPool.query<{ tenant_id: string }>("SELECT tenant_id FROM users WHERE id = $1", [b.id])).rows[0]!
          .tenant_id,
      ),
    ).toBe("active");
  });

  it("answers 401 to an anonymous caller", async () => {
    const res = await fetch(`${baseUrl}/api/account/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(401);
  });
});

const accountSummarySchema = z.strictObject({
  activeSessions: z.number().int(),
  mailAccountCount: z.number().int(),
  mailAccountsNeedingReauth: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  trashItems: z.number().int(),
  trashDatabases: z.number().int(),
  problemCount: z.number().int(),
  aiCostMonthUsd: z.number(),
});
type AccountSummaryBody = z.infer<typeof accountSummarySchema>;

describe("account summary route (issue gh-1903)", () => {
  let adminPool: Pool;
  let pool: Pool;
  let server: Server;
  let baseUrl: string;

  interface Member {
    userId: string;
    email: string;
    password: string;
    headers: { Authorization: string };
  }

  /** A tenant provisioned like a real one, with a budget row so the Semp status does not list a missing budget. */
  async function newTenant(): Promise<string> {
    const tenantId = await createTestTenant(adminPool);
    await provisionTenant(pool, tenantId);
    await setTenantAiBudget(adminPool, tenantId);
    return tenantId;
  }

  async function signUp(tenantId: string): Promise<Member> {
    const email = `${randomUUID()}@example.com`;
    const user = await createUser(adminPool, { email, passwordHash: await hashPassword(PASSWORD), tenantId });
    return { userId: user.id, email, password: PASSWORD, headers: await signIn(email) };
  }

  /** Another session of the same user, as a second device signs in. */
  async function signIn(email: string): Promise<{ Authorization: string }> {
    const { token } = await login(adminPool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    return { Authorization: `Bearer ${token}` };
  }

  async function request(
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  /** A 2xx answer's body, for the writes that build the fixture through the real routes. */
  async function requestOk(headers: Record<string, string>, method: string, path: string, body?: unknown) {
    const answer = await request(headers, method, path, body);
    if (answer.status < 200 || answer.status >= 300) {
      throw new Error(`${method} ${path} answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    }
    return answer.body;
  }

  async function readSummary(headers: Record<string, string>): Promise<AccountSummaryBody> {
    return accountSummarySchema.parse(await requestOk(headers, "GET", "/api/account/summary"));
  }

  const idBody = z.object({ id: z.string() });

  async function createDatabase(headers: Record<string, string>, name: string): Promise<string> {
    return idBody.parse(await requestOk(headers, "POST", "/api/databases", { name })).id;
  }

  /** `count` items of a new database, each moved to the trash on its own: each is the root of its deletion. */
  async function trashItems(headers: Record<string, string>, count: number): Promise<string[]> {
    const databaseId = await createDatabase(headers, `Trash source ${randomUUID()}`);
    const ids: string[] = [];
    for (let n = 0; n < count; n += 1) {
      const id = idBody.parse(
        await requestOk(headers, "POST", `/api/databases/${databaseId}/items`, { properties: {} }),
      ).id;
      await requestOk(headers, "DELETE", `/api/items/${id}`);
      ids.push(id);
    }
    return ids;
  }

  /** `count` empty user databases, each archived through the delete route. */
  async function archiveDatabases(headers: Record<string, string>, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let n = 0; n < count; n += 1) {
      const id = await createDatabase(headers, `Archived ${randomUUID()}`);
      await requestOk(headers, "DELETE", `/api/databases/${id}`);
      ids.push(id);
    }
    return ids;
  }

  /** A Mailboxes item named `name`; `syncStatus` is written the way the sync job writes it. */
  function createMailbox(tenantId: string, name: string, syncStatus?: "needsReauthorization"): Promise<string> {
    return runInTenant(tenantId, () =>
      withTransaction(pool, async (client) => {
        const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
        const mailbox = await createItemWithClient(client, {
          databaseId: mailboxesDatabaseId,
          properties: { name, provider: "generic" },
        });
        if (syncStatus !== undefined) {
          await updateItemWithClient(
            client,
            { databaseId: mailboxesDatabaseId, itemId: mailbox.id, propertiesPatch: { syncStatus } },
            { allowedSystemKeys: ["syncStatus"] },
          );
        }
        return mailbox.id;
      }),
    );
  }

  /** One active Semp problem of the tenant, raised through the writer the producers use. */
  function raiseSempProblem(tenantId: string, userId: string): Promise<string> {
    return runInTenant(tenantId, () =>
      withTransaction(pool, async (client) => {
        const sourceId = randomUUID();
        const raised = await raiseProblem(client, {
          userId,
          category: "agents",
          kind: "agentHeartbeat",
          severity: "warning",
          sourceTable: "project_heartbeats",
          sourceId,
          dedupeKey: `agents:heartbeat:${sourceId}`,
        });
        return raised.problemId;
      }),
    );
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
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "account-summary-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-account-summary-${randomUUID()}`)),
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

  it("counts 4 active sessions without the revoked one, 5 trashed root items and 2 archived databases", async () => {
    const tenantId = await newTenant();
    const member = await signUp(tenantId);
    for (let device = 0; device < 3; device += 1) await signIn(member.email);
    const toRevoke = await signIn(member.email);
    const current = z
      .object({ sessions: z.array(z.object({ id: z.string(), current: z.boolean() })) })
      .parse(await requestOk(toRevoke, "GET", "/api/auth/sessions"))
      .sessions.find((session) => session.current);
    if (!current) throw new Error("the session list names no current session");
    await requestOk(member.headers, "POST", `/api/auth/sessions/${current.id}/revoke`, {});
    const trashed = await trashItems(member.headers, 5);
    const archived = await archiveDatabases(member.headers, 2);

    const summary = await readSummary(member.headers);

    expect(summary).toEqual({
      activeSessions: 4,
      mailAccountCount: 0,
      mailAccountsNeedingReauth: [],
      trashItems: 5,
      trashDatabases: 2,
      problemCount: 0,
      aiCostMonthUsd: 0,
    });
    // The fixture is real: the owners' lists hold the very rows the counts stand for.
    const trashList = z
      .object({ items: z.array(z.object({ item: idBody })) })
      .parse(await requestOk(member.headers, "GET", "/api/trash/items?limit=200"));
    expect(trashList.items.map((row) => row.item.id).sort()).toEqual([...trashed].sort());
    const databaseList = z
      .object({ databases: z.array(idBody) })
      .parse(await requestOk(member.headers, "GET", "/api/trash/databases"));
    expect(databaseList.databases.map((row) => row.id).sort()).toEqual([...archived].sort());
  });

  it("answers the figures the owners' own routes answer for the same data", async () => {
    const tenantId = await newTenant();
    const member = await signUp(tenantId);
    await signIn(member.email);
    await createMailbox(tenantId, "Private account");
    const signedOut = await createMailbox(tenantId, "Work account", "needsReauthorization");
    await raiseSempProblem(tenantId, member.userId);
    await runInTenant(tenantId, () =>
      recordTokenGatewayCall(pool, {
        provider: "anthropic",
        model: "summary-test",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 2.5,
      }),
    );
    await trashItems(member.headers, 2);
    await archiveDatabases(member.headers, 1);

    const summary = await readSummary(member.headers);

    const sessions = z
      .object({ sessions: z.array(idBody) })
      .parse(await requestOk(member.headers, "GET", "/api/auth/sessions")).sessions;
    const mail = z
      .object({
        accounts: z.number(),
        accountsNeedingReauth: z.array(z.object({ id: z.string(), name: z.string() })),
      })
      .parse(await requestOk(member.headers, "GET", "/api/mail/summary"));
    const trashItemsTotal = z
      .object({ totalCount: z.number() })
      .parse(await requestOk(member.headers, "GET", "/api/trash/items")).totalCount;
    const trashDatabasesTotal = z
      .object({ totalCount: z.number() })
      .parse(await requestOk(member.headers, "GET", "/api/trash/databases")).totalCount;
    const semp = z
      .object({ activeCount: z.number() })
      .parse(await requestOk(member.headers, "GET", "/api/semp-status/summary"));
    const usage = z
      .object({ spentMonthUsd: z.number() })
      .parse(await requestOk(member.headers, "GET", "/api/ai-usage/summary"));
    expect(summary).toEqual({
      activeSessions: sessions.length,
      mailAccountCount: mail.accounts,
      mailAccountsNeedingReauth: mail.accountsNeedingReauth,
      trashItems: trashItemsTotal,
      trashDatabases: trashDatabasesTotal,
      problemCount: semp.activeCount,
      aiCostMonthUsd: usage.spentMonthUsd,
    });
    // The equal figures are not all zero: the data above is what they count.
    expect(summary).toEqual({
      activeSessions: 2,
      mailAccountCount: 2,
      mailAccountsNeedingReauth: [{ id: signedOut, name: "Work account" }],
      trashItems: 2,
      trashDatabases: 1,
      problemCount: 1,
      aiCostMonthUsd: 2.5,
    });
  });

  it("keeps each tenant's figures apart: neither sees the other's sessions, trash, accounts, problems or spend", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const a = await signUp(tenantA);
    const b = await signUp(tenantB);
    await signIn(b.email);
    await signIn(b.email);
    await trashItems(a.headers, 1);
    await trashItems(b.headers, 3);
    await archiveDatabases(b.headers, 2);
    const signedOutOfA = await createMailbox(tenantA, "Signed out of A", "needsReauthorization");
    const signedOutOfB = await createMailbox(tenantB, "Signed out of B", "needsReauthorization");
    await createMailbox(tenantB, "Second of B");
    await raiseSempProblem(tenantB, b.userId);
    await runInTenant(tenantB, () =>
      recordTokenGatewayCall(pool, {
        provider: "anthropic",
        model: "summary-test",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 4,
      }),
    );

    expect(await readSummary(a.headers)).toEqual({
      activeSessions: 1,
      mailAccountCount: 1,
      mailAccountsNeedingReauth: [{ id: signedOutOfA, name: "Signed out of A" }],
      trashItems: 1,
      trashDatabases: 0,
      problemCount: 0,
      aiCostMonthUsd: 0,
    });
    expect(await readSummary(b.headers)).toEqual({
      activeSessions: 3,
      mailAccountCount: 2,
      mailAccountsNeedingReauth: [{ id: signedOutOfB, name: "Signed out of B" }],
      trashItems: 3,
      trashDatabases: 2,
      problemCount: 1,
      aiCostMonthUsd: 4,
    });
  });

  it("rejects a request without a session, and one with a token that names no session, with 401", async () => {
    const anonymous = await request({}, "GET", "/api/account/summary");
    const unknownToken = await request({ Authorization: "Bearer not-a-session-token" }, "GET", "/api/account/summary");

    expect(anonymous.status).toBe(401);
    expect(unknownToken.status).toBe(401);
  });
});
