import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runOnce } from "@semprec/queue";
import { AiGatewayFailedError, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createActionRegistry, type ActionRegistry } from "../scheduler/actions.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import {
  createSemprecTickAction,
  semprecTickActionConfigSchema,
  SEMPREC_TICK_ACTION_ID,
  SEMPREC_TICK_QUEUE_NAME,
  type ComputeSemprecProposalFn,
} from "../inbox/inboxTickAction.js";
import { createCoreTaskList } from "../worker.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let chokePoint: ChokePoint;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

interface TickJobRow {
  key: string;
  queue_name: string | null;
  // Issue #167: `enqueueJob` wraps every job payload in a `{ traceId, payload }` envelope before
  // it reaches `graphile_worker`'s own `jobs` table.
  payload: { traceId: string; payload: { heartbeatId: string; itemId: string } };
}

async function pendingTickJobs(): Promise<TickJobRow[]> {
  const { rows } = await pool.query<TickJobRow>(
    `SELECT j.key, jq.queue_name, j.payload
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     LEFT JOIN graphile_worker._private_job_queues jq ON jq.id = j.job_queue_id
     WHERE t.identifier = 'heartbeatFireCore'`,
  );
  return rows;
}

async function drainQueue(registry: ActionRegistry = createActionRegistry()): Promise<void> {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, registry) });
}

/** These dispatch-only tests never exercise a recognized-type item, so this is never actually invoked. */
const unusedComputeProposal: ComputeSemprecProposalFn = async () => {
  throw new Error("computeProposal should not be called by these tests");
};

function countingTickRegistry(calls: string[]): ActionRegistry {
  const registry = createActionRegistry();
  const real = createSemprecTickAction(pool, unusedComputeProposal);
  registry.set(SEMPREC_TICK_ACTION_ID, async (actionConfig, context) => {
    calls.push(context.itemId!);
    await real(actionConfig, context);
  });
  return registry;
}

/** Captures the item state the tick action actually observed, mirroring createSemprecTickAction's own re-read. */
function capturingTickRegistry(captured: Array<Record<string, unknown> | null>): ActionRegistry {
  const registry = createActionRegistry();
  registry.set(SEMPREC_TICK_ACTION_ID, async (actionConfig, context) => {
    const config = semprecTickActionConfigSchema.parse(actionConfig);
    await withTransaction(pool, async (client) => {
      const item = await itemsStore.getItemById(client, config.inboxDatabaseId, context.itemId!);
      captured.push(item ? item.properties : null);
    });
  });
  return registry;
}

