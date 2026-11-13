import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createPool, withTransaction } from "../../db/pool.js";
import { sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { logger } from "../logger.js";
import { claimSempMessage, finishSempMessageTurn } from "../sempMessagesStore.js";
import {
  listRunningSempTurnIds,
  requestSempTurnCancel,
  SEMP_TURN_CANCEL_CHANNEL,
  startSempTurnCancelListener,
  type SempTurnCancelListener,
  type SempTurnCancelRequest,
} from "../sempTurnCancellation.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** What the next `pool.connect()` of the listener pool does before (or instead of) connecting. */
type ConnectStep =
  | { kind: "wait"; gate: Promise<void> }
  | { kind: "reject"; error: Error; gate?: Promise<void> }
  | { kind: "failListen" }
  | { kind: "dropDuringListen" };

/**
 * Wraps the dedicated listener pool's `connect()` so a test can see every backend pid the listener connects with, hold
 * a reconnect at a gate, fail it outright, or fail its `LISTEN`. The pool is created per test and ended afterwards.
 */
function instrumentConnect(pool: Pool): { pids: number[]; steps: ConnectStep[] } {
  const pids: number[] = [];
  const steps: ConnectStep[] = [];
  const original = pool.connect.bind(pool) as () => Promise<PoolClient>;
  const connect = async (): Promise<PoolClient> => {
    const step = steps.shift();
    if (step?.kind === "wait") await step.gate;
    if (step?.kind === "reject") {
      await step.gate;
      throw step.error;
    }
    const client = await original();
    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    pids.push(rows[0]!.pid);
    if (step?.kind === "failListen") {
      // This client is destroyed by the listener's failure path, so the patch never returns to the pool.
      const query = client.query.bind(client) as (text: string) => Promise<unknown>;
      client.query = ((text: string) =>
        text.startsWith("LISTEN") ? Promise.reject(new Error("listen refused")) : query(text)) as PoolClient["query"];
    }
    if (step?.kind === "dropDuringListen") {
      // The connection reports an error and the LISTEN fails with it, as a dropped connection does during setup.
      const query = client.query.bind(client) as (text: string) => Promise<unknown>;
      client.query = ((text: string) => {
        if (!text.startsWith("LISTEN")) return query(text);
        client.emit("error", new Error("dropped during setup"));
        return Promise.reject(new Error("listen refused"));
      }) as PoolClient["query"];
    }
    return client;
  };
  vi.spyOn(pool as unknown as { connect: () => Promise<PoolClient> }, "connect").mockImplementation(connect);
  return { pids, steps };
}

describe("the Semp turn cancel request", () => {
  let admin: Pool;
  let runtime: Pool;
  let listenerPool: Pool;
  let listener: SempTurnCancelListener | null;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    for (const tenantId of [tenantA, tenantB]) {
      await createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    }
  });

  beforeEach(() => {
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
    await runtime?.end();
  });

  async function start(onCancel: (request: SempTurnCancelRequest) => void): Promise<SempTurnCancelListener> {
    listener = await startSempTurnCancelListener(listenerPool, onCancel);
    return listener;
  }

  async function isBackendAlive(pid: number): Promise<boolean> {
    const { rows } = await admin.query<{ alive: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1) AS alive",
      [pid],
    );
    return rows[0]!.alive;
  }

  const request = (tenantId: string): SempTurnCancelRequest => ({ tenantId, assistantMessageId: randomUUID() });

  it("delivers the two ids of a request sent on the runtime role pool", async () => {
    const calls: SempTurnCancelRequest[] = [];
    await start((value) => calls.push(value));
    const sent = request(tenantA);

    await requestSempTurnCancel(runtime, sent);

    await vi.waitFor(() => expect(calls).toEqual([sent]));
  });

  it("delivers a request sent inside a transaction only when it commits", async () => {
    const calls: SempTurnCancelRequest[] = [];
    await start((value) => calls.push(value));
    const rolledBack = request(tenantA);
    const committed = request(tenantB);

    await expect(
      withTransaction(runtime, async (client) => {
        await requestSempTurnCancel(client, rolledBack);
        throw new Error("rolled back after the request");
      }),
    ).rejects.toThrow("rolled back after the request");
    await withTransaction(runtime, (client) => requestSempTurnCancel(client, committed));

    // The committed request arrives on the same channel after the rolled-back one would have.
    await vi.waitFor(() => expect(calls).toEqual([committed]));
  });

  it("rejects a request whose ids are not uuids before anything is sent", async () => {
    const calls: SempTurnCancelRequest[] = [];
    await start((value) => calls.push(value));

    await expect(
      requestSempTurnCancel(runtime, { tenantId: "not-a-uuid", assistantMessageId: randomUUID() }),
    ).rejects.toMatchObject({ code: "22P02" });
    await expect(
      requestSempTurnCancel(runtime, { tenantId: tenantA, assistantMessageId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "22P02" });
    const control = request(tenantA);
    await requestSempTurnCancel(runtime, control);

    await vi.waitFor(() => expect(calls).toEqual([control]));
  });

  it("logs and drops a payload that is not exactly the two uuids and keeps listening", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const calls: SempTurnCancelRequest[] = [];
    await start((value) => calls.push(value));
    const id = randomUUID();

    const invalidPayloads = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ tenantId: tenantA }),
      JSON.stringify({ assistantMessageId: id }),
      JSON.stringify({ tenantId: "not-a-uuid", assistantMessageId: id }),
      JSON.stringify({ tenantId: tenantA, assistantMessageId: 42 }),
      JSON.stringify({ tenantId: tenantA, assistantMessageId: id, extra: true }),
    ];
    for (const payload of invalidPayloads) {
      await admin.query("SELECT pg_notify($1, $2)", [SEMP_TURN_CANCEL_CHANNEL, payload]);
    }
    // An empty payload is no JSON either.
    await admin.query("NOTIFY semp_turn_cancel");
    const control = request(tenantB);
    await requestSempTurnCancel(admin, control);

    await vi.waitFor(() => expect(calls).toEqual([control]));
    const drops = warnSpy.mock.calls.filter(([, msg]) => msg === "semp_turn_cancel_payload_invalid");
    expect(drops).toHaveLength(invalidPayloads.length + 1);
    expect(drops[0]).toEqual([{ channel: SEMP_TURN_CANCEL_CHANNEL }, "semp_turn_cancel_payload_invalid"]);
  });

  it("lower-cases the ids of a request", async () => {
    const calls: SempTurnCancelRequest[] = [];
    await start((value) => calls.push(value));
    const id = randomUUID();

    await admin.query("SELECT pg_notify($1, $2)", [
      SEMP_TURN_CANCEL_CHANNEL,
      JSON.stringify({ tenantId: tenantA.toUpperCase(), assistantMessageId: id.toUpperCase() }),
    ]);

    await vi.waitFor(() => expect(calls).toEqual([{ tenantId: tenantA, assistantMessageId: id }]));
  });

  it("logs a handler that throws by its error name and keeps calling the handler", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    const calls: SempTurnCancelRequest[] = [];
    const first = request(tenantA);
    const second = request(tenantA);
    await start((value) => {
      calls.push(value);
      if (value.assistantMessageId === first.assistantMessageId) throw new TypeError("handler failed");
    });

    await requestSempTurnCancel(runtime, first);
    await requestSempTurnCancel(runtime, second);

    await vi.waitFor(() => expect(calls).toEqual([first, second]));
    expect(errorSpy).toHaveBeenCalledWith({ errorName: "TypeError" }, "Semp turn cancel handler failed");
  });

  it("rejects the start and releases its client when the initial LISTEN fails", async () => {
    const { pids, steps } = instrumentConnect(listenerPool);
    steps.push({ kind: "failListen" });

    await expect(startSempTurnCancelListener(listenerPool, () => {})).rejects.toThrow("listen refused");

    expect(listenerPool.totalCount).toBe(0);
    await vi.waitFor(async () => expect(await isBackendAlive(pids[0]!)).toBe(false));
  });

  it("starts no reconnect for a connection that drops while its LISTEN is being set up", async () => {
    const { pids, steps } = instrumentConnect(listenerPool);
    steps.push({ kind: "dropDuringListen" });

    await expect(startSempTurnCancelListener(listenerPool, () => {})).rejects.toThrow("listen refused");
    // 200 ms is the first reconnect backoff; a reconnect would have connected again by now.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(pids).toHaveLength(1);
    expect(listenerPool.totalCount).toBe(0);
  });

  it("listens again after its connection drops, with a backoff when the first reconnect fails", async () => {
    const { pids, steps } = instrumentConnect(listenerPool);
    const calls: SempTurnCancelRequest[] = [];
    await start((value) => calls.push(value));
    const firstPid = pids[0]!;
    steps.push({ kind: "reject", error: new Error("connect refused") });
    const errorSpy = vi.spyOn(logger, "error");

    await admin.query("SELECT pg_terminate_backend($1)", [firstPid]);
    await vi.waitFor(() => expect(pids).toHaveLength(2), { timeout: 10_000 });
    const sent = request(tenantA);
    await requestSempTurnCancel(admin, sent);

    await vi.waitFor(() => expect(calls).toEqual([sent]));
    expect(errorSpy).toHaveBeenCalledWith({ errorName: "Error" }, "Semp turn cancel LISTEN reconnect failed");
    expect(await isBackendAlive(firstPid)).toBe(false);
  });

  it("releases its client on close() and calls the handler no more", async () => {
    const { pids } = instrumentConnect(listenerPool);
    const calls: SempTurnCancelRequest[] = [];
    const active = await start((value) => calls.push(value));
    const control: SempTurnCancelRequest[] = [];
    const controlListener = await startSempTurnCancelListener(admin, (value) => control.push(value));

    await active.close();
    listener = null;
    try {
      const sent = request(tenantA);
      await requestSempTurnCancel(admin, sent);
      await vi.waitFor(() => expect(control).toEqual([sent]));
    } finally {
      await controlListener.close();
    }

    expect(calls).toEqual([]);
    expect(listenerPool.totalCount).toBe(0);
    await vi.waitFor(async () => expect(await isBackendAlive(pids[0]!)).toBe(false));
  });

  it("does not back off when a reconnect in flight at close() then fails", async () => {
    const { pids, steps } = instrumentConnect(listenerPool);
    await start(() => {});
    const gate = deferred();
    steps.push({ kind: "reject", error: new Error("connect refused"), gate: gate.promise });

    await admin.query("SELECT pg_terminate_backend($1)", [pids[0]!]);
    await vi.waitFor(() => expect(steps).toEqual([]));
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const closing = listener!.close();
    listener = null;
    gate.resolve();
    await closing;

    // 200 ms is the listener's first reconnect backoff.
    expect(setSpy.mock.calls.filter((call) => call[1] === 200)).toEqual([]);
    expect(listenerPool.totalCount).toBe(0);
  });

  it("releases a reconnect's client that resolves after close(), without calling the handler", async () => {
    const { pids, steps } = instrumentConnect(listenerPool);
    const calls: SempTurnCancelRequest[] = [];
    const active = await start((value) => calls.push(value));
    const gate = deferred();
    steps.push({ kind: "wait", gate: gate.promise });

    await admin.query("SELECT pg_terminate_backend($1)", [pids[0]!]);
    await vi.waitFor(() => expect(steps).toEqual([]));
    const closing = active.close();
    listener = null;
    gate.resolve();
    await closing;
    await requestSempTurnCancel(admin, request(tenantA));

    expect(pids).toHaveLength(2);
    expect(calls).toEqual([]);
    expect(listenerPool.totalCount).toBe(0);
    await vi.waitFor(async () => expect(await isBackendAlive(pids[1]!)).toBe(false));
  });

  describe("listRunningSempTurnIds", () => {
    function send(tenantId: string, text: string, threadId?: string) {
      return runInTenant(tenantId, () =>
        withTransaction(runtime, (client) =>
          sendSempMessage(client, { ...(threadId ? { threadId } : {}), text, context: [], hasContext: false }),
        ),
      );
    }

    it("lists the running assistant messages of the thread and no queued, done or failed one", async () => {
      const first = await send(tenantA, "first");
      const second = await send(tenantA, "second", first.threadId);
      const third = await send(tenantA, "third", first.threadId);
      // The fourth reply stays queued.
      await send(tenantA, "fourth", first.threadId);
      await runInTenant(tenantA, () =>
        withTransaction(runtime, async (client) => {
          for (const sent of [first, second, third]) {
            expect(await claimSempMessage(client, first.threadId, sent.assistantMessageId)).toBe(true);
          }
          expect(
            await finishSempMessageTurn(client, second.assistantMessageId, {
              status: "done",
              text: "answer",
              lastEventId: "1",
            }),
          ).toBe(true);
          expect(await finishSempMessageTurn(client, third.assistantMessageId, { status: "error" })).toBe(true);
        }),
      );

      const running = await runInTenant(tenantA, () => listRunningSempTurnIds(runtime, first.threadId));

      expect(running).toEqual([first.assistantMessageId]);
    });

    it("lists nothing of another tenant's thread and nothing of a thread without a running turn", async () => {
      const own = await send(tenantA, "own turn");
      const foreign = await send(tenantB, "foreign turn");
      await runInTenant(tenantB, () =>
        withTransaction(runtime, async (client) => {
          expect(await claimSempMessage(client, foreign.threadId, foreign.assistantMessageId)).toBe(true);
        }),
      );

      expect(await runInTenant(tenantB, () => listRunningSempTurnIds(runtime, foreign.threadId))).toEqual([
        foreign.assistantMessageId,
      ]);
      expect(await runInTenant(tenantA, () => listRunningSempTurnIds(runtime, foreign.threadId))).toEqual([]);
      expect(await runInTenant(tenantA, () => listRunningSempTurnIds(runtime, own.threadId))).toEqual([]);
    });
  });
});
