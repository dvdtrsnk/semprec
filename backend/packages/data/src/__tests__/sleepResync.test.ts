import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mergeModuleTaskListForAffinity } from "../moduleTasks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import type { ItemCreateHookContext, ItemDeleteHookContext, ItemRestoreHookContext } from "../chokePoint/hooks.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withClient, withTransaction } from "../db/pool.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import * as apnsAdapter from "../push/apnsAdapter.js";
import type { ApnsTarget, PushSendResult } from "../push/pushSenders.js";
import {
  revokePushSubscriptionByProviderInvalidation,
  upsertApnsSubscription,
  upsertWebPushSubscription,
} from "../push/pushSubscriptionsStore.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import {
  SLEEP_RESYNC_DELAY_MS,
  SLEEP_RESYNC_TASK_NAME,
  enqueueSleepResync,
  handleSleepResync,
  runSleepResync,
  type SleepResyncSender,
} from "../sleep/sleepResync.js";
import {
  sleepResyncCreateHook,
  sleepResyncDeleteHook,
  sleepResyncRestoreHook,
  sleepResyncUpdateHook,
} from "../sleep/sleepWriteHooks.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// Passthrough spy: a call reaches the real adapter (which answers not-configured without APNS_* settings) unless a
// test replaces one answer, so the default wiring of the handler to the adapter is observed without a network.
vi.mock("../push/apnsAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../push/apnsAdapter.js")>();
  return { ...actual, sendApnsBackgroundPush: vi.fn(actual.sendApnsBackgroundPush) };
});

const USER = { writerKind: "user" } as const;
const NIGHT = "2026-10-16";

interface ResyncTenant {
  tenantId: string;
  userId: string;
  settingsDatabaseId: string;
  plansDatabaseId: string;
  nightsDatabaseId: string;
  settingsItemId: string;
  planId: string;
}

interface ResyncJob {
  key: string | null;
  run_at: Date;
}

let adminPool: Pool;
let dataPool: Pool;
let tenant: ResyncTenant;
let other: ResyncTenant;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

function chokePoint(t: ResyncTenant) {
  return {
    create: (databaseId: string, properties: Record<string, unknown>) =>
      runInTenant(t.tenantId, () =>
        createChokePoint(dataPool).createItem({ databaseId, properties }, undefined, undefined, USER),
      ),
    patch: (databaseId: string, itemId: string, propertiesPatch: Record<string, unknown>) =>
      runInTenant(t.tenantId, () =>
        createChokePoint(dataPool).updateItem({ databaseId, itemId, propertiesPatch }, undefined, undefined, USER),
      ),
    trash: (databaseId: string, itemId: string) =>
      runInTenant(t.tenantId, () => createChokePoint(dataPool).softDeleteItem(databaseId, itemId, undefined, USER)),
    restore: (databaseId: string, itemId: string) =>
      runInTenant(t.tenantId, () => createChokePoint(dataPool).restoreItem(databaseId, itemId, undefined, USER)),
  };
}

/** A new tenant seeded as production seeds one, with a user, so it has the settings item and the two default plans. */
async function seededTenant(): Promise<ResyncTenant> {
  const tenantId = await createTestTenant(adminPool);
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const user = await createUser(adminPool, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  const databaseId = async (moduleId: string): Promise<string> => {
    const database = await inTenant(tenantId, (client) => databasesStore.getDatabaseByModuleId(client, moduleId));
    if (!database) throw new Error(`The tenant has no ${moduleId} database`);
    return database.id;
  };
  const settingsDatabaseId = await databaseId(SLEEP_SETTINGS_MODULE_ID);
  const plansDatabaseId = await databaseId(SLEEP_PLANS_MODULE_ID);
  const firstItemId = (databaseId: string) =>
    inTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1",
        [databaseId],
      );
      const [row] = rows;
      if (!row) throw new Error(`Database ${databaseId} has no item`);
      return row.id;
    });
  return {
    tenantId,
    userId: user.id,
    settingsDatabaseId,
    plansDatabaseId,
    nightsDatabaseId: await databaseId(SLEEP_NIGHTS_MODULE_ID),
    settingsItemId: await firstItemId(settingsDatabaseId),
    planId: await firstItemId(plansDatabaseId),
  };
}

/** The pending `sleep.resync` jobs, read through the public view of the queue schema. */
async function resyncJobs(): Promise<ResyncJob[]> {
  const { rows } = await adminPool.query<ResyncJob>(
    "SELECT key, run_at FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [SLEEP_RESYNC_TASK_NAME],
  );
  return rows;
}

