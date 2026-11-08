import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  getDatabaseByModuleId,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  withTransaction,
  type BlobStorageWriter,
  type ChokePoint,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

/**
 * `POST /api/files` with `X-Attach-To-Item` and `X-Attach-Relation` (issue #1645), and tasks as an attach
 * target (issue #1654), through the real dispatcher on a `semprec_data` pool, so row-level security
 * applies, with two tenants. Every fixture write goes through the choke point.
 */

const PASSWORD = "s3cret-password";
const moduleRegistry = await loadFullModuleRegistry();

let admin: Pool;
let pool: Pool;
let chokePoint: ChokePoint;
let server: Server;
let baseUrl: string;
let storageDir: string;
/** Set by a test that needs to act while the upload body is streaming; released in that test's `finally`. */
let streamingGate: { started: () => void; release: Promise<void> } | null = null;

interface TenantFixture {
  tenantId: string;
  token: string;
  filesId: string;
  healthRecordsId: string;
  tasksId: string;
  projectsId: string;
}

let a: TenantFixture;
let b: TenantFixture;

/** The real local storage, with a hook that lets a test hold the stream until it has acted. */
function gatedStorage(real: BlobStorageWriter): BlobStorageWriter {
  return {
    async writeStream(storageKey: string, source: Readable, options) {
      const gate = streamingGate;
      if (gate) {
        gate.started();
        await gate.release;
      }
      return real.writeStream(storageKey, source, options);
    },
    delete: (storageKey) => real.delete(storageKey),
    readStream: (storageKey, range) => real.readStream(storageKey, range),
  };
}

async function requireDatabaseId(tenantId: string, moduleId: string): Promise<string> {
  const database = await runInTenant(tenantId, () =>
    withTransaction(pool, (client) => getDatabaseByModuleId(client, moduleId)),
  );
  if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
  return database.id;
}

async function buildTenant(): Promise<TenantFixture> {
  const tenantId = await createTestTenant(admin);
  await runInTenant(tenantId, () => seedSystem(pool));
  const email = `${randomUUID()}@example.com`;
  await createUser(admin, { email, passwordHash: await hashPassword(PASSWORD), tenantId });
  const { token } = await login(admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return {
    tenantId,
    token,
    filesId: await requireDatabaseId(tenantId, "files"),
    healthRecordsId: await requireDatabaseId(tenantId, "healthRecords"),
    tasksId: await requireDatabaseId(tenantId, "tasks"),
    projectsId: await requireDatabaseId(tenantId, "projects"),
  };
}

async function createItem(tenant: TenantFixture, databaseId: string, name: string): Promise<string> {
  return runInTenant(
    tenant.tenantId,
    async () => (await chokePoint.createItem({ databaseId, properties: { name } })).id,
  );
}

interface Upload {
  body: Buffer;
  filename?: string;
  targetItemId?: string;
  relationKey?: string;
}

interface Answer {
  status: number;
  text: string;
}

async function upload(tenant: TenantFixture, input: Upload): Promise<Answer> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tenant.token}`,
    "Content-Type": "application/octet-stream",
    "X-Filename": input.filename ?? "attachment.bin",
  };
  if (input.targetItemId !== undefined) headers["X-Attach-To-Item"] = input.targetItemId;
  if (input.relationKey !== undefined) headers["X-Attach-Relation"] = input.relationKey;
  const res = await fetch(`${baseUrl}/api/files`, { method: "POST", headers, body: input.body });
  return { status: res.status, text: await res.text() };
}

const itemBody = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) });
const errorBody = z.object({ error: z.object({ code: z.string(), details: z.unknown().optional() }) });

/** The live Files items of `tenant`, by id. */
async function fileIds(tenant: TenantFixture): Promise<string[]> {
  return runInTenant(tenant.tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY id",
      [tenant.filesId],
    );
    return rows.map((row) => row.id);
  });
}

async function blobCount(tenant: TenantFixture): Promise<number> {
  return runInTenant(tenant.tenantId, async () => {
    const { rows } = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs");
    return rows[0]?.count ?? -1;
  });
}

/** Every stored byte file under the storage root, as relative paths. */
async function storedFiles(): Promise<string[]> {
  const entries = await readdir(storageDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** The items `fileId`'s Files relation `relationKey` links to, read through the choke point's relation list. */
async function linked(tenant: TenantFixture, fileId: string, relationKey: string): Promise<string[]> {
  return runInTenant(tenant.tenantId, async () => {
    const property = (await chokePoint.listProperties(tenant.filesId)).find((p) => p.key === relationKey);
    if (!property) throw new Error(`Files.${relationKey} is not seeded`);
    const relations = await chokePoint.listItemRelations(fileId, property.id);
    if (relations === null) throw new Error("file not found");
    return relations.map((entry) => entry.targetItemId).sort();
  });
}

/** Everything an upload could have stored in `tenant`: Files items, blob rows and stored bytes. */
async function storedState(tenant: TenantFixture) {
  return { files: await fileIds(tenant), blobs: await blobCount(tenant), bytes: await storedFiles() };
}

const PDF = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`, "latin1");

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  chokePoint = createChokePoint(pool);
});

