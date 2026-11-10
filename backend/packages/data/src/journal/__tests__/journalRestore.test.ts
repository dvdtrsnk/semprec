import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { restoreItemWithClient } from "../../chokePoint/itemTrash.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { ConflictError } from "../../errors.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { getOrCreateJournalItem } from "../journalStore.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let journalId: string;

const REFERENCE = new Date("2026-10-16T12:00:00Z");
const ZONE = "Europe/Prague";
const PERIOD = "2026-10-16";
const WAIT_MS = 10_000;

function entry(): Promise<string> {
  return runInTenant(tenant, () =>
    withTransaction(
      pool,
      async (client) => (await getOrCreateJournalItem(client, journalId, "day", REFERENCE, ZONE)).id,
    ),
  );
}

async function trash(itemId: string): Promise<void> {
  const deleted = await runInTenant(tenant, () => cp.softDeleteItem(journalId, itemId));
  expect(deleted?.deletedAt).not.toBeNull();
}

function restore(itemId: string) {
  return runInTenant(tenant, () => cp.restoreItem(journalId, itemId));
}

/** The item the period's reservation points at, or null when there is none. */
async function reservation(): Promise<string | null> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ item_id: string }>("SELECT item_id FROM idempotency_keys WHERE key = $1", [
      `journal:${journalId}:day:${PERIOD}`,
    ]);
    return rows[0]?.item_id ?? null;
  });
}

/** Every reservation row of the tenant, in key order. */
async function reservationRows(): Promise<Array<{ key: string; item_id: string }>> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ key: string; item_id: string }>(
      "SELECT key, item_id FROM idempotency_keys ORDER BY key",
    );
    return rows;
  });
}

/** The ids of the period's entries, live and trashed, in id order. */
async function periodEntries(): Promise<Array<{ id: string; live: boolean }>> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ id: string; live: boolean }>(
      `SELECT id, deleted_at IS NULL AS live FROM items
       WHERE database_id = $1 AND properties->>'type' = 'day' AND properties->>'period' = $2 ORDER BY id`,
      [journalId, PERIOD],
    );
    return rows;
  });
}

async function conflictOf(write: Promise<unknown>): Promise<ConflictError> {
  const error: unknown = await write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ConflictError)) throw new Error(`Expected a ConflictError, got ${String(error)}`);
  return error;
}

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function withinWait<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not happen within ${WAIT_MS} ms`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("No backend pid");
  return pid;
}

/** Polls (bounded) until `waiter`'s statement is blocked by `holder`, read through the admin pool; stops when aborted. */
async function untilBlocked(waiter: number, holder: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (signal.aborted) return;
    const { rows } = await admin.query<{ blocked: boolean }>(
      "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked",
      [waiter, holder],
    );
    if (rows[0]?.blocked === true) return;
    if (Date.now() > deadline) throw new Error(`Backend ${waiter} was not blocked by ${holder}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Rejects as soon as `write` settles: a write that should still be waiting has finished, or it failed. */
function settledEarly(write: Promise<unknown>, label: string): Promise<never> {
  return write.then((): never => {
    throw new Error(`${label} finished before it was expected to`);
  });
}

/**
 * Runs `first` in a transaction that stays open until the second writer is observed waiting on it, then commits it
 * and settles both. The gate is opened on every path, and both transactions are awaited before this returns, so a
 * failing case leaves no open transaction behind; the first failure is the one rethrown.
 */
async function contended<A, B>(
  first: (client: PoolClient) => Promise<A>,
  second: (client: PoolClient) => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const release = gate();
  let firstPid: (pid: number) => void = () => undefined;
  const firstReady = new Promise<number>((resolve) => {
    firstPid = resolve;
  });
  let secondPid: (pid: number) => void = () => undefined;
  const secondStarted = new Promise<number>((resolve) => {
    secondPid = resolve;
  });
  const a = runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const result = await first(client);
      firstPid(await backendPid(client));
      await release.promise;
      return result;
    }),
  );
  let b: Promise<B> = Promise.reject(new Error("The second write was not started"));
  b.catch(() => undefined);
  const stopPolling = new AbortController();
  let polling: Promise<void> = Promise.resolve();
  let primary: unknown;
  try {
    const holder = await withinWait(Promise.race([firstReady, settledEarly(a, "The first write")]), "The first write");
    b = runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        secondPid(await backendPid(client));
        return second(client);
      }),
    );
    const waiter = await withinWait(
      Promise.race([secondStarted, settledEarly(b, "The second write")]),
      "The second write",
    );
    polling = untilBlocked(waiter, holder, stopPolling.signal);
    await Promise.race([polling, settledEarly(b, "The second write")]);
  } catch (error) {
    primary = error;
  } finally {
    stopPolling.abort();
    release.open();
  }
  await Promise.allSettled([polling]);
  const settled = await Promise.allSettled([a, b] as const);
  if (primary instanceof Error) throw primary;
  if (primary !== undefined) throw new Error("The contended writes failed with a non-Error value", { cause: primary });
  return settled;
}

