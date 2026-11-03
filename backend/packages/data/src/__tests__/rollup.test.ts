import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import {
  bindToTenantZero,
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { ValidationError } from "../errors.js";
import { recomputeRollupCell, rollupRecomputeFullJobKey, rollupRecomputeJobKey } from "../rollup/recompute.js";
import { withTransaction } from "../db/pool.js";
import { databaseArchiveWithClient } from "../chokePoint/databaseOps.js";

let pool: Pool;
let chokePoint: ChokePoint;

const DRAIN_PASS_LIMIT = 10;

interface DrainSteps {
  runPass: () => Promise<void>;
  countRemainingJobs: () => Promise<string | undefined>;
}

const realDrainSteps: DrainSteps = {
  runPass: () => runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, createActionRegistry()) }),
  countRemainingJobs: async () => {
    const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM graphile_worker._private_jobs");
    return rows[0]?.n;
  },
};

/**
 * Jobs on one per-tenant lane run one at a time, and a single `runOnce` pass stops when the only
 * jobs left are behind a lane that was busy, so pass until the queue is empty. Throws when the
 * queue is still non-empty after the last pass, so a caller never asserts against a partial drain.
 * `steps` is replaced only by the drainQueue boundary checks below.
 */
async function drainQueue(steps: DrainSteps = realDrainSteps, passLimit = DRAIN_PASS_LIMIT) {
  let remaining: string | undefined;
  for (let pass = 0; pass < passLimit; pass++) {
    await steps.runPass();
    remaining = await steps.countRemainingJobs();
    if (remaining === "0") return;
  }
  throw new Error(
    `drainQueue: incomplete drain, ${remaining ?? "unknown"} job(s) still remaining after the ${passLimit}-pass limit`,
  );
}

describe("drainQueue", () => {
  function scriptedSteps(counts: string[]) {
    let observed = 0;
    const steps = {
      runPass: vi.fn(async () => {}),
      countRemainingJobs: vi.fn(async () => {
        const n = counts[observed];
        observed++;
        if (n === undefined) throw new Error(`unexpected count query #${observed}`);
        return n;
      }),
    };
    return steps;
  }

  it("rejects after ten non-empty passes, naming the limit and the last remaining count, without an eleventh pass", async () => {
    const steps = scriptedSteps(["5", "5", "4", "4", "3", "3", "3", "2", "2", "1"]);
    await expect(drainQueue(steps)).rejects.toThrow(
      "drainQueue: incomplete drain, 1 job(s) still remaining after the 10-pass limit",
    );
    expect(steps.runPass).toHaveBeenCalledTimes(10);
    expect(steps.countRemainingJobs).toHaveBeenCalledTimes(10);
  });

  it("returns after the first pass when the queue is empty", async () => {
    const steps = scriptedSteps(["0"]);
    await expect(drainQueue(steps)).resolves.toBeUndefined();
    expect(steps.runPass).toHaveBeenCalledTimes(1);
    expect(steps.countRemainingJobs).toHaveBeenCalledTimes(1);
  });

  it("returns when the queue becomes empty on the tenth pass", async () => {
    const steps = scriptedSteps(["9", "8", "7", "6", "5", "4", "3", "2", "1", "0"]);
    await expect(drainQueue(steps)).resolves.toBeUndefined();
    expect(steps.runPass).toHaveBeenCalledTimes(10);
    expect(steps.countRemainingJobs).toHaveBeenCalledTimes(10);
  });
});

