import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runOnce } from "@alldots/queue";
import { getTraceContext, runInTenant } from "@alldots/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  inTenantZero,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import {
  createHeartbeat,
  getHeartbeat,
  occurrenceFireJobKey,
  prepareHeartbeatOccurrenceFire,
  recomputeAllForTimezoneChange,
  recordHeartbeatFireSetupFailure,
  setHeartbeatEnabled,
  sweepDueHeartbeats,
  updateHeartbeatRule,
} from "../scheduler/schedulerStore.js";
import {
  createActionRegistry,
  CORE_AGENT_RUN_ACTION_ID,
  coreAgentRunAction,
  type ActionRegistry,
} from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
import {
  createHeartbeatFireCoreTask,
  createHeartbeatFireAgentTask,
  handleHeartbeatSweepTask,
} from "../scheduler/sweep.js";
import { getSystemSettingsItemId, getSystemTimezone } from "../systemSettings.js";
import { createAgentRun, listAgentRunsByHeartbeat } from "../agentRuns/agentRunsStore.js";
import { createHeartbeatTriggerTool } from "../scheduler/heartbeatAgentTools.js";
import type { HeartbeatRule, HeartbeatRuleKindRegistry } from "../scheduler/rule.js";
import { computeNextFireAt } from "../scheduler/nextFireAt.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import type { InvalidationEvent } from "../realtimeHook.js";

type FireTask = ReturnType<typeof createHeartbeatFireCoreTask>;
type JobHelpers = Parameters<FireTask>[1];

let pool: Pool;
let chokePoint: ChokePoint;
let ownerUserId: string;

const DAILY: HeartbeatRule = { kind: "dailyTime", at: "09:00" };
const EVERY_MINUTE: HeartbeatRule = { kind: "interval", minutes: 1 };
const UNHANDLED = "No handler registered for heartbeat action 'unregistered'";

function jobHelpers(attempts = 1, jobId = "job-1"): JobHelpers {
  return { job: { id: jobId, attempts, max_attempts: 3 } } as JobHelpers;
}

async function drainQueue(registry = createActionRegistry()) {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, registry) });
}

/** A registry whose `actionId` handler only counts its calls. */
function countingRegistry(actionId = "noop"): { registry: ActionRegistry; ran: () => number } {
  let ran = 0;
  const registry = createActionRegistry();
  registry.set(actionId, async () => {
    ran += 1;
  });
  return { registry, ran: () => ran };
}

/** A registry whose `core.agentRun` runner answers `handled: <task>`. */
function agentRegistry(): ActionRegistry {
  const registry = createActionRegistry();
  registry.set(
    CORE_AGENT_RUN_ACTION_ID,
    coreAgentRunAction(pool, async ({ task }) => ({ result: `handled: ${task}` })),
  );
  return registry;
}

