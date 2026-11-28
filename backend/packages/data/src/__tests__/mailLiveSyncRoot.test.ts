import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  currentTenantScope,
  getTraceContext,
  runInTenant,
  withTraceContext,
  type TenantScope,
  type TraceContext,
} from "@alldots/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import {
  clearMailSyncFailure,
  getMailAccountSyncState,
  recordSyncError,
  type MailSyncFailureKind,
} from "../mail/mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import { removeMailbox } from "../mail/mailboxRemoval.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import {
  createMailLiveSyncRoot,
  type MailAccountLifecycle,
  type MailLiveSyncAccount,
  type MailLiveSyncLifecycleFactory,
  type MailLiveSyncRoot,
} from "../mail/mailLiveSyncRoot.js";
import {
  getExpectedProcessHeartbeatStatuses,
  mailSyncProcessName,
  PROCESS_HEARTBEAT_INTERVAL_MS,
} from "../health/processHeartbeats.js";

let pool: Pool;
let dataPool: Pool;

beforeEach(async () => {
  pool ??= getTestPool();
  await resetDatabase(pool);
  await seedSystem(pool);
  dataPool = await createRuntimeRolePool(pool, "alldots_data");
});

afterEach(async () => {
  vi.useRealTimers();
  await dataPool.end();
});

const tenantZero = (): string => getTenantZeroId();

async function addTenant(): Promise<string> {
  const tenantId = await createTestTenant(pool);
  await provisionTenant(dataPool, tenantId);
  return tenantId;
}

function mailboxesDatabaseOf(tenantId: string): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => (await resolveMailModuleIds(client)).mailboxesDatabaseId),
  );
}

async function addMailbox(tenantId = tenantZero(), properties: Record<string, string> = {}): Promise<string> {
  const databaseId = await mailboxesDatabaseOf(tenantId);
  const item = await runInTenant(tenantId, () =>
    withTransaction(dataPool, (client) =>
      createItemWithClient(client, { databaseId, properties: { provider: "generic", ...properties } }),
    ),
  );
  return item.id;
}

async function trash(mailboxItemId: string, tenantId = tenantZero()): Promise<void> {
  const databaseId = await mailboxesDatabaseOf(tenantId);
  await runInTenant(tenantId, () => createChokePoint(dataPool).softDeleteItem(databaseId, mailboxItemId));
}

async function untrash(mailboxItemId: string, tenantId = tenantZero()): Promise<void> {
  const databaseId = await mailboxesDatabaseOf(tenantId);
  await runInTenant(tenantId, () => createChokePoint(dataPool).restoreItem(databaseId, mailboxItemId));
}

function syncStateOf(
  mailboxItemId: string,
  tenantId = tenantZero(),
): Promise<Awaited<ReturnType<typeof getMailAccountSyncState>>> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, (client) => getMailAccountSyncState(client, mailboxItemId)),
  );
}

/** Raw status write: the suspension's own writer needs users and an admin, which this root does not read. */
async function markSuspended(tenantId: string): Promise<void> {
  await pool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantId]);
}