function resyncKey(t: ResyncTenant): string {
  return `sleep-resync:${t.tenantId}`;
}

/** Removes every pending `sleep.resync` job, so the next write is the only one that can have enqueued one. */
async function clearResyncJobs(): Promise<void> {
  for (const job of await resyncJobs()) {
    await adminPool.query("SELECT graphile_worker.remove_job($1)", [job.key]);
  }
}

const jobEnvelope = z.object({ tenantId: z.string(), payload: z.object({ tenantId: z.string() }).strict() });

beforeAll(async () => {
  adminPool = getTestPool();
  dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
});

afterAll(async () => {
  await dataPool?.end();
  await adminPool?.end();
});

describe("enqueueSleepResync and the sleep write hooks (issue gh-1838)", () => {
  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenant = await seededTenant();
    other = await seededTenant();
    await clearResyncJobs();
  });

  it("enqueues one job for a patch of a plan, keyed by the tenant, 30 seconds ahead, with only the tenant id", async () => {
    const before = Date.now();
    await chokePoint(tenant).patch(tenant.plansDatabaseId, tenant.planId, { bedTime: "22:30" });
    const after = Date.now();

    const jobs = await resyncJobs();
    expect(jobs.map((job) => job.key)).toEqual([resyncKey(tenant)]);
    const runAt = jobs[0]?.run_at.getTime() ?? 0;
    expect(runAt).toBeGreaterThanOrEqual(before + SLEEP_RESYNC_DELAY_MS);
    expect(runAt).toBeLessThanOrEqual(after + SLEEP_RESYNC_DELAY_MS);
    expect(SLEEP_RESYNC_DELAY_MS).toBe(30_000);
    const payloads = await readJobPayloadsByIdentifier(adminPool, SLEEP_RESYNC_TASK_NAME);
    expect(payloads.map((payload) => jobEnvelope.parse(payload))).toEqual([
      { tenantId: tenant.tenantId, payload: { tenantId: tenant.tenantId } },
    ]);
  });

  it("leaves one pending job for ten writes in a row and moves its run time to the last write", async () => {
    await chokePoint(tenant).patch(tenant.plansDatabaseId, tenant.planId, { bedTime: "22:00" });
    const firstRunAt = (await resyncJobs())[0]?.run_at.getTime() ?? 0;
    for (let minute = 1; minute < 10; minute += 1) {
      await chokePoint(tenant).patch(tenant.plansDatabaseId, tenant.planId, { bedTime: `22:0${minute}` });
    }

    const jobs = await resyncJobs();
    expect(jobs.map((job) => job.key)).toEqual([resyncKey(tenant)]);
    expect(jobs[0]?.run_at.getTime() ?? 0).toBeGreaterThan(firstRunAt);
  });

  it("keeps one pending job when writes of different kinds follow each other", async () => {
    const night = await chokePoint(tenant).create(tenant.nightsDatabaseId, { night: NIGHT, bedTime: "21:00" });
    await chokePoint(tenant).patch(tenant.nightsDatabaseId, night.id, { wakeTime: "07:00" });
    await chokePoint(tenant).trash(tenant.nightsDatabaseId, night.id);

    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
  });

  describe.each([
    ["creating a plan", () => chokePoint(tenant).create(tenant.plansDatabaseId, planProperties())],
    [
      "creating a night exception",
      () => chokePoint(tenant).create(tenant.nightsDatabaseId, { night: NIGHT, bedTime: "21:00" }),
    ],
    [
      "patching the sleep settings",
      () => chokePoint(tenant).patch(tenant.settingsDatabaseId, tenant.settingsItemId, { enabled: false }),
    ],
    ["patching a plan", () => chokePoint(tenant).patch(tenant.plansDatabaseId, tenant.planId, { alarm: false })],
    [
      "patching a night exception",
      async () => {
        const night = await chokePoint(tenant).create(tenant.nightsDatabaseId, { night: NIGHT });
        await clearResyncJobs();
        await chokePoint(tenant).patch(tenant.nightsDatabaseId, night.id, { bedTime: "21:15" });
      },
    ],
    ["soft-deleting a plan", () => chokePoint(tenant).trash(tenant.plansDatabaseId, tenant.planId)],
    [
      "soft-deleting a night exception",
      async () => {
        const night = await chokePoint(tenant).create(tenant.nightsDatabaseId, { night: NIGHT });
        await clearResyncJobs();
        await chokePoint(tenant).trash(tenant.nightsDatabaseId, night.id);
      },
    ],
    [
      "restoring a plan",
      async () => {
        await chokePoint(tenant).trash(tenant.plansDatabaseId, tenant.planId);
        await clearResyncJobs();
        await chokePoint(tenant).restore(tenant.plansDatabaseId, tenant.planId);
      },
    ],
    [
      "restoring a night exception",
      async () => {
        const night = await chokePoint(tenant).create(tenant.nightsDatabaseId, { night: NIGHT });
        await chokePoint(tenant).trash(tenant.nightsDatabaseId, night.id);
        await clearResyncJobs();
        await chokePoint(tenant).restore(tenant.nightsDatabaseId, night.id);
      },
    ],
    ["changing the System settings time zone", () => patchSystemSettings(tenant, { timezone: "Europe/London" })],
  ])("%s", (_name, write) => {
    it("enqueues the resync of the tenant and of no other", async () => {
      await write();

      expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
    });
  });

  it.each([
    ["creates", (ctx: HookContexts) => sleepResyncCreateHook(ctx.create)],
    ["updates", (ctx: HookContexts) => sleepResyncUpdateHook(ctx.update)],
    ["soft-deletes", (ctx: HookContexts) => sleepResyncDeleteHook(ctx.delete)],
    ["restores", (ctx: HookContexts) => sleepResyncRestoreHook(ctx.restore)],
  ])("enqueues when the hook that %s is given the sleep settings database", async (_name, run) => {
    await inTenant(tenant.tenantId, async (client) => run(await hookContexts(client, SLEEP_SETTINGS_MODULE_ID)));

    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
  });

  it("enqueues nothing for a System settings patch that does not name the time zone", async () => {
    await patchSystemSettings(tenant, { name: "Renamed" });

    expect(await resyncJobs()).toEqual([]);
  });

  it("enqueues nothing for writes to a database that is not a sleep database, whichever hook runs", async () => {
    await inTenant(tenant.tenantId, async (client) => {
      const contexts = await hookContexts(client, SYSTEM_SETTINGS_MODULE_ID);
      await sleepResyncCreateHook(contexts.create);
      await sleepResyncDeleteHook(contexts.delete);
      await sleepResyncRestoreHook(contexts.restore);
      await sleepResyncUpdateHook({ ...contexts.update, propertiesPatch: { name: "x" } });
    });
    const tasks = await inTenant(tenant.tenantId, (client) =>
      databasesStore.getDatabaseByModuleId(client, TASKS_MODULE_ID),
    );
    if (!tasks) throw new Error("The tenant has no tasks database");
    await chokePoint(tenant).create(tasks.id, { name: "Not sleep" });

    expect(await resyncJobs()).toEqual([]);
  });

  it("fails a hook that runs outside a tenant instead of enqueueing a job for no tenant", async () => {
    const contexts = await inTenant(tenant.tenantId, (client) => hookContexts(client, SLEEP_SETTINGS_MODULE_ID));

    await expect(
      runAsSystem("sleep resync test without a tenant", () =>
        withTransaction(dataPool, (client) => sleepResyncCreateHook({ ...contexts.create, client })),
      ),
    ).rejects.toThrow("A sleep write ran without a tenant");

    expect(await resyncJobs()).toEqual([]);
  });

  it("enqueues nothing for a write the sleep rules refuse", async () => {
    await expect(
      chokePoint(tenant).patch(tenant.plansDatabaseId, tenant.planId, { bedTime: "25:00" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(chokePoint(tenant).create(tenant.nightsDatabaseId, { night: "2026-13-01" })).rejects.toMatchObject({
      status: 400,
    });

    expect(await resyncJobs()).toEqual([]);
  });

  it("enqueues nothing when the transaction of the write rolls back", async () => {
    await expect(
      inTenant(tenant.tenantId, async (client) => {
        await enqueueSleepResync(client, tenant.tenantId);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(await resyncJobs()).toEqual([]);
  });

  it("enqueues nothing for another tenant when this tenant's sleep data changes, and one per tenant for both", async () => {
    await chokePoint(other).patch(other.plansDatabaseId, other.planId, { bedTime: "22:45" });
    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(other)]);
    expect((await resyncJobs()).map((job) => job.key)).not.toContain(resyncKey(tenant));

    await chokePoint(tenant).patch(tenant.plansDatabaseId, tenant.planId, { bedTime: "22:15" });

    expect((await resyncJobs()).map((job) => job.key).sort()).toEqual([resyncKey(tenant), resyncKey(other)].sort());
  });
});

describe("sleep.resync as a module task (issue gh-1838)", () => {
  it("is declared by the sleep module for the API runtime with the schema and the handler it exports", async () => {
    const registry = await loadFullModuleRegistry();

    const definitions = (await registry.getTaskDefinitions()).filter((task) => task.moduleId === "sleep");
    expect(definitions.map(({ name, queueAffinity }) => ({ name, queueAffinity }))).toEqual([
      { name: SLEEP_RESYNC_TASK_NAME, queueAffinity: "api" },
    ]);
    expect(definitions[0]?.handler).toBe(handleSleepResync);
    const tenantId = randomUUID();
    expect(definitions[0]?.payloadSchema.parse({ tenantId })).toEqual({ tenantId });
    expect(() => definitions[0]?.payloadSchema.parse({ tenantId, userId: randomUUID() })).toThrow();
    expect(() => definitions[0]?.payloadSchema.parse({ tenantId: "not-a-uuid" })).toThrow();
  });

  it("is registered with the queue runtime of the API and with no other runtime", async () => {
    const registry = await loadFullModuleRegistry();

    expect(Object.keys(await mergeModuleTaskListForAffinity({}, registry, "api"))).toContain(SLEEP_RESYNC_TASK_NAME);
    expect(Object.keys(await mergeModuleTaskListForAffinity({}, registry, "agents"))).not.toContain(
      SLEEP_RESYNC_TASK_NAME,
    );
  });
});

describe("the sleep.resync handler (issue gh-1838)", () => {
  interface Registration {
    id: string;
    deviceToken: string;
  }

  interface PushedTenant extends ResyncTenant {
    ios: Registration[];
    macos: Registration;
    revokedIos: Registration;
    webEndpoint: string;
  }

  function sender(answers: Record<string, PushSendResult> = {}) {
    const calls: Array<{ target: ApnsTarget; data: unknown }> = [];
    const send: SleepResyncSender = async (target, data) => {
      calls.push({ target, data });
      return answers[target.deviceToken] ?? { outcome: "delivered" };
    };
    return { send, calls };
  }

  async function register(
    t: ResyncTenant,
    platform: "ios" | "macos",
    environment: "sandbox" | "production" = "sandbox",
  ): Promise<Registration> {
    const deviceToken = randomUUID();
    const row = await runInTenant(t.tenantId, () =>
      upsertApnsSubscription(dataPool, {
        userId: t.userId,
        sessionId: null,
        platform,
        deviceToken,
        apnsEnvironment: environment,
      }),
    );
    return { id: row.id, deviceToken };
  }

  /** A tenant whose user has two active iOS registrations, a macOS one, a revoked iOS one and a Web Push one. */
  async function pushedTenant(): Promise<PushedTenant> {
    const t = await seededTenant();
    const ios = [await register(t, "ios", "sandbox"), await register(t, "ios", "production")];
    const macos = await register(t, "macos");
    const revokedIos = await register(t, "ios");
    await withTransaction(dataPool, (client) =>
      runInTenant(t.tenantId, () =>
        revokePushSubscriptionByProviderInvalidation(client, { channel: "apns", deviceToken: revokedIos.deviceToken }),
      ),
    );
    const webEndpoint = `https://push.example/${randomUUID()}`;
    await runInTenant(t.tenantId, () =>
      upsertWebPushSubscription(dataPool, {
        userId: t.userId,
        sessionId: null,
        endpoint: webEndpoint,
        p256dh: "p256dh-key",
        authSecret: "auth-secret",
      }),
    );
    return { ...t, ios, macos, revokedIos, webEndpoint };
  }

  function run(t: ResyncTenant, payload: unknown, send: SleepResyncSender): Promise<void> {
    return runInTenant(t.tenantId, () => runSleepResync(payload, (fn) => withClient(dataPool, fn), send));
  }

  async function revokedTokens(): Promise<string[]> {
    const { rows } = await adminPool.query<{ device_token: string }>(
      "SELECT device_token FROM push_subscriptions WHERE revoked_at IS NOT NULL AND channel = 'apns' ORDER BY device_token",
    );
    return rows.map((row) => row.device_token);
  }

  async function tableCounts(): Promise<{ notifications: number; deliveries: number }> {
    const { rows } = await adminPool.query<{ notifications: number; deliveries: number }>(
      "SELECT (SELECT count(*) FROM notifications)::int AS notifications, (SELECT count(*) FROM push_deliveries)::int AS deliveries",
    );
    return rows[0] ?? { notifications: -1, deliveries: -1 };
  }

  let pushed: PushedTenant;

  beforeEach(async () => {
    await resetDatabase(adminPool);
    pushed = await pushedTenant();
    vi.mocked(apnsAdapter.sendApnsBackgroundPush).mockClear();
  });

  it("sends exactly one silent push {kind: sleepResync} per active iOS APNs registration and nothing else", async () => {
    const { send, calls } = sender();

    await run(pushed, { tenantId: pushed.tenantId }, send);

    expect(calls.map((call) => call.target.deviceToken).sort()).toEqual(
      pushed.ios.map((registration) => registration.deviceToken).sort(),
    );
    expect(calls.map((call) => call.data)).toEqual([{ kind: "sleepResync" }, { kind: "sleepResync" }]);
    expect(calls.map((call) => call.target.apnsEnvironment).sort()).toEqual(["production", "sandbox"]);
    const touched = calls.map((call) => call.target.deviceToken);
    expect(touched).not.toContain(pushed.macos.deviceToken);
    expect(touched).not.toContain(pushed.revokedIos.deviceToken);
    expect(await revokedTokens()).toEqual([pushed.revokedIos.deviceToken]);
  });

  it("writes no notifications row and no push_deliveries row", async () => {
    const before = await tableCounts();

    await run(pushed, { tenantId: pushed.tenantId }, sender().send);

    expect(await tableCounts()).toEqual(before);
  });

  it("revokes the registration that APNs answers permanently and still pushes to the others", async () => {
    const [dead, alive] = pushed.ios;
    if (!dead || !alive) throw new Error("expected two iOS registrations");
    const { send, calls } = sender({ [dead.deviceToken]: { outcome: "permanent-failure", error: "status 410" } });

    await run(pushed, { tenantId: pushed.tenantId }, send);

    expect(calls).toHaveLength(2);
    expect(await revokedTokens()).toEqual([dead.deviceToken, pushed.revokedIos.deviceToken].sort());
    const active = await runInTenant(pushed.tenantId, () =>
      withClient(dataPool, async (client) => {
        const { rows } = await client.query<{ device_token: string }>(
          "SELECT device_token FROM push_subscriptions WHERE channel = 'apns' AND revoked_at IS NULL",
        );
        return rows.map((row) => row.device_token).sort();
      }),
    );
    expect(active).toEqual([alive.deviceToken, pushed.macos.deviceToken].sort());
  });

  it("fails the job after trying every registration when one answer is transient, and revokes nothing", async () => {
    const [flaky] = pushed.ios;
    if (!flaky) throw new Error("expected an iOS registration");
    const { send, calls } = sender({ [flaky.deviceToken]: { outcome: "transient-failure", error: new Error("503") } });

    const failure = await run(pushed, { tenantId: pushed.tenantId }, send).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect(calls).toHaveLength(2);
    expect(await revokedTokens()).toEqual([pushed.revokedIos.deviceToken]);
  });

  it("neither revokes nor fails when APNs is not configured, and tries every registration", async () => {
    const answer: PushSendResult = { outcome: "not-configured", reason: "APNS_TEAM_ID is not set" };
    const { send, calls } = sender(Object.fromEntries(pushed.ios.map((r) => [r.deviceToken, answer])));

    await run(pushed, { tenantId: pushed.tenantId }, send);

    expect(calls).toHaveLength(2);
    expect(await revokedTokens()).toEqual([pushed.revokedIos.deviceToken]);
  });

  it("is a successful no-op for a user without any registration", async () => {
    const bare = await seededTenant();
    const { send, calls } = sender();

    await run(bare, { tenantId: bare.tenantId }, send);

    expect(calls).toEqual([]);
  });

  it("is a successful no-op for a tenant that has no user", async () => {
    const tenantId = await createTestTenant(adminPool);
    const { send, calls } = sender();

    await runInTenant(tenantId, () => runSleepResync({ tenantId }, (fn) => withClient(dataPool, fn), send));

    expect(calls).toEqual([]);
  });

  it("pushes only to the registrations of its own tenant", async () => {
    const second = await pushedTenant();
    const { send, calls } = sender();

    await run(second, { tenantId: second.tenantId }, send);

    const tokens = calls.map((call) => call.target.deviceToken);
    expect(tokens.sort()).toEqual(second.ios.map((registration) => registration.deviceToken).sort());
    expect(tokens.filter((token) => pushed.ios.some((registration) => registration.deviceToken === token))).toEqual([]);
  });

  it("sends nothing when the payload names another tenant than the job runs in", async () => {
    const second = await pushedTenant();
    const { send, calls } = sender();

    await run(pushed, { tenantId: second.tenantId }, send);

    expect(calls).toEqual([]);
  });

  it("sends nothing when it runs outside a tenant scope", async () => {
    const { send, calls } = sender();

    await runSleepResync({ tenantId: pushed.tenantId }, (fn) => withClient(dataPool, fn), send);

    expect(calls).toEqual([]);
  });

  it.each([
    ["a payload without a tenant id", {}],
    ["a tenant id that is not a UUID", { tenantId: "tenant" }],
    ["a payload with a user id beside the tenant id", { tenantId: randomUUID(), userId: randomUUID() }],
    ["a payload that is not an object", "tenant"],
  ])("fails the job for %s and sends nothing", async (_name, payload) => {
    const { send, calls } = sender();

    await expect(run(pushed, payload, send)).rejects.toThrow();

    expect(calls).toEqual([]);
  });

  it("is wired to the APNs background push by default and revokes what that answers with 410", async () => {
    const [dead] = pushed.ios;
    if (!dead) throw new Error("expected an iOS registration");
    vi.mocked(apnsAdapter.sendApnsBackgroundPush).mockImplementation(async (target) =>
      target.deviceToken === dead.deviceToken
        ? { outcome: "permanent-failure", error: "status 410" }
        : { outcome: "delivered" },
    );

    await runInTenant(pushed.tenantId, () =>
      handleSleepResync({ tenantId: pushed.tenantId }, {
        withPgClient: (fn: (client: PoolClient) => Promise<unknown>) => withClient(dataPool, fn),
      } as never),
    );

    const calls = vi.mocked(apnsAdapter.sendApnsBackgroundPush).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map(([, data]) => data)).toEqual([{ kind: "sleepResync" }, { kind: "sleepResync" }]);
    expect(await revokedTokens()).toEqual([dead.deviceToken, pushed.revokedIos.deviceToken].sort());
    vi.mocked(apnsAdapter.sendApnsBackgroundPush).mockReset();
  });
});

function planProperties(): Record<string, unknown> {
  return { name: "Extra", wakeDays: [], bedTime: "22:00", wakeTime: "06:00", alarm: false, position: 5 };
}

/** Patches the System settings item of the tenant through the choke point. */
async function patchSystemSettings(t: ResyncTenant, propertiesPatch: Record<string, unknown>): Promise<void> {
  const database = await inTenant(t.tenantId, (client) =>
    databasesStore.getDatabaseByModuleId(client, SYSTEM_SETTINGS_MODULE_ID),
  );
  if (!database) throw new Error("The tenant has no system settings database");
  const itemId = await inTenant(t.tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [database.id]);
    const [row] = rows;
    if (!row) throw new Error("The tenant has no system settings item");
    return row.id;
  });
  await chokePoint(t).patch(database.id, itemId, propertiesPatch);
}

