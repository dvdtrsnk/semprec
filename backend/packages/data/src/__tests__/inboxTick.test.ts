import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runOnce } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createActionRegistry, type ActionRegistry } from "../scheduler/actions.js";
import { createSemprecTickAction, SEMPREC_TICK_ACTION_ID, SEMPREC_TICK_QUEUE_NAME } from "../inbox/inboxTickAction.js";
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
  payload: { heartbeatId: string; itemId: string };
}

async function pendingTickJobs(): Promise<TickJobRow[]> {
  const { rows } = await pool.query<TickJobRow>(
    `SELECT j.key, jq.queue_name, j.payload
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     LEFT JOIN graphile_worker._private_job_queues jq ON jq.id = j.job_queue_id
     WHERE t.identifier = 'heartbeatFire'`,
  );
  return rows;
}

async function drainQueue(registry: ActionRegistry = createActionRegistry()): Promise<void> {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, registry) });
}

function countingTickRegistry(calls: string[]): ActionRegistry {
  const registry = createActionRegistry();
  const real = createSemprecTickAction(pool);
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
    const config = actionConfig as { inboxDatabaseId: string };
    await withTransaction(pool, async (client) => {
      const item = await itemsStore.getItemById(client, config.inboxDatabaseId, context.itemId!);
      captured.push(item ? item.properties : null);
    });
  });
  return registry;
}

describe("Inbox item event dispatch (issue #103)", () => {
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

  async function createItem(inboxId: string, journalId: string, overrides: Partial<{ text: string }> = {}) {
    return withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
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
    const journalId = await databaseIdFor("journal");
    const item = await createItem(inboxId, journalId);

    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.itemId).toBe(item.id);
    expect(jobs[0].key.endsWith(`:${item.id}`)).toBe(true);
  });

  it("update and delete each enqueue their own item-scoped job, never colliding with create's", async () => {
    const inboxId = await databaseIdFor("inbox");
    const journalId = await databaseIdFor("journal");
    const item = await createItem(inboxId, journalId);

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
    const journalId = await databaseIdFor("journal");
    const item = await createItem(inboxId, journalId);

    await chokePoint.updateItem({ databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "first edit" } });
    await chokePoint.updateItem({ databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "second edit" } });
    await chokePoint.updateItem({ databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "third edit" } });

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
    const journalId = await databaseIdFor("journal");
    const itemA = await createItem(inboxId, journalId);
    const itemB = await createItem(inboxId, journalId);

    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.key)).size).toBe(2);

    const calls: string[] = [];
    await drainQueue(countingTickRegistry(calls));
    expect(calls.sort()).toEqual([itemA.id, itemB.id].sort());
  });

  it("a rolled-back item mutation emits no job", async () => {
    const inboxId = await databaseIdFor("inbox");
    const journalId = await databaseIdFor("journal");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(0);
  });

  it("routes the heartbeat-fire job to the queue affinity registered for the semprec.tick handler", async () => {
    const inboxId = await databaseIdFor("inbox");
    const journalId = await databaseIdFor("journal");
    const queueAffinity = new Map([[SEMPREC_TICK_ACTION_ID, SEMPREC_TICK_QUEUE_NAME]]);

    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        queueAffinity,
      }),
    );

    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.itemId).toBe(item.id);
    expect(jobs[0].queue_name).toBe(SEMPREC_TICK_QUEUE_NAME);
  });

  it("with no queue affinity supplied, the job runs unaffinitized (queue_name is null)", async () => {
    const inboxId = await databaseIdFor("inbox");
    const journalId = await databaseIdFor("journal");
    await createItem(inboxId, journalId);

    const jobs = await pendingTickJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].queue_name).toBeNull();
  });

  it("rejects a misconfigured heartbeat instead of silently no-op'ing", async () => {
    const handler = createSemprecTickAction(pool);
    await expect(handler({}, { heartbeatId: "hb", projectItemId: "proj", itemId: "item" })).rejects.toThrow();
    await expect(handler({ inboxDatabaseId: "not-a-uuid" }, { heartbeatId: "hb", projectItemId: "proj", itemId: "item" })).rejects.toThrow();
  });
});
