import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { runOnce, CORE_TASK_NAMES } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
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
import {
  insertInboxAttachments,
  listInboxAttachments,
  recordInboxAttachmentMetadata,
} from "../inbox/inboxAttachmentsStore.js";
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

// Confirming a `fileFromAttachment` step moves an Inbox attachment into Files, through the real confirm
// path. Every envelope has a Task as its primary step: a file step is never primary.

const dayRecomputeJobSchema = z.object({ payload: z.object({ journalDayItemId: z.string() }) });

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let inboxId: string;
let typesId: string;
let proposalsId: string;
let filesId: string;
let tasksId: string;
let projectsId: string;
let taskType: ItemRow;

function ownOverlap(runtime: Pool, cancel: () => void) {
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
  const onClientError = (error: Error) => errors.push(error);
  const destroy = (client: PoolClient, token: object) => {
    if (active.get(client) !== token) return;
    try {
      destroyed.add(token);
      client.release(true);
    } catch (error) {
      errors.push(error);
    }
  };
  const onAcquire = (client: PoolClient) => {
    const token = {};
    active.set(client, token);
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
  return { run, wait, finish, consume };
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
  throw error;
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

async function journalDayIdOf(inboxItemId: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    const property = await propertiesStore.getPropertyByKey(client, inboxId, "journalDay");
    const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property!.id);
    const [edge] = await relationsStore.listRelationsForItem(client, definition!.id, inboxItemId);
    return relationsStore.otherSide(edge!, inboxItemId);
  });
}

/** The Journal days with a pending recompute job, read from the job payloads. */
async function pendingDayRecomputes(): Promise<string[]> {
  const payloads = await readJobPayloadsByIdentifier(pool, CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE);
  return payloads.flatMap((raw) => {
    const parsed = dayRecomputeJobSchema.safeParse(raw);
    return parsed.success ? [parsed.data.payload.journalDayItemId] : [];
  });
}

async function clearDayRecomputes(): Promise<void> {
  await pool.query(
    `DELETE FROM graphile_worker._private_jobs
     WHERE task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = $1)`,
    [CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE],
  );
}

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

const brokenStep: ProposalStep = {
  // A wrong value type passes envelope validation and fails only in the choke point's write, after the move ran.
  ref: "broken",
  op: "create",
  databaseKey: "tasks",
  role: "secondary",
  properties: { name: 42 },
};

const executeSteps = (steps: ProposalStep[], sourceInboxItemId: string | null) =>
  withTransaction(pool, (client) =>
    executeProposalSteps(client, steps, { writer: { writerKind: "user" }, sourceInboxItemId }),
  );

const confirmIn = (cardId: string) => (client: PoolClient) =>
  confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId);

