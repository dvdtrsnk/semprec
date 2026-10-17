import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { currentTenantScope, runInTenant, type TenantScope } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { getMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import {
  createMailLiveSyncRoot,
  type MailAccountLifecycle,
  type MailLiveSyncAccount,
  type MailLiveSyncLifecycleFactory,
} from "../mail/mailLiveSyncRoot.js";
import {
  getExpectedProcessHeartbeatStatuses,
  mailSyncProcessName,
  PROCESS_HEARTBEAT_INTERVAL_MS,
} from "../health/processHeartbeats.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

interface RecordingLifecycle extends MailAccountLifecycle {
  starts: number;
  stops: number;
}

function recordingFactory(
  onCreate?: (account: MailLiveSyncAccount, lifecycle: RecordingLifecycle) => void,
  behavior?: (account: MailLiveSyncAccount) => Partial<MailAccountLifecycle>,
): { factory: MailLiveSyncLifecycleFactory; byAccount: Map<string, RecordingLifecycle> } {
  const byAccount = new Map<string, RecordingLifecycle>();
  const factory: MailLiveSyncLifecycleFactory = (account) => {
    const overrides = behavior?.(account) ?? {};
    const lifecycle: RecordingLifecycle = {
      starts: 0,
      stops: 0,
      async start() {
        lifecycle.starts++;
        await overrides.start?.();
      },
      async stop() {
        lifecycle.stops++;
        await overrides.stop?.();
      },
    };
    byAccount.set(account.mailboxItemId, lifecycle);
    onCreate?.(account, lifecycle);
    return lifecycle;
  };
  return { factory, byAccount };
}

/** Counts every `pool.connect()` call — a proxy for how many transactions discovery opens. */
function countingConnectPool(target: Pool): { pool: Pool; connectCount: () => number } {
  let count = 0;
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "connect") {
        return (...args: unknown[]) => {
          count++;
          return (t.connect as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(t, prop, receiver);
    },
  });
  return { pool: proxy, connectCount: () => count };
}

/**
 * Wraps `pool` so that the `mail_account_sync_state` seeding INSERT for `failItemId` is rewritten
 * into a statement the server itself rejects (an insert into a nonexistent column) — a fake
 * client-side rejection would never abort the surrounding transaction on Postgres's side, so it
 * would pass even without savepoints; this must actually reach and fail against the server.
 */
function failingSeedPool(target: Pool, failItemId: string): Pool {
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "connect") {
        return async (...args: unknown[]) => {
          // `pool.query()` (a heartbeat tick's own write, unrelated to this helper's rewrite
          // target) calls `this.connect(callback)` in callback style internally, which doesn't
          // resolve a client through this wrapper's return value at all. Only the promise-style
          // call this helper's SAVEPOINT-seeding transaction actually makes needs wrapping.
          if (typeof args[0] === "function") {
            return (t.connect as (...a: unknown[]) => unknown)(...args);
          }
          const client = await (t.connect as (...a: unknown[]) => Promise<PoolClient>)(...args);
          return new Proxy(client, {
            get(clientTarget, clientProp, clientReceiver) {
              if (clientProp === "query") {
                return (...queryArgs: unknown[]) => {
                  const [text, params] = queryArgs as [string, unknown[] | undefined];
                  if (
                    typeof text === "string" &&
                    text.includes("INSERT INTO mail_account_sync_state") &&
                    Array.isArray(params) &&
                    params[0] === failItemId
                  ) {
                    return (clientTarget.query as (...a: unknown[]) => unknown)(
                      "INSERT INTO mail_account_sync_state (item_id, sync_mode, this_column_does_not_exist) VALUES ($1, $2, 'x')",
                      params,
                    );
                  }
                  return (clientTarget.query as (...a: unknown[]) => unknown)(...queryArgs);
                };
              }
              return Reflect.get(clientTarget, clientProp, clientReceiver);
            },
          });
        };
      }
      return Reflect.get(t, prop, receiver);
    },
  });
  return proxy;
}

/**
 * Like `failingSeedPool`, but also rewrites the subsequent `ROLLBACK TO SAVEPOINT
 * discover_account` into a rejection with `rollbackErr` — exercises the discover `catch`'s
 * ordering: `onLifecycleError` must still receive the original seed error even when the rollback
 * that follows it also throws.
 */