describe("restoring a Journal entry (issue #1666)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    cp = createChokePoint(pool);
    journalId = await runInTenant(tenant, async () => {
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE system AND owner_module_id = 'journal'",
      );
      if (!rows[0]) throw new Error("Journal not seeded");
      return rows[0].id;
    });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("refuses with 409 to restore a trashed entry while a live one holds the period, and keeps it trashed", async () => {
    const old = await entry();
    await trash(old);
    const live = await entry();
    expect(live).not.toBe(old);
    expect(await reservation()).toBe(live);

    const error = await conflictOf(restore(old));
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ liveItemId: live });
    expect(await periodEntries()).toEqual(
      [
        { id: old, live: false },
        { id: live, live: true },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    expect(await reservation()).toBe(live);
  });

  it("restores the older of two trashed entries, points the reservation at it, and the next write returns it", async () => {
    const old = await entry();
    await trash(old);
    const newer = await entry();
    await trash(newer);
    expect(await reservation()).toBe(newer);

    const restored = await restore(old);
    expect(restored?.id).toBe(old);
    expect(restored?.deletedAt).toBeNull();
    expect(await reservation()).toBe(old);

    expect(await entry()).toBe(old);
    expect(await periodEntries()).toEqual(
      [
        { id: old, live: true },
        { id: newer, live: false },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
  });

  it("restores an entry nobody else holds as before", async () => {
    const only = await entry();
    await trash(only);
    const restored = await restore(only);
    expect(restored?.deletedAt).toBeNull();
    expect(await reservation()).toBe(only);
    expect(await entry()).toBe(only);
    expect(await periodEntries()).toEqual([{ id: only, live: true }]);
  });

  it("re-creates a missing reservation for the restored entry", async () => {
    const only = await entry();
    await trash(only);
    // Synthetic state: no production writer removes a reservation without re-creating it in the same transaction.
    await runInTenant(tenant, async () => {
      const removed = await pool.query("DELETE FROM idempotency_keys WHERE key = $1", [
        `journal:${journalId}:day:${PERIOD}`,
      ]);
      expect(removed.rowCount).toBe(1);
    });
    expect(await reservation()).toBeNull();
    await restore(only);
    expect(await reservation()).toBe(only);
  });

  it("leaves the restore of a non-Journal item and every reservation unchanged", async () => {
    await entry();
    const reservationsBefore = await reservationRows();
    const tasks = await runInTenant(tenant, async () => {
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE system AND owner_module_id = 'tasks'",
      );
      if (!rows[0]) throw new Error("Tasks not seeded");
      return rows[0].id;
    });
    const task = await runInTenant(tenant, () => cp.createItem({ databaseId: tasks, properties: { name: "Plain" } }));
    await runInTenant(tenant, () => cp.softDeleteItem(tasks, task.id));
    const restored = await runInTenant(tenant, () => cp.restoreItem(tasks, task.id));
    expect(restored?.deletedAt).toBeNull();
    expect(await reservationRows()).toEqual(reservationsBefore);
  });

  describe("concurrent writers of one period", () => {
    const affinity = createActionQueueAffinity();

    it("lets one of two concurrent restores win; the other waits on the reservation and gets 409", async () => {
      const first = await entry();
      await trash(first);
      const second = await entry();
      await trash(second);

      const [won, lost] = await contended(
        (client) => restoreItemWithClient(client, journalId, first, affinity),
        (client) => restoreItemWithClient(client, journalId, second, affinity),
      );
      expect(won.status).toBe("fulfilled");
      expect(lost.status).toBe("rejected");
      if (lost.status !== "rejected") throw new Error("unreachable");
      if (!(lost.reason instanceof ConflictError))
        throw new Error(`Expected a ConflictError, got ${String(lost.reason)}`);
      expect(lost.reason.status).toBe(409);
      expect(lost.reason.details).toEqual({ liveItemId: first });
      expect(await reservation()).toBe(first);
      expect((await periodEntries()).filter((row) => row.live)).toEqual([{ id: first, live: true }]);
    });

    it("hands a getOrCreate that waited on a restore the restored entry, with no new entry", async () => {
      const old = await entry();
      await trash(old);
      const newer = await entry();
      await trash(newer);

      const [restored, created] = await contended(
        (client) => restoreItemWithClient(client, journalId, old, affinity),
        async (client) => (await getOrCreateJournalItem(client, journalId, "day", REFERENCE, ZONE)).id,
      );
      expect(restored.status).toBe("fulfilled");
      expect(created).toEqual({ status: "fulfilled", value: old });
      expect(await periodEntries()).toHaveLength(2);
      expect(await reservation()).toBe(old);
    });

    it("refuses a restore that waited on a getOrCreate creating a new entry, naming that entry", async () => {
      const old = await entry();
      await trash(old);
      const newer = await entry();
      await trash(newer);

      const [created, restored] = await contended(
        async (client) => (await getOrCreateJournalItem(client, journalId, "day", REFERENCE, ZONE)).id,
        (client) => restoreItemWithClient(client, journalId, old, affinity),
      );
      expect(created.status).toBe("fulfilled");
      if (created.status !== "fulfilled") throw new Error("unreachable");
      expect([old, newer]).not.toContain(created.value);
      expect(restored.status).toBe("rejected");
      if (restored.status !== "rejected") throw new Error("unreachable");
      if (!(restored.reason instanceof ConflictError)) {
        throw new Error(`Expected a ConflictError, got ${String(restored.reason)}`);
      }
      expect(restored.reason.details).toEqual({ liveItemId: created.value });
      expect(await reservation()).toBe(created.value);
      expect((await periodEntries()).filter((row) => row.live)).toEqual([{ id: created.value, live: true }]);
    });
  });
});