beforeEach(async () => {
  await resetDatabase(admin);
  storageDir = await mkdtemp(join(tmpdir(), "semprec-attach-upload-"));
  a = await buildTenant();
  b = await buildTenant();
  const dispatch = await createDispatcher(pool, {
    passwordResetMailer: { async sendPasswordResetEmail() {} },
    appBaseUrl: "http://localhost",
    setupToken: "unused-setup-token",
    moduleRegistry,
    blobStorage: gatedStorage(new LocalFsBlobStorageWriter(storageDir)),
    maxFileSizeBytes: 64 * 1024,
  });
  server = createServer(dispatch);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return async () => {
    streamingGate = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // This test's own storage root, created above.
    await rm(storageDir, { recursive: true, force: true });
  };
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("attach an upload to an item in the same request (issue #1645)", () => {
  it("links a new file to a health record (201), the same bytes to a second one (200), and repeats as a no-op", async () => {
    const first = await createItem(a, a.healthRecordsId, "Blood test");
    const second = await createItem(a, a.healthRecordsId, "Follow-up");
    const bytes = PDF("lab result");

    const created = await upload(a, { body: bytes, targetItemId: first, relationKey: "healthRecords" });
    expect(created.status, created.text).toBe(201);
    const file = itemBody.parse(JSON.parse(created.text));
    expect(await linked(a, file.id, "healthRecords")).toEqual([first]);

    const again = await upload(a, { body: bytes, targetItemId: second, relationKey: "healthRecords" });
    expect(again.status, again.text).toBe(200);
    expect(itemBody.parse(JSON.parse(again.text)).id).toBe(file.id);
    expect(await fileIds(a)).toEqual([file.id]);
    expect(await linked(a, file.id, "healthRecords")).toEqual([first, second].sort());

    const before = await storedState(a);
    const repeat = await upload(a, { body: bytes, targetItemId: second, relationKey: "healthRecords" });
    expect(repeat.status, repeat.text).toBe(200);
    expect(await linked(a, file.id, "healthRecords")).toEqual([first, second].sort());
    expect(await storedState(a)).toEqual(before);
  });

  it("answers an unknown, a trashed and another tenant's target with the same 404 and stores nothing", async () => {
    const trashed = await createItem(a, a.healthRecordsId, "Old record");
    await runInTenant(a.tenantId, () => chokePoint.softDeleteItem(a.healthRecordsId, trashed));
    const foreign = await createItem(b, b.healthRecordsId, "B's record");
    const before = await storedState(a);
    const answers: Answer[] = [];
    for (const targetItemId of [randomUUID(), trashed, foreign]) {
      answers.push(
        await upload(a, { body: PDF(`missing ${targetItemId}`), targetItemId, relationKey: "healthRecords" }),
      );
    }
    expect(answers[0]?.status).toBe(404);
    expect(errorBody.parse(JSON.parse(answers[0]?.text ?? "")).error.code).toBe("not_found");
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(answers[0]?.text).not.toContain(foreign);
    expect(await storedState(a)).toEqual(before);
  });

  it("refuses a relation key that is not a Files relation, or leads elsewhere, with 400 on X-Attach-Relation", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const before = await storedState(a);
    for (const relationKey of ["neznamy", "name", "projects"]) {
      const answer = await upload(a, { body: PDF(relationKey), targetItemId: record, relationKey });
      expect(answer.status, relationKey).toBe(400);
      expect(errorBody.parse(JSON.parse(answer.text)).error).toMatchObject({
        code: "validation_failed",
        details: { field: "X-Attach-Relation" },
      });
    }
    expect(await storedState(a)).toEqual(before);
  });

  it("refuses one attach header without the other, and a target that is not an id, with 400 naming the header", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const before = await storedState(a);
    const cases: [Upload, string][] = [
      [{ body: PDF("one"), targetItemId: record }, "X-Attach-Relation"],
      [{ body: PDF("two"), relationKey: "healthRecords" }, "X-Attach-To-Item"],
      [{ body: PDF("three"), targetItemId: "not-an-id", relationKey: "healthRecords" }, "X-Attach-To-Item"],
    ];
    for (const [input, field] of cases) {
      const answer = await upload(a, input);
      expect(answer.status, field).toBe(400);
      expect(errorBody.parse(JSON.parse(answer.text)).error).toMatchObject({
        code: "validation_failed",
        details: { field },
      });
    }
    expect(await storedState(a)).toEqual(before);
  });

  it("without the headers stores the file unlinked, 201 then 200 for the same bytes, as before", async () => {
    const bytes = PDF("plain");
    const created = await upload(a, { body: bytes });
    expect(created.status).toBe(201);
    const file = itemBody.parse(JSON.parse(created.text));
    const repeat = await upload(a, { body: bytes });
    expect(repeat.status).toBe(200);
    expect(itemBody.parse(JSON.parse(repeat.text)).id).toBe(file.id);
    expect(await linked(a, file.id, "healthRecords")).toEqual([]);
    expect(await fileIds(a)).toEqual([file.id]);
  });

  it("answers 404 and keeps nothing when the target is trashed while the body streams", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const before = await storedState(a);
    let started: () => void = () => {};
    const streaming = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => {};
    streamingGate = {
      started,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const answer = upload(a, { body: PDF("raced"), targetItemId: record, relationKey: "healthRecords" });
    // Observed at once, so a failed request cannot leave an unhandled rejection while the test waits.
    const settled = answer.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await streaming;
      await runInTenant(a.tenantId, () => chokePoint.softDeleteItem(a.healthRecordsId, record));
    } finally {
      release();
    }
    const outcome = await settled;
    if (!outcome.ok) throw outcome.error;
    expect(outcome.value.status).toBe(404);
    expect(errorBody.parse(JSON.parse(outcome.value.text)).error.code).toBe("not_found");
    expect(await storedState(a)).toEqual(before);
  });

  it("keeps a cardinality violation's 409 and rolls the new file and its bytes back", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    expect((await upload(a, { body: PDF("first"), targetItemId: record, relationKey: "healthRecords" })).status).toBe(
      201,
    );
    // No writer changes a schema-locked system relation's cardinality, so the one-to-one shape a 409 needs is
    // set directly on A's Files.healthRecords definition.
    const changed = await admin.query(
      `UPDATE relation_definitions SET cardinality = 'one_to_one'
       WHERE tenant_id = $1 AND property_id_a = (
         SELECT id FROM properties WHERE tenant_id = $1 AND database_id = $2 AND key = 'healthRecords')`,
      [a.tenantId, a.filesId],
    );
    expect(changed.rowCount).toBe(1);
    const before = await storedState(a);
    const answer = await upload(a, { body: PDF("second"), targetItemId: record, relationKey: "healthRecords" });
    expect(answer.status, answer.text).toBe(409);
    expect(await storedState(a)).toEqual(before);
  });
});
