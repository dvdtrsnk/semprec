import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  attachUploadedFileWithClient,
  createChokePoint,
  createUser,
  getDatabaseByModuleId,
  hashPassword,
  ingestUploadedFileWithTransaction,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  resolveUploadAttachTarget,
  seedSystem,
  setInvalidationHook,
  withTransaction,
  type BlobStorageWriter,
  type ChokePoint,
  type InvalidationEvent,
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
/**
 * The dispatcher's own runtime-role pool; no other code borrows from it. Every client it opens is instrumented
 * by `instrumentReservations`.
 */
let uploadPool: Pool;
let chokePoint: ChokePoint;
let server: Server;
let baseUrl: string;
let storageDir: string;
/** Set by a test that needs to act while the upload body is streaming; released in that test's `finally`. */
let streamingGate: { started: () => void; release: Promise<void> } | null = null;

/** Armed by a test that pauses an upload at one attach reservation; one-shot, disarmed when it is reached. */
let reservationBarrier: { itemId: string; reached: (pid: number) => void; release: Promise<void> } | null = null;
/** The release of every barrier armed in the current test, called again by its teardown. */
let barrierReleases: (() => void)[] = [];
/** Every realtime invalidation this process emitted during the current test. */
let invalidations: InvalidationEvent[] = [];

/**
 * Test-local instrumentation of the dispatcher's own pool, installed on each client it opens. When the client is
 * about to run an attach reservation (`FOR UPDATE NOWAIT`) of the item an armed barrier names, it reports its
 * backend pid and waits for the barrier's release, then runs that same statement with the original receiver and
 * arguments; its result or error is the real one. Every other call is passed straight through.
 */
function instrumentReservations(client: PoolClient): void {
  const original: unknown = Reflect.get(client, "query");
  if (typeof original !== "function") throw new Error("pg client has no query method");
  const instrumented = (...args: unknown[]): unknown => {
    const barrier = reservationBarrier;
    const [text, values] = args;
    if (
      barrier &&
      typeof text === "string" &&
      text.includes("FOR UPDATE NOWAIT") &&
      Array.isArray(values) &&
      values[1] === barrier.itemId &&
      !args.some((arg) => typeof arg === "function")
    ) {
      reservationBarrier = null;
      const pid: unknown = Reflect.get(client, "processID");
      if (typeof pid !== "number") throw new Error("pg client has no backend pid");
      barrier.reached(pid);
      return barrier.release.then(() => Reflect.apply(original, client, args));
    }
    return Reflect.apply(original, client, args);
  };
  if (!Reflect.set(client, "query", instrumented)) throw new Error("Could not instrument the pg client");
}