function failingSeedAndRollbackPool(target: Pool, failItemId: string, rollbackErr: Error): Pool {
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "connect") {
        return async (...args: unknown[]) => {
          if (typeof args[0] === "function") {
            return (t.connect as (...a: unknown[]) => unknown)(...args);
          }
          const client = await (t.connect as (...a: unknown[]) => Promise<PoolClient>)(...args);
          return new Proxy(client, {
            get(clientTarget, clientProp, clientReceiver) {
              if (clientProp === "query") {
                return (...queryArgs: unknown[]) => {
                  const [text, params] = queryArgs as [string, unknown[] | undefined];
                  if (
                    typeof text === "string" &&
                    text.includes("INSERT INTO mail_account_sync_state") &&
                    Array.isArray(params) &&
                    params[0] === failItemId
                  ) {
                    return (clientTarget.query as (...a: unknown[]) => unknown)(
                      "INSERT INTO mail_account_sync_state (item_id, sync_mode, this_column_does_not_exist) VALUES ($1, $2, 'x')",
                      params,
                    );
                  }
                  if (typeof text === "string" && text === "ROLLBACK TO SAVEPOINT discover_account") {
                    return Promise.reject(rollbackErr);
                  }
                  return (clientTarget.query as (...a: unknown[]) => unknown)(...queryArgs);
                };
              }
              return Reflect.get(clientTarget, clientProp, clientReceiver);
            },
          });
        };
      }
      return Reflect.get(t, prop, receiver);
    },
  });
  return proxy;
}

/**
 * Wraps `pool.query` so a test can await every `process_heartbeats` UPSERT a heartbeat tick
 * issued, rather than racing its own assertions against a write that `startProcessHeartbeat`
 * never awaits (it fires the query and moves on). `rejectNextUpsert`, when set, makes the very
 * next matching UPSERT reject instead of running, to exercise the `onError` -> `onLifecycleError`
 * "heartbeat" phase.
 */
function heartbeatTrackingPool(target: Pool): {
  pool: Pool;
  drain: () => Promise<void>;
  rejectNextUpsert: (err: Error) => void;
} {
  const pending: Promise<unknown>[] = [];
  let rejectOnce: Error | null = null;
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "query") {
        return (...args: unknown[]) => {
          const [text] = args as [string];
          if (typeof text === "string" && text.includes("INSERT INTO process_heartbeats")) {
            if (rejectOnce) {
              const err = rejectOnce;
              rejectOnce = null;
              const rejected = Promise.reject(err);
              pending.push(rejected.catch(() => {}));
              return rejected;
            }
            const result = (t.query as (...a: unknown[]) => Promise<unknown>)(...args);
            pending.push(result.catch(() => {}));
            return result;
          }
          return (t.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(t, prop, receiver);
    },
  });
  return {
    pool: proxy,
    drain: async () => {
      await Promise.all(pending);
      pending.length = 0;
    },
    rejectNextUpsert: (err: Error) => {
      rejectOnce = err;
    },
  };
}

