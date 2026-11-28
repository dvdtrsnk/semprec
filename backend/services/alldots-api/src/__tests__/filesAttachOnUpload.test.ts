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
import { runInTenant } from "@alldots/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@alldots/data/testSupport";
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
} from "@alldots/data";
import { createDispatcher } from "../app.js";

/**
 * `POST /api/files` with `X-Attach-To-Item` and `X-Attach-Relation`, tasks included as targets, through the
 * real dispatcher on a `alldots_data` pool so row-level security applies, with two tenants.
 */

const PASSWORD = "s3cret-password";
const moduleRegistry = await loadFullModuleRegistry();

let admin: Pool;
let pool: Pool;
/** The dispatcher's own runtime-role pool; every client it opens is instrumented by `instrumentReservations`. */
let uploadPool: Pool;
let chokePoint: ChokePoint;
let server: Server;
let baseUrl: string;
let storageDir: string;
let streamingGate: { started: () => void; release: Promise<void> } | null = null;

/** One-shot: disarmed when reached. */
let reservationBarrier: { itemId: string; reached: (pid: number) => void; release: Promise<void> } | null = null;
let barrierReleases: (() => void)[] = [];
let invalidations: InvalidationEvent[] = [];

/**
 * Before an attach reservation (`FOR UPDATE NOWAIT`) of the item an armed barrier names, reports the backend pid
 * and waits for release, then runs the same statement with the original receiver and arguments.
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
      text.includes("UPDATE NOWAIT") &&
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

async function fileIds(tenant: TenantFixture): Promise<string[]> {
  return runInTenant(tenant.tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY id",
      [tenant.filesId],
    );
    return rows.map((row) => row.id);
  });
}

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
 * A content-hash dedup hit removes its streamed copy after commit without the response waiting, so this rereads
 * for up to 5 s and returns the last read either way.
 */
async function storedBytesOnce(ready: (bytes: Record<string, string>) => boolean): Promise<Record<string, string>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const bytes = await storedBytes();
    if (ready(bytes) || Date.now() >= deadline) return bytes;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Every Files item (trashed included), blob row, relation edge and stored byte file, read under RLS. */
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

/** Rethrows the case's own failure first, with cleanup failures after it; a thrown falsy value counts. */
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

/** As a value, so a started request is observed from the start. */
function outcomeOf<T>(work: Promise<T>): Promise<Outcome<T>> {
  return work.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );
}

/** Bounded, so no request outlives the case. */
async function settleRequests<T>(started: Promise<Outcome<T>>[], what: string): Promise<Outcome<T>[]> {
  return within(Promise.all(started), 10_000, what);
}

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

/** Every column of graphile-worker 0.17.3's public `jobs` view; it exposes no payload. */
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

async function queuedJobs(): Promise<QueuedJob[]> {
  const { rows } = await admin.query<Record<string, unknown>>(
    `SELECT id::text AS id, queue_name, task_identifier, priority, run_at, attempts, max_attempts, last_error,
            created_at, updated_at, key, locked_at, locked_by, revision, flags
     FROM graphile_worker.jobs ORDER BY id`,
  );
  return rows.map((row) => queuedJobRow.parse(row));
}

/**
 * New or changed jobs without identity and timing, ids replaced by placeholders; sorted so two writers' deltas
 * compare as multisets.
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

function invalidationShape(events: InvalidationEvent[], names: Record<string, string>): string[] {
  return events
    .map((event) => {
      let text = JSON.stringify("updatedAt" in event ? { ...event, updatedAt: "<time>" } : event);
      for (const [id, placeholder] of Object.entries(names)) text = text.split(id).join(placeholder);
      return text;
    })
    .sort();
}

async function pollFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`${what} was not observed within 10000 ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function onlyBlobId(tenant: TenantFixture): Promise<string> {
  const ids = await runInTenant(tenant.tenantId, async () =>
    (await pool.query<{ id: string }>("SELECT id FROM blobs")).rows.map((row) => row.id),
  );
  const [id] = ids;
  if (ids.length !== 1 || id === undefined) throw new Error(`expected one blob, found ${ids.length}`);
  return id;
}

/** Exactly one new file, the paused upload's own streamed copy of `body`; returns its key. */
function onlyInFlightCopy(preRequest: Record<string, string>, paused: Record<string, string>, body: Buffer): string {
  const extra = Object.keys(paused).filter((key) => !Object.hasOwn(preRequest, key));
  expect(extra).toHaveLength(1);
  const [key] = extra;
  if (key === undefined) throw new Error("no in-flight copy");
  expect(paused[key]).toBe(createHash("sha256").update(body).digest("hex"));
  expect(Object.fromEntries(Object.entries(paused).filter(([other]) => other !== key))).toEqual(preRequest);
  return key;
}