/** A pool whose `connect` is replaced; every other member is the test pool's. */
function poolWithConnect(connect: (target: Pool) => Promise<PoolClient>): Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "connect") return () => connect(target);
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function getAlldotsProjectId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id WHERE d.owner_module_id = 'projects' LIMIT 1`,
  );
  if (!rows[0]) throw new Error("Missing seeded project");
  return rows[0].id;
}

async function heartbeatWith(
  input: { rule: unknown; actionId?: string; name?: string; actionConfig?: Record<string, unknown> },
  moduleRuleKinds?: HeartbeatRuleKindRegistry,
) {
  const projectItemId = await getAlldotsProjectId();
  return withTransaction(pool, (client) =>
    createHeartbeat(
      client,
      {
        projectItemId,
        name: input.name ?? "Heartbeat",
        rule: input.rule,
        actionId: input.actionId ?? "noop",
        actionConfig: input.actionConfig,
      },
      moduleRuleKinds,
    ),
  );
}

const agentHeartbeat = (rule: HeartbeatRule = EVERY_MINUTE) =>
  heartbeatWith({
    name: "Process inbox",
    rule,
    actionId: CORE_AGENT_RUN_ACTION_ID,
    actionConfig: { task: "process the inbox" },
  });

/** Moves a heartbeat's schedule into the past so the production sweep picks it up. */
async function makeDue(heartbeatId: string, at?: Date): Promise<void> {
  const result = at
    ? await pool.query("UPDATE project_heartbeats SET next_fire_at = $2 WHERE id = $1", [heartbeatId, at])
    : await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
        heartbeatId,
      ]);
  expect(result.rowCount).toBe(1);
}

const sweep = (moduleRuleKinds?: HeartbeatRuleKindRegistry) =>
  inTenantZero(() => withTransaction(pool, (client) => sweepDueHeartbeats(client, moduleRuleKinds)));

async function read(heartbeatId: string, moduleRuleKinds?: HeartbeatRuleKindRegistry) {
  const heartbeat = await withTransaction(pool, (client) => getHeartbeat(client, heartbeatId, moduleRuleKinds));
  if (!heartbeat) throw new Error("Missing heartbeat");
  return heartbeat;
}

async function occurrences(heartbeatId: string) {
  const { rows } = await pool.query<{ id: string; generation: number; status: string; rule_snapshot: unknown }>(
    "SELECT id, generation, status, rule_snapshot FROM heartbeat_occurrences WHERE heartbeat_id = $1 ORDER BY scheduled_for",
    [heartbeatId],
  );
  return rows;
}

async function lastError(heartbeatId: string): Promise<string | null | undefined> {
  const { rows } = await pool.query<{ last_error: string | null }>(
    "SELECT last_error FROM project_heartbeats WHERE id = $1",
    [heartbeatId],
  );
  return rows[0]?.last_error;
}

async function notificationKinds(heartbeatId: string): Promise<{ kind: string }[]> {
  const { rows } = await pool.query<{ kind: string }>("SELECT kind FROM notifications WHERE source_id = $1", [
    heartbeatId,
  ]);
  return rows;
}

describe("scheduler", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
    const owner = await createUser(pool, {
      email: "owner@example.test",
      passwordHash: await hashPassword("s3cret-password"),
      locale: "en",
      tenantId: getTenantZeroId(),
    });
    ownerUserId = owner.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("computes next_fire_at at write time, clears it on disable and recomputes it on re-enable", async () => {
    const heartbeat = await heartbeatWith({ rule: DAILY });
    expect(heartbeat.nextFireAt).not.toBeNull();
    const disabled = await withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, false));
    expect(disabled.nextFireAt).toBeNull();
    const reenabled = await withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, true));
    expect(reenabled.nextFireAt).not.toBeNull();
  });

  it("onItemEvent heartbeats have no next_fire_at, are invisible to the sweep and fire through the choke point's write path", async () => {
    const db = await chokePoint.createDatabase({ name: "Watched" });
    const { registry, ran } = countingRegistry("markRan");
    const heartbeat = await heartbeatWith({
      rule: { kind: "onItemEvent", databaseId: db.id, event: "create" },
      actionId: "markRan",
    });
    expect(heartbeat.nextFireAt).toBeNull();
    expect((await sweep()).fired).toHaveLength(0);

    await inTenantZero(() => chokePoint.createItem({ databaseId: db.id, properties: {} }));
    await drainQueue(registry);
    expect(ran()).toBe(1);
  });

  it("creates an unchained run for an item-event fire through the worker", async () => {
    const db = await chokePoint.createDatabase({ name: "Event-run evidence" });
    const heartbeat = await heartbeatWith({
      rule: { kind: "onItemEvent", databaseId: db.id, event: "create" },
      actionId: CORE_AGENT_RUN_ACTION_ID,
      actionConfig: { task: "event" },
    });
    await inTenantZero(() => chokePoint.createItem({ databaseId: db.id, properties: {} }));
    await drainQueue(agentRegistry());
    const runs = await listAgentRunsByHeartbeat(pool, heartbeat.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "done", heartbeatOccurrenceId: null, retryOfRunId: null, attempt: 1 });
  });

  it("sweepDueHeartbeats fires a due heartbeat exactly once", async () => {
    const heartbeat = await heartbeatWith({ rule: EVERY_MINUTE });
    // A normal tick or catch-up after downtime.
    await makeDue(heartbeat.id);

    expect((await sweep()).fired.map((f) => f.id)).toEqual([heartbeat.id]);
    await drainQueue(countingRegistry().registry);
    const after = await read(heartbeat.id);
    expect(after.lastFiredAt).not.toBeNull();
    expect(new Date(after.nextFireAt!).getTime()).toBeGreaterThan(Date.now());
    expect((await sweep()).fired).toHaveLength(0);
  });

  it.each([false, true])(
    "chains scheduled retries through the queue worker (final failure: %s)",
    async (finalFailure) => {
      const heartbeat = await heartbeatWith({
        rule: EVERY_MINUTE,
        actionId: CORE_AGENT_RUN_ACTION_ID,
        actionConfig: { task: "retry" },
      });
      await makeDue(heartbeat.id);
      await sweep();
      let calls = 0;
      const registry = createActionRegistry();
      registry.set(
        CORE_AGENT_RUN_ACTION_ID,
        coreAgentRunAction(pool, async () => {
          calls += 1;
          if (calls < 3 || finalFailure) throw new Error("retry test failure");
        }),
      );
      const errorNotifications = async () =>
        (await pool.query<{ source_id: string }>("SELECT source_id FROM notifications WHERE kind = 'agent_run_error'"))
          .rows;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await drainQueue(registry);
        if (attempt === 3) break;
        expect(await errorNotifications()).toEqual([]);
        const { rows } = await pool.query<{ id: string; attempts: number }>(
          "SELECT id::text, attempts FROM graphile_worker.jobs WHERE key LIKE $1",
          [`heartbeat-fire:${heartbeat.id}:%`],
        );
        expect(rows).toMatchObject([{ attempts: attempt }]);
        const rescheduled = await pool.query("SELECT * FROM graphile_worker.reschedule_jobs($1::bigint[], now())", [
          [rows[0]!.id],
        ]);
        expect(rescheduled.rowCount).toBe(1);
      }
      const runs = (await listAgentRunsByHeartbeat(pool, heartbeat.id)).sort((a, b) => a.attempt - b.attempt);
      expect(runs.map((run) => run.attempt)).toEqual([1, 2, 3]);
      expect(runs.map((run) => run.status)).toEqual(["error", "error", finalFailure ? "error" : "done"]);
      const occurrenceId = runs[0]?.heartbeatOccurrenceId;
      expect(occurrenceId).toBeTruthy();
      expect(runs.map((run) => run.heartbeatOccurrenceId)).toEqual([occurrenceId, occurrenceId, occurrenceId]);
      expect(runs.map((run) => run.retryOfRunId)).toEqual([null, runs[0]?.id, runs[1]?.id]);
      expect(await errorNotifications()).toEqual(finalFailure ? [{ source_id: runs[2]?.id }] : []);
    },
  );

  it("a floating (interval/everyNDays) heartbeat leaves next_fire_at and last_fired_at unset at sweep time, and schedules its next occurrence from the first attempt's actual start, not enqueue time", async () => {
    const heartbeat = await heartbeatWith({ rule: EVERY_MINUTE });
    await makeDue(heartbeat.id);
    await sweep();
    expect(await read(heartbeat.id)).toMatchObject({ nextFireAt: null, lastFiredAt: null });

    const beforeFire = Date.now();
    await drainQueue(countingRegistry().registry);
    const afterFire = await read(heartbeat.id);
    expect(new Date(afterFire.lastFiredAt!).getTime()).toBeGreaterThanOrEqual(beforeFire);
    expect(new Date(afterFire.nextFireAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("a fixed (dailyTime/weekly) heartbeat advances next_fire_at immediately at sweep time, unaffected by queue delay before the fire task actually runs", async () => {
    const heartbeat = await heartbeatWith({ rule: DAILY });
    await makeDue(heartbeat.id);
    await sweep();
    const afterSweep = await read(heartbeat.id);
    expect(afterSweep.nextFireAt).not.toBeNull();
    expect(afterSweep.lastFiredAt).toBeNull();

    await drainQueue(countingRegistry().registry);
    const afterFire = await read(heartbeat.id);
    expect(afterFire.lastFiredAt).not.toBeNull();
    // The fire task's own start time never shifts a fixed rule's calendar-anchored schedule.
    expect(afterFire.nextFireAt).toBe(afterSweep.nextFireAt);
  });

  it("changing the system timezone recomputes next_fire_at for enabled time-based heartbeats", async () => {
    const heartbeat = await heartbeatWith({ rule: DAILY });
    const settingsItemId = await withTransaction(pool, (client) => getSystemSettingsItemId(client));
    const { rows } = await pool.query<{ database_id: string }>("SELECT database_id FROM items WHERE id = $1", [
      settingsItemId,
    ]);
    await chokePoint.updateItem({
      databaseId: rows[0]!.database_id,
      itemId: settingsItemId,
      propertiesPatch: { timezone: "Pacific/Kiritimati" },
    });
    expect((await read(heartbeat.id)).nextFireAt).not.toBe(heartbeat.nextFireAt);
  });

  it("recomputes for a transform-added timezone and rolls back an invalid one", async () => {
    const heartbeat = await heartbeatWith({ rule: DAILY });
    const settingsId = await withTransaction(pool, (client) => getSystemSettingsItemId(client));
    const settings = await pool.query<{ database_id: string }>("SELECT database_id FROM items WHERE id = $1", [
      settingsId,
    ]);
    const databaseId = settings.rows[0]?.database_id;
    if (!databaseId) throw new Error("Missing system settings database");
    vi.resetModules();
    const hooks = await import("../chokePoint/hooks.js");
    const search = await import("../search/itemSearchIndexer.js");
    const searchUpdate = vi.spyOn(search, "itemSearchUpdateHook");
    await import("../domainWriteHooks.js");
    const isolated = await import("../chokePoint/chokePoint.js");
    const isolatedRealtime = await import("../realtimeHook.js");
    try {
      hooks.registerItemPreWriteTransform("systemSettings", async ({ patch }) => ({
        ...patch,
        timezone: patch.name === "invalid" ? "Not/A_Zone" : "Pacific/Kiritimati",
      }));
      const cp = isolated.createChokePoint(pool);
      const events: InvalidationEvent[] = [];
      isolatedRealtime.setInvalidationHook((event) => events.push(event));
      await cp.updateItem({ databaseId, itemId: settingsId, propertiesPatch: { name: "valid" } });
      expect(searchUpdate).toHaveBeenCalledOnce();
      expect(events).toMatchObject([{ scope: "item", itemId: settingsId, op: "update" }]);
      events.length = 0;
      const after = (await read(heartbeat.id)).nextFireAt;
      expect(after).not.toBe(heartbeat.nextFireAt);
      const persisted = await cp.getItem(databaseId, settingsId);
      expect(persisted?.properties).toMatchObject({ name: "valid", timezone: "Pacific/Kiritimati" });
      const readSearchIndex = () =>
        pool.query<{ item_id: string; updated_at: Date; body: string | null; search_vector: string }>(
          "SELECT item_id, updated_at, body, search_vector::text FROM item_search_index WHERE item_id = $1",
          [settingsId],
        );
      const searchBefore = await readSearchIndex();
      expect(searchBefore.rowCount).toBe(1);
      await expect(
        cp.updateItem({ databaseId, itemId: settingsId, propertiesPatch: { name: "invalid" } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed" });
      expect((await cp.getItem(databaseId, settingsId))?.properties).toEqual(persisted?.properties);
      expect((await read(heartbeat.id)).nextFireAt).toBe(after);
      expect(events).toEqual([]);
      expect(searchUpdate).toHaveBeenCalledTimes(2);
      expect((await readSearchIndex()).rows).toEqual(searchBefore.rows);
    } finally {
      isolatedRealtime.setInvalidationHook(() => {});
      hooks.clearHooksForTests();
      searchUpdate.mockRestore();
      vi.resetModules();
    }
  });

  it("core.agentRun creates an agent_runs row, calls the injected runner under a trace context bound to the new run, and records the delegation trail", async () => {
    const observed: { traceId: string | undefined; agentRunId: string | undefined }[] = [];
    const registry = createActionRegistry();
    registry.set(
      CORE_AGENT_RUN_ACTION_ID,
      coreAgentRunAction(pool, async ({ task }) => {
        const ctx = getTraceContext();
        observed.push({ traceId: ctx?.traceId, agentRunId: ctx?.agentRunId });
        return { result: `handled: ${task}` };
      }),
    );
    const heartbeat = await agentHeartbeat();
    await makeDue(heartbeat.id);
    await sweep();
    await drainQueue(registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeat.id);
    expect(runs).toMatchObject([{ status: "done", result: "handled: process the inbox", triggeredBy: "heartbeat" }]);
    expect(observed).toEqual([{ agentRunId: runs[0]!.id, traceId: expect.stringMatching(/^[0-9a-f-]{36}$/i) }]);
  });

  it("heartbeat.trigger's manual fire attributes the child run's parent_run_id to the invoking run, without touching next_fire_at/last_fired_at", async () => {
    const heartbeat = await agentHeartbeat({ kind: "interval", minutes: 5 });
    const before = await read(heartbeat.id);
    const invokingRun = await createAgentRun(pool, {
      projectItemId: await getAlldotsProjectId(),
      triggeredBy: "user",
      task: "trigger it",
    });
    const outcome = await inTenantZero(() =>
      createHeartbeatTriggerTool(pool)(invokingRun.id, { heartbeatId: heartbeat.id }),
    );
    expect(outcome.error).toBe(false);
    await drainQueue(agentRegistry());

    expect(await listAgentRunsByHeartbeat(pool, heartbeat.id)).toMatchObject([
      { triggeredBy: "heartbeat", parentRunId: invokingRun.id },
    ]);
    const after = await read(heartbeat.id);
    expect(after.nextFireAt).toBe(before.nextFireAt);
    expect(after.lastFiredAt).toBe(before.lastFiredAt);
  });

  it("an occurrence insert conflicting on (heartbeat_id, scheduled_for) is an idempotent no-op: no second job, no second next_fire_at advance", async () => {
    const heartbeat = await heartbeatWith({ rule: DAILY });
    const dueAt = new Date(Date.now() - 60_000);
    await makeDue(heartbeat.id, dueAt);
    // Another sweep already recorded the occurrence for this due time without advancing next_fire_at.
    await pool.query(
      `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
       VALUES ($1, $2, $3::jsonb, 'queued')`,
      [heartbeat.id, dueAt, JSON.stringify(heartbeat.rule)],
    );

    expect((await sweep()).fired).toHaveLength(0);
    expect(await occurrences(heartbeat.id)).toHaveLength(1);
    // The no-op branch never reaches the next_fire_at update: still the due time from before this call.
    expect(new Date((await read(heartbeat.id)).nextFireAt!).getTime()).toBe(dueAt.getTime());
  });

  it("a retried fire attempt reuses the persisted occurrenceId and first_started_at, and never advances next_fire_at a second time", async () => {
    const heartbeat = await heartbeatWith({ rule: EVERY_MINUTE });
    await makeDue(heartbeat.id);
    expect((await sweep()).fired).toHaveLength(1);
    const occurrenceId = (await occurrences(heartbeat.id))[0]!.id;

    expect((await prepareHeartbeatOccurrenceFire(pool, heartbeat.id, occurrenceId, 1)).outcome).toBe("proceed");
    const afterFirst = await read(heartbeat.id);
    expect(afterFirst.nextFireAt).not.toBeNull();
    expect(afterFirst.lastFiredAt).not.toBeNull();

    // A retried job reuses the occurrenceId; the "genuine first attempt" branch must not fire again.
    expect((await prepareHeartbeatOccurrenceFire(pool, heartbeat.id, occurrenceId, 1)).outcome).toBe("proceed");
    const afterRetry = await read(heartbeat.id);
    expect(afterRetry.nextFireAt).toBe(afterFirst.nextFireAt);
    expect(afterRetry.lastFiredAt).toBe(afterFirst.lastFiredAt);
  });

  it.each([
    {
      change: "the heartbeat was disabled",
      apply: (client: PoolClient, id: string) => setHeartbeatEnabled(client, id, false),
      // Disabling already cleared next_fire_at; the fire task must not have touched it further.
      nextFireAt: null,
    },
    {
      change: "the heartbeat's rule was edited",
      apply: (client: PoolClient, id: string) => updateHeartbeatRule(client, id, { kind: "dailyTime", at: "10:30" }),
      nextFireAt: expect.any(String),
    },
  ])(
    "cancels the occurrence without executing or recording a fire when $change after the occurrence was enqueued",
    async ({ apply, nextFireAt }) => {
      const { registry, ran } = countingRegistry("markRan");
      const heartbeat = await heartbeatWith({ rule: DAILY, actionId: "markRan" });
      await makeDue(heartbeat.id);
      await sweep();
      await withTransaction(pool, (client) => apply(client, heartbeat.id));

      await drainQueue(registry);
      expect(ran()).toBe(0);
      expect(await occurrences(heartbeat.id)).toMatchObject([{ status: "cancelled" }]);
      expect(await read(heartbeat.id)).toMatchObject({ nextFireAt, lastFiredAt: null });
    },
  );

  it("reactivates a cancelled occurrence when disable/re-enable recomputes the schedule back onto its exact timestamp, firing exactly once under the new generation instead of staying cancelled", async () => {
    const { registry, ran } = countingRegistry("markRan");
    const heartbeat = await heartbeatWith({ rule: DAILY, actionId: "markRan" });
    const dueAt = new Date(Date.now() - 60_000);
    await makeDue(heartbeat.id, dueAt);
    await sweep();

    // Disabled before the fire task ran: it cancels the occurrence instead of executing it.
    await withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, false));
    await drainQueue(registry);
    expect(ran()).toBe(0);
    const [cancelled] = await occurrences(heartbeat.id);
    expect(cancelled).toMatchObject({ status: "cancelled", generation: 1 });
    const occurrenceId = cancelled!.id;

    // Re-enable and force the recomputed schedule back onto the cancelled occurrence's timestamp
    // (edit-away/edit-back landing on the same instant).
    await withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, true));
    await makeDue(heartbeat.id, dueAt);
    expect((await sweep()).fired.map((f) => f.id)).toEqual([heartbeat.id]);
    expect(await occurrences(heartbeat.id)).toMatchObject([{ id: occurrenceId, generation: 2, status: "queued" }]);

    // A stale generation 1 delivery after the reactivation must never consume or cancel the reactivated occurrence.
    expect((await prepareHeartbeatOccurrenceFire(pool, heartbeat.id, occurrenceId, 1)).outcome).toBe("stale");
    expect(await occurrences(heartbeat.id)).toMatchObject([{ status: "queued" }]);

    // The new generation's job fires the current rule exactly once.
    await drainQueue(registry);
    expect(ran()).toBe(1);
    expect(await occurrences(heartbeat.id)).toMatchObject([{ id: occurrenceId, status: "succeeded" }]);
  });

  it("replaces a queued occurrence's stale rule_snapshot in place (preserving its id/status) when a re-edit recomputes the schedule back onto the same still-pending timestamp, and the new generation fires exactly once", async () => {
    const { registry, ran } = countingRegistry();
    const heartbeat = await heartbeatWith({ rule: DAILY });
    const dueAt = new Date(Date.now() - 60_000);
    await makeDue(heartbeat.id, dueAt);
    await sweep();
    const [queued] = await occurrences(heartbeat.id);
    expect(queued).toMatchObject({ status: "queued", generation: 1, rule_snapshot: DAILY });

    // Edit the rule while the occurrence is still queued, then force the schedule back onto the same pending
    // timestamp, a race the unique (heartbeat_id, scheduled_for) index can surface.
    const edited = { kind: "dailyTime", at: "10:30" } as const;
    await withTransaction(pool, (client) => updateHeartbeatRule(client, heartbeat.id, edited));
    await makeDue(heartbeat.id, dueAt);
    expect((await sweep()).fired.map((f) => f.id)).toEqual([heartbeat.id]);
    expect(await occurrences(heartbeat.id)).toEqual([
      { id: queued!.id, status: "queued", generation: 2, rule_snapshot: edited },
    ]);

    // A handler for the stale generation 1 job sees the fresh snapshot once it has the lock and proceeds as a first attempt.
    await drainQueue(registry);
    expect(ran()).toBe(1);
    expect(await occurrences(heartbeat.id)).toMatchObject([{ id: queued!.id, status: "succeeded" }]);
  });

  it("distinct scheduled occurrences for the same heartbeat get distinct job keys", async () => {
    const heartbeat = await heartbeatWith({ rule: DAILY });
    for (let n = 0; n < 2; n += 1) {
      await makeDue(heartbeat.id);
      await sweep();
    }
    const rows = await occurrences(heartbeat.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => occurrenceFireJobKey(heartbeat.id, r.id, r.generation))).size).toBe(2);
  });

  it("two overlapping sweeps still fire a due heartbeat exactly once", async () => {
    const { registry, ran } = countingRegistry();
    const heartbeat = await heartbeatWith({ rule: DAILY });
    await makeDue(heartbeat.id);

    // `FOR UPDATE SKIP LOCKED` in sweepDueHeartbeats means two concurrent sweeps never both select this row.
    const [resultA, resultB] = await Promise.all([sweep(), sweep()]);
    expect(resultA.fired.length + resultB.fired.length).toBe(1);
    expect(await occurrences(heartbeat.id)).toHaveLength(1);
    await drainQueue(registry);
    expect(ran()).toBe(1);
  });

  it.each([
    { name: "createHeartbeatFireCoreTask", create: createHeartbeatFireCoreTask, extra: [{ triggeredByRunId: "r1" }] },
    { name: "createHeartbeatFireAgentTask", create: createHeartbeatFireAgentTask, extra: [] },
  ])(
    "$name rejects a payload carrying zero or more than one of occurrenceId/itemId/triggeredByRunId with validation_failed",
    async ({ create, extra }) => {
      const task = create(pool, createActionRegistry());
      for (const payload of [
        {},
        { occurrenceId: "o1", itemId: "i1" },
        ...extra.map((e) => ({ occurrenceId: "o1", ...e })),
      ]) {
        await expect(task({ heartbeatId: "h1", ...payload }, jobHelpers())).rejects.toMatchObject({
          code: "validation_failed",
        });
      }
    },
  );

  it("createHeartbeatFireAgentTask runs the core.agentRun handler for an agent-session heartbeat", async () => {
    const heartbeat = await agentHeartbeat();
    await createHeartbeatFireAgentTask(pool, agentRegistry())(
      { heartbeatId: heartbeat.id, itemId: "unused" },
      jobHelpers(),
    );
    expect(await listAgentRunsByHeartbeat(pool, heartbeat.id)).toMatchObject([
      { status: "done", result: "handled: process the inbox\nTriggering item id: unused" },
    ]);
  });

  it.each([
    {
      title: "createHeartbeatFireCoreTask rejects a core.agentRun heartbeat",
      agent: true,
      scheduled: false,
      create: createHeartbeatFireCoreTask,
      message: /resolves to 'heartbeatFireAgent'.*dispatched to the 'api' runtime/,
    },
    {
      title: "createHeartbeatFireCoreTask rejects a scheduled (occurrenceId) fire of a core.agentRun heartbeat",
      agent: true,
      scheduled: true,
      create: createHeartbeatFireCoreTask,
      message: /resolves to 'heartbeatFireAgent'.*dispatched to the 'api' runtime/,
    },
    {
      title: "createHeartbeatFireAgentTask rejects a deterministic heartbeat",
      agent: false,
      scheduled: false,
      create: createHeartbeatFireAgentTask,
      message: /resolves to 'heartbeatFireCore'.*dispatched to the 'agents' runtime/,
    },
  ])("$title with an affinity-mismatch error instead of running it", async ({ agent, scheduled, create, message }) => {
    const counting = countingRegistry();
    const heartbeat = agent ? await agentHeartbeat(DAILY) : await heartbeatWith({ rule: DAILY });
    let payload: Record<string, unknown> = { itemId: "unused" };
    if (scheduled) {
      await makeDue(heartbeat.id);
      expect((await sweep()).fired).toHaveLength(1);
      payload = { occurrenceId: (await occurrences(heartbeat.id))[0]!.id, generation: 1 };
    }
    const task = create(pool, agent ? agentRegistry() : counting.registry);
    await expect(task({ heartbeatId: heartbeat.id, ...payload }, jobHelpers())).rejects.toThrow(message);
    expect(await listAgentRunsByHeartbeat(pool, heartbeat.id)).toHaveLength(0);
    expect(counting.ran()).toBe(0);
  });

  it("writes a heartbeat_error notification on the final retry attempt, deduped by job id but not across distinct failing jobs", async () => {
    const heartbeat = await heartbeatWith({ name: "Always fails", rule: DAILY, actionId: "alwaysFails" });
    const registry = createActionRegistry();
    registry.set("alwaysFails", async () => {
      throw new Error("boom");
    });
    const task = createHeartbeatFireCoreTask(pool, registry);
    const failFinal = (jobId: string) =>
      expect(task({ heartbeatId: heartbeat.id, itemId: "unused" }, jobHelpers(3, jobId))).rejects.toThrow("boom");

    await failFinal("job-1");
    const { rows } = await pool.query(
      `SELECT user_id, kind, title, source_table, source_id, transition_instance FROM notifications WHERE source_id = $1`,
      [heartbeat.id],
    );
    expect(rows).toMatchObject([
      {
        user_id: ownerUserId,
        kind: "heartbeat_error",
        title: `Heartbeat "Always fails" failed`,
        source_table: "project_heartbeats",
        transition_instance: "job-1",
      },
    ]);
    // Redelivery (e.g. a crash after this insert, before the job's failure is recorded) must not duplicate the notification.
    await failFinal("job-1");
    expect(await notificationKinds(heartbeat.id)).toHaveLength(1);
    // A later, independent failure (a new job) is a different transition and does insert.
    await failFinal("job-2");
    expect(await notificationKinds(heartbeat.id)).toHaveLength(2);
  });

  describe("fire failures before the action handler runs", () => {
    function poolWithFailingConnects(errors: Error[]): Pool {
      const remaining = [...errors];
      return poolWithConnect((target) => {
        const next = remaining.shift();
        return next ? Promise.reject(next) : target.connect();
      });
    }

    async function sweepFloatingHeartbeat(): Promise<{ heartbeatId: string; occurrenceId: string }> {
      const heartbeat = await heartbeatWith({ name: "Floating", rule: { kind: "interval", minutes: 30 } });
      await makeDue(heartbeat.id);
      await sweep();
      const rows = await occurrences(heartbeat.id);
      expect(rows).toMatchObject([{ status: "queued" }]);
      return { heartbeatId: heartbeat.id, occurrenceId: rows[0]!.id };
    }

    async function readState(heartbeatId: string, occurrenceId: string) {
      const { rows: heartbeatRows } = await pool.query<{
        next_fire_at: Date | null;
        last_error: string | null;
        in_future: boolean | null;
      }>("SELECT next_fire_at, last_error, next_fire_at > now() AS in_future FROM project_heartbeats WHERE id = $1", [
        heartbeatId,
      ]);
      const { rows: occurrenceRows } = await pool.query<{ status: string; last_error: string | null }>(
        "SELECT status, last_error FROM heartbeat_occurrences WHERE id = $1",
        [occurrenceId],
      );
      return {
        heartbeat: heartbeatRows[0]!,
        occurrence: occurrenceRows[0]!,
        notifications: await notificationKinds(heartbeatId),
      };
    }

    it.each([
      {
        title: "on the final attempt, restores a floating heartbeat's next_fire_at and records the failure",
        attempts: 3,
        expected: {
          heartbeat: { next_fire_at: expect.any(Date), in_future: true, last_error: "simulated database outage" },
          occurrence: { status: "failed", last_error: "simulated database outage" },
          notifications: [{ kind: "heartbeat_error" }],
        },
      },
      {
        title: "records nothing on a non-final attempt",
        attempts: 1,
        expected: {
          heartbeat: { next_fire_at: null, last_error: null },
          occurrence: { status: "queued", last_error: null },
          notifications: [],
        },
      },
    ])("$title when preparation throws", async ({ attempts, expected }) => {
      const { heartbeatId, occurrenceId } = await sweepFloatingHeartbeat();
      const task = createHeartbeatFireCoreTask(
        poolWithFailingConnects([new Error("simulated database outage")]),
        countingRegistry().registry,
      );
      await expect(task({ heartbeatId, occurrenceId, generation: 1 }, jobHelpers(attempts))).rejects.toThrow(
        "simulated database outage",
      );
      expect(await readState(heartbeatId, occurrenceId)).toMatchObject(expected);
    });

    it("rethrows the original error, not the close-out's, when recording the setup failure fails too", async () => {
      const { heartbeatId, occurrenceId } = await sweepFloatingHeartbeat();
      const task = createHeartbeatFireCoreTask(
        poolWithFailingConnects([new Error("simulated database outage"), new Error("close-out outage")]),
        createActionRegistry(),
      );
      await expect(task({ heartbeatId, occurrenceId, generation: 1 }, jobHelpers(3))).rejects.toThrow(
        "simulated database outage",
      );
      const state = await readState(heartbeatId, occurrenceId);
      expect(state.heartbeat.last_error).toBeNull();
      expect(state.occurrence.status).toBe("queued");
    });

    it("fails a scheduled occurrence with no registered handler on the final attempt without moving a fixed rule's next_fire_at", async () => {
      const heartbeat = await heartbeatWith({ rule: DAILY, actionId: "unregistered" });
      await makeDue(heartbeat.id);
      await sweep();
      const occurrenceId = (await occurrences(heartbeat.id))[0]!.id;
      const before = await readState(heartbeat.id, occurrenceId);
      expect(before.heartbeat.next_fire_at).not.toBeNull();

      const task = createHeartbeatFireCoreTask(pool, createActionRegistry());
      await expect(task({ heartbeatId: heartbeat.id, occurrenceId, generation: 1 }, jobHelpers(3))).rejects.toThrow(
        UNHANDLED,
      );
      expect(await readState(heartbeat.id, occurrenceId)).toMatchObject({
        heartbeat: { next_fire_at: before.heartbeat.next_fire_at, last_error: UNHANDLED },
        occurrence: { status: "failed", last_error: UNHANDLED },
        notifications: [{ kind: "heartbeat_error" }],
      });
    });

    it("records last_error and a notification for a manual fire with no registered handler on the final attempt", async () => {
      const heartbeat = await heartbeatWith({ rule: DAILY, actionId: "unregistered" });
      const task = createHeartbeatFireCoreTask(pool, createActionRegistry());
      await expect(
        task({ heartbeatId: heartbeat.id, triggeredByRunId: "00000000-0000-0000-0000-000000000001" }, jobHelpers(3)),
      ).rejects.toThrow(UNHANDLED);
      expect((await read(heartbeat.id)).lastError).toBe(UNHANDLED);
      expect(await notificationKinds(heartbeat.id)).toEqual([{ kind: "heartbeat_error" }]);
    });

    it("recordHeartbeatFireSetupFailure still records last_error when the unscheduled rule can no longer be parsed", async () => {
      const { heartbeatId, occurrenceId } = await sweepFloatingHeartbeat();
      await pool.query(`UPDATE project_heartbeats SET rule = '{"kind":"retiredKind"}'::jsonb WHERE id = $1`, [
        heartbeatId,
      ]);
      const failed = await withTransaction(pool, (client) =>
        recordHeartbeatFireSetupFailure(client, heartbeatId, occurrenceId, "boom"),
      );
      expect(failed).toEqual({ id: heartbeatId, name: "Floating" });
      const state = await readState(heartbeatId, occurrenceId);
      expect(state.heartbeat.next_fire_at).toBeNull();
      expect(state.heartbeat.last_error).toMatch(/^boom; schedule could not be restored: .+/);
      expect(state.occurrence).toEqual({ status: "failed", last_error: "boom" });
    });

    it("recordHeartbeatFireSetupFailure leaves a terminal occurrence alone and returns null for a deleted heartbeat", async () => {
      const { heartbeatId, occurrenceId } = await sweepFloatingHeartbeat();
      await pool.query("UPDATE heartbeat_occurrences SET status = 'succeeded' WHERE id = $1", [occurrenceId]);
      await withTransaction(pool, (client) =>
        recordHeartbeatFireSetupFailure(client, heartbeatId, occurrenceId, "boom"),
      );
      const state = await readState(heartbeatId, occurrenceId);
      expect(state.occurrence).toEqual({ status: "succeeded", last_error: null });
      expect(state.heartbeat.last_error).toBe("boom");

      await pool.query("DELETE FROM project_heartbeats WHERE id = $1", [heartbeatId]);
      const failed = await withTransaction(pool, (client) =>
        recordHeartbeatFireSetupFailure(client, heartbeatId, undefined, "boom"),
      );
      expect(failed).toBeNull();
    });
  });

  describe("module-declared heartbeat rule kinds", () => {
    const WIDGET_RULE = { kind: "fixtureModule.onWidgetTick", every: 5 };
    const moduleRuleKinds: HeartbeatRuleKindRegistry = new Map([
      [
        "fixtureModule.onWidgetTick",
        {
          schema: { safeParse: (raw: unknown) => ({ success: true, data: raw }) },
          nextFireAt: (_rule: unknown, _tz: string, after: Date) => new Date(after.getTime() + 60_000),
        },
      ],
    ]);
    const widgetHeartbeat = (actionId = "noop") =>
      heartbeatWith({ name: "Widget tick", rule: WIDGET_RULE, actionId }, moduleRuleKinds);

    it("creates and schedules a heartbeat using an active module's rule kind, and refuses it while the module is inactive", async () => {
      const heartbeat = await widgetHeartbeat();
      expect(heartbeat.nextFireAt).not.toBeNull();
      expect(heartbeat.rule).toEqual(WIDGET_RULE);
      await expect(heartbeatWith({ rule: WIDGET_RULE })).rejects.toThrow(/Unknown heartbeat rule kind/);
    });

    it("sweep dispatches a due module-kind heartbeat via its nextFireAtExport", async () => {
      const heartbeat = await widgetHeartbeat();
      await makeDue(heartbeat.id);
      expect((await sweep(moduleRuleKinds)).fired.map((f) => f.id)).toEqual([heartbeat.id]);
      // A module rule kind is treated like a core fixed rule (only `everyNDays`/`interval` float): the sweep
      // advances next_fire_at via the fixture's nextFireAtExport at once.
      const after = await read(heartbeat.id, moduleRuleKinds);
      expect(after.nextFireAt).not.toBeNull();
      expect(after.lastFiredAt).toBeNull();
    });

    it("a heartbeat whose module rule kind became inactive is skipped by the sweep, not dispatched", async () => {
      const heartbeat = await widgetHeartbeat();
      await makeDue(heartbeat.id);
      // The module is now deactivated: the sweep is run with no module rule kinds registered.
      expect((await sweep()).fired).toHaveLength(0);
      const { rows } = await pool.query<{ last_error: string; next_fire_at: Date | null }>(
        "SELECT last_error, next_fire_at FROM project_heartbeats WHERE id = $1",
        [heartbeat.id],
      );
      expect(rows[0]!.last_error).toMatch(/Unknown heartbeat rule kind/);
      // Left due, so reactivating the module lets the next sweep pick it up.
      expect(rows[0]!.next_fire_at).not.toBeNull();
    });

    it("a heartbeat whose module rule kind became inactive can be disabled but not re-enabled (there is no calculator to schedule it with)", async () => {
      const heartbeat = await widgetHeartbeat();
      // The module is now deactivated: both calls run with no module rule kinds registered.
      const disabled = await withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, false));
      expect(disabled).toMatchObject({ enabled: false, nextFireAt: null, rule: WIDGET_RULE });
      await expect(withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, true))).rejects.toThrow(
        /Unknown heartbeat rule kind/,
      );
    });

    it("a heartbeat whose module rule kind became inactive can be updated to a new (core) rule", async () => {
      const heartbeat = await widgetHeartbeat();
      const updated = await withTransaction(pool, (client) => updateHeartbeatRule(client, heartbeat.id, DAILY));
      expect(updated.rule).toEqual(DAILY);
      expect(updated.nextFireAt).not.toBeNull();
    });

    it("the fire job degrades gracefully when its module rule kind is deactivated between sweep and fire, instead of retrying and losing the run", async () => {
      const { registry, ran } = countingRegistry("markRan");
      const heartbeat = await widgetHeartbeat("markRan");
      await makeDue(heartbeat.id);
      expect((await sweep(moduleRuleKinds)).fired.map((f) => f.id)).toEqual([heartbeat.id]);

      // The module is deactivated when the fire job runs (no moduleRegistry): the task must record the failure
      // and skip firing rather than throw and retry.
      await expect(drainQueue(registry)).resolves.not.toThrow();
      expect(ran()).toBe(0);
      expect(await lastError(heartbeat.id)).toMatch(/Unknown heartbeat rule kind/);
    });

    it("recomputeAllForTimezoneChange recomputes a heartbeat using an active module's rule kind", async () => {
      const heartbeat = await widgetHeartbeat();
      await withTransaction(pool, (client) =>
        recomputeAllForTimezoneChange(client, "Pacific/Kiritimati", moduleRuleKinds),
      );
      const after = (await read(heartbeat.id, moduleRuleKinds)).nextFireAt;
      expect(after).not.toBeNull();
      expect(after).not.toBe(heartbeat.nextFireAt);
    });

    it("recomputeAllForTimezoneChange skips a heartbeat whose module rule kind became inactive, without aborting the batch", async () => {
      const moduleHeartbeat = await widgetHeartbeat();
      const coreHeartbeat = await heartbeatWith({ rule: DAILY });
      // The module is now deactivated: recompute runs with no module rule kinds registered.
      await expect(
        withTransaction(pool, (client) => recomputeAllForTimezoneChange(client, "Pacific/Kiritimati")),
      ).resolves.toBeUndefined();
      expect(await lastError(moduleHeartbeat.id)).toMatch(/Unknown heartbeat rule kind/);
      expect((await read(coreHeartbeat.id)).nextFireAt).not.toBe(coreHeartbeat.nextFireAt);
    });
  });

  describe("chunked sweep", () => {
    async function insertDueDailyHeartbeats(count: number): Promise<string[]> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO project_heartbeats (project_item_id, name, rule, action_id, enabled, next_fire_at)
         SELECT $1, 'Bulk heartbeat ' || gs, $2::jsonb, 'noop', true, now() - interval '1 minute'
         FROM generate_series(1, $3) AS gs
         RETURNING id`,
        [await getAlldotsProjectId(), JSON.stringify(DAILY), count],
      );
      return rows.map((row) => row.id);
    }

    async function countFireJobs(): Promise<number> {
      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id
         WHERE t.identifier = 'heartbeatFireCore'`,
      );
      return rows[0]!.count;
    }

    async function countScheduled(ids: string[], future: boolean): Promise<number> {
      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM project_heartbeats WHERE id = ANY($1) AND (next_fire_at > now()) = $2`,
        [ids, future],
      );
      return rows[0]!.count;
    }

    it("fires every due heartbeat exactly once, in ceil(n/100) chunk transactions", async () => {
      const ids = await insertDueDailyHeartbeats(250);
      let connects = 0;
      await handleHeartbeatSweepTask(
        poolWithConnect((target) => {
          connects += 1;
          return target.connect();
        }),
      );
      expect(connects).toBe(3);
      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM heartbeat_occurrences WHERE heartbeat_id = ANY($1)`,
        [ids],
      );
      expect(rows[0]!.count).toBe(250);
      expect(await countFireJobs()).toBe(250);
      expect(await countScheduled(ids, true)).toBe(250);
    });

    it("leaves earlier chunks committed when a later chunk's transaction fails to start", async () => {
      const ids = await insertDueDailyHeartbeats(150);
      let connects = 0;
      const failingPool = poolWithConnect((target) => {
        connects += 1;
        return connects === 2 ? Promise.reject(new Error("simulated outage")) : target.connect();
      });

      const err: unknown = await handleHeartbeatSweepTask(failingPool).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors[0]).toEqual(expect.objectContaining({ message: "simulated outage" }));
      expect(await countScheduled(ids, true)).toBe(100);
      expect(await countFireJobs()).toBe(100);
      expect(await countScheduled(ids, false)).toBe(50);

      await handleHeartbeatSweepTask(pool);
      expect(await countFireJobs()).toBe(150);
      expect(await countScheduled(ids, true)).toBe(150);
    });

    describe("clock skew between the application and the database", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("computes the next fire from the database clock, not a lagging application clock", async () => {
        const heartbeat = await heartbeatWith({ rule: DAILY });
        await makeDue(heartbeat.id);

        // The expectation is derived from the DB clock and the timezone the sweep resolves, as production does.
        const { rows: dbNowRows } = await pool.query<{ db_now: Date }>("SELECT now() AS db_now");
        const dbNowBeforeSweep = dbNowRows[0]!.db_now;
        const timezone = await withTransaction(pool, (client) => getSystemTimezone(client));

        // The application clock lags the database clock by 26 h, so a sweep computing from `new Date()` instead of
        // `db_now` lands on a different calendar day whatever time the suite runs.
        vi.useFakeTimers({ toFake: ["Date"] });
        const appClockDuringSweep = new Date(dbNowBeforeSweep.getTime() - 26 * 60 * 60 * 1000);
        vi.setSystemTime(appClockDuringSweep);
        await sweep();
        vi.useRealTimers();

        const expectedFromDbClock = computeNextFireAt(DAILY, timezone, dbNowBeforeSweep);
        expect(expectedFromDbClock).not.toEqual(computeNextFireAt(DAILY, timezone, appClockDuringSweep));
        const { rows } = await pool.query<{ next_fire_at: Date }>(
          "SELECT next_fire_at FROM project_heartbeats WHERE id = $1",
          [heartbeat.id],
        );
        expect(rows[0]!.next_fire_at).toEqual(expectedFromDbClock);
        expect((await sweep()).fired.map((f) => f.id)).not.toContain(heartbeat.id);
      });
    });
  });

  it("plans the triggerOnItemEventHeartbeats query on project_heartbeats_on_item_event_idx when sequential scans are off", async () => {
    // Verbatim copy of triggerOnItemEventHeartbeats's query (scheduler/schedulerStore.ts).
    const query = `SELECT id, action_id FROM project_heartbeats
     WHERE enabled
       AND rule ->> 'kind' = 'onItemEvent'
       AND rule ->> 'databaseId' = $1
       AND rule ->> 'event' = $2`;
    const indexNames = new Set<string>();
    const collect = (plan: Record<string, unknown>): void => {
      const nodeType = plan["Node Type"];
      const indexName = plan["Index Name"];
      if ((nodeType === "Index Scan" || nodeType === "Bitmap Index Scan") && typeof indexName === "string") {
        indexNames.add(indexName);
      }
      if (Array.isArray(plan.Plans)) for (const sub of plan.Plans) collect(sub as Record<string, unknown>);
    };
    await withTransaction(pool, async (client) => {
      await client.query("SET LOCAL enable_seqscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(
        `EXPLAIN (FORMAT JSON) ${query}`,
        ["00000000-0000-0000-0000-000000000000", "create"],
      );
      collect(rows[0]!["QUERY PLAN"][0]!.Plan);
    });
    expect([...indexNames]).toEqual(["project_heartbeats_on_item_event_idx"]);
  });
});

describe("heartbeat_error recipient in a tenant", () => {
  let adminPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    adminPool = getTestPool();
    runtimePool = await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(adminPool, "alldots_data"));
  });

  beforeEach(async () => {
    await runInTenant(getTenantZeroId(), () => resetDatabase(adminPool));
  });

  afterAll(async () => {
    await Promise.all([runtimePool?.end(), adminPool?.end()]);
  });

  it("notifies the user of the tenant the heartbeat fails in, never the earlier-created account", async () => {
    const tenantB = await runInTenant(getTenantZeroId(), () => createTestTenant(adminPool));
    const userA = await runInTenant(getTenantZeroId(), () =>
      createUser(adminPool, { email: "a@example.test", passwordHash: "x", tenantId: getTenantZeroId() }),
    );
    const userB = await runInTenant(tenantB, () =>
      createUser(adminPool, { email: "b@example.test", passwordHash: "x", tenantId: tenantB }),
    );
    const heartbeatId = await runInTenant(tenantB, async () => {
      const { rows } = await runtimePool.query<{ id: string }>(
        `INSERT INTO project_heartbeats (project_item_id, name, rule, action_id, enabled, next_fire_at)
         VALUES ($1, 'Fails in B', $2::jsonb, 'alwaysFails', true, now()) RETURNING id`,
        [randomUUID(), JSON.stringify(DAILY)],
      );
      return rows[0]!.id;
    });
    const registry = createActionRegistry();
    registry.set("alwaysFails", async () => {
      throw new Error("boom");
    });
    const task = createHeartbeatFireCoreTask(runtimePool, registry);

    await expect(
      runInTenant(tenantB, () => task({ heartbeatId, itemId: "unused" }, jobHelpers(3, "job-b"))),
    ).rejects.toThrow("boom");

    const { rows } = await adminPool.query<{ user_id: string; kind: string; tenant_id: string }>(
      `SELECT user_id, kind, tenant_id FROM notifications WHERE source_id = $1`,
      [heartbeatId],
    );
    expect(rows).toEqual([{ user_id: userB.id, kind: "heartbeat_error", tenant_id: tenantB }]);
    expect(rows[0]?.user_id).not.toBe(userA.id);
  });
});