describe("mail live-sync composition root (issue #195)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts exactly one lifecycle per active account, seeding its sync state", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "gmail" } }),
    );
    const b = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "B", provider: "imap" } }),
    );

    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(pool, factory);

    await root.reconcileOnce();

    expect(byAccount.get(a.id)?.starts).toBe(1);
    expect(byAccount.get(b.id)?.starts).toBe(1);

    const stateA = await withTransaction(pool, (client) => getMailAccountSyncState(client, a.id));
    expect(stateA?.syncMode).toBe("gmail_api");

    // A second pass with no changes to the active set must not start a second lifecycle for
    // either account — exactly one lifecycle per active account, restart or not.
    await root.reconcileOnce();
    expect(byAccount.get(a.id)?.starts).toBe(1);
    expect(byAccount.get(b.id)?.starts).toBe(1);

    await root.stop();
    expect(byAccount.get(a.id)?.stops).toBe(1);
    expect(byAccount.get(b.id)?.stops).toBe(1);
  });

  it("stops a lifecycle when its account is deactivated (soft-deleted), leaving the others running", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );
    const b = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "B", provider: "generic" } }),
    );

    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(pool, factory);
    await root.reconcileOnce();
    expect(byAccount.get(a.id)?.starts).toBe(1);
    expect(byAccount.get(b.id)?.starts).toBe(1);

    await chokePoint.softDeleteItem(mailboxesId, a.id);
    await root.reconcileOnce();

    expect(byAccount.get(a.id)?.stops).toBe(1);
    expect(byAccount.get(b.id)?.stops).toBe(0);

    // Reactivation restarts a fresh lifecycle for the account rather than leaving it stopped.
    await chokePoint.restoreItem(mailboxesId, a.id);
    await root.reconcileOnce();
    expect(byAccount.get(a.id)?.starts).toBe(1);
  });

  it("restarting the composition root restores state instead of resetting it and does not duplicate a watcher", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    const first = recordingFactory();
    const rootOne = createMailLiveSyncRoot(pool, first.factory);
    await rootOne.reconcileOnce();
    expect(first.byAccount.get(a.id)?.starts).toBe(1);

    // Persisted sync state survives across "restarts" (a brand-new root instance, simulating a
    // process restart) — it is read back, not reset, and the fresh root does not start a
    // second concurrent lifecycle for the still-active account beyond its own one.
    const stateBeforeRestart = await withTransaction(pool, (client) => getMailAccountSyncState(client, a.id));

    const second = recordingFactory();
    const rootTwo = createMailLiveSyncRoot(pool, second.factory);
    await rootTwo.reconcileOnce();
    expect(second.byAccount.get(a.id)?.starts).toBe(1);

    const stateAfterRestart = await withTransaction(pool, (client) => getMailAccountSyncState(client, a.id));
    expect(stateAfterRestart?.syncMode).toBe(stateBeforeRestart?.syncMode);
    expect(stateAfterRestart?.nextExpectedActivityAt).toBe(stateBeforeRestart?.nextExpectedActivityAt);
  });

  it("isolates one account's lifecycle failure from the others", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );
    const b = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "B", provider: "generic" } }),
    );

    const errors: Array<{ mailboxItemId: string; phase: string }> = [];
    const { factory, byAccount } = recordingFactory(undefined, (account) =>
      account.mailboxItemId === a.id
        ? {
            start: async () => {
              throw new Error("boom: simulated transport failure for account A");
            },
          }
        : {},
    );
    const root = createMailLiveSyncRoot(pool, factory, {
      onLifecycleError: (mailboxItemId, phase) => errors.push({ mailboxItemId, phase }),
    });

    await root.reconcileOnce();

    expect(errors).toEqual([{ mailboxItemId: a.id, phase: "start" }]);
    expect(byAccount.get(a.id)?.starts).toBe(1);
    expect(byAccount.get(b.id)?.starts).toBe(1);

    await root.stop();
    // Even though A's lifecycle failed to start, it is still tracked as hosted (its `start`
    // threw, but the composition root already recorded it) and gets a matching stop call.
    expect(byAccount.get(a.id)?.stops).toBe(1);
    expect(byAccount.get(b.id)?.stops).toBe(1);
  });

  it("restarts a lifecycle when the account's sync mode changes instead of hosting two at once", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(pool, factory);
    await root.reconcileOnce();
    expect(byAccount.get(a.id)?.starts).toBe(1);
    const firstLifecycle = byAccount.get(a.id)!;

    await withTransaction(pool, (client) =>
      client.query("UPDATE mail_account_sync_state SET sync_mode = 'gmail_api' WHERE item_id = $1", [a.id]),
    );
    await root.reconcileOnce();

    expect(firstLifecycle.stops).toBe(1);
    const secondLifecycle = byAccount.get(a.id)!;
    expect(secondLifecycle).not.toBe(firstLifecycle);
    expect(secondLifecycle.starts).toBe(1);
  });
});

