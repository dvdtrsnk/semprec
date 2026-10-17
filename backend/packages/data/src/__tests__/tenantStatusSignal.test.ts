import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem } from "@semprec/shared";
import { createPool, withTransaction } from "../db/pool.js";
import { createRuntimeRolePool, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createTestTenant } from "../testSupport/tenantFixtures.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { reactivateAccount, suspendAccount } from "../tenancy/accountsAdminStore.js";
import {
  startTenantDeactivationListener,
  TENANT_STATUS_CHANNEL,
  type TenantDeactivationListener,
} from "../tenancy/tenantStatusSignal.js";
import { logger } from "../tenancy/logger.js";

interface Account {
  userId: string;
  tenantId: string;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** What the next `pool.connect()` of the listener pool does before (or instead of) connecting. */
type ConnectStep = { kind: "wait"; gate: Promise<void> } | { kind: "reject"; error: Error } | { kind: "failListen" };

/**
 * Wraps the dedicated listener pool's `connect()` so a test can see every backend pid the listener
 * connects with, hold a reconnect at a gate, fail it outright, or fail its `LISTEN`. The pool is
 * created per test and ended afterwards, so the patched method never outlives the test.
 */
function instrumentConnect(pool: Pool): { pids: number[]; clients: PoolClient[]; steps: ConnectStep[] } {
  const pids: number[] = [];
  const clients: PoolClient[] = [];
  const steps: ConnectStep[] = [];
  const original = pool.connect.bind(pool) as () => Promise<PoolClient>;
  const connect = async (): Promise<PoolClient> => {
    const step = steps.shift();
    if (step?.kind === "wait") await step.gate;
    if (step?.kind === "reject") throw step.error;
    const client = await original();
    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    pids.push(rows[0]!.pid);
    clients.push(client);
    if (step?.kind === "failListen") {
      // This client is destroyed by the listener's failure path, so the patch never returns to the pool.
      const query = client.query.bind(client) as (text: string) => Promise<unknown>;
      client.query = ((text: string) =>
        text.startsWith("LISTEN") ? Promise.reject(new Error("listen refused")) : query(text)) as PoolClient["query"];
    }
    return client;
  };
  // Viewed through its promise overload only: the listener never uses the callback form.
  vi.spyOn(pool as unknown as { connect: () => Promise<PoolClient> }, "connect").mockImplementation(connect);
  return { pids, clients, steps };
}

describe("tenant deactivation signal (issue #1042)", () => {
  let adminPool: Pool;
  let dataPool: Pool;
  let listenerPool: Pool;
  let listener: TenantDeactivationListener | null;
  let actor: Account;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    await adminPool.query("DELETE FROM admin_audit_log");
    actor = await makeAccount("admin");
    listener = null;
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set");
    listenerPool = createPool(url);
  });

  afterEach(async () => {
    await listener?.close();
    vi.restoreAllMocks();
    await listenerPool.end();
  });

  afterAll(async () => {
    await dataPool.end();
  });

  async function makeAccount(role: "admin" | "member"): Promise<Account> {
    const tenantId = await createTestTenant(adminPool);
    const user = await createUser(adminPool, {
      email: `${role}-${tenantId}@example.test`,
      passwordHash: await hashPassword("s3cret-password"),
      tenantId,
      role,
    });
    return { userId: user.id, tenantId };
  }

  async function suspend(target: Account): Promise<void> {
    await runAsSystem("tenantStatusSignalTest", () =>
      withTransaction(dataPool, (client) =>
        suspendAccount(client, { actorUserId: actor.userId, targetUserId: target.userId }),
      ),
    );
  }

  async function start(onDeactivated: (tenantId: string) => Promise<void>): Promise<TenantDeactivationListener> {
    listener = await startTenantDeactivationListener(listenerPool, onDeactivated);
    return listener;
  }