async function blobIdsOf(tenant: TenantFixture): Promise<string[]> {
  return runInTenant(tenant.tenantId, async () =>
    (await pool.query<{ id: string }>("SELECT id FROM blobs ORDER BY id")).rows.map((row) => row.id),
  );
}

function conflictCode(answer: Answer, ids: string[]): string {
  for (const id of ids) expect(answer.text).not.toContain(id);
  return errorBody.parse(JSON.parse(answer.text)).error.code;
}

async function makeOneToOne(tenant: TenantFixture, relationKey: string): Promise<void> {
  // No writer changes a schema-locked system relation's cardinality, so it is set directly.
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

/** What a refused or rolled-back request must leave as it was. */
async function mark(tenant: TenantFixture = a) {
  return { state: await storedState(tenant), jobs: await queuedJobs(), invalidations: invalidations.length };
}

/** Asserts no row, byte file, job or invalidation changed since `since`; `bytes` overrides the stored bytes expected. */
async function expectUnchangedSince(since: Awaited<ReturnType<typeof mark>>, bytes?: Record<string, string>) {
  expect(await storedState(a)).toEqual(bytes ? { ...since.state, bytes } : since.state);
  expect(await queuedJobs()).toEqual(since.jobs);
  expect(invalidations.slice(since.invalidations)).toEqual([]);
}

function attach(body: Buffer, targetItemId: string, relationKey = "healthRecords"): Upload {
  return { body, targetItemId, relationKey };
}

/** Uploads `input` to tenant A and returns the created or deduplicated Files item. */
async function fileOf(input: Upload, status: number = 201) {
  const answer = await upload(a, input);
  expect(answer.status, answer.text).toBe(status);
  return itemBody.parse(JSON.parse(answer.text));
}

function errorOf(answer: Answer) {
  return errorBody.parse(JSON.parse(answer.text)).error;
}

/** Holds every body stream until `release`; `streaming` resolves once `count` uploads stream. */
function gateStreams(count: number): { streaming: Promise<void>; release: () => void } {
  let arrivals = 0;
  let allStreaming: () => void = () => {};
  const streaming = new Promise<void>((resolve) => {
    allStreaming = resolve;
  });
  let release: () => void = () => {};
  streamingGate = {
    started: () => {
      arrivals += 1;
      if (arrivals === count) allStreaming();
    },
    release: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  return { streaming, release };
}

/** Settles `started` after the case's own steps, keeping its failure first, and returns their answers. */
async function answersAfter(
  primary: { error: unknown } | undefined,
  started: Promise<Outcome<Answer>>[],
  what: string,
  failures: unknown[] = [],
): Promise<Answer[]> {
  let outcomes: Outcome<Answer>[] | undefined;
  try {
    outcomes = await settleRequests(started, what);
  } catch (error) {
    failures.push(error);
  }
  settle(primary, failures);
  if (!outcomes) throw new Error(`${what} did not settle`);
  return outcomes.map((outcome) => {
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  });
}

/**
 * Pauses tenant A's upload of `input` at the reservation of `pauseAt`, runs `during` while it waits, then
 * releases it. Work started through `track` is settled too, and the case's own failure stays first.
 */
async function withPausedUpload<T>(
  pauseAt: string,
  input: Upload,
  during: (uploadPid: number, track: <R>(work: Promise<R>, what: string) => Promise<Outcome<R>>) => Promise<T>,
): Promise<{ answer: Answer; value: T }> {
  const gate = pauseAtReservationOf(pauseAt);
  const uploading = outcomeOf(upload(a, input));
  const tracked: Array<readonly [Promise<unknown>, string]> = [];
  const track = <R>(work: Promise<R>, what: string) => {
    const outcome = outcomeOf(work);
    tracked.push([outcome, what]);
    return outcome;
  };
  let primary: { error: unknown } | undefined;
  let result: { value: T } | undefined;
  let uploaded: Outcome<Answer> | undefined;
  try {
    const uploadPid = await within(gate.reached, 10_000, "The upload's reservation");
    result = { value: await during(uploadPid, track) };
    gate.release();
    uploaded = await within(uploading, 10_000, "The paused upload");
  } catch (error) {
    primary = { error };
  }
  gate.release();
  const failures: unknown[] = [];
  for (const [started, what] of uploaded ? tracked : [[uploading, "The paused upload"] as const, ...tracked]) {
    try {
      await within(started, 10_000, what);
    } catch (error) {
      failures.push(error);
    }
  }
  settle(primary, failures);
  if (!uploaded || !result) throw new Error("The paused upload did not settle");
  if (!uploaded.ok) throw uploaded.error;
  return { answer: uploaded.value, value: result.value };
}

/** Runs `act` while the upload is paused, then marks the state and the paused upload's one in-flight byte copy. */
async function markAfter(
  act: Promise<Outcome<unknown>>,
  what: string,
  preRequestBytes: Record<string, string>,
  body: Buffer,
) {
  const done = await within(act, 10_000, what);
  if (!done.ok) throw done.error;
  const since = await mark();
  onlyInFlightCopy(preRequestBytes, since.state.bytes, body);
  return since;
}

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "alldots_data");
  chokePoint = createChokePoint(pool);
  uploadPool = await createRuntimeRolePool(admin, "alldots_data");
  uploadPool.on("connect", instrumentReservations);
});