describe("mail live-sync root: double-start guard and batched discovery (issue #272)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calling start() twice sequentially schedules only one interval, and a single stop() leaves none firing", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    const { factory } = recordingFactory();
    const { pool: countingPool, connectCount } = countingConnectPool(pool);

    vi.useFakeTimers();
    const root = createMailLiveSyncRoot(countingPool, factory, { discoveryIntervalMs: 1000 });

    await root.start();
    await root.start(); // second call must be a no-op: no second initial reconcile, no second interval

    const beforeTick = connectCount();
    await vi.advanceTimersByTimeAsync(1000);
    // Exactly one interval firing means exactly one discovery pass: the tenant enumeration plus one page transaction.
    // `stop()` awaits the pass the tick started, so every connection it opens is counted by then.
    await root.stop();
    expect(connectCount() - beforeTick).toBe(2);
    const afterStop = connectCount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(connectCount()).toBe(afterStop);
  });

  it("calling start() twice without awaiting the first schedules only one interval", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    const { factory } = recordingFactory();
    const { pool: countingPool, connectCount } = countingConnectPool(pool);

    vi.useFakeTimers();
    const root = createMailLiveSyncRoot(countingPool, factory, { discoveryIntervalMs: 1000 });

    const first = root.start();
    const second = root.start(); // fired before `first`'s initial reconcile has resolved
    await Promise.all([first, second]);

    const beforeTick = connectCount();
    await vi.advanceTimersByTimeAsync(1000);
    // `stop()` awaits the pass the tick started, so every connection it opens is counted by then.
    await root.stop();
    expect(connectCount() - beforeTick).toBe(2);
    const afterStop = connectCount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(connectCount()).toBe(afterStop);
  });

  it("stop() during start()'s initial reconcile leaves no interval scheduled once start() resumes, including start()->stop()->start()", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    let releaseFirstReconcile: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseFirstReconcile = resolve));
    let gateUsed = false;
    const { factory } = recordingFactory(undefined, () =>
      gateUsed
        ? {}
        : {
            start: async () => {
              gateUsed = true;
              await gate; // holds the first start()'s initial reconcileOnce() in flight
            },
          },
    );
    const { pool: countingPool, connectCount } = countingConnectPool(pool);

    vi.useFakeTimers();
    const root = createMailLiveSyncRoot(countingPool, factory, { discoveryIntervalMs: 1000 });

    const firstStart = root.start(); // still awaiting its initial reconcileOnce (gated above)
    await root.stop(); // bumps the generation and clears `started` while firstStart is in flight
    const secondStart = root.start(); // start() -> stop() -> start(): a fresh, current generation

    releaseFirstReconcile();
    await Promise.all([firstStart, secondStart]);

    // Only the second start()'s interval (the current generation) should be scheduled; the
    // first call's resumed continuation must have skipped scheduling as superseded.
    const beforeTick = connectCount();
    await vi.advanceTimersByTimeAsync(1000);
    // `stop()` awaits the pass the tick started, so every connection it opens is counted by then.
    await root.stop();
    expect(connectCount() - beforeTick).toBe(2);
    const afterStop = connectCount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(connectCount()).toBe(afterStop);
  });

  it("stop() waits for a discovery pass already in flight rather than returning while it still queries", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    let releaseIntervalPass: () => void = () => {};
    let intervalPassStarted = false;
    const gate = new Promise<void>((resolve) => (releaseIntervalPass = resolve));
    const { factory } = recordingFactory(undefined, () => ({
      start: async () => {
        // Only the interval-driven pass is gated; start()'s own initial reconcile must not be,
        // or start() itself would never resolve.
        if (!intervalPassStarted) return;
        await gate;
      },
    }));

    vi.useFakeTimers();
    const root = createMailLiveSyncRoot(pool, factory, { discoveryIntervalMs: 1000 });
    await root.start();

    intervalPassStarted = true;
    await vi.advanceTimersByTimeAsync(1000);

    let stopped = false;
    const stopping = root.stop().then(() => {
      stopped = true;
    });
    // Drain the microtask queue well past the handful of awaits stop() needs for its own
    // teardown. clearInterval cancels the next tick but not the pass already running, so as
    // long as that pass is gated stop() must not resolve no matter how long we yield for.
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(stopped).toBe(false);

    releaseIntervalPass();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("discovers a page of accounts in one transaction, isolating one account's seeding failure via a savepoint", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );
    const b = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "B", provider: "generic" } }),
    );
    const c = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "C", provider: "generic" } }),
    );

    const { pool: countingPool, connectCount } = countingConnectPool(failingSeedPool(pool, b.id));
    // Each hosted account's first heartbeat tick fires `pool.query()` immediately without being
    // awaited by `startProcessHeartbeat` — left untracked, that write can still be in flight when
    // this test (or a later one sharing the module-level `pool`) tears the connection down,
    // surfacing as an unrelated unhandled rejection deep in `failingSeedPool`'s proxy. Draining it
    // here keeps this test's own async work fully settled before it returns.
    const { pool: trackingPool, drain } = heartbeatTrackingPool(countingPool);

    const errors: Array<{ mailboxItemId: string; phase: string }> = [];
    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(trackingPool, factory, {
      onLifecycleError: (mailboxItemId, phase) => errors.push({ mailboxItemId, phase }),
    });

    const before = connectCount();
    await root.reconcileOnce();
    await drain();

    // A single page (three accounts, well under the 200-row page limit) costs exactly one
    // transaction for the whole page's read-and-seed, not one per account — plus one more
    // `pool.connect()` per account that actually got hosted (A and C; B never enters the active
    // set), since each one's first heartbeat tick fires its own `pool.query()` immediately.
    expect(connectCount() - before).toBe(4);

    expect(errors).toEqual([{ mailboxItemId: b.id, phase: "discover" }]);
    // The failing account never enters the active set, so it never gets a hosted lifecycle...
    expect(byAccount.has(b.id)).toBe(false);
    // ...while the rest of the page is unaffected: both other accounts started normally.
    expect(byAccount.get(a.id)?.starts).toBe(1);
    expect(byAccount.get(c.id)?.starts).toBe(1);

    const stateA = await withTransaction(pool, (client) => getMailAccountSyncState(client, a.id));
    const stateB = await withTransaction(pool, (client) => getMailAccountSyncState(client, b.id));
    const stateC = await withTransaction(pool, (client) => getMailAccountSyncState(client, c.id));
    expect(stateA).not.toBeNull();
    // The rolled-back savepoint means B's row was never actually inserted.
    expect(stateB).toBeNull();
    expect(stateC).not.toBeNull();

    await root.stop();
    await drain();
  });

  it("reports the seed error through onLifecycleError even when the savepoint rollback itself throws", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    const rollbackErr = new Error("rollback failed: connection reset");
    const { pool: trackingPool, drain } = heartbeatTrackingPool(failingSeedAndRollbackPool(pool, a.id, rollbackErr));

    const errors: Array<{ mailboxItemId: string; phase: string; err: unknown }> = [];
    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(trackingPool, factory, {
      onLifecycleError: (mailboxItemId, phase, err) => errors.push({ mailboxItemId, phase, err }),
    });

    // The rollback's own failure aborts the page's transaction; the per-tenant discovery catches it
    // and reports it as `("*", "discover", rollbackErr)`, so the pass itself resolves.
    await expect(root.reconcileOnce()).resolves.toBeUndefined();
    await drain();

    expect(errors).toHaveLength(2);
    const [reported, tenantReport] = errors;
    if (!reported || !tenantReport) throw new Error("expected two lifecycle errors");
    expect(tenantReport.mailboxItemId).toBe("*");
    expect(tenantReport.phase).toBe("discover");
    expect(tenantReport.err).toBe(rollbackErr);
    expect(reported.mailboxItemId).toBe(a.id);
    expect(reported.phase).toBe("discover");
    // The seed statement's own error must surface, not the rollback error that followed it.
    expect(reported.err).not.toBe(rollbackErr);
    expect(String((reported.err as Error).message)).not.toContain("rollback failed");
    expect(byAccount.has(a.id)).toBe(false);

    await root.stop();
    await drain();
  });

  it("resets the started guard when start()'s initial reconcile throws, so a later start() is not a permanent no-op", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    let connectCalls = 0;
    const flakyPool = new Proxy(pool, {
      get(t, prop, receiver) {
        if (prop === "connect") {
          return (...args: unknown[]) => {
            connectCalls++;
            if (connectCalls === 1) {
              const err = new Error("boom: simulated transient connection failure");
              // The first connect is the tenant enumeration's `pool.query()`, which connects callback-style.
              if (typeof args[0] === "function") return (args[0] as (e: Error) => void)(err);
              return Promise.reject(err);
            }
            return (t.connect as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(t, prop, receiver);
      },
    });

    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(flakyPool, factory);

    await expect(root.start()).rejects.toThrow(/boom/);

    // If `started` had stayed stuck `true` after that failure, this second call would silently
    // no-op at the guard check instead of actually running discovery.
    await root.start();
    expect(byAccount.get(a.id)?.starts).toBe(1);

    await root.stop();
  });
});

