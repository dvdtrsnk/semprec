import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import { getDocByItemId, getOrCreateDoc } from "../docs/docsStore.js";
import { ConflictError, NotFoundError } from "../errors.js";

let pool: Pool;

async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  let primary: unknown;
  let failed = false;
  try {
    await client.query("BEGIN");
    await fn(client);
  } catch (err) {
    failed = true;
    primary = err;
  }
  let rollbackError: unknown;
  let rollbackFailed = false;
  try {
    await client.query("ROLLBACK");
  } catch (err) {
    rollbackFailed = true;
    rollbackError = err;
  } finally {
    client.release();
  }
  // The test's own failure is the real one; a rollback failure only surfaces when nothing else failed.
  if (failed) throw primary;
  if (rollbackFailed) throw rollbackError;
}

async function scopeTo(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("RESET ROLE");
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  await client.query("SET LOCAL ROLE alldots_data");
}

async function countDocs(client: PoolClient, itemId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM docs WHERE item_id = $1", [
    itemId,
  ]);
  return rows[0]?.n ?? 0;
}

async function twoTenants(client: PoolClient) {
  await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
  const { rows } = await client.query<{ id: string }>("SELECT id FROM tenants");
  const tenantA = rows[0]?.id;
  if (!tenantA) throw new Error("no first tenant");
  const { rows: inserted } = await client.query<{ id: string }>(
    "INSERT INTO tenants (status) VALUES ('active') RETURNING id",
  );
  const tenantB = inserted[0]?.id;
  if (!tenantB) throw new Error("second tenant was not inserted");
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
  const dbA = await createDatabase(client, { name: "A" });
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
  const dbB = await createDatabase(client, { name: "B" });
  return { tenantA, tenantB, dbA, dbB };
}

async function insertItemWithId(client: PoolClient, databaseId: string, id: string): Promise<void> {
  await client.query(`INSERT INTO items (id, database_id, properties) VALUES ($1, $2, '{}')`, [id, databaseId]);
}

/** The part of a pooled client the race cleanup drives; a fake implements it in the failure regression. */
interface RaceClient {
  query(sql: string): Promise<unknown>;
  release(): void;
}

interface FirstWriteRace<C> {
  startLoser: <T>(start: (client: C) => Promise<T>) => Promise<T>;
  commitWinner: () => Promise<void>;
}

/**
 * Owns both clients of the concurrent-first-write race; `scenario` runs inside the winner's open
 * transaction. On failure the winner is rolled back unless committed (releasing the loser's lock), the
 * loser's settlement is awaited, then both are released. The scenario's own error is rethrown.
 */
async function runFirstWriteRace<C extends RaceClient>(
  winner: C,
  loser: C,
  scenario: (race: FirstWriteRace<C>) => Promise<void>,
): Promise<void> {
  let loserSettled: Promise<void> = Promise.resolve();
  let committed = false;
  try {
    await winner.query("BEGIN");
    await scenario({
      startLoser: (start) => {
        const pending = start(loser);
        // Both outcomes are observed here, so a loser rejection is never unhandled.
        loserSettled = pending.then(
          () => undefined,
          () => undefined,
        );
        return pending;
      },
      commitWinner: async () => {
        await winner.query("COMMIT");
        committed = true;
      },
    });
  } catch (err) {
    if (!committed) {
      try {
        await winner.query("ROLLBACK");
      } catch (rollbackErr) {
        // The scenario failure stays the reported one; the rollback failure is logged, not dropped.
        console.warn("first-write race: winner ROLLBACK failed during cleanup", {
          name: rollbackErr instanceof Error ? rollbackErr.name : typeof rollbackErr,
        });
      }
    }
    await loserSettled;
    throw err;
  } finally {
    try {
      winner.release();
    } finally {
      loser.release();
    }
  }
}