interface HookContexts {
  create: ItemCreateHookContext;
  update: Parameters<typeof sleepResyncUpdateHook>[0];
  delete: ItemDeleteHookContext;
  restore: ItemRestoreHookContext;
}

/** The contexts the choke point would give the four hooks for the first item of the database `moduleId`. */
async function hookContexts(client: PoolClient, moduleId: string): Promise<HookContexts> {
  const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
  if (!database) throw new Error(`The tenant has no ${moduleId} database`);
  const { rows } = await client.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 LIMIT 1", [
    database.id,
  ]);
  const [row] = rows;
  if (!row) throw new Error(`Database ${moduleId} has no item`);
  const item = await itemsStore.getItemById(client, database.id, row.id);
  if (!item) throw new Error(`Item ${row.id} is not stored`);
  const writer = USER;
  return {
    create: { client, database, item, properties: item.properties, writer },
    update: { client, database, item, propertiesPatch: { timezone: "Europe/London" }, writer },
    delete: {
      client,
      database,
      item,
      rootItemId: item.id,
      deletedAt: new Date().toISOString(),
      writerKind: "user",
    },
    restore: {
      client,
      database,
      item,
      rootItemId: item.id,
      deletedAt: new Date().toISOString(),
      deletedAtExact: new Date().toISOString(),
      queueAffinity: createActionQueueAffinity(),
      writerKind: "user",
    },
  };
}
