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
  recomputeAllForTimezoneChange,
  setHeartbeatEnabled,
  sweepDueHeartbeats,
  triggerOnItemEventHeartbeats,
} from "../scheduler/schedulerStore.js";
import { createActionRegistry, CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
import { getSystemSettingsItemId } from "../systemSettings.js";
import { listAgentRunsByHeartbeat } from "../agentRuns/agentRunsStore.js";
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

  it("sweepDueHeartbeats fires a due heartbeat exactly once and advances next_fire_at", async () => {
    const projectItemId = await getSemprecProjectId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Every minute-ish",
        rule: { kind: "interval", minutes: 1 },
        actionId: "noop",
      }),
    );
    // Force it due "now" (simulating either a normal tick or catch-up after downtime).
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [heartbeat.id]);

    const fired = await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    expect(fired.map((f) => f.id)).toEqual([heartbeat.id]);

    const after = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id));
    expect(after!.lastFiredAt).not.toBeNull();
    expect(new Date(after!.nextFireAt!).getTime()).toBeGreaterThan(Date.now());

    // A second sweep right away finds nothing due.
    const fired2 = await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    expect(fired2).toHaveLength(0);
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
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [heartbeat.id]);
    await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    await drainQueue(registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeat.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("done");
    expect(runs[0].result).toBe("handled: process the inbox");
    expect(runs[0].triggeredBy).toBe("heartbeat");
  });

  describe("module-declared heartbeat rule kinds", () => {
    function fixtureModuleRuleKinds(nextFireAt: (rule: unknown, timezone: string, after: Date) => Date | null): HeartbeatRuleKindRegistry {
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
      await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [heartbeat.id]);

      const fired = await withTransaction(pool, (client) => sweepDueHeartbeats(client, moduleRuleKinds));
      expect(fired.map((f) => f.id)).toEqual([heartbeat.id]);

      const after = await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id, moduleRuleKinds));
      expect(after!.lastFiredAt).not.toBeNull();
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
      await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [heartbeat.id]);

      // The module is now deactivated: the sweep is run with no module rule kinds registered.
      const fired = await withTransaction(pool, (client) => sweepDueHeartbeats(client));
      expect(fired).toHaveLength(0);

      const { rows } = await pool.query("SELECT last_error, next_fire_at FROM project_heartbeats WHERE id = $1", [heartbeat.id]);
      expect(rows[0].last_error).toMatch(/Unknown heartbeat rule kind/);
      expect(rows[0].next_fire_at).not.toBeNull(); // left due, so reactivating the module lets the next sweep pick it up
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
      const before = (await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id, moduleRuleKinds)))!.nextFireAt;

      await withTransaction(pool, (client) => recomputeAllForTimezoneChange(client, "Pacific/Kiritimati", moduleRuleKinds));

      const after = (await withTransaction(pool, (client) => getHeartbeat(client, heartbeat.id, moduleRuleKinds)))!.nextFireAt;
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
      await expect(withTransaction(pool, (client) => recomputeAllForTimezoneChange(client, "Pacific/Kiritimati"))).resolves.toBeUndefined();

      const { rows } = await pool.query("SELECT last_error FROM project_heartbeats WHERE id = $1", [moduleHeartbeat.id]);
      expect(rows[0].last_error).toMatch(/Unknown heartbeat rule kind/);

      // The core heartbeat after it in the same batch still gets recomputed.
      const coreAfter = (await withTransaction(pool, (client) => getHeartbeat(client, coreHeartbeat.id)))!.nextFireAt;
      expect(coreAfter).not.toBe(coreBefore);
    });
  });
});