describe("mail live-sync root: per-account process heartbeat (issue #707)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("beats a mailsync:<id> heartbeat once a lifecycle starts, reported present and not stale", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    const { factory } = recordingFactory();
    const { pool: trackingPool, drain } = heartbeatTrackingPool(pool);
    const root = createMailLiveSyncRoot(trackingPool, factory);

    await root.reconcileOnce();
    await drain();

    const processName = mailSyncProcessName(a.id);
    const { rows } = await pool.query<{ beat_at: Date }>("SELECT beat_at FROM process_heartbeats WHERE process = $1", [
      processName,
    ]);
    expect(rows).toHaveLength(1);
    expect(Date.now() - rows[0]!.beat_at.getTime()).toBeLessThan(1000);

    const statuses = await getExpectedProcessHeartbeatStatuses(pool);
    const status = statuses.find((s) => s.process === processName);
    expect(status?.present).toBe(true);
    expect(status?.stale).toBe(false);

    await root.stop();
  });

  it("stops beating once the account is deactivated, so beat_at is never rewritten again", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    const { factory } = recordingFactory();
    const { pool: trackingPool, drain } = heartbeatTrackingPool(pool);
    const root = createMailLiveSyncRoot(trackingPool, factory);

    await root.reconcileOnce();
    await drain();

    const processName = mailSyncProcessName(a.id);
    const beforeDelete = await pool.query<{ beat_at: Date }>(
      "SELECT beat_at FROM process_heartbeats WHERE process = $1",
      [processName],
    );
    const beatAtBeforeDelete = beforeDelete.rows[0]?.beat_at;
    expect(beatAtBeforeDelete).toBeDefined();

    await chokePoint.softDeleteItem(mailboxesId, a.id);

    vi.useFakeTimers();
    try {
      // reconcileOnce() itself clears the heartbeat's interval synchronously via `stopHosted`;
      // advancing well past the heartbeat interval afterwards proves nothing was scheduled that
      // could still fire, not merely that we didn't wait long enough.
      await root.reconcileOnce();
      await vi.advanceTimersByTimeAsync(PROCESS_HEARTBEAT_INTERVAL_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await drain();

    const afterWait = await pool.query<{ beat_at: Date }>("SELECT beat_at FROM process_heartbeats WHERE process = $1", [
      processName,
    ]);
    expect(afterWait.rows[0]?.beat_at.toISOString()).toBe(beatAtBeforeDelete!.toISOString());

    // The expected set no longer includes the deactivated account either, so nothing alerts on it.
    const statuses = await getExpectedProcessHeartbeatStatuses(pool);
    expect(statuses.some((s) => s.process === processName)).toBe(false);
  });

  it("starts no heartbeat for a lifecycle whose start() throws", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    const errors: Array<{ mailboxItemId: string; phase: string }> = [];
    const { factory } = recordingFactory(undefined, () => ({
      start: async () => {
        throw new Error("boom: simulated transport failure for account A");
      },
    }));
    const { pool: trackingPool, drain } = heartbeatTrackingPool(pool);
    const root = createMailLiveSyncRoot(trackingPool, factory, {
      onLifecycleError: (mailboxItemId, phase) => errors.push({ mailboxItemId, phase }),
    });

    await root.reconcileOnce();
    await drain();

    expect(errors).toEqual([{ mailboxItemId: a.id, phase: "start" }]);

    const processName = mailSyncProcessName(a.id);
    const { rows } = await pool.query("SELECT 1 FROM process_heartbeats WHERE process = $1", [processName]);
    expect(rows).toHaveLength(0);

    await root.stop();
  });

  it('reports a heartbeat UPSERT failure through onLifecycleError with phase "heartbeat"', async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }),
    );

    const { factory } = recordingFactory();
    const { pool: trackingPool, drain, rejectNextUpsert } = heartbeatTrackingPool(pool);
    rejectNextUpsert(new Error("boom: simulated heartbeat UPSERT failure"));

    const errors: Array<{ mailboxItemId: string; phase: string }> = [];
    const root = createMailLiveSyncRoot(trackingPool, factory, {
      onLifecycleError: (mailboxItemId, phase) => errors.push({ mailboxItemId, phase }),
    });

    await root.reconcileOnce();
    await drain();

    expect(errors).toEqual([{ mailboxItemId: a.id, phase: "heartbeat" }]);

    await root.stop();
  });
});