beforeEach(async () => {
  await resetDatabase(admin);
  storageDir = await mkdtemp(join(tmpdir(), "alldots-attach-upload-"));
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
    await rm(storageDir, { recursive: true, force: true });
  };
});

afterAll(async () => {
  await uploadPool?.end();
  await pool?.end();
  await admin?.end();
});

const HOLD_ROW = {
  items: "SELECT id FROM items WHERE id = $1 FOR NO KEY UPDATE",
  blobs: "SELECT id FROM blobs WHERE id = $1 FOR UPDATE",
} as const;

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

/**
 * Uploads every input while `table`'s row `id` is held and runs `observe`, then ends the holder whatever
 * `observe` did, so a waiting request can go on, and drains the requests. The case's own failure stays first.
 */
async function whileHeld<T>(
  table: keyof typeof HOLD_ROW,
  id: string,
  inputs: Upload[],
  observe: (requests: Promise<Outcome<Answer>>[], holderPid: number) => Promise<T>,
): Promise<{ value: T; answers: Answer[] }> {
  const holder = await holdRow(table, id);
  // Observed before any await, so they are drained whatever happens while the row is held.
  const requests = inputs.map((input) => outcomeOf(upload(a, input)));
  let primary: { error: unknown } | undefined;
  let result: { value: T } | undefined;
  try {
    result = { value: await observe(requests, holder.pid) };
  } catch (error) {
    primary = { error };
  }
  const failures: unknown[] = [];
  try {
    await holder.end();
  } catch (error) {
    failures.push(error);
  }
  const answers = await answersAfter(primary, requests, "The requests after their holder ended", failures);
  if (!result) throw new Error("The held requests' observation returned nothing");
  return { value: result.value, answers };
}

const TARGETS = [
  { relationKey: "healthRecords", database: (tenant: TenantFixture) => tenant.healthRecordsId, bytes: PDF },
  { relationKey: "tasks", database: (tenant: TenantFixture) => tenant.tasksId, bytes: JPG },
] as const;