describe("docs are per tenant", () => {
  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("converges concurrent first writes on one doc on the tenant-leading index alone", async () => {
    await resetDatabase(pool);
    const db = await createChokePoint(pool).createDatabase({ name: "Pages" });
    const item = await insertItem(pool, { databaseId: db.id, properties: {} });

    const { rows: indexes } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'docs' AND indexname IN ('docs_item_id_idx', 'docs_tenant_item_id_uq')",
    );
    expect(indexes.map((r) => r.indexname)).toEqual(["docs_tenant_item_id_uq"]);

    const first = await pool.connect();
    const second = await pool.connect();
    await runFirstWriteRace(first, second, async ({ startLoser, commitWinner }) => {
      const created = await getOrCreateDoc(first, item.id, "page");
      const { rows: pidRows } = await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const firstPid = pidRows[0]!.pid;

      const racing = startLoser((client) => getOrCreateDoc(client, item.id, "page"));
      await vi.waitFor(
        async () => {
          const { rows } = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [firstPid],
          );
          expect(Number(rows[0]!.count)).toBe(1);
        },
        { timeout: 10_000, interval: 20 },
      );
      await commitWinner();

      const resolved = await racing;
      expect(resolved.id).toBe(created.id);
    });

    const counts = await pool.query<{ docs: number; snapshots: number; history: number }>(
      `SELECT (SELECT count(*)::int FROM docs WHERE item_id = $1) AS docs,
              (SELECT count(*)::int FROM doc_snapshots s JOIN docs d ON d.id = s.doc_id WHERE d.item_id = $1) AS snapshots,
              (SELECT count(*)::int FROM doc_snapshot_history h JOIN docs d ON d.id = h.doc_id WHERE d.item_id = $1) AS history`,
      [item.id],
    );
    expect(counts.rows[0]).toEqual({ docs: 1, snapshots: 1, history: 1 });
  });

  describe("first-write race cleanup after a scenario failure", () => {
    type LoserOutcome = "resolves" | "rejects";

    /**
     * Fake clients that log every step. The loser stays pending until the winner's ROLLBACK or COMMIT, as a
     * writer blocked on the winner's row lock would.
     */
    function fakeRace(outcome: LoserOutcome, rollbackFails: boolean) {
      const events: string[] = [];
      let settleLoser: () => void = () => undefined;
      const loserResult = new Promise<string>((resolve, reject) => {
        // Settles on a later macrotask, so a cleanup that released the clients without awaiting the loser logs
        // the releases first. Only runFirstWriteRace's observer keeps a rejection handled.
        settleLoser = () => {
          setTimeout(() => {
            events.push(`loser ${outcome}`);
            if (outcome === "resolves") resolve("loser doc");
            else reject(new Error("loser failed"));
          }, 5);
        };
      });
      const winner: RaceClient = {
        query: async (sql) => {
          events.push(`winner ${sql}`);
          if (sql === "COMMIT") settleLoser();
          if (sql === "ROLLBACK") {
            settleLoser();
            if (rollbackFails) throw new Error("rollback failed");
          }
          return undefined;
        },
        release: () => events.push("winner released"),
      };
      const loser: RaceClient = {
        query: async () => undefined,
        release: () => events.push("loser released"),
      };
      return { events, winner, loser, loserResult };
    }

    async function failScenario(outcome: LoserOutcome, rollbackFails: boolean, afterCommit = false) {
      const { events, winner, loser, loserResult } = fakeRace(outcome, rollbackFails);
      const forced = new Error(afterCommit ? "forced post-commit failure" : "forced pre-commit failure");
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const run = runFirstWriteRace(winner, loser, async ({ startLoser, commitWinner }) => {
          // startLoser attaches the settlement observer itself; the scenario deliberately never awaits it.
          void startLoser(() => loserResult);
          if (afterCommit) await commitWinner();
          throw forced;
        });
        await expect(run).rejects.toBe(forced);
        // Let a rejection without a handler reach the process-level hook before checking it.
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      expect(unhandled).toEqual([]);
      return events;
    }

    for (const outcome of ["resolves", "rejects"] as const) {
      it(`rolls the winner back, then waits for a loser that ${outcome}, then releases both clients`, async () => {
        const events = await failScenario(outcome, false);
        expect(events).toEqual([
          "winner BEGIN",
          "winner ROLLBACK",
          `loser ${outcome}`,
          "winner released",
          "loser released",
        ]);
      });

      it(`keeps the forced failure when the winner ROLLBACK also fails and the loser ${outcome}`, async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
          const events = await failScenario(outcome, true);
          expect(events).toEqual([
            "winner BEGIN",
            "winner ROLLBACK",
            `loser ${outcome}`,
            "winner released",
            "loser released",
          ]);
          expect(warn).toHaveBeenCalledTimes(1);
        } finally {
          warn.mockRestore();
        }
      });

      it(`skips the ROLLBACK after the winner committed, then waits for a loser that ${outcome}`, async () => {
        const events = await failScenario(outcome, false, true);
        expect(events).toEqual([
          "winner BEGIN",
          "winner COMMIT",
          `loser ${outcome}`,
          "winner released",
          "loser released",
        ]);
      });
    }
  });

  it("repeat write is idempotent, a different kind conflicts", async () => {
    await resetDatabase(pool);
    const db = await createChokePoint(pool).createDatabase({ name: "Pages" });
    const item = await insertItem(pool, { databaseId: db.id, properties: {} });
    await inRolledBackTransaction(async (client) => {
      const first = await getOrCreateDoc(client, item.id, "page");
      const again = await getOrCreateDoc(client, item.id, "page");
      expect(again.id).toBe(first.id);
      expect(await countDocs(client, item.id)).toBe(1);
      await expect(getOrCreateDoc(client, item.id, "canvas")).rejects.toBeInstanceOf(ConflictError);
      expect(await countDocs(client, item.id)).toBe(1);
    });
  });

  it("gives an item in each of two tenants a doc each, read only in its own tenant", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      // Item ids are unique across tenants, so each tenant's doc belongs to an item of its own.
      const { tenantA, tenantB, dbA, dbB } = await twoTenants(client);
      const itemIdA = "11111111-1111-4111-8111-111111111111";
      const itemIdB = "22222222-2222-4222-8222-222222222222";
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await insertItemWithId(client, dbA.id, itemIdA);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
      await insertItemWithId(client, dbB.id, itemIdB);

      await scopeTo(client, tenantA);
      const docA = await getOrCreateDoc(client, itemIdA, "page");
      await scopeTo(client, tenantB);
      const docB = await getOrCreateDoc(client, itemIdB, "canvas");
      expect(docB.id).not.toBe(docA.id);

      expect(await getDocByItemId(client, itemIdB)).toEqual(docB);
      expect(await getDocByItemId(client, itemIdA)).toBeNull();
      await scopeTo(client, tenantA);
      expect(await getDocByItemId(client, itemIdA)).toEqual(docA);
      expect(await getDocByItemId(client, itemIdB)).toBeNull();
    });
  });

  it("treats another tenant's item as missing", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      const { tenantA, tenantB, dbA } = await twoTenants(client);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      const itemA = await insertItem(client, { databaseId: dbA.id, properties: {} });

      await scopeTo(client, tenantA);
      const docA = await getOrCreateDoc(client, itemA.id, "page");

      await scopeTo(client, tenantB);
      await expect(getOrCreateDoc(client, itemA.id, "page")).rejects.toBeInstanceOf(NotFoundError);
      expect(await getDocByItemId(client, itemA.id)).toBeNull();
      await client.query("DELETE FROM docs WHERE item_id = $1", [itemA.id]);

      await client.query("RESET ROLE");
      expect(await countDocs(client, itemA.id)).toBe(1);
      await scopeTo(client, tenantA);
      expect(await getDocByItemId(client, itemA.id)).toEqual(docA);
    });
  });
});
