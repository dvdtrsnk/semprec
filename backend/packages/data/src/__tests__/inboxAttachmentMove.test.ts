import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { runOnce, CORE_TASK_NAMES } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import type { Pool, PoolClient } from "pg";
import {
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createBlob, getBlob } from "../blobs/blobsStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { deleteItemDependents } from "../chokePoint/itemTrash.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { purgeExpiredTrash } from "../trash/purgeExpiredTrash.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import { insertInboxAttachments, listInboxAttachments } from "../inbox/inboxAttachmentsStore.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn, type ProposalStep } from "../inbox/inboxTickAction.js";
import { confirmProposalWithClient } from "../inbox/proposalActions.js";
import { executeProposalSteps } from "../inbox/proposalSteps.js";
import {
  createFilesTranscriptionTriggerAction,
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
} from "../transcription/transcriptionActions.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
import { transcriptionJobKey } from "../transcription/transcriptionJob.js";
import type { ItemRow } from "../types.js";

// Issue #1703: confirming a `fileFromAttachment` step moves an Inbox attachment into Files. These tests
// run the real confirm path against the seeded database, through the runtime that owns the tables.
// Every envelope has a Task as its primary step: a file step is never primary (see the ADR).

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let inboxId: string;
let typesId: string;
let proposalsId: string;
let filesId: string;
let tasksId: string;
let projectsId: string;
let taskType: ItemRow;

/** Owns only this overlap's runtime clients, gates and operations. */
// pg 8.23.0 emits this plain, uncoded error on this owned-release path.
function isOwnedPgClosure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.constructor === Error &&
    !("code" in error) &&
    error.message === "Connection terminated"
  );
}