describe("mail live-sync root: stopTenant (issue #1042)", () => {
  let dataPool: Pool;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await dataPool.end();
  });

  /** Tenant zero's mailbox, created through the runtime role inside tenant zero. */
  async function addMailboxToTenantZero(): Promise<string> {
    return addMailboxTo(getTenantZeroId(), { provider: "generic" });
  }

  /** A mailbox in a tenant that already has a Mailboxes database, created through the runtime role inside it. */
  async function addMailboxTo(tenantId: string, properties: Record<string, string> = {}): Promise<string> {
    return runInTenant(tenantId, () =>
      withTransaction(dataPool, async (client) => {
        const { rows } = await client.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
          MAILBOXES_MODULE_ID,
        ]);
        const databaseId = rows[0]?.id;
        if (!databaseId) throw new Error(`tenant ${tenantId} has no Mailboxes database`);
        const item = await createItemWithClient(client, { databaseId, properties });
        return item.id;
      }),
    );
  }

  /** A second tenant's minimal mail fixture: the four system mail databases and one mailbox. */
  async function addTenantWithMailbox(): Promise<{ tenantId: string; mailboxId: string }> {
    const tenantId = await createTestTenant(pool);
    const mailboxId = await runInTenant(tenantId, () =>
      withTransaction(dataPool, async (client) => {
        let mailboxesId = "";
        for (const ownerModuleId of [EMAILS_MODULE_ID, FILES_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID]) {
          // `key` stays unset: `databases_key_unique` is still global.
          const database = await createDatabase(client, { name: ownerModuleId, system: true, ownerModuleId });
          if (ownerModuleId === MAILBOXES_MODULE_ID) mailboxesId = database.id;
        }
        const item = await createItemWithClient(client, { databaseId: mailboxesId, properties: {} });
        return item.id;
      }),
    );
    return { tenantId, mailboxId };
  }

  /** Raw status write: the suspension's own writer needs users and an admin, none of which this root reads. */
  async function markSuspended(tenantId: string): Promise<void> {
    await pool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantId]);
  }

  async function beatAt(mailboxId: string): Promise<number | undefined> {
    const { rows } = await pool.query<{ beat_at: Date }>("SELECT beat_at FROM process_heartbeats WHERE process = $1", [
      mailSyncProcessName(mailboxId),
    ]);
    return rows[0]?.beat_at.getTime();
  }

  interface ScopedLifecycle extends MailAccountLifecycle {
    starts: Array<TenantScope | undefined>;
    stops: Array<TenantScope | undefined>;
  }

  function scopedFactory(startGate?: Promise<void>): {
    factory: MailLiveSyncLifecycleFactory;
    created: Array<{ mailboxItemId: string; lifecycle: ScopedLifecycle }>;
    events: string[];
  } {
    const created: Array<{ mailboxItemId: string; lifecycle: ScopedLifecycle }> = [];
    const events: string[] = [];
    const factory: MailLiveSyncLifecycleFactory = (account) => {
      const lifecycle: ScopedLifecycle = {
        starts: [],
        stops: [],
        async start() {
          lifecycle.starts.push(currentTenantScope());
          events.push(`start:${account.mailboxItemId}`);
          if (startGate) await startGate;
          events.push(`started:${account.mailboxItemId}`);
        },
        async stop() {
          lifecycle.stops.push(currentTenantScope());
          events.push(`stop:${account.mailboxItemId}`);
        },
      };
      created.push({ mailboxItemId: account.mailboxItemId, lifecycle });
      return lifecycle;
    };
    return { factory, created, events };
  }

  it("stops the tenant's lifecycles and heartbeats, keeps the other tenant's, and a later pass does not re-host them", async () => {
    const m0 = await addMailboxToTenantZero();
    const b = await addTenantWithMailbox();
    // Only the heartbeat's interval is faked, so its tick can be advanced without waiting 15 s.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { factory, created } = scopedFactory();
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();
    // Each hosted account's first beat is a fire-and-forget write, so wait for both rows to exist.
    await vi.waitFor(
      async () => {
        expect(await beatAt(b.mailboxId)).toBeDefined();
        expect(await beatAt(m0)).toBeDefined();
      },
      { timeout: 5000 },
    );
    const lifecycleOf = (id: string) => created.find((entry) => entry.mailboxItemId === id)!.lifecycle;

    await markSuspended(b.tenantId);
    await root.stopTenant(b.tenantId);

    expect(lifecycleOf(b.mailboxId).stops).toEqual([{ kind: "tenant", tenantId: b.tenantId }]);
    expect(lifecycleOf(m0).stops).toEqual([]);

    const before = { b: (await beatAt(b.mailboxId))!, m0: (await beatAt(m0))! };
    await vi.advanceTimersByTimeAsync(PROCESS_HEARTBEAT_INTERVAL_MS);
    await vi.waitFor(async () => expect(await beatAt(m0)).toBeGreaterThan(before.m0), { timeout: 5000 });
    expect(await beatAt(b.mailboxId)).toBe(before.b);

    await root.reconcileOnce();
    expect(created.map((entry) => entry.mailboxItemId)).toEqual(expect.arrayContaining([m0, b.mailboxId]));
    expect(created).toHaveLength(2);
    expect(lifecycleOf(m0).stops).toEqual([]);

    await root.stop();
  });

  it("does nothing on a second call for the same tenant", async () => {
    const m0 = await addMailboxToTenantZero();
    const b = await addTenantWithMailbox();
    const { factory, events } = scopedFactory();
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();
    await markSuspended(b.tenantId);

    await root.stopTenant(b.tenantId);
    await root.stopTenant(b.tenantId);

    expect(events.filter((event) => event.startsWith("stop:"))).toEqual([`stop:${b.mailboxId}`]);
    expect(events).not.toContain(`stop:${m0}`);

    await root.stop();
  });

  it("stops each lifecycle once, and waits for its stop, when a pass started while it waits retires the same tenant", async () => {
    const b = await addTenantWithMailbox();
    const b2 = await addMailboxTo(b.tenantId);
    const gate = (): { promise: Promise<void>; release: () => void } => {
      let release: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
    const startGates = new Map<string, Promise<void>>();
    const firstStop = gate();
    let stopCalls = 0;
    const events: string[] = [];
    const factory: MailLiveSyncLifecycleFactory = (account) => ({
      async start() {
        events.push(`start:${account.mailboxItemId}`);
        await startGates.get(account.mailboxItemId);
      },
      async stop() {
        events.push(`stop:${account.mailboxItemId}`);
        if (stopCalls++ === 0) await firstStop.promise;
      },
    });
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();
    expect(events.filter((event) => event.startsWith("start:")).sort()).toEqual(
      [`start:${b.mailboxId}`, `start:${b2}`].sort(),
    );

    // Pass 1 hosts a new tenant-zero mailbox and holds in its start, so stopTenant waits for it.
    const m0 = await addMailboxToTenantZero();
    const m0Start = gate();
    startGates.set(m0, m0Start.promise);
    await markSuspended(b.tenantId);
    const pass1 = root.reconcileOnce();
    await vi.waitFor(() => expect(events).toContain(`start:${m0}`));
    let stopped = false;
    const stopping = root.stopTenant(b.tenantId).then(() => {
      stopped = true;
    });

    // Pass 2 starts after stopTenant took its snapshot of running passes. Its retire loop
    // snapshots both of B's entries and holds in the first one's stop.
    const pass2 = root.reconcileOnce();
    await vi.waitFor(() => expect(events.filter((event) => event.startsWith("stop:"))).toHaveLength(1));

    // Pass 1 then retires B's other entry, and stopTenant finds nothing left hosted, but still
    // waits for pass 2's stop of B's first entry before it resolves.
    m0Start.release();
    await pass1;
    await vi.waitFor(() => expect(events.filter((event) => event.startsWith("stop:"))).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    firstStop.release();
    await stopping;
    await pass2;

    const stops = events.filter((event) => event.startsWith("stop:")).sort();
    expect(stops).toEqual([`stop:${b.mailboxId}`, `stop:${b2}`].sort());
    await root.stop();
  });

  it("waits for a discovery pass in flight before stopping, so a lifecycle still starting is stopped after it started", async () => {
    const b = await addTenantWithMailbox();
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { factory, events } = scopedFactory(startGate);
    const root = createMailLiveSyncRoot(dataPool, factory);

    const pass = root.reconcileOnce();
    await vi.waitFor(() => expect(events).toContain(`start:${b.mailboxId}`));
    let stopped = false;
    const stopping = root.stopTenant(b.tenantId).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);

    releaseStart();
    await pass;
    await stopping;

    expect(events.filter((event) => event.includes(b.mailboxId))).toEqual([
      `start:${b.mailboxId}`,
      `started:${b.mailboxId}`,
      `stop:${b.mailboxId}`,
    ]);
    // The heartbeat the finished start installed was stopped with the lifecycle: nothing is left hosted.
    await root.stop();
    expect(events.filter((event) => event.startsWith("stop:"))).toHaveLength(1);
  });
});