/** Arms a one-shot barrier at the next attach reservation of `itemId`; `reached` resolves with that backend's pid. */
function pauseAtReservationOf(itemId: string): { reached: Promise<number>; release: () => void } {
  let reached: (pid: number) => void = () => {};
  const arrived = new Promise<number>((resolve) => {
    reached = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  reservationBarrier = { itemId, reached, release: released };
  barrierReleases.push(release);
  return { reached: arrived, release };
}

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

/** Every stored byte file under the storage root, by path, with the SHA-256 of its content. */
async function storedBytes(): Promise<Record<string, string>> {
  const entries = await readdir(storageDir, { recursive: true, withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const hashes: Record<string, string> = {};
  for (const path of paths)
    hashes[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  return hashes;
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

/**
 * The stored bytes once `ready` holds for them, read again for at most 5 s: a content-hash dedup hit removes
 * its streamed copy after the commit without the response waiting for it. Returns the last read either way, so
 * the caller's assertion reports any difference.
 */
async function storedBytesOnce(ready: (bytes: Record<string, string>) => boolean): Promise<Record<string, string>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const bytes = await storedBytes();
    if (ready(bytes) || Date.now() >= deadline) return bytes;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Everything an upload could have stored in `tenant`, exactly: every Files item row (trashed ones included),
 * every blob row and every relation edge of the tenant as stored, and every stored byte file with the SHA-256
 * of its content. Read on the runtime pool in the tenant, so row-level security applies.
 */
async function storedState(tenant: TenantFixture) {
  const rows = (text: string, values: unknown[] = []) =>
    runInTenant(tenant.tenantId, async () => (await pool.query<{ row: unknown }>(text, values)).rows.map((r) => r.row));
  return {
    files: await rows("SELECT to_jsonb(i) AS row FROM items i WHERE i.database_id = $1 ORDER BY i.id", [
      tenant.filesId,
    ]),
    blobs: await rows("SELECT to_jsonb(b) AS row FROM blobs b ORDER BY b.id"),
    edges: await rows("SELECT to_jsonb(r) AS row FROM item_relations r ORDER BY r.id"),
    bytes: await storedBytes(),
  };
}

/** Rejects naming `what` when `work` has not settled within `ms`; the timer is cleared either way. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rethrows the case's own failure first: alone, or inside an `AggregateError` with the cleanup failures after it.
 * A thrown falsy value counts, because `primary` wraps it.
 */
function settle(primary: { error: unknown } | undefined, cleanupFailures: unknown[]): void {
  if (primary && cleanupFailures.length > 0) {
    throw new AggregateError([primary.error, ...cleanupFailures], "The case and its cleanup failed", {
      cause: primary.error,
    });
  }
  if (primary) throw primary.error;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "The case's cleanup failed");
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** `work`'s outcome as a value, so a started request is observed from the start and read when the case is ready. */
function outcomeOf<T>(work: Promise<T>): Promise<Outcome<T>> {
  return work.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );
}

/** Awaits every started request with a bound, so none outlives the case; returns each one's outcome. */
async function settleRequests<T>(started: Promise<Outcome<T>>[], what: string): Promise<Outcome<T>[]> {
  return within(Promise.all(started), 10_000, what);
}

/** The pids that wait, directly or through another waiter, on the backend `holderPid`. */
async function waitersOn(holderPid: number): Promise<Set<number>> {
  const { rows } = await admin.query<{ pid: number; blockers: number[] }>(
    "SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
  );
  const waiting = new Set<number>();
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (waiting.has(row.pid)) continue;
      if (row.blockers.some((blocker) => blocker === holderPid || waiting.has(blocker))) {
        waiting.add(row.pid);
        grew = true;
      }
    }
  }
  return waiting;
}

/**
 * One row of graphile-worker's public `jobs` view, every column it has (graphile-worker 0.17.3,
 * `sql/000017.sql`). `revision` and `updated_at` change when a keyed job is replaced. The view exposes no
 * payload, so payloads are not observed.
 */
const queuedJobRow = z
  .object({
    id: z.string(),
    queue_name: z.string().nullable(),
    task_identifier: z.string(),
    priority: z.number(),
    run_at: z.date(),
    attempts: z.number(),
    max_attempts: z.number(),
    last_error: z.string().nullable(),
    created_at: z.date(),
    updated_at: z.date(),
    key: z.string().nullable(),
    locked_at: z.date().nullable(),
    locked_by: z.string().nullable(),
    revision: z.number(),
    flags: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
type QueuedJob = z.infer<typeof queuedJobRow>;

/** Every queued job, whole rows of graphile-worker's public `jobs` view, in id order. */
async function queuedJobs(): Promise<QueuedJob[]> {
  const { rows } = await admin.query<Record<string, unknown>>(
    `SELECT id::text AS id, queue_name, task_identifier, priority, run_at, attempts, max_attempts, last_error,
            created_at, updated_at, key, locked_at, locked_by, revision, flags
     FROM graphile_worker.jobs ORDER BY id`,
  );
  return rows.map((row) => queuedJobRow.parse(row));
}

/**
 * The jobs `after` holds that `before` did not, or holds changed, as their content without identity and
 * timing (row id, timestamps, attempts), with each id of `names` replaced by its placeholder; sorted, so two
 * writers' deltas compare as multisets.
 */
function jobDelta(before: QueuedJob[], after: QueuedJob[], names: Record<string, string>): string[] {
  const earlier = new Map(before.map((job) => [job.id, JSON.stringify(job)]));
  const rename = (value: string | null) => {
    if (value === null) return null;
    let renamed = value;
    for (const [id, placeholder] of Object.entries(names)) renamed = renamed.split(id).join(placeholder);
    return renamed;
  };
  return after
    .filter((job) => earlier.get(job.id) !== JSON.stringify(job))
    .map((job) =>
      JSON.stringify({
        queue: rename(job.queue_name),
        task: job.task_identifier,
        key: rename(job.key),
        priority: job.priority,
        maxAttempts: job.max_attempts,
        flags: job.flags,
        replaced: earlier.has(job.id),
      }),
    )
    .sort();
}

/** `events` without their timing, with each id of `names` replaced by its placeholder; sorted. */
function invalidationShape(events: InvalidationEvent[], names: Record<string, string>): string[] {
  return events
    .map((event) => {
      let text = JSON.stringify("updatedAt" in event ? { ...event, updatedAt: "<time>" } : event);
      for (const [id, placeholder] of Object.entries(names)) text = text.split(id).join(placeholder);
      return text;
    })
    .sort();
}

/** Reads `probe` until it returns a value, failing after 10 s. */
async function pollFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`${what} was not observed within 10000 ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The id of `tenant`'s one blob; fails when it holds none or several. */
async function onlyBlobId(tenant: TenantFixture): Promise<string> {
  const ids = await runInTenant(tenant.tenantId, async () =>
    (await pool.query<{ id: string }>("SELECT id FROM blobs")).rows.map((row) => row.id),
  );
  const [id] = ids;
  if (ids.length !== 1 || id === undefined) throw new Error(`expected one blob, found ${ids.length}`);
  return id;
}

/**
 * The stored bytes `paused` holds beyond `preRequest`, the bytes stored before a paused upload started: exactly
 * one file, that upload's own streamed copy of `body`, with every other file as it was. Returns its key.
 */
function onlyInFlightCopy(preRequest: Record<string, string>, paused: Record<string, string>, body: Buffer): string {
  const extra = Object.keys(paused).filter((key) => !Object.hasOwn(preRequest, key));
  expect(extra).toHaveLength(1);
  const [key] = extra;
  if (key === undefined) throw new Error("no in-flight copy");
  expect(paused[key]).toBe(createHash("sha256").update(body).digest("hex"));
  expect(Object.fromEntries(Object.entries(paused).filter(([other]) => other !== key))).toEqual(preRequest);
  return key;
}

/** The ids of `tenant`'s blobs. */
async function blobIdsOf(tenant: TenantFixture): Promise<string[]> {
  return runInTenant(tenant.tenantId, async () =>
    (await pool.query<{ id: string }>("SELECT id FROM blobs ORDER BY id")).rows.map((row) => row.id),
  );
}

/** The upload answer's error code, with the body checked to name none of `ids`. */
function conflictCode(answer: Answer, ids: string[]): string {
  for (const id of ids) expect(answer.text).not.toContain(id);
  return errorBody.parse(JSON.parse(answer.text)).error.code;
}

/** Sets a relation definition of `tenant`'s Files relation `relationKey` to one-to-one. */
async function makeOneToOne(tenant: TenantFixture, relationKey: string): Promise<void> {
  // No writer changes a schema-locked system relation's cardinality, so the one-to-one shape a 409 needs is
  // set directly on the tenant's definition of that Files relation.
  const changed = await admin.query(
    `UPDATE relation_definitions SET cardinality = 'one_to_one'
     WHERE tenant_id = $1 AND (SELECT id FROM properties WHERE tenant_id = $1 AND database_id = $2 AND key = $3)
       IN (property_id_a, property_id_b)`,
    [tenant.tenantId, tenant.filesId, relationKey],
  );
  expect(changed.rowCount).toBe(1);
}

const PDF = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`, "latin1");
const JPG = (marker: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from(`JFIF ${marker}`, "latin1")]);

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  chokePoint = createChokePoint(pool);
  uploadPool = await createRuntimeRolePool(admin, "semprec_data");
  uploadPool.on("connect", instrumentReservations);
});

beforeEach(async () => {
  await resetDatabase(admin);
  storageDir = await mkdtemp(join(tmpdir(), "semprec-attach-upload-"));
  a = await buildTenant();
  b = await buildTenant();
  invalidations = [];
  setInvalidationHook((event) => invalidations.push(event));
  const dispatch = await createDispatcher(uploadPool, {
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
    reservationBarrier = null;
    for (const release of barrierReleases) release();
    barrierReleases = [];
    setInvalidationHook(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // This test's own storage root, created above.
    await rm(storageDir, { recursive: true, force: true });
  };
});

afterAll(async () => {
  await uploadPool?.end();
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
    let primary: { error: unknown } | undefined;
    try {
      await within(streaming, 10_000, "The upload's body stream");
      await runInTenant(a.tenantId, () => chokePoint.softDeleteItem(a.healthRecordsId, record));
    } catch (error) {
      primary = { error };
    }
    // The request settles before the case goes on or ends, whatever happened above.
    release();
    const failures: unknown[] = [];
    let outcome: Awaited<typeof settled> | undefined;
    try {
      outcome = await within(settled, 10_000, "The raced upload");
    } catch (error) {
      failures.push(error);
    }
    settle(primary, failures);
    if (!outcome) throw new Error("The raced upload did not settle");
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
    await makeOneToOne(a, "healthRecords");
    const before = await storedState(a);
    const answer = await upload(a, { body: PDF("second"), targetItemId: record, relationKey: "healthRecords" });
    expect(answer.status, answer.text).toBe(409);
    expect(await storedState(a)).toEqual(before);
  });

  it("refuses attaching bytes an existing file holds to a missing, trashed or foreign target, or through a wrong relation, leaving that file, its edges and its bytes as they were", async () => {
    const owner = await createItem(a, a.healthRecordsId, "Owner");
    const bytes = PDF("already filed");
    expect((await upload(a, { body: bytes, targetItemId: owner, relationKey: "healthRecords" })).status).toBe(201);
    const trashed = await createItem(a, a.healthRecordsId, "Old record");
    await runInTenant(a.tenantId, () => chokePoint.softDeleteItem(a.healthRecordsId, trashed));
    const foreign = await createItem(b, b.healthRecordsId, "B's record");
    const before = await storedState(a);
    for (const targetItemId of [randomUUID(), trashed, foreign]) {
      const answer = await upload(a, { body: bytes, targetItemId, relationKey: "healthRecords" });
      expect(answer.status, targetItemId).toBe(404);
      expect(errorBody.parse(JSON.parse(answer.text)).error.code).toBe("not_found");
    }
    for (const relationKey of ["projects", "name"]) {
      const answer = await upload(a, { body: bytes, targetItemId: owner, relationKey });
      expect(answer.status, relationKey).toBe(400);
      expect(errorBody.parse(JSON.parse(answer.text)).error).toMatchObject({ details: { field: "X-Attach-Relation" } });
    }
    expect(await storedState(a)).toEqual(before);
  });

  it("keeps an existing file's bytes and edges when attaching its bytes violates the cardinality (409)", async () => {
    await makeOneToOne(a, "healthRecords");
    const first = await createItem(a, a.healthRecordsId, "First");
    const second = await createItem(a, a.healthRecordsId, "Second");
    const firstBytes = PDF("first record's file");
    expect((await upload(a, { body: firstBytes, targetItemId: first, relationKey: "healthRecords" })).status).toBe(201);
    expect(
      (await upload(a, { body: PDF("second record's file"), targetItemId: second, relationKey: "healthRecords" }))
        .status,
    ).toBe(201);
    const before = await storedState(a);
    // The first file to the second record: both ends already hold their one edge.
    const answer = await upload(a, { body: firstBytes, targetItemId: second, relationKey: "healthRecords" });
    expect(answer.status, answer.text).toBe(409);
    expect(await storedState(a)).toEqual(before);
  });

  it.each([
    ["one target", false],
    ["two targets", true],
  ])(
    "serializes two concurrent uploads of an existing file's bytes on its blob row, to %s",
    async (_name, twoTargets) => {
      const first = await createItem(a, a.healthRecordsId, "First");
      const second = twoTargets ? await createItem(a, a.healthRecordsId, "Second") : first;
      const bytes = PDF("filed under contention");
      const filed = await upload(a, { body: bytes });
      expect(filed.status).toBe(201);
      const file = itemBody.parse(JSON.parse(filed.text));
      const before = await storedState(a);
      const blobIds = await runInTenant(a.tenantId, async () =>
        (await pool.query<{ id: string }>("SELECT id FROM blobs")).rows.map((row) => row.id),
      );
      expect(blobIds).toHaveLength(1);

      // A lock-only admin transaction holds the blob row both uploads file under.
      const holder = await admin.connect();
      let holding = false;
      const started: Promise<Outcome<Answer>>[] = [];
      let primary: { error: unknown } | undefined;
      let answers: Outcome<Answer>[] | undefined;
      try {
        await holder.query("BEGIN");
        holding = true;
        const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (pid === undefined) throw new Error("no holder pid");
        expect((await holder.query("SELECT id FROM blobs WHERE id = $1 FOR UPDATE", [blobIds[0]])).rowCount).toBe(1);
        for (const targetItemId of [first, second]) {
          started.push(outcomeOf(upload(a, { body: bytes, targetItemId, relationKey: "healthRecords" })));
        }
        // Both uploads wait on the held blob row: one on the holder, the other on it or on the first.
        const deadline = Date.now() + 10_000;
        while ((await waitersOn(pid)).size < 2) {
          if (Date.now() >= deadline) throw new Error("The two uploads did not both wait on the held blob row");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await holder.query("COMMIT");
        holding = false;
        answers = await settleRequests(started, "The two contending uploads");
      } catch (error) {
        primary = { error };
      }
      const failures: unknown[] = [];
      if (holding) {
        try {
          await holder.query("ROLLBACK");
        } catch (error) {
          failures.push(error);
        }
      }
      holder.release(
        failures.length > 0 ? new Error("The holder's ROLLBACK failed; its connection is destroyed") : undefined,
      );
      if (!answers) {
        try {
          await settleRequests(started, "The two contending uploads");
        } catch (error) {
          failures.push(error);
        }
      }
      settle(primary, failures);
      if (!answers) throw new Error("The contending uploads did not settle");

      const values = answers.map((outcome) => {
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      });
      expect(values.map((answer) => answer.status)).toEqual([200, 200]);
      for (const answer of values) expect(itemBody.parse(JSON.parse(answer.text)).id).toBe(file.id);
      const after = await storedState(a);
      expect(after.blobs).toEqual(before.blobs);
      // Each upload's streamed copy is removed again: the stored bytes are the existing file's alone.
      expect(await storedBytesOnce((bytes) => isDeepStrictEqual(bytes, before.bytes))).toEqual(before.bytes);
      expect(await fileIds(a)).toEqual([file.id]);
      expect(await linked(a, file.id, "healthRecords")).toEqual([...new Set([first, second])].sort());
      expect(after.edges).toHaveLength(before.edges.length + (twoTargets ? 2 : 1));
    },
  );

  it("files two concurrent uploads of the same new bytes as one Files item with one edge, answering 201 and 200", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const bytes = PDF("new under contention");
    const before = await storedState(a);
    let arrivals = 0;
    let bothStreaming: () => void = () => {};
    const streaming = new Promise<void>((resolve) => {
      bothStreaming = resolve;
    });
    let release: () => void = () => {};
    streamingGate = {
      started: () => {
        arrivals += 1;
        if (arrivals === 2) bothStreaming();
      },
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const started = [0, 1].map(() =>
      outcomeOf(upload(a, { body: bytes, targetItemId: record, relationKey: "healthRecords" })),
    );
    let primary: { error: unknown } | undefined;
    try {
      // Both bodies are in flight before either reaches its ingest transaction.
      await within(streaming, 10_000, "Both upload streams");
    } catch (error) {
      primary = { error };
    }
    release();
    streamingGate = null;
    const failures: unknown[] = [];
    let answers: Outcome<Answer>[] | undefined;
    try {
      answers = await settleRequests(started, "The two concurrent uploads");
    } catch (error) {
      failures.push(error);
    }
    settle(primary, failures);
    if (!answers) throw new Error("The concurrent uploads did not settle");

    const values = answers.map((outcome) => {
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    });
    expect(values.map((answer) => answer.status).sort()).toEqual([200, 201]);
    const ids = values.map((answer) => itemBody.parse(JSON.parse(answer.text)).id);
    expect(new Set(ids).size).toBe(1);
    const [fileId] = ids;
    if (fileId === undefined) throw new Error("no file id");
    expect(await fileIds(a)).toEqual([fileId]);
    expect(await linked(a, fileId, "healthRecords")).toEqual([record]);
    const after = await storedState(a);
    expect(after.blobs).toHaveLength(before.blobs.length + 1);
    expect(after.edges).toHaveLength(before.edges.length + 1);
    // One stored copy of the bytes: the second upload's streamed copy is removed again.
    const stored = await storedBytesOnce(
      (current) => Object.keys(current).length === Object.keys(before.bytes).length + 1,
    );
    expect(Object.keys(stored)).toHaveLength(Object.keys(before.bytes).length + 1);
    expect(Object.values(stored)).toContain(createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("attach uploads to a task through the shared upload headers (issue #1654)", () => {
  it("links a JPG and a PDF to a task with Files.tasks edges and the type read from the bytes", async () => {
    const task = await createItem(a, a.tasksId, "Renew passport");
    const jpg = await upload(a, {
      body: JPG("photo"),
      filename: "photo.jpg",
      targetItemId: task,
      relationKey: "tasks",
    });
    const pdf = await upload(a, { body: PDF("form"), filename: "form.pdf", targetItemId: task, relationKey: "tasks" });
    expect([jpg.status, pdf.status]).toEqual([201, 201]);
    const jpgFile = itemBody.parse(JSON.parse(jpg.text));
    const pdfFile = itemBody.parse(JSON.parse(pdf.text));
    expect(jpgFile.properties.type).toBe("jpg");
    expect(pdfFile.properties.type).toBe("pdf");
    expect(await linked(a, jpgFile.id, "tasks")).toEqual([task]);
    expect(await linked(a, pdfFile.id, "tasks")).toEqual([task]);
  });

  it("gives the same bytes uploaded to two tasks one Files item with two edges, the second answer 200", async () => {
    const first = await createItem(a, a.tasksId, "First");
    const second = await createItem(a, a.tasksId, "Second");
    const bytes = JPG("shared");
    expect((await upload(a, { body: bytes, targetItemId: first, relationKey: "tasks" })).status).toBe(201);
    const again = await upload(a, { body: bytes, targetItemId: second, relationKey: "tasks" });
    expect(again.status).toBe(200);
    const file = itemBody.parse(JSON.parse(again.text));
    expect(await fileIds(a)).toEqual([file.id]);
    expect(await linked(a, file.id, "tasks")).toEqual([first, second].sort());
  });

  it("answers a missing, trashed or foreign task with 404 and stores no blob or Files item", async () => {
    const trashed = await createItem(a, a.tasksId, "Done task");
    await runInTenant(a.tenantId, () => chokePoint.softDeleteItem(a.tasksId, trashed));
    const foreign = await createItem(b, b.tasksId, "B's task");
    const before = await storedState(a);
    for (const targetItemId of [randomUUID(), trashed, foreign]) {
      const answer = await upload(a, { body: JPG(targetItemId), targetItemId, relationKey: "tasks" });
      expect(answer.status, targetItemId).toBe(404);
    }
    expect(await storedState(a)).toEqual(before);
  });

  it("refuses an X-Attach-Relation that is not a Files relation with 400 and creates nothing", async () => {
    const task = await createItem(a, a.tasksId, "Task");
    const before = await storedState(a);
    const answer = await upload(a, { body: JPG("unknown"), targetItemId: task, relationKey: "attachments" });
    expect(answer.status).toBe(400);
    expect(errorBody.parse(JSON.parse(answer.text)).error).toMatchObject({ details: { field: "X-Attach-Relation" } });
    expect(await storedState(a)).toEqual(before);
  });

  it("keeps an existing file's own project when the same bytes are attached to a task", async () => {
    const project = await createItem(a, a.projectsId, "Own project");
    const task = await createItem(a, a.tasksId, "Task");
    const bytes = PDF("filed under a project");
    const filed = await upload(a, { body: bytes, targetItemId: project, relationKey: "projects" });
    expect(filed.status).toBe(201);
    const file = itemBody.parse(JSON.parse(filed.text));
    expect((await upload(a, { body: bytes, targetItemId: task, relationKey: "tasks" })).status).toBe(200);
    expect(await linked(a, file.id, "projects")).toEqual([project]);
    expect(await linked(a, file.id, "tasks")).toEqual([task]);
  });

  it("answers a tasks attach whose target is not a task with 400 on X-Attach-Relation, for new and for existing bytes, storing nothing", async () => {
    const record = await createItem(a, a.healthRecordsId, "Not a task");
    const existing = JPG("already filed");
    expect((await upload(a, { body: existing })).status).toBe(201);
    const before = await storedState(a);
    for (const body of [JPG("new"), existing]) {
      const answer = await upload(a, { body, targetItemId: record, relationKey: "tasks" });
      expect(answer.status).toBe(400);
      expect(errorBody.parse(JSON.parse(answer.text)).error).toMatchObject({
        code: "validation_failed",
        details: { field: "X-Attach-Relation" },
      });
    }
    expect(await storedState(a)).toEqual(before);
  });

  it("keeps a task cardinality violation's 409 and rolls the new file and its bytes back", async () => {
    await makeOneToOne(a, "tasks");
    const task = await createItem(a, a.tasksId, "Task");
    expect((await upload(a, { body: JPG("first"), targetItemId: task, relationKey: "tasks" })).status).toBe(201);
    const before = await storedState(a);
    const answer = await upload(a, { body: JPG("second"), targetItemId: task, relationKey: "tasks" });
    expect(answer.status, answer.text).toBe(409);
    expect(await storedState(a)).toEqual(before);
  });
});

describe("attach reservations never wait while the upload holds its blob (batch 36 D1)", () => {
  /** The lock-only statement for each table a holder may hold a row of; constant SQL, the id bound. */
  const HOLD_ROW = {
    items: "SELECT id FROM items WHERE id = $1 FOR UPDATE",
    blobs: "SELECT id FROM blobs WHERE id = $1 FOR UPDATE",
  } as const;

  /** A lock-only admin transaction holding one item row `FOR UPDATE` until `end` commits it. */
  async function holdItem(itemId: string): Promise<{ end: () => Promise<void>; pid: number }> {
    return holdRow("items", itemId);
  }

  /** A lock-only admin transaction holding one row of `table` `FOR UPDATE` until `end` commits it. */
  async function holdRow(table: keyof typeof HOLD_ROW, id: string): Promise<{ end: () => Promise<void>; pid: number }> {
    const holder = await admin.connect();
    let open = false;
    let pid: number | undefined;
    try {
      await holder.query("BEGIN");
      open = true;
      pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      if (pid === undefined) throw new Error("no holder pid");
      const held = await holder.query(HOLD_ROW[table], [id]);
      expect(held.rowCount).toBe(1);
    } catch (error) {
      let destroyWith: Error | undefined;
      if (open) {
        try {
          await holder.query("ROLLBACK");
        } catch {
          destroyWith = new Error("The holder's ROLLBACK failed; its connection is destroyed");
        }
      }
      holder.release(destroyWith);
      throw error;
    }
    let ended = false;
    return {
      pid,
      end: async () => {
        if (ended) return;
        ended = true;
        try {
          await holder.query("COMMIT");
        } catch (error) {
          holder.release(new Error("The holder's COMMIT failed; its connection is destroyed"));
          throw error;
        }
        holder.release();
      },
    };
  }

  /** How long a holder case waits for the refusal a NOWAIT reservation gives at once; well inside the case timeout. */
  const REFUSAL_MS = 5_000;
  /** How long a request is given to finish once its holder has ended. */
  const DRAIN_MS = 10_000;

  /**
   * Runs `observe` on `request`, a request already observed (`outcomeOf`) and started while `holder` holds a row.
   * Whatever `observe` does, the holder is ended first, so a request waiting on its row can go on, and the request
   * is then drained within `DRAIN_MS`. The case's own failure stays first; holder and drain failures follow it.
   */
  async function whileHeld<T>(
    holder: { end: () => Promise<void> },
    request: Promise<Outcome<Answer>>,
    observe: (request: Promise<Outcome<Answer>>) => Promise<T>,
  ): Promise<T> {
    let primary: { error: unknown } | undefined;
    let result: { value: T } | undefined;
    try {
      result = { value: await observe(request) };
    } catch (error) {
      primary = { error };
    }
    const failures: unknown[] = [];
    try {
      await holder.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      const drained = await within(request, DRAIN_MS, "The request after its holder ended");
      if (!drained.ok && !(primary && primary.error === drained.error)) failures.push(drained.error);
    } catch (error) {
      failures.push(error);
    }
    settle(primary, failures);
    if (!result) throw new Error("The held request's observation returned nothing");
    return result.value;
  }

  /** The answer of a request with no holder, observed at once and awaited within `DRAIN_MS`. */
  async function answerOf(request: Promise<Answer>, what: string): Promise<Answer> {
    const outcome = await within(outcomeOf(request), DRAIN_MS, what);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** The refusal a held reservation gives, awaited within `REFUSAL_MS`. */
  async function refusal(request: Promise<Outcome<Answer>>): Promise<Answer> {
    const outcome = await within(request, REFUSAL_MS, "The upload refused while its row is held");
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  it("answers 409 upload_attach_conflict and rolls back while a PATCH holds the Files item and waits on the upload's blob, then the PATCH commits", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const bytes = PDF("patched while attaching");
    const filed = await upload(a, { body: bytes });
    expect(filed.status).toBe(201);
    const file = itemBody.parse(JSON.parse(filed.text));
    const blobId = await onlyBlobId(a);
    const patch = (itemId: string, fileBlobId: string) =>
      runInTenant(a.tenantId, () =>
        chokePoint.updateItem({
          databaseId: a.filesId,
          itemId,
          propertiesPatch: { name: "Renamed while attaching", file: { blobId: fileBlobId } },
        }),
      );

    // The control: the same PATCH of another, uncontended Files item. Its jobs and invalidations are what the
    // PATCH below may add; anything beyond them would be the upload's.
    const control = itemBody.parse(JSON.parse((await upload(a, { body: PDF("control file") })).text));
    const controlBlobId = (await blobIdsOf(a)).find((id) => id !== blobId);
    if (!controlBlobId) throw new Error("no control blob");
    const controlJobsBefore = await queuedJobs();
    const controlMarked = invalidations.length;
    await patch(control.id, controlBlobId);
    const controlNames = { [control.id]: "<file>", [controlBlobId]: "<blob>" };
    const controlJobs = jobDelta(controlJobsBefore, await queuedJobs(), controlNames);
    const controlInvalidations = invalidationShape(invalidations.slice(controlMarked), controlNames);

    const before = await storedState(a);
    const jobsBefore = await queuedJobs();
    const marked = invalidations.length;

    // The upload pauses at its target reservation, after it has taken the blob `FOR UPDATE`.
    const gate = pauseAtReservationOf(record);
    const uploading = outcomeOf(upload(a, { body: bytes, targetItemId: record, relationKey: "healthRecords" }));
    let patching: Promise<Outcome<unknown>> | undefined;
    let primary: { error: unknown } | undefined;
    let uploaded: Outcome<Answer> | undefined;
    let patched: Outcome<unknown> | undefined;
    try {
      const uploadPid = await within(gate.reached, 10_000, "The upload's target reservation");
      // The production PATCH owner on the runtime role: it takes the Files item, then its blob reference lock.
      patching = outcomeOf(patch(file.id, blobId));
      const waiting = await pollFor(async () => {
        const { rows } = await admin.query<{ pid: number; query: string }>(
          "SELECT pid, query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [uploadPid],
        );
        return rows.length > 0 ? rows : undefined;
      }, "The PATCH waiting on the upload's blob");
      // Exactly one backend waits on the upload: the PATCH, at its blob reference statement.
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.query).toMatch(/FROM blobs .*FOR KEY SHARE/s);
      gate.release();
      uploaded = await within(uploading, 10_000, "The paused upload");
      patched = await within(patching, 10_000, "The waiting PATCH");
    } catch (error) {
      primary = { error };
    }
    gate.release();
    const failures: unknown[] = [];
    for (const [started, what] of [
      [uploaded ? undefined : uploading, "The paused upload"],
      [patched ? undefined : patching, "The waiting PATCH"],
    ] as const) {
      if (!started) continue;
      try {
        await within(started, 10_000, what);
      } catch (error) {
        failures.push(error);
      }
    }
    settle(primary, failures);
    if (!uploaded || !patched) throw new Error("The upload or the PATCH did not settle");
    if (!uploaded.ok) throw uploaded.error;
    if (!patched.ok) throw patched.error;

    expect(uploaded.value.status).toBe(409);
    expect(conflictCode(uploaded.value, [file.id, record, blobId])).toBe("upload_attach_conflict");
    const after = await storedState(a);
    // The upload committed nothing: no edge, no blob, and its streamed copy is gone; only the PATCH's write landed.
    expect(after.edges).toEqual(before.edges);
    expect(after.blobs).toEqual(before.blobs);
    expect(after.bytes).toEqual(before.bytes);
    expect(await fileIds(a)).toEqual([control.id, file.id].sort());
    expect(await linked(a, file.id, "healthRecords")).toEqual([]);
    const patchedFile = await runInTenant(a.tenantId, () => chokePoint.getItem(a.filesId, file.id));
    expect(patchedFile?.properties).toMatchObject({ name: "Renamed while attaching", file: { blobId } });
    // Exactly the control PATCH's effects, for this Files item: the upload added no job and no invalidation.
    const names = { [file.id]: "<file>", [blobId]: "<blob>" };
    expect(jobDelta(jobsBefore, await queuedJobs(), names)).toEqual(controlJobs);
    expect(invalidationShape(invalidations.slice(marked), names)).toEqual(controlInvalidations);
    expect(controlInvalidations.length).toBeGreaterThan(0);
  });

  it.each([
    ["the target", true],
    ["the deduplicated Files item", false],
  ])(
    "answers 409 upload_attach_conflict at once while another transaction holds %s, stores nothing, and a new request then succeeds",
    async (_name, holdTarget) => {
      const record = await createItem(a, a.healthRecordsId, "Record");
      const bytes = PDF(`held ${holdTarget ? "target" : "file"}`);
      const filed = await upload(a, { body: bytes });
      const file = itemBody.parse(JSON.parse(filed.text));
      const before = await storedState(a);
      const jobsBefore = await queuedJobs();
      const marked = invalidations.length;

      const holder = await holdItem(holdTarget ? record : file.id);
      // Observed at once, before any await, so it is drained whatever happens while the row is held.
      const request = outcomeOf(upload(a, { body: bytes, targetItemId: record, relationKey: "healthRecords" }));
      const refused = await whileHeld(holder, request, refusal);

      expect(refused.status).toBe(409);
      expect(conflictCode(refused, [file.id, record])).toBe("upload_attach_conflict");
      expect(await storedState(a)).toEqual(before);
      expect(await queuedJobs()).toEqual(jobsBefore);
      expect(invalidations.slice(marked)).toEqual([]);

      // Not retried by the server: the caller's new, complete request is what succeeds.
      const retried = await answerOf(
        upload(a, { body: bytes, targetItemId: record, relationKey: "healthRecords" }),
        "The new request after the holder ended",
      );
      expect(retried.status, retried.text).toBe(200);
      expect(itemBody.parse(JSON.parse(retried.text)).id).toBe(file.id);
      expect(await linked(a, file.id, "healthRecords")).toEqual([record]);
    },
  );

  it("answers 409 upload_attach_conflict at once for new bytes to a held target, and the new request then answers 201", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const before = await storedState(a);
    const jobsBefore = await queuedJobs();
    const holder = await holdItem(record);
    // Observed at once, before any await, so it is drained whatever happens while the row is held.
    const request = outcomeOf(
      upload(a, { body: PDF("new to a held target"), targetItemId: record, relationKey: "healthRecords" }),
    );
    const refused = await whileHeld(holder, request, refusal);
    expect(refused.status).toBe(409);
    expect(conflictCode(refused, [record])).toBe("upload_attach_conflict");
    // The new Files item and its blob rolled back, and its streamed bytes were deleted.
    expect(await storedState(a)).toEqual(before);
    expect(await queuedJobs()).toEqual(jobsBefore);

    const retried = await answerOf(
      upload(a, { body: PDF("new to a held target"), targetItemId: record, relationKey: "healthRecords" }),
      "The new request after the holder ended",
    );
    expect(retried.status, retried.text).toBe(201);
    expect(await linked(a, itemBody.parse(JSON.parse(retried.text)).id, "healthRecords")).toEqual([record]);
  });

  it("ends the holder and drains a request still waiting on the held row when the observation fails early, keeping that failure", async () => {
    // A request that really waits: an upload of an existing file's bytes waits on that file's held blob row.
    const record = await createItem(a, a.healthRecordsId, "Record");
    const bytes = PDF("waits on a held blob");
    const file = itemBody.parse(JSON.parse((await answerOf(upload(a, { body: bytes }), "The fixture upload")).text));
    const holder = await holdRow("blobs", await onlyBlobId(a));
    const request = outcomeOf(upload(a, { body: bytes, targetItemId: record, relationKey: "healthRecords" }));
    let settledWhenHeld: boolean | undefined;
    let settled = false;
    // `request` never rejects (outcomeOf), so this observer cannot either; it is awaited below.
    const marking = request.then(() => {
      settled = true;
    });
    const early = new Error("The case's observation failed while the request was waiting");

    const thrown = await whileHeld(holder, request, async () => {
      // The request waits on the holder's row, correlated through pg_blocking_pids.
      await pollFor(async () => ((await waitersOn(holder.pid)).size === 1 ? true : undefined), "The waiting upload");
      settledWhenHeld = settled;
      throw early;
    }).then(
      () => null,
      (error: unknown) => error,
    );
    const settledWhenReturned = settled;
    await marking;

    // The case's own failure, as it was thrown, and nothing appended: the holder ended and the request drained.
    expect(thrown).toBe(early);
    expect(settledWhenHeld).toBe(false);
    expect(settledWhenReturned).toBe(true);
    expect((await waitersOn(holder.pid)).size).toBe(0);
    const outcome = await request;
    if (!outcome.ok) throw outcome.error;
    // Released, the request completed as an ordinary deduplicated attach.
    expect(outcome.value.status).toBe(200);
    expect(await linked(a, file.id, "healthRecords")).toEqual([record]);
  });

  it.each([
    ["a new edge", false],
    ["an existing edge", true],
  ])(
    "answers 409 upload_attach_conflict when the deduplicated Files item is trashed after the lookup, for %s, and stores nothing",
    async (_name, alreadyLinked) => {
      const record = await createItem(a, a.healthRecordsId, "Record");
      const bytes = PDF(`trashed after lookup ${String(alreadyLinked)}`);
      const filed = alreadyLinked
        ? await upload(a, { body: bytes, targetItemId: record, relationKey: "healthRecords" })
        : await upload(a, { body: bytes });
      expect(filed.status).toBe(201);
      const file = itemBody.parse(JSON.parse(filed.text));

      // The upload pauses at its Files item reservation: after the deduplicating lookup found the live item.
      // Every stored byte file before the request starts, once all fixture uploads have finished.
      const preRequestBytes = await storedBytes();
      const gate = pauseAtReservationOf(file.id);
      const uploading = outcomeOf(upload(a, { body: bytes, targetItemId: record, relationKey: "healthRecords" }));
      let inFlightKey: string | undefined;
      let primary: { error: unknown } | undefined;
      let before: Awaited<ReturnType<typeof storedState>> | undefined;
      let jobsBefore: unknown[] = [];
      let marked = 0;
      let uploaded: Outcome<Answer> | undefined;
      let trashing: Promise<Outcome<unknown>> | undefined;
      try {
        await within(gate.reached, 10_000, "The upload's Files item reservation");
        trashing = outcomeOf(runInTenant(a.tenantId, () => chokePoint.softDeleteItem(a.filesId, file.id)));
        const trashed = await within(trashing, 10_000, "Trashing the Files item while the upload is paused");
        if (!trashed.ok) throw trashed.error;
        before = await storedState(a);
        // The deliberate writer stored or removed no byte file; the one file beyond the pre-request bytes is the
        // paused upload's own streamed copy.
        inFlightKey = onlyInFlightCopy(preRequestBytes, before.bytes, bytes);
        jobsBefore = await queuedJobs();
        marked = invalidations.length;
        gate.release();
        uploaded = await within(uploading, 10_000, "The paused upload");
      } catch (error) {
        primary = { error };
      }
      gate.release();
      const failures: unknown[] = [];
      for (const [started, what] of [
        [uploaded ? undefined : uploading, "The paused upload"],
        [trashing, "Trashing the Files item"],
      ] as const) {
        if (!started) continue;
        try {
          await within(started, 10_000, what);
        } catch (error) {
          failures.push(error);
        }
      }
      settle(primary, failures);
      if (!uploaded || !before || inFlightKey === undefined) throw new Error("The paused upload did not settle");
      if (!uploaded.ok) throw uploaded.error;

      expect(uploaded.value.status).toBe(409);
      expect(conflictCode(uploaded.value, [file.id, record])).toBe("upload_attach_conflict");
      // The writer's rows with the pre-request bytes: the upload's streamed copy is gone, every other file intact.
      const after = await storedState(a);
      expect(after).toEqual({ ...before, bytes: preRequestBytes });
      expect(Object.hasOwn(after.bytes, inFlightKey)).toBe(false);
      expect(await queuedJobs()).toEqual(jobsBefore);
      expect(invalidations.slice(marked)).toEqual([]);
    },
  );

  it.each([
    ["a new edge", false],
    ["an existing edge", true],
  ])(
    "answers 409 upload_attach_conflict when a PATCH repoints the deduplicated Files item from its blob to another after the lookup, for %s, and stores nothing",
    async (_name, alreadyLinked) => {
      const record = await createItem(a, a.healthRecordsId, "Record");
      const bytes = PDF(`repointed after lookup ${String(alreadyLinked)}`);
      const filed = alreadyLinked
        ? await upload(a, { body: bytes, targetItemId: record, relationKey: "healthRecords" })
        : await upload(a, { body: bytes });
      expect(filed.status).toBe(201);
      const file = itemBody.parse(JSON.parse(filed.text));
      const uploadedBlobId = await onlyBlobId(a);
      // Blob C: other bytes, stored through the standalone blob route, filed by no item.
      const stored = await fetch(`${baseUrl}/api/blobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/pdf" },
        body: PDF(`other bytes ${String(alreadyLinked)}`),
      });
      expect(stored.status).toBe(201);
      const otherBlobId = z.object({ blobId: z.string() }).parse(await stored.json()).blobId;
      expect(otherBlobId).not.toBe(uploadedBlobId);

      // The upload pauses at its Files item reservation: after the deduplicating lookup found the item filing B.
      // Every stored byte file before the request starts, once all fixture uploads have finished.
      const preRequestBytes = await storedBytes();
      const gate = pauseAtReservationOf(file.id);
      const uploading = outcomeOf(upload(a, { body: bytes, targetItemId: record, relationKey: "healthRecords" }));
      let inFlightKey: string | undefined;
      let primary: { error: unknown } | undefined;
      let before: Awaited<ReturnType<typeof storedState>> | undefined;
      let jobsBefore: QueuedJob[] = [];
      let marked = 0;
      let uploaded: Outcome<Answer> | undefined;
      let patching: Promise<Outcome<unknown>> | undefined;
      try {
        await within(gate.reached, 10_000, "The upload's Files item reservation");
        // The production PATCH owner repoints the item at C; it does not wait on the upload, which holds B.
        patching = outcomeOf(
          runInTenant(a.tenantId, () =>
            chokePoint.updateItem({
              databaseId: a.filesId,
              itemId: file.id,
              propertiesPatch: { file: { blobId: otherBlobId } },
            }),
          ),
        );
        const patched = await within(patching, 10_000, "Repointing the Files item while the upload is paused");
        if (!patched.ok) throw patched.error;
        before = await storedState(a);
        // The deliberate writer stored or removed no byte file; the one file beyond the pre-request bytes is the
        // paused upload's own streamed copy.
        inFlightKey = onlyInFlightCopy(preRequestBytes, before.bytes, bytes);
        jobsBefore = await queuedJobs();
        marked = invalidations.length;
        gate.release();
        uploaded = await within(uploading, 10_000, "The paused upload");
      } catch (error) {
        primary = { error };
      }
      gate.release();
      const failures: unknown[] = [];
      for (const [started, what] of [
        [uploaded ? undefined : uploading, "The paused upload"],
        [patching, "Repointing the Files item"],
      ] as const) {
        if (!started) continue;
        try {
          await within(started, 10_000, what);
        } catch (error) {
          failures.push(error);
        }
      }
      settle(primary, failures);
      if (!uploaded || !before || inFlightKey === undefined) throw new Error("The paused upload did not settle");
      if (!uploaded.ok) throw uploaded.error;

      expect(uploaded.value.status).toBe(409);
      expect(conflictCode(uploaded.value, [file.id, record, uploadedBlobId, otherBlobId])).toBe(
        "upload_attach_conflict",
      );
      // Exactly the rows the PATCH left, with the pre-request bytes: the item still files C, no edge was added or
      // changed, and the upload's streamed copy of B's bytes is gone again while B's own bytes stay.
      const after = await storedState(a);
      expect(after).toEqual({ ...before, bytes: preRequestBytes });
      expect(Object.hasOwn(after.bytes, inFlightKey)).toBe(false);
      expect(await queuedJobs()).toEqual(jobsBefore);
      expect(invalidations.slice(marked)).toEqual([]);
      const repointed = await runInTenant(a.tenantId, () => chokePoint.getItem(a.filesId, file.id));
      expect(repointed?.properties).toMatchObject({ file: { blobId: otherBlobId } });
      expect(await linked(a, file.id, "healthRecords")).toEqual(alreadyLinked ? [record] : []);
    },
  );

  it("answers the same 404 when the target is trashed after the pre-check and before its reservation, and stores nothing", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const body = PDF("target trashed");
    // Every stored byte file before the request starts.
    const preRequestBytes = await storedBytes();
    const gate = pauseAtReservationOf(record);
    const uploading = outcomeOf(upload(a, { body, targetItemId: record, relationKey: "healthRecords" }));
    let inFlightKey: string | undefined;
    let primary: { error: unknown } | undefined;
    let before: Awaited<ReturnType<typeof storedState>> | undefined;
    let jobsBefore: unknown[] = [];
    let marked = 0;
    let uploaded: Outcome<Answer> | undefined;
    let trashing: Promise<Outcome<unknown>> | undefined;
    try {
      await within(gate.reached, 10_000, "The upload's target reservation");
      trashing = outcomeOf(runInTenant(a.tenantId, () => chokePoint.softDeleteItem(a.healthRecordsId, record)));
      const trashed = await within(trashing, 10_000, "Trashing the target while the upload is paused");
      if (!trashed.ok) throw trashed.error;
      before = await storedState(a);
      // The trash stored or removed no byte file; the one file beyond the pre-request bytes is the paused upload's
      // own streamed copy.
      inFlightKey = onlyInFlightCopy(preRequestBytes, before.bytes, body);
      jobsBefore = await queuedJobs();
      marked = invalidations.length;
      gate.release();
      uploaded = await within(uploading, 10_000, "The paused upload");
    } catch (error) {
      primary = { error };
    }
    gate.release();
    const failures: unknown[] = [];
    for (const [started, what] of [
      [uploaded ? undefined : uploading, "The paused upload"],
      [trashing, "Trashing the target"],
    ] as const) {
      if (!started) continue;
      try {
        await within(started, 10_000, what);
      } catch (error) {
        failures.push(error);
      }
    }
    settle(primary, failures);
    if (!uploaded || !before || inFlightKey === undefined) throw new Error("The paused upload did not settle");
    if (!uploaded.ok) throw uploaded.error;

    expect(uploaded.value.status).toBe(404);
    expect(conflictCode(uploaded.value, [record])).toBe("not_found");
    const unknown = await upload(a, {
      body: PDF("unknown target"),
      targetItemId: randomUUID(),
      relationKey: "healthRecords",
    });
    expect(uploaded.value).toEqual(unknown);
    // The trash's rows with the pre-request bytes: the new file, its blob and its streamed bytes are gone.
    const after = await storedState(a);
    expect(after).toEqual({ ...before, bytes: preRequestBytes });
    expect(Object.hasOwn(after.bytes, inFlightKey)).toBe(false);
    expect(await queuedJobs()).toEqual(jobsBefore);
    expect(invalidations.slice(marked)).toEqual([]);
  });

  it("marks the upload rollback-only, so a caller that catches the attach conflict still commits nothing", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const gone = itemBody.parse(JSON.parse((await upload(a, { body: PDF("gone") })).text)).id;
    const goneBlobId = await onlyBlobId(a);
    await runInTenant(a.tenantId, () => chokePoint.softDeleteItem(a.filesId, gone));
    const before = await storedState(a);
    const jobsBefore = await queuedJobs();
    const marked = invalidations.length;
    const caught: unknown[] = [];

    const failure = await runInTenant(a.tenantId, async () => {
      const target = await withTransaction(pool, (client) =>
        resolveUploadAttachTarget(client, {
          filesDatabaseId: a.filesId,
          targetItemId: record,
          relationKey: "healthRecords",
        }),
      );
      return ingestUploadedFileWithTransaction(
        pool,
        {
          filesDatabaseId: a.filesId,
          filename: "caught.pdf",
          contentType: "application/pdf",
          source: Readable.from([PDF("caught")]),
          storageKeyPrefix: "files",
          maxBytes: 64 * 1024,
          storage: new LocalFsBlobStorageWriter(storageDir),
        },
        async (client) => {
          // The trashed Files item as the attach source: the conflict is caught here and not rethrown.
          try {
            await attachUploadedFileWithClient(client, target, gone, goneBlobId);
          } catch (error) {
            caught.push(error);
          }
        },
      ).then(
        () => null,
        (error: unknown) => error,
      );
    });

    expect(caught).toHaveLength(1);
    expect(caught[0]).toMatchObject({ status: 409, code: "upload_attach_conflict" });
    // The managed transaction rethrows that same error at its end instead of committing.
    expect(failure).toBe(caught[0]);
    expect(await storedState(a)).toEqual(before);
    expect(await queuedJobs()).toEqual(jobsBefore);
    expect(invalidations.slice(marked)).toEqual([]);
  });
});