describe("attach an upload to a health record or a task in the same request", () => {
  it.each(TARGETS)(
    "links a new file to one $relationKey target (201), the same bytes to a second (200), and repeats as a no-op",
    async ({ relationKey, database, bytes: make }) => {
      const first = await createItem(a, database(a), "First");
      const second = await createItem(a, database(a), "Second");
      const bytes = make("shared");
      const file = await fileOf(attach(bytes, first, relationKey));
      expect(await linked(a, file.id, relationKey)).toEqual([first]);
      expect((await fileOf(attach(bytes, second, relationKey), 200)).id).toBe(file.id);
      expect(await fileIds(a)).toEqual([file.id]);
      expect(await linked(a, file.id, relationKey)).toEqual([first, second].sort());
      const before = await storedState(a);
      expect((await fileOf(attach(bytes, second, relationKey), 200)).id).toBe(file.id);
      expect(await storedState(a)).toEqual(before);
    },
  );

  it("links a JPG and a PDF to a task with Files.tasks edges and the type read from the bytes", async () => {
    const task = await createItem(a, a.tasksId, "Renew passport");
    const jpg = await fileOf({ ...attach(JPG("photo"), task, "tasks"), filename: "photo.jpg" });
    const pdf = await fileOf({ ...attach(PDF("form"), task, "tasks"), filename: "form.pdf" });
    expect([jpg.properties.type, pdf.properties.type]).toEqual(["jpg", "pdf"]);
    expect(await linked(a, jpg.id, "tasks")).toEqual([task]);
    expect(await linked(a, pdf.id, "tasks")).toEqual([task]);
  });

  it("without the headers stores the file unlinked, 201 then 200 for the same bytes, as before", async () => {
    const bytes = PDF("plain");
    const file = await fileOf({ body: bytes });
    expect((await fileOf({ body: bytes }, 200)).id).toBe(file.id);
    expect(await linked(a, file.id, "healthRecords")).toEqual([]);
    expect(await fileIds(a)).toEqual([file.id]);
  });

  it("keeps an existing file's own project when the same bytes are attached to a task", async () => {
    const project = await createItem(a, a.projectsId, "Own project");
    const task = await createItem(a, a.tasksId, "Task");
    const bytes = PDF("filed under a project");
    const file = await fileOf(attach(bytes, project, "projects"));
    await fileOf(attach(bytes, task, "tasks"), 200);
    expect(await linked(a, file.id, "projects")).toEqual([project]);
    expect(await linked(a, file.id, "tasks")).toEqual([task]);
  });

  it.each(TARGETS)(
    "answers a missing, trashed or foreign $relationKey target with the same 404, for new and filed bytes, and stores nothing",
    async ({ relationKey, database, bytes: make }) => {
      const owner = await createItem(a, database(a), "Owner");
      const filed = make("already filed");
      await fileOf(attach(filed, owner, relationKey));
      const trashed = await createItem(a, database(a), "Old");
      await runInTenant(a.tenantId, () => chokePoint.softDeleteItem(database(a), trashed));
      const foreign = await createItem(b, database(b), "B's");
      const before = await storedState(a);
      for (const body of [make("new"), filed]) {
        const answers: Answer[] = [];
        for (const targetItemId of [randomUUID(), trashed, foreign]) {
          answers.push(await upload(a, attach(body, targetItemId, relationKey)));
        }
        expect(answers[0]?.status).toBe(404);
        expect(errorOf(answers[0]!).code).toBe("not_found");
        expect(answers[1]).toEqual(answers[0]);
        expect(answers[2]).toEqual(answers[0]);
        expect(answers[0]?.text).not.toContain(foreign);
      }
      expect(await storedState(a)).toEqual(before);
    },
  );

  it("refuses a relation that is not a Files relation, or leads elsewhere, with 400 on X-Attach-Relation, for new and filed bytes", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const task = await createItem(a, a.tasksId, "Task");
    const filed = PDF("already filed");
    await fileOf(attach(filed, record));
    const before = await storedState(a);
    const cases: [string, string][] = [
      [record, "neznamy"],
      [record, "name"],
      [record, "projects"],
      [task, "attachments"],
      // A tasks attach whose target is not a task.
      [record, "tasks"],
    ];
    for (const [targetItemId, relationKey] of cases) {
      for (const body of [PDF(`new ${relationKey}`), filed]) {
        const answer = await upload(a, attach(body, targetItemId, relationKey));
        expect(answer.status, relationKey).toBe(400);
        expect(errorOf(answer)).toMatchObject({ code: "validation_failed", details: { field: "X-Attach-Relation" } });
      }
    }
    expect(await storedState(a)).toEqual(before);
  });

  it("refuses one attach header without the other, and a target that is not an id, with 400 naming the header", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const before = await storedState(a);
    const cases: [Upload, string][] = [
      [{ body: PDF("one"), targetItemId: record }, "X-Attach-Relation"],
      [{ body: PDF("two"), relationKey: "healthRecords" }, "X-Attach-To-Item"],
      [attach(PDF("three"), "not-an-id"), "X-Attach-To-Item"],
    ];
    for (const [input, field] of cases) {
      const answer = await upload(a, input);
      expect(answer.status, field).toBe(400);
      expect(errorOf(answer)).toMatchObject({ code: "validation_failed", details: { field } });
    }
    expect(await storedState(a)).toEqual(before);
  });

  it.each(TARGETS)(
    "keeps a $relationKey cardinality violation's 409 and rolls the new file and its bytes back",
    async ({ relationKey, database, bytes: make }) => {
      const target = await createItem(a, database(a), "Target");
      await fileOf(attach(make("first"), target, relationKey));
      await makeOneToOne(a, relationKey);
      const before = await storedState(a);
      const answer = await upload(a, attach(make("second"), target, relationKey));
      expect(answer.status, answer.text).toBe(409);
      expect(await storedState(a)).toEqual(before);
    },
  );

  it("keeps an existing file's bytes and edges when attaching its bytes violates the cardinality (409)", async () => {
    await makeOneToOne(a, "healthRecords");
    const first = await createItem(a, a.healthRecordsId, "First");
    const second = await createItem(a, a.healthRecordsId, "Second");
    const firstBytes = PDF("first record's file");
    await fileOf(attach(firstBytes, first));
    await fileOf(attach(PDF("second record's file"), second));
    const before = await storedState(a);
    // Both ends already hold their one edge.
    const answer = await upload(a, attach(firstBytes, second));
    expect(answer.status, answer.text).toBe(409);
    expect(await storedState(a)).toEqual(before);
  });

  it("answers 404 and keeps nothing when the target is trashed while the body streams", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const before = await storedState(a);
    const gate = gateStreams(1);
    const started = [outcomeOf(upload(a, attach(PDF("raced"), record)))];
    let primary: { error: unknown } | undefined;
    try {
      await within(gate.streaming, 10_000, "The upload's body stream");
      await runInTenant(a.tenantId, () => chokePoint.softDeleteItem(a.healthRecordsId, record));
    } catch (error) {
      primary = { error };
    }
    gate.release();
    const [answer] = await answersAfter(primary, started, "The raced upload");
    expect(answer?.status).toBe(404);
    expect(errorOf(answer!).code).toBe("not_found");
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
      const file = await fileOf({ body: bytes });
      const before = await storedState(a);

      const { answers } = await whileHeld(
        "blobs",
        await onlyBlobId(a),
        [first, second].map((targetItemId) => attach(bytes, targetItemId)),
        (_requests, pid) =>
          pollFor(
            async () => ((await waitersOn(pid)).size >= 2 ? true : undefined),
            "The two uploads waiting on the held blob row",
          ),
      );

      expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
      for (const answer of answers) expect(itemBody.parse(JSON.parse(answer.text)).id).toBe(file.id);
      const after = await storedState(a);
      expect(after.blobs).toEqual(before.blobs);
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
    const gate = gateStreams(2);
    const started = [0, 1].map(() => outcomeOf(upload(a, attach(bytes, record))));
    let primary: { error: unknown } | undefined;
    try {
      await within(gate.streaming, 10_000, "Both upload streams");
    } catch (error) {
      primary = { error };
    }
    gate.release();
    streamingGate = null;
    const answers = await answersAfter(primary, started, "The two concurrent uploads");

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 201]);
    const ids = new Set(answers.map((answer) => itemBody.parse(JSON.parse(answer.text)).id));
    expect(ids.size).toBe(1);
    const [fileId] = ids;
    if (fileId === undefined) throw new Error("no file id");
    expect(await fileIds(a)).toEqual([fileId]);
    expect(await linked(a, fileId, "healthRecords")).toEqual([record]);
    const after = await storedState(a);
    expect(after.blobs).toHaveLength(before.blobs.length + 1);
    expect(after.edges).toHaveLength(before.edges.length + 1);
    const stored = await storedBytesOnce(
      (current) => Object.keys(current).length === Object.keys(before.bytes).length + 1,
    );
    expect(Object.keys(stored)).toHaveLength(Object.keys(before.bytes).length + 1);
    expect(Object.values(stored)).toContain(createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("attach reservations never wait while the upload holds its blob", () => {
  it("answers 409 upload_attach_conflict and rolls back while a PATCH holds the Files item and waits on the upload's blob, then the PATCH commits", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const bytes = PDF("patched while attaching");
    const file = await fileOf({ body: bytes });
    const blobId = await onlyBlobId(a);
    const patch = (itemId: string, fileBlobId: string) =>
      runInTenant(a.tenantId, () =>
        chokePoint.updateItem({
          databaseId: a.filesId,
          itemId,
          propertiesPatch: { name: "Renamed while attaching", file: { blobId: fileBlobId } },
        }),
      );

    // The control: the same PATCH of an uncontended Files item. Anything beyond its effects would be the upload's.
    const control = await fileOf({ body: PDF("control file") });
    const controlBlobId = (await blobIdsOf(a)).find((id) => id !== blobId);
    if (!controlBlobId) throw new Error("no control blob");
    const controlJobsBefore = await queuedJobs();
    const controlMarked = invalidations.length;
    await patch(control.id, controlBlobId);
    const controlNames = { [control.id]: "<file>", [controlBlobId]: "<blob>" };
    const controlJobs = jobDelta(controlJobsBefore, await queuedJobs(), controlNames);
    const controlInvalidations = invalidationShape(invalidations.slice(controlMarked), controlNames);
    expect(controlInvalidations.length).toBeGreaterThan(0);

    const before = await mark();
    // The upload pauses at its target reservation, after it has taken the blob `FOR UPDATE`.
    const { answer, value } = await withPausedUpload(record, attach(bytes, record), async (uploadPid, track) => {
      // The production PATCH takes the Files item, then its blob reference lock.
      const patching = track(patch(file.id, blobId), "The waiting PATCH");
      const waiting = await pollFor(async () => {
        const { rows } = await admin.query<{ pid: number; query: string }>(
          "SELECT pid, query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [uploadPid],
        );
        return rows.length > 0 ? rows : undefined;
      }, "The PATCH waiting on the upload's blob");
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.query).toMatch(/FROM blobs .*FOR KEY SHARE/s);
      // Wrapped, so returning it does not wait for the PATCH, which waits on the paused upload.
      return { patching };
    });
    const patched = await within(value.patching, 10_000, "The waiting PATCH");
    if (!patched.ok) throw patched.error;

    expect(answer.status).toBe(409);
    expect(conflictCode(answer, [file.id, record, blobId])).toBe("upload_attach_conflict");
    const after = await storedState(a);
    expect({ ...after, files: [] }).toEqual({ ...before.state, files: [] });
    expect(await fileIds(a)).toEqual([control.id, file.id].sort());
    expect(await linked(a, file.id, "healthRecords")).toEqual([]);
    const patchedFile = await runInTenant(a.tenantId, () => chokePoint.getItem(a.filesId, file.id));
    expect(patchedFile?.properties).toMatchObject({ name: "Renamed while attaching", file: { blobId } });
    const names = { [file.id]: "<file>", [blobId]: "<blob>" };
    expect(jobDelta(before.jobs, await queuedJobs(), names)).toEqual(controlJobs);
    expect(invalidationShape(invalidations.slice(before.invalidations), names)).toEqual(controlInvalidations);
  });

  it.each([
    { held: "the target", holdTarget: true, filed: true },
    { held: "the deduplicated Files item", holdTarget: false, filed: true },
    { held: "the target, for new bytes,", holdTarget: true, filed: false },
  ])(
    "answers 409 upload_attach_conflict at once while another transaction holds $held stores nothing, and a new request then succeeds",
    async ({ holdTarget, filed }) => {
      const record = await createItem(a, a.healthRecordsId, "Record");
      const bytes = PDF(`held ${holdTarget ? "target" : "file"} ${String(filed)}`);
      const file = filed ? await fileOf({ body: bytes }) : undefined;
      const before = await mark();
      const { value: refused } = await whileHeld(
        "items",
        holdTarget ? record : file!.id,
        [attach(bytes, record)],
        async ([request]) => {
          const outcome = await within(request!, 5_000, "The upload refused while its row is held");
          if (!outcome.ok) throw outcome.error;
          return outcome.value;
        },
      );
      expect(refused.status).toBe(409);
      expect(conflictCode(refused, file ? [file.id, record] : [record])).toBe("upload_attach_conflict");
      await expectUnchangedSince(before);

      // Not retried by the server: the caller's new request is what succeeds.
      const retried = await fileOf(attach(bytes, record), filed ? 200 : 201);
      if (file) expect(retried.id).toBe(file.id);
      expect(await linked(a, retried.id, "healthRecords")).toEqual([record]);
    },
  );

  it("waits, rather than refusing, while another transaction holds the deduplicated blob, then links the file", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const bytes = PDF("waits on a held blob");
    const file = await fileOf({ body: bytes });
    const { answers } = await whileHeld("blobs", await onlyBlobId(a), [attach(bytes, record)], (_requests, pid) =>
      pollFor(async () => ((await waitersOn(pid)).size === 1 ? true : undefined), "The waiting upload"),
    );
    expect(answers.map((answer) => answer.status)).toEqual([200]);
    expect(await linked(a, file.id, "healthRecords")).toEqual([record]);
  });

  it.each([
    { change: "trashed", alreadyLinked: false },
    { change: "trashed", alreadyLinked: true },
    { change: "repointed from its blob to another by a PATCH", alreadyLinked: false },
    { change: "repointed from its blob to another by a PATCH", alreadyLinked: true },
  ])(
    "answers 409 upload_attach_conflict when the deduplicated Files item is $change after the lookup, already linked: $alreadyLinked, and stores nothing",
    async ({ change, alreadyLinked }) => {
      const record = await createItem(a, a.healthRecordsId, "Record");
      const bytes = PDF(`${change} after lookup ${String(alreadyLinked)}`);
      const file = await fileOf(alreadyLinked ? attach(bytes, record) : { body: bytes });
      const uploadedBlobId = await onlyBlobId(a);
      const repoint = change !== "trashed";
      let otherBlobId: string | undefined;
      if (repoint) {
        const stored = await fetch(`${baseUrl}/api/blobs`, {
          method: "POST",
          headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/pdf" },
          body: PDF(`other bytes ${String(alreadyLinked)}`),
        });
        expect(stored.status).toBe(201);
        otherBlobId = z.object({ blobId: z.string() }).parse(await stored.json()).blobId;
        expect(otherBlobId).not.toBe(uploadedBlobId);
      }
      const preRequestBytes = await storedBytes();
      // Pauses at the Files item reservation, after the deduplicating lookup found the live item filing the bytes.
      const { answer, value: before } = await withPausedUpload(file.id, attach(bytes, record), (_pid, track) =>
        markAfter(
          // The PATCH repoints the item at the other blob; it does not wait on the upload, which holds its own.
          track(
            runInTenant(a.tenantId, () =>
              otherBlobId
                ? chokePoint.updateItem({
                    databaseId: a.filesId,
                    itemId: file.id,
                    propertiesPatch: { file: { blobId: otherBlobId } },
                  })
                : chokePoint.softDeleteItem(a.filesId, file.id),
            ),
            `The Files item ${change} while the upload is paused`,
          ),
          `The Files item ${change} while the upload is paused`,
          preRequestBytes,
          bytes,
        ),
      );
      expect(answer.status).toBe(409);
      expect(conflictCode(answer, [file.id, record, uploadedBlobId, ...(otherBlobId ? [otherBlobId] : [])])).toBe(
        "upload_attach_conflict",
      );
      await expectUnchangedSince(before, preRequestBytes);
      if (otherBlobId) {
        const repointed = await runInTenant(a.tenantId, () => chokePoint.getItem(a.filesId, file.id));
        expect(repointed?.properties).toMatchObject({ file: { blobId: otherBlobId } });
        expect(await linked(a, file.id, "healthRecords")).toEqual(alreadyLinked ? [record] : []);
      }
    },
  );

  it("answers the same 404 when the target is trashed after the pre-check and before its reservation, and stores nothing", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const body = PDF("target trashed");
    const preRequestBytes = await storedBytes();
    const { answer, value: before } = await withPausedUpload(record, attach(body, record), (_pid, track) =>
      markAfter(
        track(
          runInTenant(a.tenantId, () => chokePoint.softDeleteItem(a.healthRecordsId, record)),
          "Trashing the target",
        ),
        "Trashing the target while the upload is paused",
        preRequestBytes,
        body,
      ),
    );
    expect(answer.status).toBe(404);
    expect(conflictCode(answer, [record])).toBe("not_found");
    expect(answer).toEqual(await upload(a, attach(PDF("unknown target"), randomUUID())));
    await expectUnchangedSince(before, preRequestBytes);
  });

  it("marks the upload rollback-only, so a caller that catches the attach conflict still commits nothing", async () => {
    const record = await createItem(a, a.healthRecordsId, "Record");
    const gone = (await fileOf({ body: PDF("gone") })).id;
    const goneBlobId = await onlyBlobId(a);
    await runInTenant(a.tenantId, () => chokePoint.softDeleteItem(a.filesId, gone));
    const before = await mark();
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
    expect(failure).toBe(caught[0]);
    await expectUnchangedSince(before);
  });
});