describe("Inbox item event dispatch (issue #103)", () => {
  let retryRuntimePool: Pool | undefined;

  afterEach(async () => {
    await retryRuntimePool?.end();
    retryRuntimePool = undefined;
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    chokePoint = createChokePoint(pool, undefined, viewTypeRegistry);
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createItem(inboxId: string, overrides: Partial<{ text: string }> = {}) {
    return withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        ...overrides,
      }),
    );
  }

  it("registers one onItemEvent heartbeat per create/update/delete, all dispatching semprec.tick", async () => {
    const inboxId = await databaseIdFor("inbox");
    const { rows } = await pool.query<{ rule: { event: string }; action_id: string }>(
      `SELECT rule, action_id FROM project_heartbeats WHERE rule ->> 'databaseId' = $1`,
      [inboxId],
    );
    expect(rows.map((r) => r.rule.event).sort()).toEqual(["create", "delete", "update"]);
    for (const row of rows) expect(row.action_id).toBe(SEMPREC_TICK_ACTION_ID);
  });

  it("create enqueues a heartbeat-fire job scoped to that item, transactionally", async () => {
    const inboxId = await databaseIdFor("inbox");
    const item = await createItem(inboxId);

    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.payload.itemId).toBe(item.id);
    expect(jobs[0]!.key.endsWith(`:${item.id}`)).toBe(true);
  });

  it("update and delete each enqueue their own item-scoped job, never colliding with create's", async () => {
    const inboxId = await databaseIdFor("inbox");
    const item = await createItem(inboxId);

    await chokePoint.updateItem({ databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "edited" } });
    const afterUpdate = await pendingTickJobs();
    expect(afterUpdate).toHaveLength(2); // create's pending job plus update's

    await chokePoint.softDeleteItem(inboxId, item.id);
    const afterDelete = await pendingTickJobs();
    expect(afterDelete).toHaveLength(3); // + delete's own job
    expect(new Set(afterDelete.map((j) => j.key)).size).toBe(3);
  });

  it("rapid pending updates on the same item collapse into a single job that reads the latest state", async () => {
    const inboxId = await databaseIdFor("inbox");
    const item = await inTenantZero(() => createItem(inboxId));

    await inTenantZero(() =>
      chokePoint.updateItem({ databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "first edit" } }),
    );
    await inTenantZero(() =>
      chokePoint.updateItem({ databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "second edit" } }),
    );
    await inTenantZero(() =>
      chokePoint.updateItem({ databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "third edit" } }),
    );

    // Exactly one create job + one update job pending, never three separate update jobs.
    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(2);

    const captured: Array<Record<string, unknown> | null> = [];
    await drainQueue(capturingTickRegistry(captured));

    const updateCapture = captured.find((c) => c?.text === "third edit");
    expect(updateCapture).toBeTruthy();
    expect(captured.some((c) => c?.text === "first edit" || c?.text === "second edit")).toBe(false);
  });

  it("different Inbox items never deduplicate each other", async () => {
    const inboxId = await databaseIdFor("inbox");
    const itemA = await inTenantZero(() => createItem(inboxId));
    const itemB = await inTenantZero(() => createItem(inboxId));

    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.key)).size).toBe(2);

    const calls: string[] = [];
    await drainQueue(countingTickRegistry(calls));
    expect(calls.sort()).toEqual([itemA.id, itemB.id].sort());
  });

  it("a rolled-back item mutation emits no job", async () => {
    const inboxId = await databaseIdFor("inbox");

    const rollback = new Error("Deliberate rollback");
    await expect(
      inTenantZero(() =>
        withTransaction(pool, async (client) => {
          await createInboxItemWithClient(client, {
            inboxDatabaseId: inboxId,
            date: "2026-08-28",
            time: "09:00",
          });
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);

    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(0);
  });

  it("inside a tenant scope the tick job lands on the tenant's semprec-tick lane", async () => {
    const inboxId = await databaseIdFor("inbox");
    const tenantZero = getTenantZeroId();

    await runInTenant(tenantZero, () => createItem(inboxId));

    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.queue_name).toBe(`${SEMPREC_TICK_QUEUE_NAME}:${tenantZero}`);
  });

  it("routes the heartbeat-fire job to the queue affinity registered for the semprec.tick handler", async () => {
    const inboxId = await databaseIdFor("inbox");
    const queueAffinity = new Map([[SEMPREC_TICK_ACTION_ID, SEMPREC_TICK_QUEUE_NAME]]);

    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        queueAffinity,
      }),
    );

    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.payload.itemId).toBe(item.id);
    expect(jobs[0]!.queue_name).toBe(SEMPREC_TICK_QUEUE_NAME);
  });

  it("with no queue affinity supplied, the job runs on the production semprec-tick queue", async () => {
    const inboxId = await databaseIdFor("inbox");
    await createItem(inboxId);

    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.queue_name).toBe(SEMPREC_TICK_QUEUE_NAME);
  });

  it("createChokePoint(pool) with defaults routes update and delete ticks to semprec-tick", async () => {
    const inboxId = await databaseIdFor("inbox");
    const defaultChokePoint = createChokePoint(pool, undefined, viewTypeRegistry);
    const item = await createItem(inboxId);

    await defaultChokePoint.updateItem({
      databaseId: inboxId,
      itemId: item.id,
      propertiesPatch: { text: "edited" },
    });
    const afterUpdate = await pendingTickJobs();
    expect(afterUpdate).toHaveLength(2);
    expect(afterUpdate.every((j) => j.queue_name === SEMPREC_TICK_QUEUE_NAME)).toBe(true);

    await defaultChokePoint.softDeleteItem(inboxId, item.id);
    const afterDelete = await pendingTickJobs();
    expect(afterDelete).toHaveLength(3);
    expect(afterDelete.every((j) => j.queue_name === SEMPREC_TICK_QUEUE_NAME)).toBe(true);
  });

  it("rejects a misconfigured heartbeat instead of silently no-op'ing", async () => {
    const handler = createSemprecTickAction(pool, unusedComputeProposal);
    await expect(handler({}, { heartbeatId: "hb", projectItemId: "proj", itemId: "item" })).rejects.toThrow();
    await expect(
      handler({ inboxDatabaseId: "not-a-uuid" }, { heartbeatId: "hb", projectItemId: "proj", itemId: "item" }),
    ).rejects.toThrow();
  });

  it("capturingTickRegistry's handler rejects a malformed actionConfig exactly like production", async () => {
    const handler = capturingTickRegistry([]).get(SEMPREC_TICK_ACTION_ID)!;
    await expect(handler({}, { heartbeatId: "hb", projectItemId: "proj", itemId: "item" })).rejects.toThrow();
    await expect(
      handler({ inboxDatabaseId: "not-a-uuid" }, { heartbeatId: "hb", projectItemId: "proj", itemId: "item" }),
    ).rejects.toThrow();
  });

  it("routes the update and soft-delete paths' heartbeat-fire jobs to the same queue affinity as create", async () => {
    const inboxId = await databaseIdFor("inbox");
    const queueAffinity = new Map([[SEMPREC_TICK_ACTION_ID, SEMPREC_TICK_QUEUE_NAME]]);
    const affinitizedChokePoint = createChokePoint(pool, undefined, viewTypeRegistry, queueAffinity);

    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        queueAffinity,
      }),
    );

    await affinitizedChokePoint.updateItem({
      databaseId: inboxId,
      itemId: item.id,
      propertiesPatch: { text: "edited" },
    });
    const afterUpdate = await pendingTickJobs();
    expect(afterUpdate).toHaveLength(2); // create's pending job plus update's
    expect(afterUpdate.every((j) => j.queue_name === SEMPREC_TICK_QUEUE_NAME)).toBe(true);

    await affinitizedChokePoint.softDeleteItem(inboxId, item.id);
    const afterDelete = await pendingTickJobs();
    expect(afterDelete).toHaveLength(3);
    expect(afterDelete.every((j) => j.queue_name === SEMPREC_TICK_QUEUE_NAME)).toBe(true);
  });

  it("retries two timeouts and records a failure card on the third worker attempt (issue #1485)", async () => {
    const inboxId = await databaseIdFor("inbox");
    const typesId = await databaseIdFor("inboxItemTypes");
    const proposalsId = await databaseIdFor("processingProposals");
    const type = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      ),
    );
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          date: "2026-08-28",
          time: "09:00",
          text: "Buy milk",
          type: type.id,
        }),
      ),
    );

    retryRuntimePool = await createRuntimeRolePool(pool, "semprec_data");
    const runtime = retryRuntimePool;
    const role = await runtime.query<{ name: string; bypass: boolean; superuser: boolean }>(
      "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
    const registry = createActionRegistry();
    registry.set(
      SEMPREC_TICK_ACTION_ID,
      createSemprecTickAction(runtime, async () => {
        throw new AiGatewayFailedError("timeout");
      }),
    );
    await runOnce({ pgPool: pool, taskList: createCoreTaskList(runtime, registry) });

    // Attempt 1 of 3 is not final, so the tick rethrows and graphile-worker keeps the job for a retry.
    const { rows: jobs } = await pool.query<{ key: string; attempts: number; last_error: string | null }>(
      `SELECT j.key, j.attempts, j.last_error
       FROM graphile_worker._private_jobs j
       JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = 'heartbeatFireCore'`,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.attempts).toBe(1);
    expect(jobs[0]!.last_error).toContain("AI gateway call failed: timeout");

    const { rows: cards } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM items WHERE database_id = $1",
      [proposalsId],
    );
    expect(cards[0]!.n).toBe(0);

    // Advance only this test's pending job; Graphile's backoff would otherwise delay the retry.
    await pool.query("UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = $1", [jobs[0]!.key]);
    await runOnce({ pgPool: pool, taskList: createCoreTaskList(runtime, registry) });
    const second = await pool.query<{ attempts: number; last_error: string | null }>(
      `SELECT attempts, last_error FROM graphile_worker._private_jobs WHERE key = $1`,
      [jobs[0]!.key],
    );
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]).toMatchObject({ attempts: 2 });
    expect(second.rows[0]!.last_error).toContain("AI gateway call failed: timeout");
    const afterSecond = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      proposalsId,
    ]);
    expect(afterSecond.rows[0]!.n).toBe(0);

    await pool.query("UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = $1", [jobs[0]!.key]);
    await runOnce({ pgPool: pool, taskList: createCoreTaskList(runtime, registry) });
    const final = await pool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [proposalsId],
    );
    expect(final.rows).toHaveLength(1);
    expect(final.rows[0]!.properties).toMatchObject({ status: "computeFailed" });
    expect(final.rows[0]!.properties.history).toEqual([
      expect.objectContaining({ message: "Computing the proposal failed: timeout." }),
    ]);
    const completed = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = $1",
      [jobs[0]!.key],
    );
    expect(completed.rows[0]!.n).toBe(0);
  });

  // Restoring an Inbox item is a change of it: its `update` heartbeat re-runs the tick (issue #1604).
  function tickRegistry(compute: ComputeSemprecProposalFn): ActionRegistry {
    const registry = createActionRegistry();
    registry.set(SEMPREC_TICK_ACTION_ID, createSemprecTickAction(pool, compute));
    return registry;
  }

  /** Records each source it is asked to recompute, then fails the test by throwing. */
  function refusingCompute(calls: string[]): ComputeSemprecProposalFn {
    return async (input) => {
      calls.push(input.sourceItem.id);
      throw new Error("computeProposal must not be called when the source fingerprint is unchanged");
    };
  }

  /** The single live card of the Processing proposals database, read from its table. */
  async function soleCardProperties(): Promise<Record<string, unknown>> {
    const proposalsId = await databaseIdFor("processingProposals");
    const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [proposalsId],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.properties;
  }

  it("restoring a deleted Inbox item enqueues one tick, which returns its invalid card to proposed with no reason", async () => {
    const inboxId = await databaseIdFor("inbox");
    const typesId = await databaseIdFor("inboxItemTypes");
    const type = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      ),
    );
    const item = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          date: "2026-08-28",
          time: "09:00",
          text: "Buy milk",
          type: type.id,
        }),
      ),
    );
    await drainQueue(tickRegistry(async () => ({ properties: { name: "Buy milk" } })));
    expect(await soleCardProperties()).toMatchObject({ status: "proposed" });

    await inTenantZero(() => chokePoint.softDeleteItem(inboxId, item.id));
    await drainQueue(tickRegistry(refusingCompute([])));
    expect(await soleCardProperties()).toMatchObject({
      status: "invalid",
      invalidReason: { code: "sourceDeleted" },
    });

    await inTenantZero(() => chokePoint.restoreItem(inboxId, item.id));
    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.payload.itemId).toBe(item.id);

    const recomputed: string[] = [];
    await drainQueue(tickRegistry(refusingCompute(recomputed)));
    expect(recomputed).toEqual([]);
    expect(await soleCardProperties()).toMatchObject({ status: "proposed", invalidReason: null });
  });

  it("restoring an item of a database without update heartbeats enqueues no tick and restores it as before", async () => {
    const movies = await inTenantZero(() => chokePoint.createDatabase({ name: "Movies" }));
    await inTenantZero(() =>
      chokePoint.createProperty({ databaseId: movies.id, key: "title", name: "Title", type: "text" }),
    );
    const movie = await inTenantZero(() =>
      chokePoint.createItem({ databaseId: movies.id, properties: { title: "Dune" } }),
    );
    await inTenantZero(() => chokePoint.softDeleteItem(movies.id, movie.id));
    expect(await pendingTickJobs()).toHaveLength(0);

    await inTenantZero(() => chokePoint.restoreItem(movies.id, movie.id));

    expect(await pendingTickJobs()).toHaveLength(0);
    const { items } = await inTenantZero(() => chokePoint.listItems(movies.id));
    expect(items.map((row) => row.id)).toEqual([movie.id]);
  });

  it("restoring a non-Inbox item triggers only its database's update heartbeat", async () => {
    const watched = await inTenantZero(() => chokePoint.createDatabase({ name: "Watched" }));
    const other = await inTenantZero(() => chokePoint.createDatabase({ name: "Other" }));
    const { rows } = await pool.query<{ project_item_id: string }>(
      "SELECT DISTINCT project_item_id FROM project_heartbeats WHERE action_id = $1",
      [SEMPREC_TICK_ACTION_ID],
    );
    expect(rows).toHaveLength(1);
    const projectItemId = rows[0]?.project_item_id;
    if (!projectItemId) throw new Error("Seeded tick heartbeat missing");
    const [heartbeat, otherHeartbeat] = await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const create = (databaseId: string) =>
          createHeartbeat(client, {
            projectItemId,
            name: "Update",
            rule: { kind: "onItemEvent", databaseId, event: "update" },
            actionId: SEMPREC_TICK_ACTION_ID,
          });
        return [await create(watched.id), await create(other.id)] as const;
      }),
    );
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: watched.id, properties: {} }));
    await inTenantZero(() => chokePoint.softDeleteItem(watched.id, item.id));
    expect(await pendingTickJobs()).toHaveLength(0);
    await inTenantZero(() => chokePoint.restoreItem(watched.id, item.id));
    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload.payload).toMatchObject({ heartbeatId: heartbeat.id, itemId: item.id });
    expect(jobs[0]?.payload.payload.heartbeatId).not.toBe(otherHeartbeat.id);
  });
});
