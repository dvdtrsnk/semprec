import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
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
    const root = createMailLiveSyncRoot(pool, mailboxesId, factory);

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
    const root = createMailLiveSyncRoot(pool, mailboxesId, factory);
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
    const rootOne = createMailLiveSyncRoot(pool, mailboxesId, first.factory);
    await rootOne.reconcileOnce();
    expect(first.byAccount.get(a.id)?.starts).toBe(1);

    // Persisted sync state survives across "restarts" (a brand-new root instance, simulating a
    // process restart) — it is read back, not reset, and the fresh root does not start a
    // second concurrent lifecycle for the still-active account beyond its own one.
    const stateBeforeRestart = await withTransaction(pool, (client) => getMailAccountSyncState(client, a.id));

    const second = recordingFactory();
    const rootTwo = createMailLiveSyncRoot(pool, mailboxesId, second.factory);
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
    const root = createMailLiveSyncRoot(pool, mailboxesId, factory, {
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
    const root = createMailLiveSyncRoot(pool, mailboxesId, factory);
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
    const root = createMailLiveSyncRoot(countingPool, mailboxesId, factory, { discoveryIntervalMs: 1000 });

    await root.start();
    await root.start(); // second call must be a no-op: no second initial reconcile, no second interval

    const beforeTick = connectCount();
    await vi.advanceTimersByTimeAsync(1000);
    // Exactly one interval firing means exactly one discovery pass (one `pool.connect()`) per tick.
    expect(connectCount() - beforeTick).toBe(1);

    await root.stop();
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
    const root = createMailLiveSyncRoot(countingPool, mailboxesId, factory, { discoveryIntervalMs: 1000 });

    const first = root.start();
    const second = root.start(); // fired before `first`'s initial reconcile has resolved
    await Promise.all([first, second]);

    const beforeTick = connectCount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connectCount() - beforeTick).toBe(1);

    await root.stop();
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
    const root = createMailLiveSyncRoot(countingPool, mailboxesId, factory, { discoveryIntervalMs: 1000 });

    const firstStart = root.start(); // still awaiting its initial reconcileOnce (gated above)
    await root.stop(); // bumps the generation and clears `started` while firstStart is in flight
    const secondStart = root.start(); // start() -> stop() -> start(): a fresh, current generation

    releaseFirstReconcile();
    await Promise.all([firstStart, secondStart]);

    // Only the second start()'s interval (the current generation) should be scheduled; the
    // first call's resumed continuation must have skipped scheduling as superseded.
    const beforeTick = connectCount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connectCount() - beforeTick).toBe(1);

    await root.stop();
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
    const root = createMailLiveSyncRoot(pool, mailboxesId, factory, { discoveryIntervalMs: 1000 });
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

    const errors: Array<{ mailboxItemId: string; phase: string }> = [];
    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(countingPool, mailboxesId, factory, {
      onLifecycleError: (mailboxItemId, phase) => errors.push({ mailboxItemId, phase }),
    });

    const before = connectCount();
    await root.reconcileOnce();

    // A single page (three accounts, well under the 200-row page limit) costs exactly one
    // transaction for the whole page's read-and-seed, not one per account — plus one more
    // `pool.connect()` per account that actually got hosted (A and C; B never enters the active
    // set), since each one's first heartbeat tick fires its own `pool.query()` immediately.
    expect(connectCount() - before).toBe(3);

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
            if (connectCalls === 1) return Promise.reject(new Error("boom: simulated transient connection failure"));
            return (t.connect as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(t, prop, receiver);
      },
    });

    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(flakyPool, mailboxesId, factory);

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
    const root = createMailLiveSyncRoot(trackingPool, mailboxesId, factory);

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
    const root = createMailLiveSyncRoot(trackingPool, mailboxesId, factory);

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
    const root = createMailLiveSyncRoot(trackingPool, mailboxesId, factory, {
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
    const root = createMailLiveSyncRoot(trackingPool, mailboxesId, factory, {
      onLifecycleError: (mailboxItemId, phase) => errors.push({ mailboxItemId, phase }),
    });

    await root.reconcileOnce();
    await drain();

    expect(errors).toEqual([{ mailboxItemId: a.id, phase: "heartbeat" }]);

    await root.stop();
  });
});
