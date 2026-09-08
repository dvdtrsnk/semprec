import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runOnce } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import {
  createHeartbeat,
  getHeartbeat,
  heartbeatFireJobKey,
  recomputeAllForTimezoneChange,
  setHeartbeatEnabled,
  sweepDueHeartbeats,
  updateHeartbeatRule,
} from "../scheduler/schedulerStore.js";
import { createActionRegistry, CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
import { createHeartbeatFireTask } from "../scheduler/sweep.js";
import { getSystemSettingsItemId } from "../systemSettings.js";
import { createAgentRun, listAgentRunsByHeartbeat } from "../agentRuns/agentRunsStore.js";
import { createHeartbeatTriggerTool } from "../scheduler/heartbeatAgentTools.js";
import type { HeartbeatRuleKindRegistry } from "../scheduler/rule.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function drainQueue(registry = createActionRegistry()) {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, registry) });
}

describe("scheduler", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function getSemprecProjectId(): Promise<string> {
    const { rows } = await pool.query("SELECT id FROM databases WHERE owner_module_id = 'projects'");
    const { rows: items } = await pool.query("SELECT id FROM items WHERE database_id = $1 LIMIT 1", [rows[0].id]);
    return items[0].id;
  }

  it("createHeartbeat computes next_fire_at deterministically at write time", async () => {
    const projectItemId = await getSemprecProjectId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Daily digest",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "noop",
      }),
    );
    expect(heartbeat.nextFireAt).not.toBeNull();
  });

  it("onItemEvent heartbeats have no next_fire_at and are invisible to the sweep", async () => {
    const projectItemId = await getSemprecProjectId();
    const db = await chokePoint.createDatabase({ name: "Watched" });
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "On create",
        rule: { kind: "onItemEvent", databaseId: db.id, event: "create" },
        actionId: "noop",
      }),
    );
    expect(heartbeat.nextFireAt).toBeNull();

    const fired = await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    expect(fired).toHaveLength(0);
  });

  it("the choke-point's write path triggers onItemEvent heartbeats", async () => {
    const projectItemId = await getSemprecProjectId();
    const db = await chokePoint.createDatabase({ name: "Watched2" });
    let ran = 0;
    const registry = createActionRegistry();
    registry.set("markRan", async () => {
      ran += 1;
    });
    await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "On create",
        rule: { kind: "onItemEvent", databaseId: db.id, event: "create" },
        actionId: "markRan",
      }),
    );

    await chokePoint.createItem({ databaseId: db.id, properties: {} });
    await drainQueue(registry);
    expect(ran).toBe(1);
  });

  it("sweepDueHeartbeats fires a due heartbeat exactly once", async () => {
    const projectItemId = await getSemprecProjectId();
    const registry = createActionRegistry();
    registry.set("noop", async () => {});
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Every minute-ish",
        rule: { kind: "interval", minutes: 1 },
        actionId: "noop",
      }),
    );
    // Force it due "now" (simulating either a normal tick or catch-up after downtime).
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      heartbeat.id,
    ]);

    const fired = await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    expect(fired.map((f) => f.id)).toEqual([heartbeat.id]);

    await drainQueue(registry);
    const after = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));
    expect(after!.lastFiredAt).not.toBeNull();
    expect(new Date(after!.nextFireAt!).getTime()).toBeGreaterThan(Date.now());

    // A second sweep right away finds nothing due.
    const fired2 = await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    expect(fired2).toHaveLength(0);
  });

  it("a floating (interval/everyNDays) heartbeat leaves next_fire_at and last_fired_at unset at sweep time, and schedules its next occurrence from the first attempt's actual start, not enqueue time", async () => {
    const projectItemId = await getSemprecProjectId();
    const registry = createActionRegistry();
    registry.set("noop", async () => {});
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Every minute-ish",
        rule: { kind: "interval", minutes: 1 },
        actionId: "noop",
      }),
    );
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      heartbeat.id,
    ]);

    await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    const afterSweep = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));
    expect(afterSweep!.nextFireAt).toBeNull();
    expect(afterSweep!.lastFiredAt).toBeNull();

    const beforeFire = Date.now();
    await drainQueue(registry);

    const afterFire = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));
    expect(new Date(afterFire!.lastFiredAt!).getTime()).toBeGreaterThanOrEqual(beforeFire);
    expect(new Date(afterFire!.nextFireAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("a fixed (dailyTime/weekly) heartbeat advances next_fire_at immediately at sweep time, unaffected by queue delay before the fire task actually runs", async () => {
    const projectItemId = await getSemprecProjectId();
    const registry = createActionRegistry();
    registry.set("noop", async () => {});
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Daily",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "noop",
      }),
    );
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      heartbeat.id,
    ]);

    await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    const afterSweep = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));
    expect(afterSweep!.nextFireAt).not.toBeNull();
    expect(afterSweep!.lastFiredAt).toBeNull();
    const calendarNextFireAt = afterSweep!.nextFireAt;

    await drainQueue(registry);

    const afterFire = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));
    expect(afterFire!.lastFiredAt).not.toBeNull();
    // The fire task's own start time never shifts a fixed rule's calendar-anchored schedule.
    expect(afterFire!.nextFireAt).toBe(calendarNextFireAt);
  });

  it("disabling clears the schedule; re-enabling recomputes from now (no catch-up of missed occurrences)", async () => {
    const projectItemId = await getSemprecProjectId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Daily",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "noop",
      }),
    );
    const disabled = await withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, false));
    expect(disabled.nextFireAt).toBeNull();

    const reenabled = await withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, true));
    expect(reenabled.nextFireAt).not.toBeNull();
  });

  it("changing the system timezone recomputes next_fire_at for enabled time-based heartbeats", async () => {
    const projectItemId = await getSemprecProjectId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Daily",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "noop",
      }),
    );
    const before = (await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id)))!.nextFireAt;

    const settingsItemId = await withTransaction(pool, (client) => getSystemSettingsItemId(client));
    const { rows: settingsRows } = await pool.query("SELECT database_id FROM items WHERE id = $1", [settingsItemId]);
    await chokePoint.updateItem({
      databaseId: settingsRows[0].database_id,
      itemId: settingsItemId,
      propertiesPatch: { timezone: "Pacific/Kiritimati" }, // UTC+14, far from Europe/Prague
    });

    const after = (await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id)))!.nextFireAt;
    expect(after).not.toBe(before);
  });

  it("core.agentRun creates an agent_runs row, calls the injected runner, and records the delegation trail", async () => {
    const projectItemId = await getSemprecProjectId();
    const registry = createActionRegistry();
    registry.set(
      CORE_AGENT_RUN_ACTION_ID,
      coreAgentRunAction(pool, async ({ task }) => ({ result: `handled: ${task}` })),
    );
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Process inbox",
        rule: { kind: "interval", minutes: 1 },
        actionId: CORE_AGENT_RUN_ACTION_ID,
        actionConfig: { task: "process the inbox" },
      }),
    );
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      heartbeat.id,
    ]);
    await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    await drainQueue(registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeat.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("done");
    expect(runs[0].result).toBe("handled: process the inbox");
    expect(runs[0].triggeredBy).toBe("heartbeat");
  });

  it("heartbeat.trigger's manual fire attributes the child run's parent_run_id to the invoking run, without touching next_fire_at/last_fired_at", async () => {
    const projectItemId = await getSemprecProjectId();
    const registry = createActionRegistry();
    registry.set(
      CORE_AGENT_RUN_ACTION_ID,
      coreAgentRunAction(pool, async ({ task }) => ({ result: `handled: ${task}` })),
    );
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Process inbox",
        rule: { kind: "interval", minutes: 5 },
        actionId: CORE_AGENT_RUN_ACTION_ID,
        actionConfig: { task: "process the inbox" },
      }),
    );
    const before = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));

    const invokingRun = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "trigger it" });
    const heartbeatTrigger = createHeartbeatTriggerTool(pool);
    const outcome = await heartbeatTrigger(invokingRun.id, { heartbeatId: heartbeat.id });
    expect(outcome.error).toBe(false);

    await drainQueue(registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeat.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].triggeredBy).toBe("heartbeat");
    expect(runs[0].parentRunId).toBe(invokingRun.id);

    const after = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));
    expect(after!.nextFireAt).toBe(before!.nextFireAt);
    expect(after!.lastFiredAt).toBe(before!.lastFiredAt);
  });

  it("an occurrence insert conflicting on (heartbeat_id, scheduled_for) is an idempotent no-op: no second job, no second next_fire_at advance", async () => {
    const projectItemId = await getSemprecProjectId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Daily",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "noop",
      }),
    );
    const dueAt = new Date(Date.now() - 60_000);
    await pool.query("UPDATE project_heartbeats SET next_fire_at = $2 WHERE id = $1", [heartbeat.id, dueAt]);

    // Simulate another sweep (or the sweep's own defense-in-depth guard) having already recorded
    // the occurrence for this exact due time, without having advanced next_fire_at off of it yet.
    await pool.query(
      `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
       VALUES ($1, $2, $3::jsonb, 'queued')`,
      [heartbeat.id, dueAt, JSON.stringify(heartbeat.rule)],
    );

    const fired = await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    expect(fired).toHaveLength(0); // conflicting insert returned no id: not treated as newly fired

    const { rows: occurrences } = await pool.query("SELECT id FROM heartbeat_occurrences WHERE heartbeat_id = $1", [
      heartbeat.id,
    ]);
    expect(occurrences).toHaveLength(1); // still exactly one row, not a duplicate

    const after = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));
    // The no-op branch never reaches the next_fire_at update: still the due time from before this call.
    expect(new Date(after!.nextFireAt!).getTime()).toBe(dueAt.getTime());
  });

  it("a retried fire attempt reuses the persisted occurrenceId and first_started_at, and never advances next_fire_at a second time", async () => {
    const projectItemId = await getSemprecProjectId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Every minute-ish",
        rule: { kind: "interval", minutes: 1 },
        actionId: "noop",
      }),
    );
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      heartbeat.id,
    ]);
    const fired = await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    expect(fired).toHaveLength(1);
    const { rows: occRows } = await pool.query("SELECT id FROM heartbeat_occurrences WHERE heartbeat_id = $1", [
      heartbeat.id,
    ]);
    const occurrenceId: string = occRows[0].id;

    const { prepareHeartbeatOccurrenceFire } = await import("../scheduler/schedulerStore.js");
    const first = await prepareHeartbeatOccurrenceFire(pool, heartbeat.id, occurrenceId);
    expect(first.outcome).toBe("proceed");
    const afterFirst = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));
    const firstNextFireAt = afterFirst!.nextFireAt;
    const firstLastFiredAt = afterFirst!.lastFiredAt;
    expect(firstNextFireAt).not.toBeNull();
    expect(firstLastFiredAt).not.toBeNull();

    // Simulate the job being retried (e.g. the handler threw on the first attempt): the same
    // occurrenceId is reused, and the "genuine first attempt" branch must not fire again.
    const retry = await prepareHeartbeatOccurrenceFire(pool, heartbeat.id, occurrenceId);
    expect(retry.outcome).toBe("proceed");
    const afterRetry = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));
    expect(afterRetry!.nextFireAt).toBe(firstNextFireAt);
    expect(afterRetry!.lastFiredAt).toBe(firstLastFiredAt);
  });

  it("cancels the occurrence without executing or touching heartbeat scheduling when the heartbeat was disabled after the occurrence was enqueued", async () => {
    const projectItemId = await getSemprecProjectId();
    let ran = 0;
    const registry = createActionRegistry();
    registry.set("markRan", async () => {
      ran += 1;
    });
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Daily",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "markRan",
      }),
    );
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      heartbeat.id,
    ]);
    await withTransaction(pool, (client) => sweepDueHeartbeats(client));

    await withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, false));

    await drainQueue(registry);
    expect(ran).toBe(0);

    const { rows } = await pool.query("SELECT status FROM heartbeat_occurrences WHERE heartbeat_id = $1", [
      heartbeat.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("cancelled");

    // Disabling already cleared next_fire_at; the fire task must not have touched it further.
    const after = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));
    expect(after!.nextFireAt).toBeNull();
    expect(after!.lastFiredAt).toBeNull();
  });

  it("cancels the occurrence without executing when the heartbeat's rule was edited after the occurrence was enqueued", async () => {
    const projectItemId = await getSemprecProjectId();
    let ran = 0;
    const registry = createActionRegistry();
    registry.set("markRan", async () => {
      ran += 1;
    });
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Daily",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "markRan",
      }),
    );
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      heartbeat.id,
    ]);
    await withTransaction(pool, (client) => sweepDueHeartbeats(client));

    await withTransaction(pool, (client) =>
      updateHeartbeatRule(client, heartbeat.id, { kind: "dailyTime", at: "10:30" }),
    );

    await drainQueue(registry);
    expect(ran).toBe(0);

    const { rows } = await pool.query("SELECT status FROM heartbeat_occurrences WHERE heartbeat_id = $1", [
      heartbeat.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("cancelled");
  });

  it("distinct scheduled occurrences for the same heartbeat get distinct job keys", async () => {
    const projectItemId = await getSemprecProjectId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Daily",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "noop",
      }),
    );
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      heartbeat.id,
    ]);
    await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      heartbeat.id,
    ]);
    await withTransaction(pool, (client) => sweepDueHeartbeats(client));

    const { rows: occRows } = await pool.query(
      "SELECT id FROM heartbeat_occurrences WHERE heartbeat_id = $1 ORDER BY scheduled_for",
      [heartbeat.id],
    );
    expect(occRows).toHaveLength(2);
    const keys = occRows.map((r) => heartbeatFireJobKey(heartbeat.id, r.id));
    expect(new Set(keys).size).toBe(2);
  });

  it("two overlapping sweeps still fire a due heartbeat exactly once", async () => {
    const projectItemId = await getSemprecProjectId();
    const registry = createActionRegistry();
    let ran = 0;
    registry.set("noop", async () => {
      ran += 1;
    });
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Daily",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "noop",
      }),
    );
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      heartbeat.id,
    ]);

    // `FOR UPDATE SKIP LOCKED` inside sweepDueHeartbeats means two concurrent sweep transactions
    // never both select this row: run them concurrently against the same pool to exercise that.
    const [firedA, firedB] = await Promise.all([
      withTransaction(pool, (client) => sweepDueHeartbeats(client)),
      withTransaction(pool, (client) => sweepDueHeartbeats(client)),
    ]);
    const totalFired = firedA.length + firedB.length;
    expect(totalFired).toBe(1);

    const { rows: occRows } = await pool.query("SELECT id FROM heartbeat_occurrences WHERE heartbeat_id = $1", [
      heartbeat.id,
    ]);
    expect(occRows).toHaveLength(1);

    await drainQueue(registry);
    expect(ran).toBe(1);
  });

  it("createHeartbeatFireTask rejects a payload carrying zero or more than one of occurrenceId/itemId/triggeredByRunId with validation_failed", async () => {
    const registry = createActionRegistry();
    const task = createHeartbeatFireTask(pool, registry);
    const helpers = { job: { attempts: 1, max_attempts: 3 } } as Parameters<typeof task>[1];

    await expect(task({ heartbeatId: "h1" }, helpers)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(task({ heartbeatId: "h1", occurrenceId: "o1", itemId: "i1" }, helpers)).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      task({ heartbeatId: "h1", occurrenceId: "o1", triggeredByRunId: "r1" }, helpers),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  describe("module-declared heartbeat rule kinds", () => {
    function fixtureModuleRuleKinds(
      nextFireAt: (rule: unknown, timezone: string, after: Date) => Date | null,
    ): HeartbeatRuleKindRegistry {
      return new Map([
        [
          "fixtureModule.onWidgetTick",
          {
            schema: { safeParse: (raw: unknown) => ({ success: true, data: raw }) },
            nextFireAt,
          },
        ],
      ]);
    }

    it("creates and schedules a heartbeat using an active module's rule kind, dispatched through its nextFireAtExport", async () => {
      const projectItemId = await getSemprecProjectId();
      const moduleRuleKinds = fixtureModuleRuleKinds((_rule, _tz, after) => new Date(after.getTime() + 60_000));

      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(
          client,
          {
            projectItemId,
            name: "Widget tick",
            rule: { kind: "fixtureModule.onWidgetTick", every: 5 },
            actionId: "noop",
          },
          moduleRuleKinds,
        ),
      );
      expect(heartbeat.nextFireAt).not.toBeNull();
      expect(heartbeat.rule).toEqual({ kind: "fixtureModule.onWidgetTick", every: 5 });
    });

    it("rejects creating a heartbeat for a rule kind whose module isn't active", async () => {
      const projectItemId = await getSemprecProjectId();
      await expect(
        withTransaction(pool, (client) =>
          createHeartbeat(client, {
            projectItemId,
            name: "Widget tick",
            rule: { kind: "fixtureModule.onWidgetTick", every: 5 },
            actionId: "noop",
          }),
        ),
      ).rejects.toThrow(/Unknown heartbeat rule kind/);
    });

    it("sweep dispatches a due module-kind heartbeat via its nextFireAtExport", async () => {
      const projectItemId = await getSemprecProjectId();
      const moduleRuleKinds = fixtureModuleRuleKinds((_rule, _tz, after) => new Date(after.getTime() + 60_000));
      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(
          client,
          {
            projectItemId,
            name: "Widget tick",
            rule: { kind: "fixtureModule.onWidgetTick", every: 5 },
            actionId: "noop",
          },
          moduleRuleKinds,
        ),
      );
      await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
        heartbeat.id,
      ]);

      const fired = await withTransaction(pool, (client) => sweepDueHeartbeats(client, moduleRuleKinds));
      expect(fired.map((f) => f.id)).toEqual([heartbeat.id]);

      // A module-declared rule kind is treated like a core fixed rule (only `everyNDays`/
      // `interval` are floating): the sweep advances next_fire_at via the fixture's own
      // nextFireAtExport immediately, without waiting for the fire task's first attempt.
      const after = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id, moduleRuleKinds));
      expect(after!.nextFireAt).not.toBeNull();
      expect(after!.lastFiredAt).toBeNull();
    });

    it("a heartbeat whose module rule kind became inactive is skipped by the sweep, not dispatched", async () => {
      const projectItemId = await getSemprecProjectId();
      const moduleRuleKinds = fixtureModuleRuleKinds((_rule, _tz, after) => new Date(after.getTime() + 60_000));
      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(
          client,
          {
            projectItemId,
            name: "Widget tick",
            rule: { kind: "fixtureModule.onWidgetTick", every: 5 },
            actionId: "noop",
          },
          moduleRuleKinds,
        ),
      );
      await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
        heartbeat.id,
      ]);

      // The module is now deactivated: the sweep is run with no module rule kinds registered.
      const fired = await withTransaction(pool, (client) => sweepDueHeartbeats(client));
      expect(fired).toHaveLength(0);

      const { rows } = await pool.query("SELECT last_error, next_fire_at FROM project_heartbeats WHERE id = $1", [
        heartbeat.id,
      ]);
      expect(rows[0].last_error).toMatch(/Unknown heartbeat rule kind/);
      expect(rows[0].next_fire_at).not.toBeNull(); // left due, so reactivating the module lets the next sweep pick it up
    });

    it("a heartbeat whose module rule kind became inactive can still be disabled", async () => {
      const projectItemId = await getSemprecProjectId();
      const moduleRuleKinds = fixtureModuleRuleKinds((_rule, _tz, after) => new Date(after.getTime() + 60_000));
      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(
          client,
          {
            projectItemId,
            name: "Widget tick",
            rule: { kind: "fixtureModule.onWidgetTick", every: 5 },
            actionId: "noop",
          },
          moduleRuleKinds,
        ),
      );

      // The module is now deactivated: disabling is called with no module rule kinds registered.
      const disabled = await withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, false));
      expect(disabled.enabled).toBe(false);
      expect(disabled.nextFireAt).toBeNull();
      expect(disabled.rule).toEqual({ kind: "fixtureModule.onWidgetTick", every: 5 });
    });

    it("re-enabling a heartbeat whose module rule kind is still inactive fails (there is no calculator to schedule it with)", async () => {
      const projectItemId = await getSemprecProjectId();
      const moduleRuleKinds = fixtureModuleRuleKinds((_rule, _tz, after) => new Date(after.getTime() + 60_000));
      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(
          client,
          {
            projectItemId,
            name: "Widget tick",
            rule: { kind: "fixtureModule.onWidgetTick", every: 5 },
            actionId: "noop",
          },
          moduleRuleKinds,
        ),
      );
      await withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, false));

      await expect(withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, true))).rejects.toThrow(
        /Unknown heartbeat rule kind/,
      );
    });

    it("a heartbeat whose module rule kind became inactive can be updated to a new (core) rule", async () => {
      const projectItemId = await getSemprecProjectId();
      const moduleRuleKinds = fixtureModuleRuleKinds((_rule, _tz, after) => new Date(after.getTime() + 60_000));
      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(
          client,
          {
            projectItemId,
            name: "Widget tick",
            rule: { kind: "fixtureModule.onWidgetTick", every: 5 },
            actionId: "noop",
          },
          moduleRuleKinds,
        ),
      );

      // The module is now deactivated: updateHeartbeatRule is called with no module rule kinds
      // registered, replacing the now-unparseable rule with a working core one.
      const updated = await withTransaction(pool, (client) =>
        updateHeartbeatRule(client, heartbeat.id, { kind: "dailyTime", at: "09:00" }),
      );
      expect(updated.rule).toEqual({ kind: "dailyTime", at: "09:00" });
      expect(updated.nextFireAt).not.toBeNull();
    });

    it("the fire job degrades gracefully when its module rule kind is deactivated between sweep and fire, instead of retrying and losing the run", async () => {
      const projectItemId = await getSemprecProjectId();
      const moduleRuleKinds = fixtureModuleRuleKinds((_rule, _tz, after) => new Date(after.getTime() + 60_000));
      let ran = 0;
      const registry = createActionRegistry();
      registry.set("markRan", async () => {
        ran += 1;
      });

      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(
          client,
          {
            projectItemId,
            name: "Widget tick",
            rule: { kind: "fixtureModule.onWidgetTick", every: 5 },
            actionId: "markRan",
          },
          moduleRuleKinds,
        ),
      );
      await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
        heartbeat.id,
      ]);

      // Sweep while the module is still active: enqueues the fire job and advances next_fire_at.
      const fired = await withTransaction(pool, (client) => sweepDueHeartbeats(client, moduleRuleKinds));
      expect(fired.map((f) => f.id)).toEqual([heartbeat.id]);

      // The module is deactivated by the time the fire job actually runs: drainQueue's
      // createCoreTaskList carries no moduleRegistry, so the fire task sees no active module
      // rule kinds. This must not throw (and thus retry/dead-letter) — it should record the
      // failure and skip firing.
      await expect(drainQueue(registry)).resolves.not.toThrow();
      expect(ran).toBe(0);

      const { rows } = await pool.query("SELECT last_error FROM project_heartbeats WHERE id = $1", [heartbeat.id]);
      expect(rows[0].last_error).toMatch(/Unknown heartbeat rule kind/);
    });

    it("recomputeAllForTimezoneChange recomputes a heartbeat using an active module's rule kind", async () => {
      const projectItemId = await getSemprecProjectId();
      const moduleRuleKinds = fixtureModuleRuleKinds((_rule, _tz, after) => new Date(after.getTime() + 60_000));
      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(
          client,
          {
            projectItemId,
            name: "Widget tick",
            rule: { kind: "fixtureModule.onWidgetTick", every: 5 },
            actionId: "noop",
          },
          moduleRuleKinds,
        ),
      );
      const before = (await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id, moduleRuleKinds)))!
        .nextFireAt;

      await withTransaction(pool, (client) =>
        recomputeAllForTimezoneChange(client, "Pacific/Kiritimati", moduleRuleKinds),
      );

      const after = (await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id, moduleRuleKinds)))!
        .nextFireAt;
      expect(after).not.toBeNull();
      expect(after).not.toBe(before);
    });

    it("recomputeAllForTimezoneChange skips a heartbeat whose module rule kind became inactive, without aborting the batch", async () => {
      const projectItemId = await getSemprecProjectId();
      const moduleRuleKinds = fixtureModuleRuleKinds((_rule, _tz, after) => new Date(after.getTime() + 60_000));
      const moduleHeartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(
          client,
          {
            projectItemId,
            name: "Widget tick",
            rule: { kind: "fixtureModule.onWidgetTick", every: 5 },
            actionId: "noop",
          },
          moduleRuleKinds,
        ),
      );
      const coreHeartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(client, {
          projectItemId,
          name: "Daily",
          rule: { kind: "dailyTime", at: "09:00" },
          actionId: "noop",
        }),
      );
      const coreBefore = (await withTransaction(pool, (client) => getHeartbeat(client, coreHeartbeat.id)))!.nextFireAt;

      // The module is now deactivated: recompute runs with no module rule kinds registered.
      await expect(
        withTransaction(pool, (client) => recomputeAllForTimezoneChange(client, "Pacific/Kiritimati")),
      ).resolves.toBeUndefined();

      const { rows } = await pool.query("SELECT last_error FROM project_heartbeats WHERE id = $1", [
        moduleHeartbeat.id,
      ]);
      expect(rows[0].last_error).toMatch(/Unknown heartbeat rule kind/);

      // The core heartbeat after it in the same batch still gets recomputed.
      const coreAfter = (await withTransaction(pool, (client) => getHeartbeat(client, coreHeartbeat.id)))!.nextFireAt;
      expect(coreAfter).not.toBe(coreBefore);
    });
  });
});
