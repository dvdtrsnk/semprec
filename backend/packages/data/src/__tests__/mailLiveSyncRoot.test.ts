import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, createItemWithClient, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { getMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import {
  createMailLiveSyncRoot,
  type MailAccountLifecycle,
  type MailLiveSyncAccount,
  type MailLiveSyncLifecycleFactory,
} from "../mail/mailLiveSyncRoot.js";

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
  return { pool: proxy as unknown as Pool, connectCount: () => count };
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
          const client = (await (t.connect as (...a: unknown[]) => Promise<PoolClient>)(...args)) as PoolClient;
          return new Proxy(client, {
            get(clientTarget, clientProp, clientReceiver) {
              if (clientProp === "query") {
                return (...queryArgs: unknown[]) => {
                  const [text, params] = queryArgs as [string, unknown[] | undefined];
                  if (typeof text === "string" && text.includes("INSERT INTO mail_account_sync_state") && Array.isArray(params) && params[0] === failItemId) {
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
  return proxy as unknown as Pool;
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
    const a = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "gmail" } }));
    const b = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "B", provider: "imap" } }));

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
    const a = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));
    const b = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "B", provider: "generic" } }));

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
    const a = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));

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
    const a = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));
    const b = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "B", provider: "generic" } }));

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
    const a = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));

    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(pool, mailboxesId, factory);
    await root.reconcileOnce();
    expect(byAccount.get(a.id)?.starts).toBe(1);
    const firstLifecycle = byAccount.get(a.id)!;

    await withTransaction(pool, (client) => client.query("UPDATE mail_account_sync_state SET sync_mode = 'gmail_api' WHERE item_id = $1", [a.id]));
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
    await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));

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
    await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));

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
    await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));

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

  it("discovers a page of accounts in one transaction, isolating one account's seeding failure via a savepoint", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));
    const b = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "B", provider: "generic" } }));
    const c = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "C", provider: "generic" } }));

    const { pool: countingPool, connectCount } = countingConnectPool(failingSeedPool(pool, b.id));

    const errors: Array<{ mailboxItemId: string; phase: string }> = [];
    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(countingPool, mailboxesId, factory, {
      onLifecycleError: (mailboxItemId, phase) => errors.push({ mailboxItemId, phase }),
    });

    const before = connectCount();
    await root.reconcileOnce();

    // A single page (three accounts, well under the 200-row page limit) costs exactly one
    // transaction — one `pool.connect()` for the whole page's read-and-seed, not one per account.
    expect(connectCount() - before).toBe(1);

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
  });
});