describe("rollup engine", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= bindToTenantZero(createChokePoint(pool));
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeProjectsAndTasks() {
    const projects = await chokePoint.createDatabase({ name: "Projects2" });
    const tasks = await chokePoint.createDatabase({ name: "Tasks2" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "done", name: "Done", type: "select" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "hours", name: "Hours", type: "number" });

    const { property: tasksRelation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
      inverse: { key: "project", name: "Project" },
    });

    const countProp = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "taskCount",
      name: "Task count",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "count" },
    });
    const sumProp = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "totalHours",
      name: "Total hours",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" },
    });

    return { projects, tasks, tasksRelation, countProp, sumProp };
  }

  it("validates rollup config: relationPropertyKey must be a relation property of the same database", async () => {
    const db = await chokePoint.createDatabase({ name: "Solo" });
    await expect(
      chokePoint.createProperty({
        databaseId: db.id,
        key: "bad",
        name: "Bad",
        type: "rollup",
        config: { relationPropertyKey: "nope", aggregation: "count" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a rollup whose targetPropertyKey type is incompatible with the aggregation", async () => {
    const projects = await chokePoint.createDatabase({ name: "P" });
    const tasks = await chokePoint.createDatabase({ name: "T" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "label", name: "Label", type: "text" });
    await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
    });

    await expect(
      chokePoint.createProperty({
        databaseId: projects.id,
        key: "sumLabel",
        name: "Bad sum",
        type: "rollup",
        config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "label" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("computes count and sum rollups after edges change, via the recompute job", async () => {
    const { projects, tasks, tasksRelation, countProp, sumProp } = await makeProjectsAndTasks();
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task1 = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 3 } });
    const task2 = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 4 } });

    await chokePoint.createRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task1.id,
    });
    await chokePoint.createRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task2.id,
    });
    await drainQueue();

    const afterLink = await chokePoint.getItem(projects.id, project.id);
    expect(afterLink?.computed[countProp.key]).toBe(2);
    expect(afterLink?.computed[sumProp.key]).toBe(7);

    await chokePoint.deleteRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task1.id,
    });
    await drainQueue();
    const afterUnlink = await chokePoint.getItem(projects.id, project.id);
    expect(afterUnlink?.computed[countProp.key]).toBe(1);
    expect(afterUnlink?.computed[sumProp.key]).toBe(4);
  });

  it("recomputes when the aggregated source property's value changes", async () => {
    const { projects, tasks, tasksRelation, sumProp } = await makeProjectsAndTasks();
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task1 = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 3 } });
    await chokePoint.createRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task1.id,
    });
    await drainQueue();

    await chokePoint.updateItem({ databaseId: tasks.id, itemId: task1.id, propertiesPatch: { hours: 10 } });
    await drainQueue();

    const item = await chokePoint.getItem(projects.id, project.id);
    expect(item?.computed[sumProp.key]).toBe(10);
  });

  it("enqueues and applies a rollup for a source key added by a registered transform", async () => {
    const projects = await chokePoint.createDatabase({ name: "Rollup parent" });
    const tasks = await chokePoint.createDatabase({ name: "Rollup child", ownerModuleId: "rollupProbe" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "trigger", name: "Trigger", type: "text" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "hours", name: "Hours", type: "number" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      targetDatabaseId: tasks.id,
      key: "tasks",
      name: "Tasks",
    });
    const total = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "total",
      name: "Total",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" },
    });
    const parent = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const child = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 3 } });
    await chokePoint.createRelation({
      relationPropertyId: property.id,
      callerItemId: parent.id,
      targetItemId: child.id,
    });
    await drainQueue();
    vi.resetModules();
    const hooks = await import("../chokePoint/hooks.js");
    const search = await import("../search/itemSearchIndexer.js");
    const searchUpdate = vi.spyOn(search, "itemSearchUpdateHook");
    await import("../domainWriteHooks.js");
    const isolated = await import("../chokePoint/chokePoint.js");
    const isolatedShared = await import("@semprec/shared");
    try {
      hooks.registerItemPreWriteTransform("rollupProbe", async ({ patch }) => ({ ...patch, hours: 10 }));
      const cp = isolated.createChokePoint(pool);
      await isolatedShared.runInTenant(getTenantZeroId(), () =>
        cp.updateItem({ databaseId: tasks.id, itemId: child.id, propertiesPatch: { trigger: "go" } }),
      );
      expect(searchUpdate).toHaveBeenCalledOnce();
      const key = rollupRecomputeJobKey(total.id, parent.id);
      const jobs = await pool.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [key]);
      expect(jobs.rows).toEqual([{ key }]);
      await drainQueue();
      expect((await chokePoint.getItem(projects.id, parent.id))?.computed.total).toBe(10);
    } finally {
      hooks.clearHooksForTests();
      searchUpdate.mockRestore();
      vi.resetModules();
    }
  });

  describe("archived source databases", () => {
    async function fullJobKeys(): Promise<string[]> {
      const { rows } = await pool.query<{ key: string }>(
        "SELECT key FROM graphile_worker._private_jobs WHERE key LIKE 'rollup-recompute:%:full' ORDER BY key",
      );
      return rows.map((row) => row.key);
    }

    async function linkedFixture() {
      const fixture = await makeProjectsAndTasks();
      const project = await chokePoint.createItem({ databaseId: fixture.projects.id, properties: {} });
      for (const hours of [3, 4]) {
        const task = await chokePoint.createItem({ databaseId: fixture.tasks.id, properties: { hours } });
        await chokePoint.createRelation({
          relationPropertyId: fixture.tasksRelation.id,
          callerItemId: project.id,
          targetItemId: task.id,
        });
      }
      await drainQueue();
      return { ...fixture, project };
    }

    async function expectValues(f: Awaited<ReturnType<typeof linkedFixture>>, count: number, sum: number | null) {
      const item = await chokePoint.getItem(f.projects.id, f.project.id);
      expect(item?.computed[f.countProp.key]).toBe(count);
      expect(item?.computed[f.sumProp.key]).toBe(sum);
    }

    it("drops the archived items from count and sum after the job runs and restores them on restore", async () => {
      const f = await linkedFixture();
      await expectValues(f, 2, 7);

      await chokePoint.archiveDatabase(f.tasks.id);
      await drainQueue();
      await expectValues(f, 0, null);

      await chokePoint.restoreDatabase(f.tasks.id);
      await drainQueue();
      await expectValues(f, 2, 7);
    });

    it("uses existing empty-input values for filled and empty count and percentage rollups", async () => {
      const f = await linkedFixture();
      const emptyTask = await chokePoint.createItem({ databaseId: f.tasks.id, properties: {} });
      await chokePoint.createRelation({
        relationPropertyId: f.tasksRelation.id,
        callerItemId: f.project.id,
        targetItemId: emptyTask.id,
      });
      const unlinked = await chokePoint.createItem({ databaseId: f.projects.id, properties: {} });
      for (const [key, aggregation] of [
        ["countFilled", "count_filled"],
        ["countEmpty", "count_empty"],
        ["percentFilled", "percent_filled"],
        ["percentEmpty", "percent_empty"],
      ] as const) {
        await chokePoint.createProperty({
          databaseId: f.projects.id,
          key,
          name: aggregation,
          type: "rollup",
          config: { relationPropertyKey: "tasks", targetPropertyKey: "hours", aggregation },
        });
      }
      // Six rollups and two parent items can enqueue six full and twelve cell jobs.
      await drainQueue(realDrainSteps, 24);
      const values = async () => (await chokePoint.getItem(f.projects.id, f.project.id))?.computed;
      const populated = { countFilled: 2, countEmpty: 1, percentFilled: 2 / 3, percentEmpty: 1 / 3 };
      const empty = { countFilled: 0, countEmpty: 0, percentFilled: 0, percentEmpty: 0 };
      expect(await values()).toMatchObject(populated);
      expect((await chokePoint.getItem(f.projects.id, unlinked.id))?.computed).toMatchObject(empty);
      await chokePoint.archiveDatabase(f.tasks.id);
      await drainQueue(realDrainSteps, 24);
      expect(await values()).toMatchObject(empty);
      await chokePoint.restoreDatabase(f.tasks.id);
      await drainQueue(realDrainSteps, 24);
      expect(await values()).toMatchObject(populated);
    });

    it("queues one full job per dependent rollup property and a second archive request does not queue another", async () => {
      const f = await linkedFixture();
      await chokePoint.archiveDatabase(f.tasks.id);
      const expected = [f.countProp.id, f.sumProp.id].map(rollupRecomputeFullJobKey).sort();
      expect(await fullJobKeys()).toEqual(expected);

      await chokePoint.archiveDatabase(f.tasks.id);
      expect(await fullJobKeys()).toEqual(expected);
    });

    it("queues nothing when no rollup aggregates the archived database", async () => {
      const f = await linkedFixture();
      await chokePoint.archiveDatabase(f.projects.id);
      expect(await fullJobKeys()).toEqual([]);
    });

    it("recounts the same way through the approved-operation path", async () => {
      const f = await linkedFixture();
      await inTenantZero(() => withTransaction(pool, (client) => databaseArchiveWithClient(client, f.tasks.id)));
      expect(await fullJobKeys()).toHaveLength(2);
      await drainQueue();
      await expectValues(f, 0, null);
    });

    it("keeps archive and recount tenant-scoped and rolls back the queued job with the archive", async () => {
      const tenantA = getTenantZeroId();
      const tenantB = await createTestTenant(pool);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let failure: { error: unknown } | undefined;
      try {
        const cp = createChokePoint(runtime);
        const fixture = await runInTenant(tenantA, async () => {
          const parents = await cp.createDatabase({ name: "Scoped rollup parents" });
          const source = await cp.createDatabase({ name: "Scoped rollup source" });
          const { property: relation } = await cp.createRelationProperty({
            sourceDatabaseId: parents.id,
            targetDatabaseId: source.id,
            key: "children",
            name: "Children",
          });
          const rollup = await cp.createProperty({
            databaseId: parents.id,
            key: "childCount",
            name: "Count",
            type: "rollup",
            config: { relationPropertyKey: "children", aggregation: "count" },
          });
          const parent = await cp.createItem({ databaseId: parents.id, properties: {} });
          const child = await cp.createItem({ databaseId: source.id, properties: {} });
          await cp.createRelation({ relationPropertyId: relation.id, callerItemId: parent.id, targetItemId: child.id });
          return { parents, source, rollup, parent };
        });
        const drain = async () => {
          for (let pass = 0; pass < 10; pass++) {
            await runOnce({ pgPool: runtime, taskList: createCoreTaskList(runtime, createActionRegistry()) });
            const remaining = await Promise.all(
              [CORE_TASK_NAMES.ROLLUP_RECOMPUTE, CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL].map((name) =>
                countJobsByIdentifier(pool, name),
              ),
            );
            if (remaining.every((count) => count === 0)) return;
          }
          throw new Error("Rollup queue did not drain");
        };
        const value = async () =>
          (await runInTenant(tenantA, () => cp.getItem(fixture.parents.id, fixture.parent.id)))?.computed.childCount;
        await drain();
        expect(await value()).toBe(1);
        const marker = new Error("rollback archive");
        await expect(
          runInTenant(tenantA, () =>
            withTransaction(runtime, async (client) => {
              await databaseArchiveWithClient(client, fixture.source.id);
              throw marker;
            }),
          ),
        ).rejects.toBe(marker);
        expect((await runInTenant(tenantA, () => cp.getDatabase(fixture.source.id)))?.archivedAt).toBeNull();
        expect(await countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL)).toBe(0);
        expect(await value()).toBe(1);
        const foreign = await Promise.allSettled([runInTenant(tenantB, () => cp.archiveDatabase(fixture.source.id))]);
        expect(foreign[0]).toMatchObject({ status: "rejected", reason: { status: 404 } });
        expect(await countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL)).toBe(0);
        expect((await runInTenant(tenantA, () => cp.getDatabase(fixture.source.id)))?.archivedAt).toBeNull();
        await runInTenant(tenantA, () => cp.archiveDatabase(fixture.source.id));
        expect(await countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL)).toBe(1);
        await drain();
        expect(await value()).toBe(0);
        await runInTenant(tenantA, () => cp.restoreDatabase(fixture.source.id));
        await drain();
        expect(await value()).toBe(1);
      } catch (error) {
        failure = { error };
      }
      const [closed] = await Promise.allSettled([runtime.end()]);
      if (failure && closed?.status === "rejected") throw new AggregateError([failure.error, closed.reason]);
      if (failure) throw failure.error;
      if (closed?.status === "rejected") throw closed.reason;
    });
  });

  it("recomputes on soft delete/restore of a source row", async () => {
    const { projects, tasks, tasksRelation, countProp } = await makeProjectsAndTasks();
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task1 = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
    await chokePoint.createRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task1.id,
    });
    await drainQueue();

    await chokePoint.softDeleteItem(tasks.id, task1.id);
    await drainQueue();
    expect((await chokePoint.getItem(projects.id, project.id))?.computed[countProp.key]).toBe(0);

    await chokePoint.restoreItem(tasks.id, task1.id);
    await drainQueue();
    expect((await chokePoint.getItem(projects.id, project.id))?.computed[countProp.key]).toBe(1);
  });

  it("rejects deleting a relation property that a rollup still depends on", async () => {
    const { tasksRelation } = await makeProjectsAndTasks();
    await expect(chokePoint.deleteProperty(tasksRelation.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects retyping a source property that a rollup still depends on incompatibly", async () => {
    const { tasks } = await makeProjectsAndTasks();
    const hoursProperty = (await chokePoint.listProperties(tasks.id)).find((p) => p.key === "hours")!;
    await expect(chokePoint.changePropertyType(hoursProperty.id, "text")).rejects.toBeInstanceOf(ValidationError);
  });

  it("backfills a rollup created after items already exist", async () => {
    const projects = await chokePoint.createDatabase({ name: "P2" });
    const tasks = await chokePoint.createDatabase({ name: "T2" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "hours", name: "Hours", type: "number" });
    const { property: relation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
    });
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 5 } });
    await chokePoint.createRelation({
      relationPropertyId: relation.id,
      callerItemId: project.id,
      targetItemId: task.id,
    });
    await drainQueue();

    const sumProp = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "totalHours",
      name: "Total hours",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" },
    });
    await drainQueue(); // backfill enqueue
    await drainQueue(); // per-cell recompute enqueued by the backfill

    const item = await chokePoint.getItem(projects.id, project.id);
    expect(item?.computed[sumProp.key]).toBe(5);
  });

  it("ignores a non-ISO date in a latest rollup and completes the job on its first attempt", async () => {
    const projects = await chokePoint.createDatabase({ name: "P3" });
    const tasks = await chokePoint.createDatabase({ name: "T3" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "due", name: "Due", type: "date" });
    const { property: relation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
    });
    const latestProp = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "latestDue",
      name: "Latest due",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "latest", targetPropertyKey: "due" },
    });
    await drainQueue(); // backfill over an empty database
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    for (const due of ["2026-01-05", "2026-03-10T12:00:00Z", "tomorrow"]) {
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { due } });
      await chokePoint.createRelation({
        relationPropertyId: relation.id,
        callerItemId: project.id,
        targetItemId: task.id,
      });
    }
    await drainQueue();

    const item = await chokePoint.getItem(projects.id, project.id);
    expect(item?.computed[latestProp.key]).toBe("2026-03-10T12:00:00.000Z");
    // A failed attempt leaves the job behind (rescheduled for a retry); a successful one deletes it.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM graphile_worker._private_jobs WHERE key = $1`,
      [`rollup-recompute:${latestProp.id}:${project.id}`],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("serialises a recompute behind a lock on the target row and aggregates the state committed meanwhile", async () => {
    const { projects, tasks, tasksRelation, sumProp } = await makeProjectsAndTasks();
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 3 } });
    await chokePoint.createRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task.id,
    });
    await drainQueue();
    expect((await chokePoint.getItem(projects.id, project.id))?.computed[sumProp.key]).toBe(3);

    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [project.id]);
      const { rows: holderRows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const holderPid = holderRows[0]!.pid;

      let settled = false;
      const recompute = recomputeRollupCell(pool, sumProp.id, project.id).finally(() => {
        settled = true;
      });
      await vi.waitFor(
        async () => {
          const { rows: waiters } = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [holderPid],
          );
          expect(Number(waiters[0]!.count), "recompute never blocked on the holder's row lock").toBe(1);
        },
        { timeout: 10_000, interval: 20 },
      );
      expect(settled).toBe(false);

      await chokePoint.updateItem({ databaseId: tasks.id, itemId: task.id, propertiesPatch: { hours: 8 } });
      await holder.query("COMMIT");
      await recompute;
    } finally {
      holder.release();
    }

    expect((await chokePoint.getItem(projects.id, project.id))?.computed[sumProp.key]).toBe(8);
  });

  it("returns without writing when the target item was purged", async () => {
    const { projects, sumProp } = await makeProjectsAndTasks();
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    await pool.query("DELETE FROM items WHERE id = $1", [project.id]);

    await expect(recomputeRollupCell(pool, sumProp.id, project.id)).resolves.toBeUndefined();
    const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM items WHERE id = $1", [
      project.id,
    ]);
    expect(rows[0]?.count).toBe("0");
  });
});