async function heartbeatOf(mailboxId: string): Promise<{ beatAt: number; startedAt: number } | undefined> {
  const { rows } = await pool.query<{ beat_at: Date; started_at: Date }>(
    "SELECT beat_at, started_at FROM process_heartbeats WHERE process = $1",
    [mailSyncProcessName(mailboxId)],
  );
  return rows[0] && { beatAt: rows[0].beat_at.getTime(), startedAt: rows[0].started_at.getTime() };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise` has not settled after a while; it is still awaited by the test afterwards. */
async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await sleep(50);
  expect(settled).toBe(false);
}

type LifecycleError = { mailboxItemId: string; phase: string; err: unknown };

function createRoot(
  target: Pool,
  factory: MailLiveSyncLifecycleFactory,
  options: { discoveryIntervalMs?: number } = {},
): { root: MailLiveSyncRoot; errors: LifecycleError[]; phases: () => Array<{ mailboxItemId: string; phase: string }> } {
  const errors: LifecycleError[] = [];
  const root = createMailLiveSyncRoot(target, factory, {
    ...options,
    onLifecycleError: (mailboxItemId, phase, err) => errors.push({ mailboxItemId, phase, err }),
  });
  return { root, errors, phases: () => errors.map(({ mailboxItemId, phase }) => ({ mailboxItemId, phase })) };
}

interface RecordingLifecycle extends MailAccountLifecycle {
  starts: number;
  stops: number;
}

/** Counts each account's latest lifecycle's starts and stops; `behavior` may replace what a start or stop does. */
function recordingFactory(behavior?: (account: MailLiveSyncAccount) => Partial<MailAccountLifecycle>): {
  factory: MailLiveSyncLifecycleFactory;
  byAccount: Map<string, RecordingLifecycle>;
} {
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
    return lifecycle;
  };
  return { factory, byAccount };
}

interface Created {
  mailboxItemId: string;
  starts: Array<{ scope: TenantScope | undefined; trace: TraceContext | undefined }>;
  stops: Array<TenantScope | undefined>;
}

/**
 * Lifecycles recording `start:<label>`, `started:<label>` and `stop:<label>`, where the label is the creation
 * number with `numbered` and the mailbox id otherwise. A start or stop waits for its mailbox's gate, and
 * `behavior` may hold or fail the start or the stop of lifecycle `n`.
 */
function eventFactory(options: { numbered?: boolean; behavior?: (n: number) => Partial<MailAccountLifecycle> } = {}): {
  factory: MailLiveSyncLifecycleFactory;
  created: Created[];
  events: string[];
  startGates: Map<string, Promise<void>>;
  stopGates: Map<string, Promise<void>>;
} {
  const created: Created[] = [];
  const events: string[] = [];
  const startGates = new Map<string, Promise<void>>();
  const stopGates = new Map<string, Promise<void>>();
  const factory: MailLiveSyncLifecycleFactory = (account) => {
    const record: Created = { mailboxItemId: account.mailboxItemId, starts: [], stops: [] };
    created.push(record);
    const n = created.length;
    const label = options.numbered ? String(n) : account.mailboxItemId;
    const overrides = options.behavior?.(n) ?? {};
    return {
      async start() {
        record.starts.push({ scope: currentTenantScope(), trace: getTraceContext() });
        events.push(`start:${label}`);
        await startGates.get(account.mailboxItemId);
        await overrides.start?.();
        events.push(`started:${label}`);
      },
      async stop() {
        record.stops.push(currentTenantScope());
        events.push(`stop:${label}`);
        await stopGates.get(account.mailboxItemId);
        await overrides.stop?.();
      },
    };
  };
  return { factory, created, events, startGates, stopGates };
}

const stopsOf = (events: string[]): string[] => events.filter((event) => event.startsWith("stop:"));
const startsOf = (events: string[]): string[] => events.filter((event) => event.startsWith("start:"));
const tenantScope = (tenantId: string): TenantScope => ({ kind: "tenant", tenantId });

/** Counts every `pool.connect()` call, a proxy for how many transactions discovery opens. */
function countingConnectPool(target: Pool): { pool: Pool; connectCount: () => number } {
  let count = 0;
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop !== "connect") return Reflect.get(t, prop, receiver);
      return (...args: unknown[]) => {
        count++;
        return (t.connect as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
  return { pool: proxy, connectCount: () => count };
}

/**
 * Lets `onQuery` see each query of the clients `target.connect()` hands out in promise style; `forward` runs
 * the query unchanged. A heartbeat's `pool.query()` connects in callback style and is not intercepted.
 */
function interceptClientQueries(
  target: Pool,
  onQuery: (client: PoolClient, text: unknown, params: unknown, forward: () => unknown) => unknown,
): Pool {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop !== "connect") return Reflect.get(t, prop, receiver);
      return async (...args: unknown[]) => {
        if (typeof args[0] === "function") return (t.connect as (...a: unknown[]) => unknown)(...args);
        const client = await (t.connect as (...a: unknown[]) => Promise<PoolClient>)(...args);
        return new Proxy(client, {
          get(clientTarget, clientProp, clientReceiver) {
            if (clientProp !== "query") return Reflect.get(clientTarget, clientProp, clientReceiver);
            return (...queryArgs: unknown[]) =>
              onQuery(clientTarget, queryArgs[0], queryArgs[1], () =>
                (clientTarget.query as (...a: unknown[]) => unknown)(...queryArgs),
              );
          },
        });
      };
    },
  });
}

const isSeedOf = (text: unknown, params: unknown, itemId?: string): params is unknown[] =>
  typeof text === "string" &&
  text.includes("INSERT INTO mail_account_sync_state") &&
  Array.isArray(params) &&
  (itemId === undefined || params[0] === itemId);

/**
 * Makes the `mail_account_sync_state` seeding INSERT for `failItemId` a statement the server rejects: a
 * client-side rejection would not abort the transaction in Postgres, so it would pass even without savepoints.
 * With `rollbackErr`, the following `ROLLBACK TO SAVEPOINT discover_account` rejects with it as well.
 */
function failingSeedPool(target: Pool, failItemId: string, rollbackErr?: Error): Pool {
  return interceptClientQueries(target, (client, text, params, forward) => {
    if (isSeedOf(text, params, failItemId)) {
      return client.query(
        "INSERT INTO mail_account_sync_state (item_id, sync_mode, this_column_does_not_exist) VALUES ($1, $2, 'x')",
        params,
      );
    }
    if (rollbackErr && text === "ROLLBACK TO SAVEPOINT discover_account") return Promise.reject(rollbackErr);
    return forward();
  });
}

/**
 * Lets a test await every `process_heartbeats` UPSERT, which `startProcessHeartbeat` never awaits.
 * `rejectNextUpsert` makes the next one reject, to exercise the "heartbeat" lifecycle error.
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
      if (prop !== "query") return Reflect.get(t, prop, receiver);
      return (...args: unknown[]) => {
        if (typeof args[0] !== "string" || !args[0].includes("INSERT INTO process_heartbeats")) {
          return (t.query as (...a: unknown[]) => unknown)(...args);
        }
        const err = rejectOnce;
        rejectOnce = null;
        const result = err ? Promise.reject(err) : (t.query as (...a: unknown[]) => Promise<unknown>)(...args);
        pending.push(result.catch(() => {}));
        return result;
      };
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

describe("mail live-sync composition root", () => {
  it("starts exactly one lifecycle per active account, seeding its sync state, and stops each on stop()", async () => {
    const a = await addMailbox(tenantZero(), { provider: "gmail" });
    const b = await addMailbox(tenantZero(), { provider: "imap" });
    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(pool, factory);

    await root.reconcileOnce();
    // A second pass with an unchanged active set starts no second lifecycle for either account.
    await root.reconcileOnce();
    expect([byAccount.get(a)?.starts, byAccount.get(b)?.starts]).toEqual([1, 1]);
    expect((await syncStateOf(a))?.syncMode).toBe("gmail_api");

    await root.stop();
    expect([byAccount.get(a)?.stops, byAccount.get(b)?.stops]).toEqual([1, 1]);
  });

  it("stops a lifecycle when its account is trashed, leaving the others running, and hosts it again once restored", async () => {
    const a = await addMailbox();
    const b = await addMailbox();
    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(pool, factory);
    await root.reconcileOnce();
    const first = byAccount.get(a);

    await trash(a);
    await root.reconcileOnce();
    expect([first?.stops, byAccount.get(b)?.stops]).toEqual([1, 0]);

    await untrash(a);
    await root.reconcileOnce();
    expect(byAccount.get(a)).not.toBe(first);
    expect(byAccount.get(a)?.starts).toBe(1);
    await root.stop();
  });

  it.each<[MailSyncFailureKind, string, boolean]>([
    ["reauthorization", "stops hosting the account until a sign-in clears the failure", false],
    ["connectionLimit", "keeps hosting the account", true],
    ["other", "keeps hosting the account", true],
  ])("after a sync failure of kind %s, %s", async (failureKind, _outcome, hosted) => {
    const a = await addMailbox();
    const b = await addMailbox();
    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(pool, factory);
    await root.reconcileOnce();
    const first = byAccount.get(a);

    await runInTenant(tenantZero(), () =>
      withTransaction(dataPool, (client) => recordSyncError(client, a, "failure", failureKind)),
    );
    await root.reconcileOnce();
    expect([first?.stops, byAccount.get(b)?.stops]).toEqual([hosted ? 0 : 1, 0]);

    await runInTenant(tenantZero(), () => withTransaction(dataPool, (client) => clearMailSyncFailure(client, a)));
    await root.reconcileOnce();
    expect(byAccount.get(a) === first).toBe(hosted);
    expect(byAccount.get(a)?.stops).toBe(0);
    await root.stop();
  });

  it("restarting the composition root restores state instead of resetting it and does not duplicate a watcher", async () => {
    const a = await addMailbox();
    const first = recordingFactory();
    await createMailLiveSyncRoot(pool, first.factory).reconcileOnce();
    const stateBeforeRestart = await syncStateOf(a);

    // Persisted sync state survives a restart (a brand-new root instance): it is read back, not reset, and
    // the fresh root starts only its own lifecycle for the still-active account.
    const second = recordingFactory();
    await createMailLiveSyncRoot(pool, second.factory).reconcileOnce();
    expect([first.byAccount.get(a)?.starts, second.byAccount.get(a)?.starts]).toEqual([1, 1]);
    const stateAfterRestart = await syncStateOf(a);
    expect(stateAfterRestart?.syncMode).toBe(stateBeforeRestart?.syncMode);
    expect(stateAfterRestart?.nextExpectedActivityAt).toBe(stateBeforeRestart?.nextExpectedActivityAt);
  });

  it("isolates one account's lifecycle failure from the others, and still stops the failed one", async () => {
    const a = await addMailbox();
    const b = await addMailbox();
    const { factory, byAccount } = recordingFactory((account) =>
      account.mailboxItemId === a
        ? {
            start: async () => {
              throw new Error("boom: simulated transport failure for account A");
            },
          }
        : {},
    );
    const { root, phases } = createRoot(pool, factory);

    await root.reconcileOnce();
    expect(phases()).toEqual([{ mailboxItemId: a, phase: "start" }]);
    expect([byAccount.get(a)?.starts, byAccount.get(b)?.starts]).toEqual([1, 1]);

    await root.stop();
    // A's start threw, but the composition root already recorded it as hosted, so it gets a matching stop.
    expect([byAccount.get(a)?.stops, byAccount.get(b)?.stops]).toEqual([1, 1]);
  });

  it("restarts a lifecycle when the account's sync mode changes instead of hosting two at once", async () => {
    const a = await addMailbox();
    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(pool, factory);
    await root.reconcileOnce();
    const firstLifecycle = byAccount.get(a);

    await pool.query("UPDATE mail_account_sync_state SET sync_mode = 'gmail_api' WHERE item_id = $1", [a]);
    await root.reconcileOnce();

    expect(firstLifecycle?.stops).toBe(1);
    expect(byAccount.get(a)).not.toBe(firstLifecycle);
    expect(byAccount.get(a)?.starts).toBe(1);
    await root.stop();
  });
});

describe("mail live-sync root: double-start guard and batched discovery", () => {
  /** One interval firing is one discovery pass, the tenant enumeration plus one page transaction; then none. */
  async function expectOneIntervalPassThenNone(root: MailLiveSyncRoot, connectCount: () => number): Promise<void> {
    const beforeTick = connectCount();
    await vi.advanceTimersByTimeAsync(1000);
    // `stop()` awaits the pass the tick started, so every connection it opens is counted by then.
    await root.stop();
    expect(connectCount() - beforeTick).toBe(2);
    const afterStop = connectCount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(connectCount()).toBe(afterStop);
  }

  it.each([
    [
      "sequentially",
      async (root: MailLiveSyncRoot) => {
        await root.start();
        await root.start();
      },
    ],
    ["without awaiting the first", (root: MailLiveSyncRoot) => Promise.all([root.start(), root.start()])],
  ])(
    "calling start() twice %s schedules only one interval, and a single stop() leaves none firing",
    async (_, twice) => {
      await addMailbox();
      const { pool: countingPool, connectCount } = countingConnectPool(pool);
      vi.useFakeTimers();
      const root = createMailLiveSyncRoot(countingPool, recordingFactory().factory, { discoveryIntervalMs: 1000 });

      await twice(root);
      await expectOneIntervalPassThenNone(root, connectCount);
    },
  );

  it("stop() during start()'s initial reconcile leaves no interval scheduled once start() resumes, including start()->stop()->start()", async () => {
    await addMailbox();
    const firstReconcile = gate();
    let gateUsed = false;
    const { factory } = recordingFactory(() =>
      gateUsed
        ? {}
        : {
            start: async () => {
              gateUsed = true;
              await firstReconcile.promise;
            },
          },
    );
    const { pool: countingPool, connectCount } = countingConnectPool(pool);
    vi.useFakeTimers();
    const root = createMailLiveSyncRoot(countingPool, factory, { discoveryIntervalMs: 1000 });

    const firstStart = root.start(); // still awaiting its initial reconcileOnce (gated above)
    await root.stop(); // bumps the generation and clears `started` while firstStart is in flight
    const secondStart = root.start(); // a fresh, current generation
    firstReconcile.release();
    await Promise.all([firstStart, secondStart]);

    // Only the second start()'s interval is scheduled; the first call's resumed continuation skips scheduling.
    await expectOneIntervalPassThenNone(root, connectCount);
  });

  it("stop() waits for a discovery pass already in flight rather than returning while it still queries", async () => {
    await addMailbox();
    const intervalPass = gate();
    let gated = false;
    // Only the interval-driven pass is gated; gating start()'s initial reconcile would hang start().
    const { factory } = recordingFactory(() => ({ start: () => (gated ? intervalPass.promise : Promise.resolve()) }));
    vi.useFakeTimers();
    const root = createMailLiveSyncRoot(pool, factory, { discoveryIntervalMs: 1000 });
    await root.start();
    gated = true;
    await vi.advanceTimersByTimeAsync(1000);

    let stopped = false;
    const stopping = root.stop().then(() => {
      stopped = true;
    });
    // Yield well past the awaits stop() needs for its own teardown. clearInterval does not cancel the pass
    // already running, so while that pass is gated stop() must not resolve.
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(stopped).toBe(false);
    intervalPass.release();
    await stopping;
  });

  it("discovers a page of accounts in one transaction, isolating one account's seeding failure via a savepoint", async () => {
    const a = await addMailbox();
    const b = await addMailbox();
    const c = await addMailbox();
    const { pool: countingPool, connectCount } = countingConnectPool(failingSeedPool(pool, b));
    // Each hosted account's first heartbeat tick fires an unawaited `pool.query()`; draining it keeps it from
    // surfacing as an unrelated unhandled rejection when a later test tears the pool down.
    const { pool: trackingPool, drain } = heartbeatTrackingPool(countingPool);
    const { factory, byAccount } = recordingFactory();
    const { root, phases } = createRoot(trackingPool, factory);

    const before = connectCount();
    await root.reconcileOnce();
    await drain();

    // A single page costs one transaction for the whole page's read-and-seed, plus one `pool.connect()` per
    // hosted account (A and C) for its first heartbeat tick.
    expect(connectCount() - before).toBe(4);
    expect(phases()).toEqual([{ mailboxItemId: b, phase: "discover" }]);
    // The failing account never enters the active set; the rest of the page is unaffected.
    expect(byAccount.has(b)).toBe(false);
    expect([byAccount.get(a)?.starts, byAccount.get(c)?.starts]).toEqual([1, 1]);
    expect([await syncStateOf(a), await syncStateOf(b), await syncStateOf(c)].map((state) => state !== null)).toEqual([
      true,
      false,
      true,
    ]);

    await root.stop();
    await drain();
  });

  it("reports the seed error through onLifecycleError even when the savepoint rollback itself throws", async () => {
    const a = await addMailbox();
    const rollbackErr = new Error("rollback failed: connection reset");
    const { pool: trackingPool, drain } = heartbeatTrackingPool(failingSeedPool(pool, a, rollbackErr));
    const { factory, byAccount } = recordingFactory();
    const { root, errors } = createRoot(trackingPool, factory);

    // The rollback's own failure aborts the page's transaction; the per-tenant discovery reports it as
    // `("*", "discover", rollbackErr)`, so the pass itself resolves.
    await expect(root.reconcileOnce()).resolves.toBeUndefined();
    await drain();

    expect(errors).toEqual([
      // The seed statement's own error surfaces, not the rollback error that followed it.
      {
        mailboxItemId: a,
        phase: "discover",
        err: expect.objectContaining({ message: expect.not.stringContaining("rollback failed") }),
      },
      { mailboxItemId: "*", phase: "discover", err: rollbackErr },
    ]);
    expect(errors[0]?.err).toBeInstanceOf(Error);
    expect(errors[0]?.err).not.toBe(rollbackErr);
    expect(byAccount.has(a)).toBe(false);

    await root.stop();
    await drain();
  });

  it("resets the started guard when start()'s initial reconcile throws, so a later start() is not a permanent no-op", async () => {
    const a = await addMailbox();
    let connectCalls = 0;
    const flakyPool = new Proxy(pool, {
      get(t, prop, receiver) {
        if (prop !== "connect") return Reflect.get(t, prop, receiver);
        return (...args: unknown[]) => {
          if (++connectCalls === 1) {
            const err = new Error("boom: simulated transient connection failure");
            // The first connect is the tenant enumeration's `pool.query()`, which connects callback-style.
            if (typeof args[0] === "function") return (args[0] as (e: Error) => void)(err);
            return Promise.reject(err);
          }
          return (t.connect as (...a: unknown[]) => unknown)(...args);
        };
      },
    });
    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(flakyPool, factory);

    await expect(root.start()).rejects.toThrow(/boom/);
    await root.start();
    expect(byAccount.get(a)?.starts).toBe(1);
    await root.stop();
  });
});

describe("mail live-sync root: per-account process heartbeat", () => {
  it("beats a mailsync:<id> heartbeat once a lifecycle starts, reported present and not stale", async () => {
    const a = await addMailbox();
    const { pool: trackingPool, drain } = heartbeatTrackingPool(pool);
    const root = createMailLiveSyncRoot(trackingPool, recordingFactory().factory);

    await root.reconcileOnce();
    await drain();

    const beat = await heartbeatOf(a);
    expect(Date.now() - (beat?.beatAt ?? 0)).toBeLessThan(1000);
    const status = (await getExpectedProcessHeartbeatStatuses(pool)).find((s) => s.process === mailSyncProcessName(a));
    expect(status).toMatchObject({ present: true, stale: false });
    await root.stop();
  });

  it("stops beating once the account is deactivated, so beat_at is never rewritten again", async () => {
    const a = await addMailbox();
    const { pool: trackingPool, drain } = heartbeatTrackingPool(pool);
    const root = createMailLiveSyncRoot(trackingPool, recordingFactory().factory);
    await root.reconcileOnce();
    await drain();
    const before = await heartbeatOf(a);
    expect(before).toBeDefined();

    await trash(a);
    vi.useFakeTimers();
    // reconcileOnce() clears the heartbeat's interval synchronously; advancing well past the interval proves
    // nothing was left scheduled.
    await root.reconcileOnce();
    await vi.advanceTimersByTimeAsync(PROCESS_HEARTBEAT_INTERVAL_MS * 2);
    vi.useRealTimers();
    await drain();

    expect((await heartbeatOf(a))?.beatAt).toBe(before?.beatAt);
    expect((await getExpectedProcessHeartbeatStatuses(pool)).some((s) => s.process === mailSyncProcessName(a))).toBe(
      false,
    );
  });

  it("starts no heartbeat for a lifecycle whose start() throws", async () => {
    const a = await addMailbox();
    const { factory } = recordingFactory(() => ({
      start: async () => {
        throw new Error("boom: simulated transport failure for account A");
      },
    }));
    const { pool: trackingPool, drain } = heartbeatTrackingPool(pool);
    const { root, phases } = createRoot(trackingPool, factory);

    await root.reconcileOnce();
    await drain();

    expect(phases()).toEqual([{ mailboxItemId: a, phase: "start" }]);
    expect(await heartbeatOf(a)).toBeUndefined();
    await root.stop();
  });

  it('reports a heartbeat UPSERT failure through onLifecycleError with phase "heartbeat"', async () => {
    const a = await addMailbox();
    const { pool: trackingPool, drain, rejectNextUpsert } = heartbeatTrackingPool(pool);
    rejectNextUpsert(new Error("boom: simulated heartbeat UPSERT failure"));
    const { root, phases } = createRoot(trackingPool, recordingFactory().factory);

    await root.reconcileOnce();
    await drain();

    expect(phases()).toEqual([{ mailboxItemId: a, phase: "heartbeat" }]);
    await root.stop();
  });
});

/** The two ways a caller retires hosted lifecycles: a whole tenant, or one mailbox of it. */
const stopEntryPoints = [
  ["stopTenant", (root: MailLiveSyncRoot, tenantId: string) => root.stopTenant(tenantId)],
  ["stopMailbox", (root: MailLiveSyncRoot, tenantId: string, mailbox: string) => root.stopMailbox(tenantId, mailbox)],
] as const;

describe("mail live-sync root: stopTenant and stopMailbox", () => {
  it("stopTenant stops the tenant's lifecycles and heartbeats, keeps the other tenant's, does nothing on a second call, and a later pass does not re-host them", async () => {
    const m0 = await addMailbox();
    const tenantB = await addTenant();
    const b = await addMailbox(tenantB);
    // Only the heartbeat's interval is faked, so its tick can be advanced without waiting 15 s.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { factory, created, events } = eventFactory();
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();
    // Each hosted account's first beat is a fire-and-forget write, so wait for both rows to exist.
    await vi.waitFor(async () => {
      expect(await heartbeatOf(b)).toBeDefined();
      expect(await heartbeatOf(m0)).toBeDefined();
    });

    await markSuspended(tenantB);
    await root.stopTenant(tenantB);
    await root.stopTenant(tenantB);
    expect(stopsOf(events)).toEqual([`stop:${b}`]);
    expect(created.find((entry) => entry.mailboxItemId === b)?.stops).toEqual([tenantScope(tenantB)]);

    const before = { b: (await heartbeatOf(b))?.beatAt, m0: (await heartbeatOf(m0))?.beatAt ?? Infinity };
    await vi.advanceTimersByTimeAsync(PROCESS_HEARTBEAT_INTERVAL_MS);
    await vi.waitFor(async () => expect((await heartbeatOf(m0))?.beatAt).toBeGreaterThan(before.m0));
    expect((await heartbeatOf(b))?.beatAt).toBe(before.b);

    await root.reconcileOnce();
    expect(created.map((entry) => entry.mailboxItemId).sort()).toEqual([m0, b].sort());
    expect(stopsOf(events)).toEqual([`stop:${b}`]);
    await root.stop();
  });

  it("stopMailbox stops the mailbox's lifecycle in its tenant's scope, leaves the tenant's other mailbox and another tenant's running, and does nothing on a second call", async () => {
    const tenantB = await addTenant();
    const removed = await addMailbox(tenantB);
    const sibling = await addMailbox(tenantB);
    const foreign = await addMailbox();
    const { factory, created, events } = eventFactory();
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();
    expect(startsOf(events).sort()).toEqual([`start:${removed}`, `start:${sibling}`, `start:${foreign}`].sort());

    await root.stopMailbox(tenantB, removed);
    await root.stopMailbox(tenantB, removed);
    expect(stopsOf(events)).toEqual([`stop:${removed}`]);
    expect(created.find((entry) => entry.mailboxItemId === removed)?.stops).toEqual([tenantScope(tenantB)]);

    await root.stop();
    expect(stopsOf(events).sort()).toEqual([`stop:${removed}`, `stop:${sibling}`, `stop:${foreign}`].sort());
  });

  it("stopMailbox leaves a mailbox hosted for another tenant, and an id that is not hosted, as they are", async () => {
    const tenantB = await addTenant();
    const hostedForB = await addMailbox(tenantB);
    const { factory, events } = eventFactory();
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();

    // The id is tenant B's, the tenant named is tenant zero: the caller does not own the lifecycle.
    await root.stopMailbox(tenantZero(), hostedForB);
    await root.stopMailbox(tenantB, "00000000-0000-4000-8000-000000000000");
    expect(stopsOf(events)).toEqual([]);

    await root.stopMailbox(tenantB, hostedForB);
    expect(stopsOf(events)).toEqual([`stop:${hostedForB}`]);
    await root.stop();
  });

  it.each([
    ["the mailbox's own tenant scope, as the removal's cleanup calls it, stops the lifecycle in that scope", true],
    ["another tenant's scope leaves the mailbox hosted, so that a later stop still reaches its lifecycle", false],
  ])("stopMailbox called from inside %s", async (_, ownScope) => {
    const tenantB = await addTenant();
    const mailbox = await addMailbox(tenantB);
    const { factory, created, events } = eventFactory();
    const { root, errors } = createRoot(dataPool, factory);
    await root.reconcileOnce();

    await runInTenant(ownScope ? tenantB : tenantZero(), () => root.stopMailbox(tenantB, mailbox));

    expect(stopsOf(events)).toEqual(ownScope ? [`stop:${mailbox}`] : []);
    expect(errors).toEqual([]);
    await root.stop();
    expect(stopsOf(events)).toEqual([`stop:${mailbox}`]);
    expect(created[0]?.stops).toEqual([tenantScope(tenantB)]);
  });

  it.each(stopEntryPoints)(
    "%s stops a lifecycle that a discovery pass is still starting only after it started",
    async (_, stopEntry) => {
      const tenantB = await addTenant();
      const mailbox = await addMailbox(tenantB);
      const { factory, events, startGates } = eventFactory();
      const starting = gate();
      startGates.set(mailbox, starting.promise);
      const root = createMailLiveSyncRoot(dataPool, factory);

      const pass = root.reconcileOnce();
      await vi.waitFor(() => expect(events).toContain(`start:${mailbox}`));
      const stopping = stopEntry(root, tenantB, mailbox);
      await expectStillPending(stopping);
      expect(stopsOf(events)).toEqual([]);

      starting.release();
      await pass;
      await stopping;
      expect(events).toEqual([`start:${mailbox}`, `started:${mailbox}`, `stop:${mailbox}`]);
      // Nothing is left hosted, the heartbeat the finished start installed included.
      await root.stop();
      expect(stopsOf(events)).toHaveLength(1);
    },
  );

  it.each(stopEntryPoints)(
    "%s waits for a restartAccount in flight and then stops the lifecycle that restart hosted",
    async (_, stopEntry) => {
      const tenantB = await addTenant();
      const mailbox = await addMailbox(tenantB);
      const oldStop = gate();
      const { factory, events } = eventFactory({
        numbered: true,
        behavior: (n) => (n === 1 ? { stop: () => oldStop.promise } : {}),
      });
      const root = createMailLiveSyncRoot(dataPool, factory);
      await root.reconcileOnce();

      // The restart holds in the old lifecycle's stop: at this moment the root hosts no entry for the mailbox.
      const restarting = root.restartAccount(mailbox);
      await vi.waitFor(() => expect(events).toContain("stop:1"));
      const stopping = stopEntry(root, tenantB, mailbox);
      await expectStillPending(stopping);

      oldStop.release();
      await restarting;
      await stopping;
      expect(events).toEqual(["start:1", "started:1", "stop:1", "start:2", "started:2", "stop:2"]);
      await root.stop();
      expect(stopsOf(events)).toEqual(["stop:1", "stop:2"]);
    },
  );

  it("stopMailbox waits for a pass that has listed the mailbox and not hosted it yet, and then stops the lifecycle that pass hosted", async () => {
    const tenantB = await addTenant();
    const one = await addMailbox(tenantB);
    const other = await addMailbox(tenantB);
    const { factory, events, startGates } = eventFactory();
    const held = gate();
    startGates.set(one, held.promise);
    startGates.set(other, held.promise);
    const root = createMailLiveSyncRoot(dataPool, factory);

    // A pass hosts one mailbox at a time: it holds in the start of one of the two and has only listed the other.
    const pass = root.reconcileOnce();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const listedOnly = events[0] === `start:${one}` ? other : one;
    const stopping = root.stopMailbox(tenantB, listedOnly);
    await expectStillPending(stopping);

    held.release();
    await pass;
    await stopping;
    expect(events.filter((event) => event.endsWith(listedOnly))).toEqual([
      `start:${listedOnly}`,
      `started:${listedOnly}`,
      `stop:${listedOnly}`,
    ]);
    expect(stopsOf(events)).toEqual([`stop:${listedOnly}`]);
    await root.stop();
    expect(stopsOf(events)).toHaveLength(2);
  });

  it("after stopMailbox, a later pass hosts the mailbox again while its item is live, and not once the item is in the trash", async () => {
    const tenantB = await addTenant();
    const mailbox = await addMailbox(tenantB);
    const { factory, events } = eventFactory();
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();

    await root.stopMailbox(tenantB, mailbox);
    await root.reconcileOnce();
    expect(startsOf(events)).toHaveLength(2);

    await trash(mailbox, tenantB);
    await root.stopMailbox(tenantB, mailbox);
    await root.reconcileOnce();
    expect(startsOf(events)).toHaveLength(2);
    await root.stop();
    expect(stopsOf(events)).toEqual([`stop:${mailbox}`, `stop:${mailbox}`]);
  });

  it.each([
    [
      "stopTenant",
      "two mailboxes of the suspended tenant",
      async (root: MailLiveSyncRoot, tenantB: string) => {
        await markSuspended(tenantB);
        return () => root.stopTenant(tenantB);
      },
    ],
    [
      "stopMailbox",
      "a trashed mailbox",
      async (root: MailLiveSyncRoot, tenantB: string, retired: string[]) => {
        const [mailbox] = retired;
        if (!mailbox) throw new Error("expected a mailbox");
        await trash(mailbox, tenantB);
        return () => root.stopMailbox(tenantB, mailbox);
      },
    ],
  ])(
    "%s stops each lifecycle once, and waits for its stop, when a pass started while it waits retires %s",
    async (entryPoint, _, retire) => {
      const tenantB = await addTenant();
      const retired = [await addMailbox(tenantB), ...(entryPoint === "stopTenant" ? [await addMailbox(tenantB)] : [])];
      const firstStop = gate();
      let stopCalls = 0;
      const { factory, events, startGates } = eventFactory({
        behavior: () => ({
          stop: async () => {
            if (stopCalls++ === 0) await firstStop.promise;
          },
        }),
      });
      const root = createMailLiveSyncRoot(dataPool, factory);
      await root.reconcileOnce();

      // Pass 1 hosts a new tenant-zero mailbox and holds in its start, so the stop waits for it.
      const other = await addMailbox();
      const otherStart = gate();
      startGates.set(other, otherStart.promise);
      const stopEntry = await retire(root, tenantB, retired);
      const pass1 = root.reconcileOnce();
      await vi.waitFor(() => expect(events).toContain(`start:${other}`));
      const stopping = stopEntry();

      // Pass 2 starts after the stop took its snapshot of running passes. It retires the entries and holds in
      // the first one's stop.
      const pass2 = root.reconcileOnce();
      await vi.waitFor(() => expect(stopsOf(events)).toHaveLength(1));

      // Pass 1 then ends (retiring what is left); the stop finds nothing left hosted, but still waits for
      // pass 2's held stop before it resolves.
      otherStart.release();
      await pass1;
      await vi.waitFor(() => expect(stopsOf(events)).toHaveLength(retired.length));
      await expectStillPending(stopping);
      firstStop.release();
      await stopping;
      await pass2;

      expect(stopsOf(events).sort()).toEqual(retired.map((id) => `stop:${id}`).sort());
      await root.stop();
      expect(stopsOf(events)).toContain(`stop:${other}`);
    },
  );

  it("stops a lifecycle an overlapping pass retired while it started only after its start, and installs no heartbeat for it", async () => {
    const tenantB = await addTenant();
    const b = await addMailbox(tenantB);
    const startGate = gate();
    // Only intervals are faked, so a heartbeat left running shows up as a pending fake timer.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { factory, events, startGates } = eventFactory();
    startGates.set(b, startGate.promise);
    const root = createMailLiveSyncRoot(dataPool, factory);

    // Pass 1 hosts B's mailbox and holds in its start; pass 2 no longer sees B active and retires it.
    const pass1 = root.reconcileOnce();
    await vi.waitFor(() => expect(events).toContain(`start:${b}`));
    await markSuspended(tenantB);
    const pass2 = root.reconcileOnce();
    await sleep(50);
    expect(events).not.toContain(`stop:${b}`);

    startGate.release();
    await pass1;
    await pass2;
    await root.stopTenant(tenantB);
    await root.stop();
    expect(events).toEqual([`start:${b}`, `started:${b}`, `stop:${b}`]);
    expect(vi.getTimerCount()).toBe(0);
    expect(await heartbeatOf(b)).toBeUndefined();
  });
});

describe("mail live-sync root: restartAccount", () => {
  it("stops the hosted lifecycle and hosts a new one from the root's factory, with one heartbeat", async () => {
    const mailboxId = await addMailbox();
    // Only intervals are faked, so each hosted heartbeat shows up as one pending fake timer.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { factory, created, events } = eventFactory({ numbered: true });
    const { root, errors } = createRoot(dataPool, factory);
    await root.reconcileOnce();
    expect(vi.getTimerCount()).toBe(1);

    await root.restartAccount(mailboxId);
    expect(events).toEqual(["start:1", "started:1", "stop:1", "start:2", "started:2"]);
    expect(created.map((record) => record.mailboxItemId)).toEqual([mailboxId, mailboxId]);
    // The old heartbeat was cleared and the new lifecycle got its own.
    expect(vi.getTimerCount()).toBe(1);

    // The replacement is the hosted one: a pass leaves it alone, and stop() stops it and nothing else.
    await root.reconcileOnce();
    await root.stop();
    expect(events.slice(5)).toEqual(["stop:2"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("replaces a lifecycle whose start() had failed, which a second discovery pass leaves in place", async () => {
    const mailboxId = await addMailbox();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { factory, created, events } = eventFactory({
      numbered: true,
      behavior: (n) =>
        n === 1
          ? {
              start: async () => {
                throw new Error("boom: the first start fails");
              },
            }
          : {},
    });
    const { root, phases } = createRoot(dataPool, factory);
    await root.reconcileOnce();
    await root.reconcileOnce();
    expect(created).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    await root.restartAccount(mailboxId);
    expect(events).toEqual(["start:1", "stop:1", "start:2", "started:2"]);
    expect(phases()).toEqual([{ mailboxItemId: mailboxId, phase: "start" }]);
    expect(vi.getTimerCount()).toBe(1);
    await root.stop();
    expect(stopsOf(events)).toEqual(["stop:1", "stop:2"]);
  });

  it("reports the new lifecycle's failed start and keeps it hosted, so a stop still reaches it", async () => {
    const mailboxId = await addMailbox();
    const { factory, events } = eventFactory({
      numbered: true,
      behavior: (n) =>
        n === 2
          ? {
              start: async () => {
                throw new Error("boom: the replacement's start fails");
              },
            }
          : {},
    });
    const { root, phases } = createRoot(dataPool, factory);
    await root.reconcileOnce();

    await expect(root.restartAccount(mailboxId)).resolves.toBeUndefined();
    expect(phases()).toEqual([{ mailboxItemId: mailboxId, phase: "start" }]);
    await root.stop();
    expect(events).toEqual(["start:1", "started:1", "stop:1", "start:2", "stop:2"]);
  });

  it("rejects when the lifecycle factory throws, and the next discovery pass hosts the account again", async () => {
    const mailboxId = await addMailbox();
    const inner = eventFactory({ numbered: true });
    let calls = 0;
    const factory: MailLiveSyncLifecycleFactory = (account) => {
      if (++calls === 2) throw new Error("boom: the factory fails");
      return inner.factory(account);
    };
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();

    await expect(root.restartAccount(mailboxId)).rejects.toThrow("boom: the factory fails");
    expect(inner.events).toEqual(["start:1", "started:1", "stop:1"]);
    await root.reconcileOnce();
    expect(inner.events).toEqual(["start:1", "started:1", "stop:1", "start:2", "started:2"]);
    await root.stop();
  });

  it("leaves an account it does not host alone: an unknown id, a mailbox no pass has discovered yet, and one hosted for another tenant than the caller's", async () => {
    const mailboxId = await addMailbox();
    const foreignMailboxId = await addMailbox(await addTenant());
    const { factory, created, events } = eventFactory({ numbered: true });
    const root = createMailLiveSyncRoot(dataPool, factory);

    await root.restartAccount("11111111-1111-4111-8111-111111111111");
    await root.restartAccount(mailboxId);
    expect(created).toEqual([]);

    await root.reconcileOnce();
    expect(created.map((record) => record.mailboxItemId).sort()).toEqual([mailboxId, foreignMailboxId].sort());
    await runInTenant(tenantZero(), () => root.restartAccount(foreignMailboxId));
    expect(events).toEqual(["start:1", "started:1", "start:2", "started:2"]);
    await root.stop();
  });

  it("called from the mailbox's tenant scope and a request's trace context, runs the new lifecycle in the root's own context", async () => {
    const tenantId = await addTenant();
    const mailboxId = await addMailbox(tenantId);
    const { factory, created } = eventFactory({ numbered: true });
    const { root, errors } = createRoot(dataPool, factory);
    await root.reconcileOnce();
    await vi.waitFor(async () => expect(await heartbeatOf(mailboxId)).toBeDefined());
    const firstHeartbeat = (await heartbeatOf(mailboxId))?.startedAt ?? Infinity;
    // The new heartbeat records its own start time, which must differ from the first one's.
    await sleep(5);

    await withTraceContext({}, () => runInTenant(tenantId, () => root.restartAccount(mailboxId)));

    expect(created).toHaveLength(2);
    expect(created[0]?.stops).toEqual([tenantScope(tenantId)]);
    // The tenant the root hosts the mailbox for, and no trace context of the calling request.
    expect(created[1]?.starts).toEqual([{ scope: tenantScope(tenantId), trace: undefined }]);
    // The heartbeat beats in a system scope; started from inside the tenant it would be refused on every tick.
    await vi.waitFor(async () => expect((await heartbeatOf(mailboxId))?.startedAt).toBeGreaterThan(firstHeartbeat));
    expect(errors).toEqual([]);
    await root.stop();
  });

  it("keeps the lifecycle a discovery pass hosted while the old one was stopping, instead of hosting a second one", async () => {
    const mailboxId = await addMailbox();
    const oldStop = gate();
    const { factory, created, events } = eventFactory({
      numbered: true,
      behavior: (n) => (n === 1 ? { stop: () => oldStop.promise } : {}),
    });
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();

    const restarting = root.restartAccount(mailboxId);
    await vi.waitFor(() => expect(events).toContain("stop:1"));
    // The pass finds the account unhosted and hosts it while the restart still waits for the stop.
    await root.reconcileOnce();
    expect(events).toEqual(["start:1", "started:1", "stop:1", "start:2", "started:2"]);
    oldStop.release();
    await restarting;

    expect(created).toHaveLength(2);
    await root.stop();
    expect(events.slice(5)).toEqual(["stop:2"]);
  });

  it("leaves exactly one lifecycle hosted when it replaces an account while a discovery pass is in flight", async () => {
    const mailboxId = await addMailbox();
    const lateStart = gate();
    const { factory, events, startGates } = eventFactory();
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();

    // The pass has read the active accounts, including `mailboxId`, and holds in the start of a newly added
    // one. Whether it reaches `mailboxId` before or after that start, it must leave the replacement alone.
    const lateMailboxId = await addMailbox();
    startGates.set(lateMailboxId, lateStart.promise);
    const pass = root.reconcileOnce();
    await vi.waitFor(() => expect(events).toContain(`start:${lateMailboxId}`));
    await root.restartAccount(mailboxId);
    lateStart.release();
    await pass;

    const ofMailbox = (): string[] => events.filter((event) => event.endsWith(mailboxId));
    const hosted = [`start:${mailboxId}`, `started:${mailboxId}`];
    expect(ofMailbox()).toEqual([...hosted, `stop:${mailboxId}`, ...hosted]);
    await root.stop();
    expect(ofMailbox()).toEqual([...hosted, `stop:${mailboxId}`, ...hosted, `stop:${mailboxId}`]);
  });

  it("stops a lifecycle the hosting pass is still starting only after that start, and gives it no heartbeat", async () => {
    const mailboxId = await addMailbox();
    const firstStart = gate();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { factory, events } = eventFactory({
      numbered: true,
      behavior: (n) => (n === 1 ? { start: () => firstStart.promise } : {}),
    });
    const root = createMailLiveSyncRoot(dataPool, factory);

    const pass = root.reconcileOnce();
    await vi.waitFor(() => expect(events).toContain("start:1"));
    const restarting = root.restartAccount(mailboxId);
    await sleep(50);
    expect(events).toEqual(["start:1"]);

    firstStart.release();
    await pass;
    await restarting;
    expect(events).toEqual(["start:1", "started:1", "stop:1", "start:2", "started:2"]);
    // Only the replacement's heartbeat: the pass installed none for the lifecycle the restart retired.
    expect(vi.getTimerCount()).toBe(1);
    await root.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hosts nothing when stop() runs while the old lifecycle is still stopping", async () => {
    const mailboxId = await addMailbox();
    const oldStop = gate();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { factory, created, events } = eventFactory({
      numbered: true,
      behavior: (n) => (n === 1 ? { stop: () => oldStop.promise } : {}),
    });
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();

    const restarting = root.restartAccount(mailboxId);
    await vi.waitFor(() => expect(events).toContain("stop:1"));
    const stopping = root.stop();
    oldStop.release();
    await Promise.all([restarting, stopping]);

    expect(created).toHaveLength(1);
    expect(events).toEqual(["start:1", "started:1", "stop:1"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finds nothing hosted while another restart of the account is between its stop and its new lifecycle", async () => {
    const mailboxId = await addMailbox();
    const oldStop = gate();
    const { factory, created, events } = eventFactory({
      numbered: true,
      behavior: (n) => (n === 1 ? { stop: () => oldStop.promise } : {}),
    });
    const root = createMailLiveSyncRoot(dataPool, factory);
    await root.reconcileOnce();

    const first = root.restartAccount(mailboxId);
    await vi.waitFor(() => expect(events).toContain("stop:1"));
    await root.restartAccount(mailboxId);
    expect(created).toHaveLength(1);

    oldStop.release();
    await first;
    // One replacement, created after both calls.
    expect(events).toEqual(["start:1", "started:1", "stop:1", "start:2", "started:2"]);
    await root.stop();
  });
});

describe("mail live-sync root: seeding under a share lock on the live mailbox", () => {
  let removalPool: Pool;

  beforeEach(async () => {
    removalPool = await createRuntimeRolePool(pool, "alldots_data");
  });

  afterEach(async () => {
    await removalPool.end();
  });

  function removal(mailboxItemId: string): Promise<boolean> {
    return runInTenant(tenantZero(), () =>
      removeMailbox(removalPool, mailboxItemId, { queueAffinity: createActionQueueAffinity() }),
    );
  }

  /**
   * Wraps `target` so the first page-transaction statement whose text is `holdAt` stops until `release()`.
   * `held` settles when it stopped, with that transaction's backend pid and the last account whose sync
   * state this pool inserted.
   */
  function holdingPool(
    target: Pool,
    holdAt: "SAVEPOINT discover_account" | "RELEASE SAVEPOINT discover_account",
  ): { pool: Pool; held: Promise<{ pid: number; lastSeeded: string | undefined }>; release: () => void } {
    const released = gate();
    let resolveHeld: (value: { pid: number; lastSeeded: string | undefined }) => void = () => {};
    const held = new Promise<{ pid: number; lastSeeded: string | undefined }>((settle) => {
      resolveHeld = settle;
    });
    let holding = false;
    let lastSeeded: string | undefined;
    const proxy = interceptClientQueries(target, async (client, text, params, forward) => {
      if (isSeedOf(text, params)) lastSeeded = typeof params[0] === "string" ? params[0] : undefined;
      if (text === holdAt && !holding) {
        holding = true;
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = rows[0]?.pid;
        if (pid === undefined) throw new Error("pg_backend_pid returned no row");
        resolveHeld({ pid, lastSeeded });
        await released.promise;
      }
      return forward();
    });
    return { pool: proxy, held, release: released.release };
  }

  it("seeds no row and hosts nothing for a mailbox whose removal committed between the page's read and its seeding", async () => {
    const removed = await addMailbox();
    const sibling = await addMailbox();
    const hold = holdingPool(dataPool, "SAVEPOINT discover_account");
    const { factory, byAccount } = recordingFactory();
    const { root, errors } = createRoot(hold.pool, factory);

    const pass = root.reconcileOnce();
    try {
      // The page transaction has listed both mailboxes as live and has seeded none of them.
      await Promise.race([hold.held, pass]);
      expect(await syncStateOf(removed)).toBeNull();
      // The removal commits on a second pool before discovery seeds anything.
      expect(await removal(removed)).toBe(true);
    } finally {
      hold.release();
      await pass;
    }

    expect(errors).toEqual([]);
    expect(byAccount.get(sibling)?.starts).toBe(1);
    expect((await syncStateOf(sibling))?.syncMode).toBe("imap");
    // Neither this pass nor a later one seeds or hosts the trashed mailbox.
    for (let passes = 0; passes < 2; passes++) {
      expect(await syncStateOf(removed)).toBeNull();
      expect(byAccount.has(removed)).toBe(false);
      await root.reconcileOnce();
    }
    await root.stop();
  });

  it("makes a removal that starts after discovery's share lock wait for the page transaction, and then leaves the mailbox without a row", async () => {
    const first = await addMailbox();
    const second = await addMailbox();
    const hold = holdingPool(dataPool, "RELEASE SAVEPOINT discover_account");
    const { root, errors } = createRoot(hold.pool, recordingFactory().factory);

    const pass = root.reconcileOnce();
    let removing: Promise<boolean> | undefined;
    let seeded: string | undefined;
    try {
      // The page transaction has inserted the row of the account it seeded first, under its share lock.
      const { pid, lastSeeded } = await Promise.race([hold.held, pass.then(() => Promise.reject(new Error("ended")))]);
      seeded = lastSeeded;
      if (seeded === undefined) throw new Error("discovery seeded no account");
      expect([first, second]).toContain(seeded);
      removing = removal(seeded);
      // The removal waits for the discovery transaction (observed through the database, not a timeout).
      await vi.waitFor(
        async () => {
          const { rows } = await pool.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [pid],
          );
          expect(rows).toHaveLength(1);
        },
        { timeout: 10_000, interval: 25 },
      );
    } finally {
      hold.release();
      await Promise.allSettled([pass, removing]);
    }

    await pass;
    expect(await removing).toBe(true);
    if (seeded === undefined) throw new Error("discovery seeded no account");
    // The removal deleted the row discovery inserted, and the mailbox is in the trash.
    expect(await syncStateOf(seeded)).toBeNull();
    const { rows } = await pool.query<{ deleted: boolean }>(
      "SELECT deleted_at IS NOT NULL AS deleted FROM items WHERE id = $1",
      [seeded],
    );
    expect(rows).toEqual([{ deleted: true }]);
    expect(await syncStateOf(seeded === first ? second : first)).not.toBeNull();
    expect(errors).toEqual([]);
    await root.stop();
  });

  it("does not wait for a mailbox whose item another transaction holds FOR UPDATE: the account is left out of that pass and hosted by a later one", async () => {
    const locked = await addMailbox();
    const sibling = await addMailbox();
    const holderHasLock = gate();
    const holderMayEnd = gate();
    const holder = runInTenant(tenantZero(), () =>
      withTransaction(removalPool, async (client) => {
        await client.query("SELECT id FROM items WHERE id = $1 FOR NO KEY UPDATE", [locked]);
        holderHasLock.release();
        await holderMayEnd.promise;
      }),
    );
    const { factory, byAccount } = recordingFactory();
    const { root, errors } = createRoot(dataPool, factory);
    try {
      await Promise.race([holderHasLock.promise, holder]);
      await root.reconcileOnce();
      expect(byAccount.has(locked)).toBe(false);
      expect(await syncStateOf(locked)).toBeNull();
      expect(byAccount.get(sibling)?.starts).toBe(1);
    } finally {
      holderMayEnd.release();
      await holder;
    }

    await root.reconcileOnce();
    expect(byAccount.get(locked)?.starts).toBe(1);
    expect((await syncStateOf(locked))?.syncMode).toBe("imap");
    expect(errors).toEqual([]);
    await root.stop();
  });

  it("gives a live mailbox without a row the provider's default sync mode and hosts it", async () => {
    const gmail = await addMailbox(tenantZero(), { provider: "gmail" });
    const outlook = await addMailbox(tenantZero(), { provider: "outlook" });
    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(dataPool, factory);

    await root.reconcileOnce();
    expect((await syncStateOf(gmail))?.syncMode).toBe("gmail_api");
    expect((await syncStateOf(outlook))?.syncMode).toBe("graph_api");
    expect([byAccount.get(gmail)?.starts, byAccount.get(outlook)?.starts]).toEqual([1, 1]);
    await root.stop();
  });
});