  async function isBackendAlive(pid: number): Promise<boolean> {
    const { rows } = await adminPool.query<{ alive: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1) AS alive",
      [pid],
    );
    return rows[0]!.alive;
  }

  it("calls the handler once with the tenant when the suspension commits", async () => {
    const b = await makeAccount("member");
    const calls: string[] = [];
    await start(async (tenantId) => {
      calls.push(tenantId);
    });

    await suspend(b);

    await vi.waitFor(() => expect(calls).toEqual([b.tenantId]));
  });

  it("delivers nothing for a suspension whose transaction rolls back", async () => {
    const b = await makeAccount("member");
    const c = await makeAccount("member");
    const calls: string[] = [];
    await start(async (tenantId) => {
      calls.push(tenantId);
    });

    await expect(
      runAsSystem("tenantStatusSignalTest", () =>
        withTransaction(dataPool, async (client) => {
          await suspendAccount(client, { actorUserId: actor.userId, targetUserId: b.userId });
          throw new Error("rolled back after the suspension");
        }),
      ),
    ).rejects.toThrow("rolled back after the suspension");
    // A later committed suspension arrives on the same channel; B's would have been delivered before it.
    await suspend(c);

    await vi.waitFor(() => expect(calls).toEqual([c.tenantId]));
  });

  it("publishes nothing on reactivation", async () => {
    const b = await makeAccount("member");
    const c = await makeAccount("member");
    await suspend(b);
    const calls: string[] = [];
    // The resync reports B, which is still suspended at start.
    await start(async (tenantId) => {
      calls.push(tenantId);
    });
    await vi.waitFor(() => expect(calls).toEqual([b.tenantId]));

    await runAsSystem("tenantStatusSignalTest", () =>
      withTransaction(dataPool, (client) =>
        reactivateAccount(client, { actorUserId: actor.userId, targetUserId: b.userId }),
      ),
    );
    await suspend(c);

    await vi.waitFor(() => expect(calls).toEqual([b.tenantId, c.tenantId]));
  });

  it("calls the handler through the resync for a tenant suspended while the connection was down", async () => {
    const b = await makeAccount("member");
    const { pids, steps } = instrumentConnect(listenerPool);
    const calls: string[] = [];
    await start(async (tenantId) => {
      calls.push(tenantId);
    });
    const firstPid = pids[0]!;
    const gate = deferred();
    // The first reconnect attempt fails outright (exercising the backoff); the second waits at the gate.
    steps.push({ kind: "reject", error: new Error("connect refused") }, { kind: "wait", gate: gate.promise });
    const errorSpy = vi.spyOn(logger, "error");

    await adminPool.query("SELECT pg_terminate_backend($1)", [firstPid]);
    await vi.waitFor(() => expect(steps).toEqual([]));
    // Committed while nothing listens: the NOTIFY it sends is lost, so only the resync can report B.
    await suspend(b);
    expect(calls).toEqual([]);
    gate.resolve();

    await vi.waitFor(() => expect(calls).toEqual([b.tenantId]));
    expect(errorSpy).toHaveBeenCalledWith({ errorName: "Error" }, "Tenant deactivation LISTEN reconnect failed");
    expect(await isBackendAlive(firstPid)).toBe(false);
  });

  it("logs and drops a payload that is not { tenantId: <uuid> } and keeps listening", async () => {
    const b = await makeAccount("member");
    const warnSpy = vi.spyOn(logger, "warn");
    const calls: string[] = [];
    await start(async (tenantId) => {
      calls.push(tenantId);
    });

    const invalidPayloads = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ tenantId: "not-a-uuid" }),
      JSON.stringify({ tenantId: 42 }),
      JSON.stringify({ tenantId: b.tenantId, extra: true }),
    ];
    for (const payload of invalidPayloads) {
      await adminPool.query("SELECT pg_notify($1, $2)", [TENANT_STATUS_CHANNEL, payload]);
    }
    await suspend(b);

    await vi.waitFor(() => expect(calls).toEqual([b.tenantId]));
    const drops = warnSpy.mock.calls.filter(([, msg]) => msg === "tenant_status_payload_invalid");
    expect(drops).toHaveLength(invalidPayloads.length);
    expect(drops[0]).toEqual([{ channel: TENANT_STATUS_CHANNEL }, "tenant_status_payload_invalid"]);
  });

  it("logs a handler rejection and keeps calling the handler", async () => {
    const b = await makeAccount("member");
    const c = await makeAccount("member");
    const errorSpy = vi.spyOn(logger, "error");
    const calls: string[] = [];
    await start(async (tenantId) => {
      calls.push(tenantId);
      if (tenantId === b.tenantId) throw new TypeError("handler failed");
    });

    await suspend(b);
    await suspend(c);

    await vi.waitFor(() => expect(calls).toEqual([b.tenantId, c.tenantId]));
    expect(errorSpy).toHaveBeenCalledWith(
      { errorName: "TypeError", tenantId: b.tenantId },
      "Tenant deactivation handler failed",
    );
  });

  it("rejects the start and releases its client when the initial LISTEN fails", async () => {
    const { pids, steps } = instrumentConnect(listenerPool);
    steps.push({ kind: "failListen" });

    await expect(startTenantDeactivationListener(listenerPool, async () => {})).rejects.toThrow("listen refused");

    expect(listenerPool.totalCount).toBe(0);
    await vi.waitFor(async () => expect(await isBackendAlive(pids[0]!)).toBe(false));
  });

  it("releases its client on close() and calls the handler no more", async () => {
    const b = await makeAccount("member");
    const { pids } = instrumentConnect(listenerPool);
    const calls: string[] = [];
    const active = await start(async (tenantId) => {
      calls.push(tenantId);
    });
    const control: string[] = [];
    const controlListener = await startTenantDeactivationListener(adminPool, async (tenantId) => {
      control.push(tenantId);
    });

    await active.close();
    listener = null;
    try {
      await suspend(b);
      await vi.waitFor(() => expect(control).toEqual([b.tenantId]));
    } finally {
      await controlListener.close();
    }

    expect(calls).toEqual([]);
    expect(listenerPool.totalCount).toBe(0);
    await vi.waitFor(async () => expect(await isBackendAlive(pids[0]!)).toBe(false));
  });

  it("releases a reconnect's client that resolves after close(), without calling the handler", async () => {
    const b = await makeAccount("member");
    const { pids, clients, steps } = instrumentConnect(listenerPool);
    const calls: string[] = [];
    const active = await start(async (tenantId) => {
      calls.push(tenantId);
    });
    const gate = deferred();
    steps.push({ kind: "wait", gate: gate.promise });

    await adminPool.query("SELECT pg_terminate_backend($1)", [pids[0]!]);
    await vi.waitFor(() => expect(steps).toEqual([]));
    // B is suspended before the held reconnect completes, so its resync would report B if it attached.
    await suspend(b);
    const closing = active.close();
    listener = null;
    gate.resolve();
    await closing;

    expect(clients).toHaveLength(2);
    expect(calls).toEqual([]);
    expect(listenerPool.totalCount).toBe(0);
    await vi.waitFor(async () => expect(await isBackendAlive(pids[1]!)).toBe(false));
  });
});