function ownOverlap(
  runtime: Pool,
  cancel: () => void,
  onCancellation?: (client: PoolClient, generation: object) => void,
  onGeneration?: (client: PoolClient, generation: object) => void,
  onReleased?: (client: PoolClient, generation: object) => void,
) {
  runtime.options.connectionTimeoutMillis = 2500;
  runtime.options.statement_timeout = 5000;
  const active = new Map<PoolClient, object>();
  const destroyed = new Set<object>();
  const retired = new Set<PoolClient>();
  const tasks = new Set<Promise<void>>();
  const outcomes: Array<{ error?: { value: unknown }; consumed: boolean }> = [];
  const outcomeByOperation = new WeakMap<Promise<unknown>, (typeof outcomes)[number]>();
  const errors: unknown[] = [];
  let closing = false;
  let expired = false;
  let closingPromise: Promise<void> | undefined;
  let settledCleanup = false;
  const onClientError = (error: Error) => errors.push(error);
  const destroy = (client: PoolClient, token: object) => {
    if (active.get(client) !== token) return;
    try {
      onCancellation?.(client, token);
      destroyed.add(token);
      client.release(true);
      onReleased?.(client, token);
    } catch (error) {
      errors.push(error);
    }
  };
  const onAcquire = (client: PoolClient) => {
    const token = {};
    active.set(client, token);
    onGeneration?.(client, token);
    client.on("error", onClientError);
    // pg-pool 3.14 assigns release after the acquire event.
    if (closing) queueMicrotask(() => destroy(client, token));
  };
  const onRelease = (_error: Error | undefined, client: PoolClient) => {
    const generation = active.get(client);
    active.delete(client);
    if (generation && destroyed.has(generation)) retired.add(client);
    else client.removeListener("error", onClientError);
  };
  runtime.on("acquire", onAcquire);
  runtime.on("release", onRelease);
  const run = <T>(start: () => Promise<T>): Promise<T> => {
    const operation = Promise.resolve().then(() => {
      if (closing) throw new Error("Overlap is closing");
      return start();
    });
    const outcome: { error?: { value: unknown }; consumed: boolean } = { consumed: false };
    outcomes.push(outcome);
    outcomeByOperation.set(operation, outcome);
    const settled = operation.then(
      () => {},
      (error: unknown) => {
        outcome.error = { value: error };
      },
    );
    tasks.add(settled);
    void settled.then(() => tasks.delete(settled));
    return operation;
  };
  const wait = <T>(signal: Promise<T>, ...actors: Promise<unknown>[]): Promise<T> =>
    overlapBounded(
      Promise.race([
        signal,
        ...actors.map((actor) =>
          actor.then(
            () => {
              throw new Error("Overlap participant completed before its barrier");
            },
            (error: unknown) => {
              throw error;
            },
          ),
        ),
      ]),
      5000,
    );
  const finish = (bodyFailed = false): Promise<void> => {
    if (closingPromise) return closingPromise;
    closing = true;
    clearTimeout(timer);
    const detach = () => {
      runtime.removeListener("acquire", onAcquire);
      runtime.removeListener("release", onRelease);
      for (const client of retired) client.removeListener("error", onClientError);
      retired.clear();
      settledCleanup = true;
    };
    closingPromise = (async () => {
      if (!bodyFailed) {
        try {
          const deadline = Date.now() + 3000;
          while (tasks.size > 0 || active.size > 0 || runtime.waitingCount > 0) {
            if (Date.now() >= deadline) throw new Error("Overlap returned with owned work pending");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        cancel();
      } catch (error) {
        errors.push(error);
      }
      for (const [client, token] of active) destroy(client, token);
      const end = runtime.end();
      const joined = (async () => {
        const results = await Promise.allSettled([end, ...tasks]);
        for (const result of results) if (result.status === "rejected") errors.push(result.reason);
        while (tasks.size > 0) await Promise.all([...tasks]);
        for (const outcome of outcomes) {
          if (outcome.error !== undefined && !outcome.consumed) errors.push(outcome.error.value);
        }
        const deadline = Date.now() + 3000;
        while (runtime.waitingCount > 0) {
          if (Date.now() >= deadline) throw new Error("Overlap pool waiters did not settle");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();
      try {
        await overlapBounded(joined, 8000);
        detach();
      } catch (error) {
        errors.push(error);
        // Only an unestablished driver/host stall reaches this failure fallback.
        void joined.then(detach, detach);
      }
      if (expired) errors.unshift(new Error("Overlap timed out"));
      if (errors.length) throw new AggregateError(errors, "Overlap cleanup failed", { cause: errors[0] });
    })();
    return closingPromise;
  };
  const timer = setTimeout(() => {
    expired = true;
    void finish(true).catch(() => {});
  }, 8000);
  const consume = (operation: Promise<unknown>, expected: unknown): void => {
    const outcome = outcomeByOperation.get(operation);
    if (!outcome?.error || outcome.error.value !== expected) throw new Error("Unexpected participant outcome");
    outcome.consumed = true;
  };
  return { run, wait, finish, consume, isSettled: () => settledCleanup };
}

async function overlapBounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Overlap cleanup timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function combineOverlapFailure(body: { error: unknown } | undefined, cleanup: unknown): { error: unknown } {
  return {
    error:
      body === undefined
        ? cleanup
        : new AggregateError([body.error, cleanup], "Overlap and cleanup failed", { cause: body.error }),
  };
}

function rethrowOverlap(error: unknown): never {
  // Preserve even non-Error thrown identities from the tested operation.
  throw error;
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Concurrency barrier timed out")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function jobExists(key: string): Promise<boolean> {
  const { rows } = await pool.query<{ "?column?": number }>(`SELECT 1 FROM graphile_worker.jobs WHERE key = $1`, [key]);
  return rows.length > 0;
}

/** Polls until the specified competitor is blocked by the specified holder. */
async function waitForBlockingPid(holderPid: number, competitorPid: number, queryPool: Pool = pool): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const { rows } = await runInTenant(getTenantZeroId(), () =>
      queryPool.query<{ waiting: boolean }>(`SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS waiting`, [
        holderPid,
        competitorPid,
      ]),
    );
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("No transaction waited on the expected holder");
}

type WaitResource = { kind: "blob" | "source"; id: string };

function observeResourceAttempt(client: PoolClient, resource: WaitResource, record: () => void): () => void {
  // The proxy forwards all production query calls unchanged, recording only the exact target row.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = client.query;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  client.query = new Proxy(client.query, {
    apply(target, receiver, args: unknown[]) {
      const sql = typeof args[0] === "string" ? args[0] : "";
      const params: unknown = args[1];
      const matches =
        resource.kind === "blob"
          ? sql.includes("FROM blobs WHERE") && sql.includes("FOR UPDATE")
          : sql.includes("FROM items i JOIN databases") && sql.includes("FOR UPDATE OF i");
      if (matches && Array.isArray(params) && params[0] === resource.id) record();
      return Reflect.apply(target, receiver, args);
    },
  });
  return () => {
    client.query = original;
  };
}

async function assertResourceHeld(resource: WaitResource, holderPid: number, observer: Pool): Promise<void> {
  // The interpolated identifier is chosen exclusively from these two fixed table names.
  const table = resource.kind === "blob" ? "blobs" : "items";
  const result = await withTenantTransaction(observer, getTenantZeroId(), (client) =>
    client.query<{ held: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${table} target JOIN pg_locks l ON l.transactionid::text = target.xmax::text
         WHERE target.id = $1 AND l.pid = $2 AND l.locktype = 'transactionid' AND l.granted) AS held`,
      [resource.id, holderPid],
    ),
  );
  expect(result.rows[0]?.held).toBe(true);
}

async function waitForResourceWait(
  resource: WaitResource,
  holderPid: number,
  competitorPid: number,
  observer: Pool,
): Promise<void> {
  const pattern =
    resource.kind === "blob" ? "%FROM blobs WHERE%FOR UPDATE%" : "%FROM items i JOIN databases%FOR UPDATE OF i%";
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $2 AND query LIKE $3
       AND $1::int = ANY(pg_blocking_pids(pid))) AS waiting`,
      [holderPid, competitorPid, pattern],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${resource.kind} statement to wait on the specified holder`);
}

/** A settled outcome instead of a promise, so a rejected concurrent confirm is never an unhandled rejection. */
type Outcome<T> = { value: T } | { error: unknown };
function settle<T>(run: Promise<T>): Promise<Outcome<T>> {
  return run.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

async function runHeldBlobOverlap<T>(
  first: (client: PoolClient) => Promise<unknown>,
  second: (client: PoolClient) => Promise<T>,
  resource: WaitResource,
  rollbackFirst = false,
  assertCompetitor?: (result: Outcome<T>) => void,
): Promise<Outcome<T>> {
  const runtime = await createRuntimeRolePool(pool, "semprec_data");
  let release = () => {};
  let firstReady = (_pid: number) => {};
  let secondReady = (_pid: number) => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstStarted = new Promise<number>((resolve) => {
    firstReady = resolve;
  });
  const secondStarted = new Promise<number>((resolve) => {
    secondReady = resolve;
  });
  const owned = ownOverlap(runtime, release);
  const rollback = new Error("forced holder rollback");
  let failure: { error: unknown } | undefined;
  let result: Outcome<T> | undefined;
  let attempted = false;
  try {
    const holder = owned.run(() =>
      withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing holder PID");
        await first(client);
        firstReady(pid);
        await gate;
        if (rollbackFirst) throw rollback;
      }),
    );
    const holderPid = await owned.wait(firstStarted, holder);
    await owned.wait(
      owned.run(() => assertResourceHeld(resource, holderPid, runtime)),
      holder,
    );
    const competitor = owned.run(() =>
      withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing competitor PID");
        const restore = observeResourceAttempt(client, resource, () => {
          attempted = true;
        });
        secondReady(pid);
        try {
          return await second(client);
        } finally {
          restore();
        }
      }),
    );
    const competitorPid = await owned.wait(secondStarted, holder, competitor);
    await owned.wait(
      owned.run(() => waitForBlockingPid(holderPid, competitorPid, runtime)),
      holder,
      competitor,
    );
    await owned.wait(
      owned.run(() => waitForResourceWait(resource, holderPid, competitorPid, runtime)),
      holder,
      competitor,
    );
    expect(attempted).toBe(true);
    release();
    const holderResult = await settle(holder);
    if (rollbackFirst) {
      expect("error" in holderResult).toBe(true);
      if (!("error" in holderResult)) throw new Error("Expected rollback");
      expect(holderResult.error).toBe(rollback);
      owned.consume(holder, rollback);
    } else if ("error" in holderResult) throw holderResult.error;
    result = await settle(competitor);
    if (assertCompetitor) {
      assertCompetitor(result);
      if ("error" in result) owned.consume(competitor, result.error);
    }
  } catch (error) {
    failure = { error };
  } finally {
    try {
      await owned.finish(failure !== undefined);
    } catch (error) {
      failure = combineOverlapFailure(failure, error);
    }
  }
  if (failure) rethrowOverlap(failure.error);
  if (!result) throw new Error("Missing overlap result");
  return result;
}

async function newBlob(mimeType: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    const blob = await createBlob(client, { mimeType, byteSize: 2048, storageKey: `blobs/${randomUUID()}` });
    return blob.id;
  });
}

/** Appends an attachment naming `blobId` to an Inbox item and returns the new attachment's id. */
async function attach(inboxItemId: string, blobId: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    await insertInboxAttachments(client, inboxItemId, [{ blobId, source: "camera" }]);
    const rows = await listInboxAttachments(client, [inboxItemId]);
    return rows[rows.length - 1]!.attachmentId;
  });
}

async function plainInboxItem(text: string): Promise<string> {
  const item = await withTransaction(pool, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId: inboxId,
      date: "2026-10-29",
      time: "09:00",
      text,
    }),
  );
  return item.id;
}

/** A Task-typed Inbox item and the Processing proposal the tick computes for it. */
async function inboxItemWithCard(text: string): Promise<{ inboxItemId: string; cardId: string }> {
  const item = await withTransaction(pool, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId: inboxId,
      date: "2026-10-29",
      time: "09:00",
      text,
      type: taskType.id,
    }),
  );
  const compute: ComputeSemprecProposalFn = async () => ({ properties: { name: text } });
  const tick = createSemprecTickAction(pool, compute);
  await tick(
    { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
    { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
  );
  return { inboxItemId: item.id, cardId: await cardOf(item.id) };
}

async function cardOf(inboxItemId: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    const property = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
    const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property!.id);
    const [edge] = await relationsStore.listRelationsForItem(client, definition!.id, inboxItemId);
    return relationsStore.otherSide(edge!, inboxItemId);
  });
}

/** Stores a multi-step envelope on a card the way the tick would: a system-owned `proposal` property, targeting Tasks. */
async function storeSteps(cardId: string, steps: ProposalStep[]): Promise<void> {
  const primary = steps.find((step) => step.role === "primary")!;
  await withTransaction(pool, (client) =>
    updateItemWithClient(
      client,
      {
        databaseId: proposalsId,
        itemId: cardId,
        propertiesPatch: {
          proposal: {
            entityKind: "database",
            target: tasksId,
            properties: primary.properties ?? {},
            operations: steps,
          },
        },
      },
      { allowedSystemKeys: ["proposal"] },
    ),
  );
}

/** The primary step of every envelope here: a Task, which the file step can run before or after. */
function taskPrimary(name = "Podepsat do 30. 10."): ProposalStep {
  return { ref: "task", op: "create", databaseKey: "tasks", role: "primary", properties: { name } };
}

function fileStep(attachmentId: string, extra: Partial<ProposalStep> = {}): ProposalStep {
  return {
    ref: "file",
    op: "fileFromAttachment",
    role: "secondary",
    properties: { attachmentId, name: "Scan", date: "2026-10-29" },
    ...extra,
  };
}

const confirm = (cardId: string): Promise<ItemRow> =>
  withTransaction(pool, (client) =>
    confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
  );

async function cardStatus(cardId: string): Promise<unknown> {
  const { rows } = await pool.query<{ status: unknown }>(
    "SELECT properties->'status' AS status FROM items WHERE id = $1",
    [cardId],
  );
  return rows[0]?.status;
}

/** Live Files items whose `file` names the blob. */
async function filesItemsFor(blobId: string): Promise<Array<{ id: string; properties: Record<string, unknown> }>> {
  const { rows } = await pool.query<{ id: string; properties: Record<string, unknown> }>(
    `SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL AND properties -> 'file' ->> 'blobId' = $2`,
    [filesId, blobId],
  );
  return rows;
}

async function attachmentCount(inboxItemId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM inbox_attachments WHERE inbox_item_id = $1",
    [inboxItemId],
  );
  return rows[0]!.n;
}

async function attachmentRowCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM inbox_attachments");
  return rows[0]!.n;
}

async function blobCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs");
  return rows[0]!.n;
}

async function countItems(databaseId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
    databaseId,
  ]);
  return rows[0]!.n;
}

async function originRowsFor(itemId: string) {
  const { rows } = await pool.query<{
    item_id: string;
    proposal_id: string;
    inbox_item_id: string | null;
    capture_channel: string;
  }>("SELECT item_id, proposal_id, inbox_item_id, capture_channel FROM item_origins WHERE item_id = $1", [itemId]);
  return rows;
}

async function edgeExists(a: string, b: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
    [a, b],
  );
  return rows.length === 1;
}

async function createIn(databaseId: string, properties: Record<string, unknown>): Promise<string> {
  return withTransaction(pool, async (client) => (await createItemWithClient(client, { databaseId, properties })).id);
}

describe("file from attachment on confirm (issue #1703)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    filesId = await databaseIdFor("files");
    tasksId = await databaseIdFor("tasks");
    projectsId = await databaseIdFor("projects");
    taskType = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("moves a photo into Files: one item on the same blob with the project, its origin and type jpg; the attachment row goes and no blob is added", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Scan of the contract");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    const projectId = await createIn(projectsId, { name: "Home" });
    const blobsBefore = await blobCount();
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId, { relations: { projects: [projectId] } })]);

    const confirmed = await confirm(cardId);

    const files = await filesItemsFor(blobId);
    expect(files).toHaveLength(1);
    const [fileItem] = files;
    expect(confirmed.properties.status).toBe("confirmed");
    expect(fileItem!.properties).toMatchObject({ name: "Scan", type: "jpg", date: "2026-10-29", file: { blobId } });
    expect(await edgeExists(fileItem!.id, projectId)).toBe(true);
    expect(await originRowsFor(fileItem!.id)).toEqual([
      { item_id: fileItem!.id, proposal_id: cardId, inbox_item_id: inboxItemId, capture_channel: "inbox" },
    ]);
    expect(await attachmentCount(inboxItemId)).toBe(0);
    expect(await blobCount()).toBe(blobsBefore);
  });

  it("returns the moved attachment and the Files item in the step result, and lists the item as created", async () => {
    const inboxItemId = await plainInboxItem("Receipt");
    const blobId = await newBlob("application/pdf");
    const attachmentId = await attach(inboxItemId, blobId);

    const executed = await withTransaction(pool, (client) =>
      executeProposalSteps(client, [taskPrimary(), fileStep(attachmentId)], {
        writer: { writerKind: "user" },
        sourceInboxItemId: inboxItemId,
      }),
    );

    const [files] = await filesItemsFor(blobId);
    expect(files!.properties).toMatchObject({ type: "pdf" });
    expect(executed.fileFromAttachments).toEqual([
      { ref: "file", fileItemId: files!.id, movedAttachmentId: attachmentId, created: true },
    ]);
    expect(executed.createdItemIds).toContain(files!.id);
    expect(executed.primaryItemId).not.toBe(files!.id);
  });

  it("leaves out the type when the blob's mime type has no Files type", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Archive");
    const blobId = await newBlob("application/zip");
    const attachmentId = await attach(inboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);

    await confirm(cardId);

    const [fileItem] = await filesItemsFor(blobId);
    expect(fileItem!.properties).not.toHaveProperty("type");
    expect(fileItem!.properties).toMatchObject({ name: "Scan", file: { blobId } });
  });

  it("resolves to the Files item that already names the blob: no second item, that item unchanged, no origin row", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Photo again");
    const blobId = await newBlob("image/jpeg");
    const existingId = await createIn(filesId, { name: "Existing", file: { blobId } });
    const before = await pool.query("SELECT properties, updated_at FROM items WHERE id = $1", [existingId]);
    const attachmentId = await attach(inboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);

    const confirmed = await confirm(cardId);

    expect(confirmed.properties.status).toBe("confirmed");
    expect(await filesItemsFor(blobId)).toHaveLength(1);
    const after = await pool.query("SELECT properties, updated_at FROM items WHERE id = $1", [existingId]);
    expect(after.rows).toEqual(before.rows);
    expect(await originRowsFor(existingId)).toEqual([]);
    expect(await attachmentCount(inboxItemId)).toBe(0);
  });

  it("returns the existing Files ID and moved attachment ID with created false", async () => {
    const source = await plainInboxItem("Existing photo");
    const blobId = await newBlob("image/jpeg");
    const existingId = await createIn(filesId, { name: "Existing", file: { blobId } });
    const attachmentId = await attach(source, blobId);
    const result = await withTransaction(pool, (client) =>
      executeProposalSteps(client, [taskPrimary(), fileStep(attachmentId)], {
        writer: { writerKind: "user" },
        sourceInboxItemId: source,
      }),
    );
    expect(result.fileFromAttachments).toEqual([
      { ref: "file", fileItemId: existingId, movedAttachmentId: attachmentId, created: false },
    ]);
    expect(result.createdItemIds).not.toContain(existingId);
    expect(await attachmentCount(source)).toBe(0);
  });

  it.each([
    ["another Inbox item's attachment", "foreign"],
    ["an attachment id that does not exist", "unknown"],
  ] as const)("refuses %s with 400 and writes nothing", async (_label, kind) => {
    const { cardId } = await inboxItemWithCard("Scan");
    const blobId = await newBlob("image/jpeg");
    let attachmentId: string;
    if (kind === "foreign") {
      const otherInboxItemId = await plainInboxItem("Someone else's scan");
      attachmentId = await attach(otherInboxItemId, blobId);
    } else {
      attachmentId = randomUUID();
    }
    const attachmentRowsBefore = await attachmentRowCount();
    const blobsBefore = await blobCount();
    const tasksBefore = await countItems(tasksId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);

    await expect(confirm(cardId)).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { ref: "file", field: "attachmentId" },
    });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentRowCount()).toBe(attachmentRowsBefore);
    expect(await blobCount()).toBe(blobsBefore);
    expect(await countItems(tasksId)).toBe(tasksBefore);
    expect(await cardStatus(cardId)).toBe("proposed");
  });

  it("refuses every attachment when the proposal has no source Inbox item", async () => {
    const inboxItemId = await plainInboxItem("Receipt");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);

    await expect(
      withTransaction(pool, (client) =>
        executeProposalSteps(client, [taskPrimary(), fileStep(attachmentId)], {
          writer: { writerKind: "user" },
          sourceInboxItemId: null,
        }),
      ),
    ).rejects.toMatchObject({ status: 400, details: { ref: "file", field: "attachmentId" } });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentCount(inboxItemId)).toBe(1);
  });

  it.each<[string, (attachmentId: string, blobId: string) => Partial<ProposalStep>]>([
    ["a file property", (attachmentId, blobId) => ({ properties: { attachmentId, name: "Scan", file: { blobId } } })],
    ["a type", (attachmentId) => ({ properties: { attachmentId, name: "Scan", type: "jpg" } })],
    ["an unrelated property", (attachmentId) => ({ properties: { attachmentId, name: "Scan", untrusted: true } })],
    ["an empty name", (attachmentId) => ({ properties: { attachmentId, name: "   " } })],
    ["no attachment", () => ({ properties: { name: "Scan" } })],
    ["an attachment id that is not a UUID", () => ({ properties: { attachmentId: "not-a-uuid", name: "Scan" } })],
    ["a database key", () => ({ databaseKey: "tasks" })],
    ["an item id", () => ({ itemId: randomUUID() })],
    ["a relation that is not a relation property", () => ({ relations: { name: [randomUUID()] } })],
  ])("refuses a step with %s with 400 and writes nothing", async (_label, override) => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Scan");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId, override(attachmentId, blobId))]);

    await expect(confirm(cardId)).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentCount(inboxItemId)).toBe(1);
    expect(await cardStatus(cardId)).toBe("proposed");
  });

  it.each([
    // The Files `type` select of a tenant seeded before #1410 has no `png` option.
    [
      "an option the select lacks",
      "UPDATE properties SET config = jsonb_set(config, '{options}', (SELECT coalesce(jsonb_agg(o), '[]'::jsonb) FROM jsonb_array_elements(config -> 'options') AS o WHERE o ->> 'key' <> 'png')) WHERE database_id = $1 AND key = 'type'",
      "image/png",
    ],
    // A `type` select without any options offers no value at all.
    [
      "a select with no options",
      "UPDATE properties SET config = '{}'::jsonb WHERE database_id = $1 AND key = 'type'",
      "image/jpeg",
    ],
  ])("leaves out the type when the Files type select does not offer it: %s", async (_label, sql, mimeType) => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Photo");
    // A raw update, because no route can produce a Files `type` select in these shapes; it only changes Files options.
    await pool.query(sql, [filesId]);
    const blobId = await newBlob(mimeType);
    const attachmentId = await attach(inboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);

    await confirm(cardId);

    const [fileItem] = await filesItemsFor(blobId);
    expect(fileItem!.properties).not.toHaveProperty("type");
  });

  it("reports a missing Files database as not found and writes nothing", async () => {
    const inboxItemId = await plainInboxItem("Receipt");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    // A raw update inside the rolled-back transaction: the seed always creates the Files database, so this state is unreachable in a real tenant.
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("UPDATE databases SET owner_module_id = NULL WHERE id = $1", [filesId]);
        return executeProposalSteps(client, [taskPrimary(), fileStep(attachmentId)], {
          writer: { writerKind: "user" },
          sourceInboxItemId: inboxItemId,
        });
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await attachmentCount(inboxItemId)).toBe(1);
    expect(await countItems(tasksId)).toBe(0);
  });

  it("refuses a file step as the primary step with 400", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Scan only");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    const primaryFile = fileStep(attachmentId, { role: "primary" });
    await storeSteps(cardId, [primaryFile]);

    await expect(confirm(cardId)).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { ref: "file", field: "op" },
    });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentCount(inboxItemId)).toBe(1);
  });

  it("rolls the move back when a later step fails: no Files item, no Task, the attachment stays, the card stays proposed", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Scan and task");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    const blobsBefore = await blobCount();
    const tasksBefore = await countItems(tasksId);
    await storeSteps(cardId, [
      taskPrimary(),
      fileStep(attachmentId),
      // A wrong value type passes envelope validation and fails only in the choke point's write, after the move ran.
      { ref: "broken", op: "create", databaseKey: "tasks", role: "secondary", properties: { name: 42 } },
    ]);

    await expect(confirm(cardId)).rejects.toMatchObject({ status: 400, details: { ref: "broken" } });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentCount(inboxItemId)).toBe(1);
    expect(await blobCount()).toBe(blobsBefore);
    expect(await countItems(tasksId)).toBe(tasksBefore);
    expect(await cardStatus(cardId)).toBe("proposed");
  });

  it("an audio attachment filed by confirm enqueues no transcription, while an audio file made in Files directly is transcribed", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Voice note");
    const blobId = await newBlob("audio/mpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);
    await confirm(cardId);
    const [fileItem] = await filesItemsFor(blobId);

    const emailsId = await databaseIdFor("emails");
    const attachmentsProperty = await withTransaction(pool, (client) =>
      propertiesStore.getPropertyByKey(client, emailsId, "attachments"),
    );
    const handler = createFilesTranscriptionTriggerAction(pool);
    const config = { filesDatabaseId: filesId, attachmentsRelationPropertyId: attachmentsProperty!.id };
    await handler(config, { heartbeatId: "hb", projectItemId: "proj", itemId: fileItem!.id });
    expect(await jobExists(transcriptionJobKey(fileItem!.id))).toBe(false);

    // The contrast: the same trigger still enqueues a recording that has no Inbox origin.
    const recordingBlobId = await newBlob("audio/mpeg");
    const recording = await createIn(filesId, { name: "Recording", file: { blobId: recordingBlobId } });
    await handler(config, { heartbeatId: "hb", projectItemId: "proj", itemId: recording });
    expect(await jobExists(transcriptionJobKey(recording))).toBe(true);
  });

  it("the queued Files heartbeat skips an audio attachment after confirm", async () => {
    const { fileItemId, fireKey } = await runInTenant(getTenantZeroId(), async () => {
      const { inboxItemId, cardId } = await inboxItemWithCard("Voice note");
      const blobId = await newBlob("audio/mpeg");
      const attachmentId = await attach(inboxItemId, blobId);
      await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);
      await confirm(cardId);
      const [fileItem] = await filesItemsFor(blobId);
      if (!fileItem) throw new Error("Expected a filed audio item");
      const heartbeat = await pool.query<{ id: string }>("SELECT id FROM project_heartbeats WHERE action_id = $1", [
        FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
      ]);
      if (heartbeat.rows.length !== 1 || !heartbeat.rows[0]) throw new Error("Expected a Files heartbeat");
      const fireKey = `heartbeat-fire:${heartbeat.rows[0].id}:${fileItem.id}`;
      expect(await jobExists(fireKey)).toBe(true);
      return { fileItemId: fileItem.id, fireKey };
    });
    const registry = createActionRegistry();
    registry.set(FILES_TRANSCRIPTION_TRIGGER_ACTION_ID, createFilesTranscriptionTriggerAction(pool));
    const heartbeatTask = createCoreTaskList(pool, registry)[CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE];
    if (!heartbeatTask) throw new Error("Missing core heartbeat task");
    await runOnce({ pgPool: pool, taskList: { [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE]: heartbeatTask } });
    expect(await jobExists(fireKey)).toBe(false);
    expect(await jobExists(transcriptionJobKey(fileItemId))).toBe(false);
    const { rows } = await pool.query<{ last_error: string | null }>(
      "SELECT last_error FROM project_heartbeats WHERE action_id = $1",
      [FILES_TRANSCRIPTION_TRIGGER_ACTION_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_error).toBeNull();
  });

  it("deleting the Files item of a move keeps the bytes an unconfirmed attachment still names", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Scan");
    const otherInboxItemId = await plainInboxItem("Second copy, not confirmed");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    await attach(otherInboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);
    await confirm(cardId);
    const [fileItem] = await filesItemsFor(blobId);

    const released = await withTransaction(pool, async (client) => {
      const row = await itemsStore.getItemById(client, filesId, fileItem!.id);
      return deleteItemDependents(client, row!);
    });

    expect(released.blobStorageKeys).toEqual([]);
    expect(await withTransaction(pool, (client) => getBlob(client, blobId))).not.toBeNull();
    expect(await attachmentCount(otherInboxItemId)).toBe(1);
  });

  it("keeps the original physical bytes through a move and later Files purge", async () => {
    const directory = await mkdtemp(join(tmpdir(), "semprec-move-bytes-"));
    const storage = new LocalFsBlobStorageWriter(directory);
    const bytes = Buffer.from("owned photo attachment bytes");
    const storageKey = `blobs/${randomUUID()}`;
    try {
      await storage.writeStream(storageKey, Readable.from([bytes]));
      const blob = await withTransaction(pool, (client) =>
        createBlob(client, {
          mimeType: "image/jpeg",
          byteSize: bytes.length,
          storageKey,
        }),
      );
      const first = await inboxItemWithCard("Move photo");
      const second = await plainInboxItem("Unconfirmed photo");
      const attachment = await attach(first.inboxItemId, blob.id);
      await attach(second, blob.id);
      const before = await readdir(join(directory, "blobs"));
      expect(before).toEqual([storageKey.split("/")[1]]);
      await storeSteps(first.cardId, [taskPrimary(), fileStep(attachment)]);
      await confirm(first.cardId);
      expect(await readdir(join(directory, "blobs"))).toEqual(before);
      expect(await readFile(join(directory, storageKey))).toEqual(bytes);
      const files = await filesItemsFor(blob.id);
      expect(files).toHaveLength(1);
      const cp = createChokePoint(pool);
      await cp.softDeleteItem(filesId, files[0]!.id);
      await pool.query("UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = $1", [files[0]!.id]);
      expect(await runInTenant(getTenantZeroId(), () => purgeExpiredTrash(pool, storage))).toBe(1);
      expect(await readdir(join(directory, "blobs"))).toEqual(before);
      expect(await readFile(join(directory, storageKey))).toEqual(bytes);
      expect(await attachmentCount(second)).toBe(1);
      expect(await withTransaction(pool, (client) => getBlob(client, blob.id))).not.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("two confirms that file the same bytes make one Files item: the second waits for the blob lock and reuses the item", async () => {
    const first = await inboxItemWithCard("First scan");
    const second = await inboxItemWithCard("Second scan");
    const blobId = await newBlob("image/jpeg");
    const firstAttachment = await attach(first.inboxItemId, blobId);
    const secondAttachment = await attach(second.inboxItemId, blobId);
    await storeSteps(first.cardId, [taskPrimary("First task"), fileStep(firstAttachment)]);
    await storeSteps(second.cardId, [taskPrimary("Second task"), fileStep(secondAttachment)]);

    const outcome = await runHeldBlobOverlap(
      (client) => confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, first.cardId),
      (client) => confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, second.cardId),
      { kind: "blob", id: blobId },
    );
    if (!("value" in outcome)) throw outcome.error;
    expect(outcome.value.properties.status).toBe("confirmed");

    const [fileItem] = await filesItemsFor(blobId);
    expect(await filesItemsFor(blobId)).toHaveLength(1);
    expect(await attachmentCount(first.inboxItemId)).toBe(0);
    expect(await attachmentCount(second.inboxItemId)).toBe(0);
    expect(await originRowsFor(fileItem!.id)).toHaveLength(1);
  });

  it("a second move of the same attachment waits for the first, then refuses with 409 and writes nothing", async () => {
    const source = await plainInboxItem("Scan");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(source, blobId);
    const steps = [taskPrimary(), fileStep(attachmentId)];
    const options = { writer: { writerKind: "user" as const }, sourceInboxItemId: source };

    const outcome = await runHeldBlobOverlap(
      (client) => executeProposalSteps(client, steps, options),
      (client) => executeProposalSteps(client, steps, options),
      { kind: "source", id: source },
      false,
      (result) => expect(result).toMatchObject({ error: { status: 409, code: "version_conflict" } }),
    );
    expect(outcome).toMatchObject({ error: { status: 409, code: "version_conflict" } });

    expect(await filesItemsFor(blobId)).toHaveLength(1);
    expect(await attachmentCount(source)).toBe(0);
  });

  it("lets the blocked competing confirm create the file when the holder rolls back", async () => {
    const first = await inboxItemWithCard("First scan");
    const second = await inboxItemWithCard("Second scan");
    const blobId = await newBlob("image/jpeg");
    const firstAttachment = await attach(first.inboxItemId, blobId);
    const secondAttachment = await attach(second.inboxItemId, blobId);
    await storeSteps(first.cardId, [taskPrimary("First task"), fileStep(firstAttachment)]);
    await storeSteps(second.cardId, [taskPrimary("Second task"), fileStep(secondAttachment)]);
    const outcome = await runHeldBlobOverlap(
      (client) => confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, first.cardId),
      (client) => confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, second.cardId),
      { kind: "blob", id: blobId },
      true,
    );
    if (!("value" in outcome)) throw outcome.error;
    expect(outcome.value.properties.status).toBe("confirmed");
    const files = await filesItemsFor(blobId);
    expect(files).toHaveLength(1);
    expect(await originRowsFor(files[0]!.id)).toEqual([
      {
        item_id: files[0]!.id,
        proposal_id: second.cardId,
        inbox_item_id: second.inboxItemId,
        capture_channel: "inbox",
      },
    ]);
    expect(await attachmentCount(first.inboxItemId)).toBe(1);
    expect(await attachmentCount(second.inboxItemId)).toBe(0);
    const firstCard = await withTransaction(pool, (client) =>
      itemsStore.getItemById(client, proposalsId, first.cardId),
    );
    expect(firstCard?.properties.status).toBe("proposed");
  });

  it.each([undefined, { marker: "late" }])(
    "retains a late participant failure and consumes only the asserted participant %#",
    async (late) => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let release = () => {};
      let started = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const owned = ownOverlap(runtime, release);
      const expected = { marker: "asserted" };
      const body = new Error("forced observation failure");
      let lateSettled = false;
      let failure: { error: unknown } | undefined;
      try {
        const negative = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            await client.query<{ "?column?": number }>("SELECT 1");
            rethrowOverlap(expected);
          }),
        );
        await expect(negative).rejects.toBe(expected);
        owned.consume(negative, expected);
        const participant = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            if (!pid) throw new Error("Missing owned PID");
            started();
            await gate;
            rethrowOverlap(late);
          }),
        );
        void participant.then(
          () => {
            lateSettled = true;
          },
          () => {
            lateSettled = true;
          },
        );
        await owned.wait(ready, participant);
        throw body;
      } catch (error) {
        failure = { error };
      } finally {
        try {
          await owned.finish(failure !== undefined);
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
      }
      if (failure && (!(failure.error instanceof AggregateError) || failure.error.cause !== body)) {
        rethrowOverlap(failure.error);
      }
      const combined = failure?.error;
      expect(combined).toBeInstanceOf(AggregateError);
      if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure");
      expect(combined.cause).toBe(body);
      expect(combined.errors[0]).toBe(body);
      const cleanup: unknown = combined.errors[1];
      expect(cleanup).toBeInstanceOf(AggregateError);
      if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failure");
      expect(combined.errors).toHaveLength(2);
      expect(cleanup.errors).toHaveLength(1);
      expect(cleanup.errors[0]).toBe(late);
      expect(cleanup.cause).toBe(late);
      expect(lateSettled).toBe(true);
      expect(runtime.ended).toBe(true);
      expect(runtime.totalCount).toBe(0);
      expect(runtime.listenerCount("acquire")).toBe(0);
      expect(runtime.listenerCount("release")).toBe(0);
    },
    20000,
  );

  it("settles ownership when the first participant has the wrong rejection", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const wrong = { marker: "wrong" };
    const expected = { marker: "expected" };
    const cleanupError = new Error("controlled cleanup failure");
    const owned = ownOverlap(runtime, () => {
      throw cleanupError;
    });
    let assertion: { error: unknown } | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const negative = owned.run(() =>
        withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
          await client.query<{ "?column?": number }>("SELECT 1");
          rethrowOverlap(wrong);
        }),
      );
      try {
        await expect(negative).rejects.toBe(expected);
      } catch (error) {
        assertion = { error };
        throw error;
      }
      owned.consume(negative, expected);
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await owned.finish(failure !== undefined);
      } catch (error) {
        failure = combineOverlapFailure(failure, error);
      }
    }
    if (!assertion) throw new Error("Expected assertion failure");
    const combined = failure?.error;
    expect(combined).toBeInstanceOf(AggregateError);
    if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure");
    expect(combined.errors).toHaveLength(2);
    expect(combined.errors[0]).toBe(assertion.error);
    expect(combined.cause).toBe(assertion.error);
    const cleanup: unknown = combined.errors[1];
    expect(cleanup).toBeInstanceOf(AggregateError);
    if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failure");
    expect(cleanup.errors).toHaveLength(2);
    expect(cleanup.errors[0]).toBe(cleanupError);
    expect(cleanup.errors[1]).toBe(wrong);
    expect(cleanup.cause).toBe(cleanupError);
    expect(runtime.ended).toBe(true);
    expect(runtime.totalCount).toBe(0);
    expect(runtime.waitingCount).toBe(0);
    expect(runtime.listenerCount("acquire")).toBe(0);
    expect(runtime.listenerCount("release")).toBe(0);
  }, 20000);

  it("preserves an early checkout failure together with cleanup failure", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const actorError = new Error("pre-verify checkout failure");
    const cleanupError = new Error("cleanup failure");
    let release = () => {};
    const signal = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.options.verify = (_client, done) => done(actorError);
    const generations = new Map<PoolClient, object>();
    const cancellationRequests = new Set<object>();
    const owned = ownOverlap(
      runtime,
      () => {
        release();
        throw cleanupError;
      },
      (_client, generation) => {
        cancellationRequests.add(generation);
      },
      (client, generation) => {
        generations.set(client, generation);
      },
    );
    let operationFailure: { value: unknown } | undefined;
    const observedDiagnostics: Array<{ error: Error; generation: object; cancelled: boolean; operation: "checkout" }> =
      [];
    const observing = new Map<PoolClient, (error: Error) => void>();
    const observeAcquire = (client: PoolClient) => {
      const generation = generations.get(client);
      if (!generation) throw new Error("Missing client generation");
      const onError = (error: Error) =>
        observedDiagnostics.push({
          error,
          generation,
          cancelled: cancellationRequests.has(generation),
          operation: "checkout",
        });
      observing.set(client, onError);
      client.on("error", onError);
    };
    const observeRelease = (_reason: unknown, client: PoolClient) => {
      const onError = observing.get(client);
      const generation = generations.get(client);
      if (generation && cancellationRequests.has(generation)) return;
      if (onError) client.removeListener("error", onError);
      observing.delete(client);
      generations.delete(client);
    };
    runtime.on("acquire", observeAcquire);
    runtime.on("release", observeRelease);
    let failure: { error: unknown } | undefined;
    try {
      const actor = owned.run(() => withTenantTransaction(runtime, getTenantZeroId(), async () => {}));
      void actor.catch((error: unknown) => {
        operationFailure = { value: error };
      });
      await owned.wait(signal, actor);
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await owned.finish(failure !== undefined);
      } catch (error) {
        failure = combineOverlapFailure(failure, error);
      }
    }
    if (!owned.isSettled()) {
      if (failure) throw failure.error;
      throw new Error("Owned overlap did not settle");
    }
    runtime.removeListener("acquire", observeAcquire);
    runtime.removeListener("release", observeRelease);
    for (const [client, onError] of observing) client.removeListener("error", onError);
    observing.clear();
    expect(observing.size).toBe(0);
    const observed = failure?.error;
    expect(observed).toBeInstanceOf(AggregateError);
    if (!(observed instanceof AggregateError)) throw new Error("Expected combined error");
    expect(observed.cause).toBe(actorError);
    expect(observed.errors[0]).toBe(actorError);
    expect(observed.errors).toHaveLength(2);
    const cleanup: unknown = observed.errors[1];
    expect(cleanup).toBeInstanceOf(AggregateError);
    if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup aggregate");
    expect(operationFailure).toBeDefined();
    if (!operationFailure) throw new Error("Missing operation failure");
    expect(operationFailure.value).toBe(actorError);
    for (const diagnostic of observedDiagnostics) {
      expect(diagnostic.cancelled).toBe(true);
      expect(diagnostic.operation).toBe("checkout");
      expect(diagnostic.error).toBe(operationFailure.value);
    }
    const expectedErrors = [cleanupError, ...observedDiagnostics.map((entry) => entry.error), operationFailure.value];
    expect(cleanup.errors).toHaveLength(expectedErrors.length);
    for (let i = 0; i < expectedErrors.length; i++) expect(cleanup.errors[i]).toBe(expectedErrors[i]);
    expect(cleanup.cause).toBe(cleanupError);
    expect(runtime.ended).toBe(true);
    expect(runtime.totalCount).toBe(0);
    expect(runtime.waitingCount).toBe(0);
    expect(runtime.listenerCount("acquire")).toBe(0);
    expect(runtime.listenerCount("release")).toBe(0);
  }, 20000);

  it.each([
    [undefined, false, false],
    [{ marker: "late participant" }, false, false],
    [{ marker: "late participant" }, true, false],
    [{ marker: "late participant" }, false, true],
  ] as const)(
    "settles blocked overlap participants on an injected body failure %#",
    async (lateParticipant, injectPreCancel, injectPostCancel) => {
      const itemId = await plainInboxItem("cleanup source");
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let release = () => {};
      let holderReady = () => {};
      let contenderReady = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holderStarted = new Promise<void>((resolve) => {
        holderReady = resolve;
      });
      const contenderStarted = new Promise<void>((resolve) => {
        contenderReady = resolve;
      });
      const generations = new Map<PoolClient, object>();
      const cancellationRequests = new Set<object>();
      const releaseCompletions = new Set<object>();
      let holderClient: PoolClient | undefined;
      let contenderClient: PoolClient | undefined;
      let contenderGeneration: object | undefined;
      const preCancel = new Error("pre-cancellation diagnostic");
      const postCancel = new Error("unrelated post-cancellation diagnostic");
      let releaseCallbackFailure: { value: unknown } | undefined;
      const owned = ownOverlap(
        runtime,
        () => {
          release();
          holderReady();
          contenderReady();
        },
        (_client, generation) => {
          cancellationRequests.add(generation);
        },
        (client, generation) => {
          generations.set(client, generation);
        },
        (client, generation) => {
          releaseCompletions.add(generation);
          if (injectPostCancel && client === holderClient) {
            try {
              client.emit("error", postCancel);
            } catch (error) {
              releaseCallbackFailure = { value: error };
              throw error;
            }
          }
        },
      );
      let holderPid: number | undefined;
      let contenderPid: number | undefined;
      let holderSettled = false;
      type ObservedClient = { generation: object; onError: (error: Error) => void };
      const observedClients = new Map<PoolClient, ObservedClient>();
      const diagnostics: Array<{
        error: Error;
        generation: object;
        cancelled: boolean;
        released: boolean;
        operation: string;
      }> = [];
      const observeAcquire = (client: PoolClient) => {
        const generation = generations.get(client);
        if (!generation) throw new Error("Missing client generation");
        const onError = (error: Error) =>
          diagnostics.push({
            error,
            generation,
            cancelled: cancellationRequests.has(generation),
            released: releaseCompletions.has(generation),
            operation: client === holderClient ? "holder" : client === contenderClient ? "contender" : "other",
          });
        observedClients.set(client, { generation, onError });
        client.on("error", onError);
      };
      const observeRelease = (_reason: unknown, client: PoolClient) => {
        const owner = observedClients.get(client);
        if (!owner) throw new Error("Unknown owned client release");
        if (cancellationRequests.has(owner.generation)) return;
        client.removeListener("error", owner.onError);
        observedClients.delete(client);
        generations.delete(client);
      };
      runtime.on("acquire", observeAcquire);
      runtime.on("release", observeRelease);
      let holderError: { value: unknown } | undefined;
      let contenderError:
        | {
            value: unknown;
            generation: object | undefined;
            cancellationRequested: boolean;
          }
        | undefined;
      let contenderSettled = false;
      const bodyError = new Error("forced overlap body failure");
      let failure: { error: unknown } | undefined;
      try {
        const holder = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            holderClient = client;
            holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            await updateItemWithClient(client, { databaseId: inboxId, itemId, propertiesPatch: { text: "held" } });
            holderReady();
            await gate;
            rethrowOverlap(lateParticipant);
          }),
        );
        void holder.then(
          () => {
            holderSettled = true;
          },
          (error: unknown) => {
            holderError = { value: error };
            holderSettled = true;
          },
        );
        await owned.wait(holderStarted, holder);
        const contender = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            contenderClient = client;
            contenderGeneration = generations.get(client);
            contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            contenderReady();
            await updateItemWithClient(client, { databaseId: inboxId, itemId, propertiesPatch: { text: "contender" } });
          }),
        );
        void contender.then(
          () => {
            contenderSettled = true;
          },
          (error: unknown) => {
            contenderError = {
              value: error,
              generation: contenderGeneration,
              cancellationRequested: contenderGeneration !== undefined && cancellationRequests.has(contenderGeneration),
            };
            contenderSettled = true;
          },
        );
        await owned.wait(contenderStarted, holder, contender);
        if (!holderPid || !contenderPid) throw new Error("Missing participant PID");
        const holderId = holderPid;
        const contenderId = contenderPid;
        await owned.wait(
          owned.run(() => waitForBlockingPid(holderId, contenderId, runtime)),
          holder,
          contender,
        );
        if (injectPreCancel) {
          if (!holderClient) throw new Error("Missing holder client");
          holderClient.emit("error", preCancel);
        }
        throw bodyError;
      } catch (error) {
        failure = { error };
      } finally {
        try {
          await owned.finish(failure !== undefined);
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        } finally {
          if (owned.isSettled()) {
            runtime.removeListener("acquire", observeAcquire);
            runtime.removeListener("release", observeRelease);
          }
        }
      }
      if (!owned.isSettled()) {
        if (failure) throw failure.error;
        throw new Error("Owned overlap did not settle");
      }
      for (const [client, owner] of observedClients) client.removeListener("error", owner.onError);
      observedClients.clear();
      const combined = failure?.error;
      expect(combined).toBeInstanceOf(AggregateError);
      if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure");
      expect(combined.cause).toBe(bodyError);
      expect(combined.errors[0]).toBe(bodyError);
      const cleanup: unknown = combined.errors[1];
      expect(cleanup).toBeInstanceOf(AggregateError);
      if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failures");
      expect(holderError).toBeDefined();
      if (!holderError) throw new Error("Missing participant failure");
      expect(holderError.value).toBe(lateParticipant);
      expect(observedClients.size).toBe(0);
      for (const diagnostic of diagnostics) {
        expect(diagnostic.error).toBeInstanceOf(Error);
        if (diagnostic.error === preCancel) {
          expect(injectPreCancel).toBe(true);
          expect(diagnostic.released).toBe(false);
          expect(diagnostic.cancelled).toBe(false);
          expect(diagnostic.operation).toBe("holder");
        } else if (diagnostic.error === postCancel) {
          expect(diagnostic.released).toBe(true);
          expect(injectPostCancel).toBe(true);
          expect(diagnostic.cancelled).toBe(true);
          expect(diagnostic.operation).toBe("holder");
          expect(isOwnedPgClosure(diagnostic.error)).toBe(false);
        } else {
          expect(diagnostic.cancelled).toBe(true);
          expect(isOwnedPgClosure(diagnostic.error)).toBe(true);
          expect(["holder", "contender"]).toContain(diagnostic.operation);
          if (diagnostic.operation === "holder") expect(diagnostic.error).toBe(holderError.value);
          else expect(diagnostic.error).toBe(contenderError?.value);
        }
      }
      if (!contenderError) throw new Error("Missing contender failure");
      expect(contenderError.generation).toBeDefined();
      expect(isOwnedPgClosure(contenderError.value)).toBe(true);
      expect(contenderError.cancellationRequested).toBe(true);
      expect(diagnostics.filter((entry) => entry.error === preCancel)).toHaveLength(injectPreCancel ? 1 : 0);
      expect(diagnostics.filter((entry) => entry.error === postCancel)).toHaveLength(injectPostCancel ? 1 : 0);
      if (releaseCallbackFailure) expect(releaseCallbackFailure.value).toBe(postCancel);
      const expectedErrors = [
        ...diagnostics.flatMap((entry) =>
          entry.error === postCancel && releaseCallbackFailure
            ? [entry.error, releaseCallbackFailure.value]
            : [entry.error],
        ),
        holderError.value,
        contenderError.value,
      ];
      expect(combined.errors).toHaveLength(2);
      expect(cleanup.errors).toHaveLength(expectedErrors.length);
      for (let i = 0; i < expectedErrors.length; i++) expect(cleanup.errors[i]).toBe(expectedErrors[i]);
      expect(cleanup.cause).toBe(expectedErrors[0]);

      expect(holderSettled).toBe(true);
      expect(contenderSettled).toBe(true);
      expect(runtime.ended).toBe(true);
      expect(runtime.totalCount).toBe(0);
      expect(runtime.waitingCount).toBe(0);
      expect(runtime.listenerCount("acquire")).toBe(0);
      expect(runtime.listenerCount("release")).toBe(0);
      expect((await createChokePoint(pool).getItem(inboxId, itemId))?.properties.text).toBe("cleanup source");
    },
    20000,
  );

  it.each([false, true])(
    "settles confirm and a shared-blob purge in both orders, purge first: %s",
    async (purgeFirst) => {
      const source = await inboxItemWithCard("Confirm shared photo");
      const trashed = await plainInboxItem("Purge shared photo");
      const blobId = await newBlob("image/jpeg");
      const attachment = await attach(source.inboxItemId, blobId);
      await attach(trashed, blobId);
      await storeSteps(source.cardId, [taskPrimary(), fileStep(attachment)]);
      await createChokePoint(pool).softDeleteItem(inboxId, trashed);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let purgePid: number | undefined;
      let confirmPid: number | undefined;
      let purgeAttempted = false;
      let confirmAttempted = false;
      let purgeReady = () => {};
      let confirmReady = () => {};
      let releasePurge = () => {};
      let releaseConfirm = () => {};
      const purgeAtBlob = new Promise<void>((resolve) => {
        purgeReady = resolve;
      });
      const confirmAtBlob = new Promise<void>((resolve) => {
        confirmReady = resolve;
      });
      const purgeGate = new Promise<void>((resolve) => {
        releasePurge = resolve;
      });
      const confirmGate = new Promise<void>((resolve) => {
        releaseConfirm = resolve;
      });
      const owned = ownOverlap(runtime, () => {
        releasePurge();
        releaseConfirm();
        purgeReady();
        confirmReady();
      });
      const observed = new Proxy(runtime, {
        get(target, key, receiver) {
          if (key !== "connect") {
            const value: unknown = Reflect.get(target, key, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, prop, innerReceiver) {
                if (prop !== "query") {
                  const value: unknown = Reflect.get(connection, prop, innerReceiver);
                  return typeof value === "function" ? value.bind(connection) : value;
                }
                return async (...args: unknown[]) => {
                  const sql = typeof args[0] === "string" ? args[0] : "";
                  const match = sql.includes("FROM blobs WHERE") && sql.includes("FOR UPDATE");
                  if (match) {
                    if (Array.isArray(args[1]) && args[1][0] === blobId) purgeAttempted = true;
                    purgePid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                    if (!purgeFirst) purgeReady();
                  }
                  const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                  if (sql.trim().toUpperCase() === "BEGIN")
                    await connection.query("SET LOCAL statement_timeout = '5s'");
                  if (match && purgeFirst) {
                    purgeReady();
                    await purgeGate;
                  }
                  return result;
                };
              },
            });
          };
        },
      });
      const pending: {
        purge?: Promise<{ purgedItemIds: string[]; blobStorageKeys: string[] }>;
        confirm?: Promise<ItemRow>;
      } = {};
      const startPurge = () => {
        pending.purge = owned.run(() =>
          runInTenant(getTenantZeroId(), () =>
            createChokePoint(observed).purgeExpiredTrashSubtree(trashed, new Date(Date.now() + 60_000)),
          ),
        );
        pending.purge.catch(() => {});
        return pending.purge;
      };
      const startConfirm = () => {
        pending.confirm = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            await client.query("SET LOCAL statement_timeout = '5s'");
            confirmPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            if (purgeFirst) confirmReady();
            const restore = observeResourceAttempt(client, { kind: "blob", id: blobId }, () => {
              confirmAttempted = true;
            });
            try {
              const result = await confirmProposalWithClient(
                client,
                { processingProposalsDatabaseId: proposalsId },
                source.cardId,
              );
              if (!purgeFirst) {
                confirmReady();
                await confirmGate;
              }
              return result;
            } finally {
              restore();
            }
          }),
        );
        pending.confirm.catch(() => {});
        return pending.confirm;
      };
      let failure: { error: unknown } | undefined;
      try {
        if (purgeFirst) {
          const purge = startPurge();
          await owned.wait(purgeAtBlob, purge);
          const confirm = startConfirm();
          await owned.wait(confirmAtBlob, purge, confirm);
        } else {
          const confirm = startConfirm();
          await owned.wait(confirmAtBlob, confirm);
          const purge = startPurge();
          await owned.wait(purgeAtBlob, confirm, purge);
        }
        if (!purgePid || !confirmPid) throw new Error("Missing competing backend PID");
        const actualPurgePid = purgePid;
        const actualConfirmPid = confirmPid;
        const purge = pending.purge;
        const confirmRun = pending.confirm;
        if (!purge || !confirmRun) throw new Error("Both operations must start");
        await owned.wait(
          owned.run(() =>
            assertResourceHeld({ kind: "blob", id: blobId }, purgeFirst ? actualPurgePid : actualConfirmPid, runtime),
          ),
          purge,
          confirmRun,
        );
        await owned.wait(
          owned.run(() =>
            waitForBlockingPid(
              purgeFirst ? actualPurgePid : actualConfirmPid,
              purgeFirst ? actualConfirmPid : actualPurgePid,
              runtime,
            ),
          ),
          purge,
          confirmRun,
        );
        await owned.wait(
          owned.run(() =>
            waitForResourceWait(
              { kind: "blob", id: blobId },
              purgeFirst ? actualPurgePid : actualConfirmPid,
              purgeFirst ? actualConfirmPid : actualPurgePid,
              runtime,
            ),
          ),
          purge,
          confirmRun,
        );
        expect(purgeFirst ? confirmAttempted : purgeAttempted).toBe(true);
        releasePurge();
        releaseConfirm();
        const [purgeResult, confirmResult] = await bounded(Promise.all([purge, confirmRun]));
        expect(purgeResult.purgedItemIds).toContain(trashed);
        expect(purgeResult.blobStorageKeys).toEqual([]);
        expect(confirmResult.properties.status).toBe("confirmed");
        expect(await filesItemsFor(blobId)).toHaveLength(1);
        expect(await attachmentCount(source.inboxItemId)).toBe(0);
        expect(await withTransaction(pool, (client) => getBlob(client, blobId))).not.toBeNull();
      } catch (error) {
        failure = { error };
      } finally {
        releasePurge();
        releaseConfirm();
        try {
          await owned.finish(failure !== undefined);
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
      }
      if (failure !== undefined) rethrowOverlap(failure.error);
    },
    20000,
  );
});