async function cardWithAttachment(text: string, mimeType: string) {
  const { inboxItemId, cardId } = await inboxItemWithCard(text);
  const blobId = await newBlob(mimeType);
  return { inboxItemId, cardId, blobId, attachmentId: await attach(inboxItemId, blobId) };
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
    const { inboxItemId, cardId, blobId, attachmentId } = await cardWithAttachment(
      "Scan of the contract",
      "image/jpeg",
    );
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

  it("returns the moved attachment and the created Files item in the step result and enqueues the recompute of the Inbox item's Journal day", async () => {
    const inboxItemId = await plainInboxItem("Receipt");
    const dayId = await journalDayIdOf(inboxItemId);
    const blobId = await newBlob("application/pdf");
    const attachmentId = await attach(inboxItemId, blobId);
    await clearDayRecomputes();

    const executed = await executeSteps([taskPrimary(), fileStep(attachmentId)], inboxItemId);

    const [files] = await filesItemsFor(blobId);
    expect(files!.properties).toMatchObject({ type: "pdf" });
    expect(executed.fileFromAttachments).toEqual([
      { ref: "file", fileItemId: files!.id, movedAttachmentId: attachmentId, created: true },
    ]);
    expect(executed.createdItemIds).toContain(files!.id);
    expect(executed.primaryItemId).not.toBe(files!.id);
    expect(await attachmentCount(inboxItemId)).toBe(0);
    expect(await pendingDayRecomputes()).toContain(dayId);
  });

  it("resolves to the Files item that already names the blob: no second item, that item unchanged, no origin row, created false", async () => {
    const source = await plainInboxItem("Existing photo");
    const blobId = await newBlob("image/jpeg");
    const existingId = await createIn(filesId, { name: "Existing", file: { blobId } });
    const before = await pool.query("SELECT properties, updated_at FROM items WHERE id = $1", [existingId]);
    const attachmentId = await attach(source, blobId);

    const result = await executeSteps([taskPrimary(), fileStep(attachmentId)], source);

    expect(result.fileFromAttachments).toEqual([
      { ref: "file", fileItemId: existingId, movedAttachmentId: attachmentId, created: false },
    ]);
    expect(result.createdItemIds).not.toContain(existingId);
    expect(await filesItemsFor(blobId)).toHaveLength(1);
    const after = await pool.query("SELECT properties, updated_at FROM items WHERE id = $1", [existingId]);
    expect(after.rows).toEqual(before.rows);
    expect(await originRowsFor(existingId)).toEqual([]);
    expect(await attachmentCount(source)).toBe(0);
  });

  it.each([
    ["a mime type with no Files type", null, "application/zip"],
    // The Files `type` select of an older tenant has no `png` option.
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
    // A raw update, because no route can produce a Files `type` select in these shapes.
    if (sql) await pool.query(sql, [filesId]);
    const { cardId, blobId, attachmentId } = await cardWithAttachment("Photo", mimeType);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);

    await confirm(cardId);

    const [fileItem] = await filesItemsFor(blobId);
    expect(fileItem!.properties).not.toHaveProperty("type");
    expect(fileItem!.properties).toMatchObject({ name: "Scan", file: { blobId } });
  });

  it.each([
    ["another Inbox item's attachment", "foreign"],
    ["an attachment id that does not exist", "unknown"],
  ] as const)("refuses %s with 400 and writes nothing", async (_label, kind) => {
    const { cardId } = await inboxItemWithCard("Scan");
    const blobId = await newBlob("image/jpeg");
    const attachmentId =
      kind === "foreign" ? await attach(await plainInboxItem("Someone else's scan"), blobId) : randomUUID();
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

    await expect(executeSteps([taskPrimary(), fileStep(attachmentId)], null)).rejects.toMatchObject({
      status: 400,
      details: { ref: "file", field: "attachmentId" },
    });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentCount(inboxItemId)).toBe(1);
  });

  it.each<[string, (attachmentId: string, blobId: string) => Partial<ProposalStep>, Record<string, unknown>]>([
    [
      "a file property",
      (attachmentId, blobId) => ({ properties: { attachmentId, name: "Scan", file: { blobId } } }),
      {},
    ],
    ["a type", (attachmentId) => ({ properties: { attachmentId, name: "Scan", type: "jpg" } }), {}],
    ["an unrelated property", (attachmentId) => ({ properties: { attachmentId, name: "Scan", untrusted: true } }), {}],
    ["an empty name", (attachmentId) => ({ properties: { attachmentId, name: "   " } }), {}],
    ["no attachment", () => ({ properties: { name: "Scan" } }), {}],
    ["an attachment id that is not a UUID", () => ({ properties: { attachmentId: "not-a-uuid", name: "Scan" } }), {}],
    ["a database key", () => ({ databaseKey: "tasks" }), {}],
    ["an item id", () => ({ itemId: randomUUID() }), {}],
    ["a relation that is not a relation property", () => ({ relations: { name: [randomUUID()] } }), {}],
    ["the primary role", () => ({ role: "primary" }), { details: { ref: "file", field: "op" } }],
  ])("refuses a step with %s with 400 and writes nothing", async (_label, override, error) => {
    const { inboxItemId, cardId, blobId, attachmentId } = await cardWithAttachment("Scan", "image/jpeg");
    const file = fileStep(attachmentId, override(attachmentId, blobId));
    // A file step as the primary step is the whole envelope: it is never primary next to a Task.
    await storeSteps(cardId, file.role === "primary" ? [file] : [taskPrimary(), file]);

    await expect(confirm(cardId)).rejects.toMatchObject({ status: 400, code: "validation_failed", ...error });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentCount(inboxItemId)).toBe(1);
    expect(await cardStatus(cardId)).toBe("proposed");
  });

  it("reports a missing Files database as not found and writes nothing", async () => {
    const inboxItemId = await plainInboxItem("Receipt");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    // A raw update inside the rolled-back transaction: the seed always creates the Files database.
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

  it("rolls the move back when a later step fails: no Files item, no Task, no day recompute, the attachment stays, the card stays proposed", async () => {
    const { inboxItemId, cardId, blobId, attachmentId } = await cardWithAttachment("Scan and task", "image/jpeg");
    const blobsBefore = await blobCount();
    const tasksBefore = await countItems(tasksId);
    await clearDayRecomputes();
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId), brokenStep]);

    await expect(confirm(cardId)).rejects.toMatchObject({ status: 400, details: { ref: "broken" } });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentCount(inboxItemId)).toBe(1);
    expect(await blobCount()).toBe(blobsBefore);
    expect(await countItems(tasksId)).toBe(tasksBefore);
    expect(await cardStatus(cardId)).toBe("proposed");
    expect(await pendingDayRecomputes()).toEqual([]);
  });

  it("an audio attachment filed by confirm enqueues no transcription, while an audio file made in Files directly is transcribed", async () => {
    const { cardId, blobId, attachmentId } = await cardWithAttachment("Voice note", "audio/mpeg");
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);
    await confirm(cardId);
    const [fileItem] = await filesItemsFor(blobId);

    const emailsId = await databaseIdFor("emails");
    const attachmentsProperty = await withTransaction(pool, (client) =>
      propertiesStore.getPropertyByKey(client, emailsId, "attachments"),
    );
    const eventsProperty = await withTransaction(pool, (client) =>
      propertiesStore.getPropertyByKey(client, filesId, "events"),
    );
    const handler = createFilesTranscriptionTriggerAction(pool);
    const config = {
      filesDatabaseId: filesId,
      attachmentsRelationPropertyId: attachmentsProperty!.id,
      eventsRelationPropertyId: eventsProperty!.id,
    };
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
      const { cardId, blobId, attachmentId } = await cardWithAttachment("Voice note", "audio/mpeg");
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

  describe("the preview and the reduced copy of the moved attachment (issue gh-1965)", () => {
    /**
     * A card whose Inbox item has a photo attachment with a run metadata job: two derived blobs, written under a
     * temporary directory. `env` is stubbed for the duration of `body`.
     */
    async function withDerivedPhoto(
      text: string,
      env: (directory: string) => Record<string, string>,
      steps: (attachmentId: string) => ProposalStep[],
      body: (photo: { cardId: string; blobId: string; keys: string[]; directory: string }) => Promise<void>,
    ): Promise<void> {
      const directory = await mkdtemp(join(tmpdir(), "semprec-move-derived-"));
      for (const [name, value] of Object.entries(env(directory))) vi.stubEnv(name, value);
      try {
        const { inboxItemId, cardId } = await inboxItemWithCard(text);
        const storage = new LocalFsBlobStorageWriter(directory);
        const keys = [
          `t/inbox-attachments/${randomUUID()}-preview.jpg`,
          `t/inbox-attachments/${randomUUID()}-reduced.jpg`,
        ];
        for (const key of keys) await storage.writeStream(key, Readable.from([Buffer.from(key)]));
        const blobId = await newBlob("image/jpeg");
        const attachmentId = await attach(inboxItemId, blobId);
        const image = (storageKey: string) => ({
          mimeType: "image/jpeg",
          byteSize: storageKey.length,
          storageKey,
          contentHash: Buffer.from(storageKey).toString("hex").slice(-64).padStart(64, "0"),
        });
        await withTransaction(pool, (client) =>
          recordInboxAttachmentMetadata(client, {
            attachmentId,
            metadata: { width: 10, height: 10, pages: null },
            thumbnail: image(keys[0]!),
            reduced: image(keys[1]!),
          }),
        );
        await storeSteps(cardId, steps(attachmentId));
        await body({ cardId, blobId, keys, directory });
      } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    }

    const derivedFiles = (directory: string) => readdir(join(directory, "t", "inbox-attachments"));

    it("frees both derived blobs when the attachment is filed, and removes their bytes once the confirm commits", async () => {
      await withDerivedPhoto(
        "Move photo",
        (directory) => ({ FILES_STORAGE_DIR: directory }),
        (attachmentId) => [taskPrimary(), fileStep(attachmentId)],
        async ({ cardId, blobId, directory }) => {
          const blobsBefore = await blobCount();
          await confirm(cardId);
          expect(await blobCount()).toBe(blobsBefore - 2);
          expect(await withTransaction(pool, (client) => getBlob(client, blobId))).not.toBeNull();
          expect(await filesItemsFor(blobId)).toHaveLength(1);
          await vi.waitFor(async () => expect(await derivedFiles(directory)).toEqual([]));
        },
      );
    });

    it("keeps the derived blobs and their bytes when the confirm rolls back after the move", async () => {
      await withDerivedPhoto(
        "Move photo, then fail",
        (directory) => ({ FILES_STORAGE_DIR: directory }),
        (attachmentId) => [taskPrimary(), fileStep(attachmentId), brokenStep],
        async ({ cardId, keys, directory }) => {
          const blobsBefore = await blobCount();
          await expect(confirm(cardId)).rejects.toMatchObject({ status: 400, details: { ref: "broken" } });
          expect(await blobCount()).toBe(blobsBefore);
          expect((await derivedFiles(directory)).sort()).toEqual(keys.map((key) => key.split("/")[2]!).sort());
        },
      );
    });

    it("leaves the bytes where they are, and logs, when no blob storage is configured", async () => {
      await withDerivedPhoto(
        "Move photo, no storage",
        () => ({ NODE_ENV: "production", FILES_STORAGE_DIR: "" }),
        (attachmentId) => [taskPrimary(), fileStep(attachmentId)],
        async ({ cardId, directory }) => {
          const blobsBefore = await blobCount();
          const confirmed = await confirm(cardId);
          expect(confirmed.properties.status).toBe("confirmed");
          expect(await blobCount()).toBe(blobsBefore - 2);
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(await derivedFiles(directory)).toHaveLength(2);
        },
      );
    });
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

  it.each([false, true])(
    "two confirms that file the same bytes make one Files item: the second waits for the blob lock (holder rolls back: %s)",
    async (rollbackFirst) => {
      const first = await inboxItemWithCard("First scan");
      const second = await inboxItemWithCard("Second scan");
      const blobId = await newBlob("image/jpeg");
      await storeSteps(first.cardId, [taskPrimary("First task"), fileStep(await attach(first.inboxItemId, blobId))]);
      await storeSteps(second.cardId, [taskPrimary("Second task"), fileStep(await attach(second.inboxItemId, blobId))]);

      const outcome = await runHeldBlobOverlap(
        confirmIn(first.cardId),
        confirmIn(second.cardId),
        { kind: "blob", id: blobId },
        rollbackFirst,
      );
      if (!("value" in outcome)) throw outcome.error;
      expect(outcome.value.properties.status).toBe("confirmed");

      const files = await filesItemsFor(blobId);
      expect(files).toHaveLength(1);
      const owner = rollbackFirst ? second : first;
      expect(await originRowsFor(files[0]!.id)).toEqual([
        {
          item_id: files[0]!.id,
          proposal_id: owner.cardId,
          inbox_item_id: owner.inboxItemId,
          capture_channel: "inbox",
        },
      ]);
      expect(await attachmentCount(first.inboxItemId)).toBe(rollbackFirst ? 1 : 0);
      expect(await attachmentCount(second.inboxItemId)).toBe(0);
      expect((await createChokePoint(pool).getItem(proposalsId, first.cardId))?.properties.status).toBe(
        rollbackFirst ? "proposed" : "confirmed",
      );
    },
  );

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
              const result = await confirmIn(source.cardId)(client);
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
        const [purgeResult, confirmResult] = await overlapBounded(Promise.all([purge, confirmRun]), 5000);
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
