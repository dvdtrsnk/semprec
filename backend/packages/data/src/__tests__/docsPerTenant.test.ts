import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import { deleteDocByItemId, getDocByItemId, getOrCreateDoc } from "../docs/docsStore.js";
import { ConflictError, NotFoundError } from "../errors.js";

let pool: Pool;

/** Runs `fn` in a transaction on the owner role that is always rolled back. */
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
  await client.query("SET LOCAL ROLE semprec_data");
}

async function countDocs(client: PoolClient, itemId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM docs WHERE item_id = $1", [
    itemId,
  ]);
  return rows[0]?.n ?? 0;
}

/** Drops the legacy index, adds a second tenant with one database each, and runs as `semprec_data`. */
async function twoTenants(client: PoolClient) {
  await client.query("DROP INDEX docs_item_id_idx");
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
  /** Starts the loser on its own client; its settlement is observed immediately, never left unhandled. */
  startLoser: <T>(start: (client: C) => Promise<T>) => Promise<T>;
  commitWinner: () => Promise<void>;
}

/**
 * Owns both clients of the concurrent-first-write race. `scenario` runs inside the winner's open
 * transaction. On any failure the winner is rolled back unless it already committed - that releases
 * the lock the loser waits on - then the loser's settlement is awaited, and only then are the winner
 * and the loser released, in that order. The scenario's own error is the one rethrown.
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
        // Both outcomes are observed here, so a loser rejection is never unhandled and
        // cleanup can wait for it without the scenario having awaited it.
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

  it("converges concurrent first writes on one doc while both unique indexes exist", async () => {
    await resetDatabase(pool);
    const db = await createChokePoint(pool).createDatabase({ name: "Pages" });
    const item = await insertItem(pool, { databaseId: db.id, properties: {} });

    const { rows: indexes } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'docs' AND indexname IN ('docs_item_id_idx', 'docs_tenant_item_id_uq')",
    );
    expect(indexes.map((r) => r.indexname).sort()).toEqual(["docs_item_id_idx", "docs_tenant_item_id_uq"]);

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

  describe("first-write race cleanup after a failure before the winner commits", () => {
    type LoserOutcome = "resolves" | "rejects";

    /**
     * Fake clients that log every step. The loser stays pending until the winner's ROLLBACK, as a
     * real writer blocked on the winner's row lock would; a cleanup that awaited the loser before
     * rolling back would never see it settle.
     */
    function fakeRace(outcome: LoserOutcome, rollbackFails: boolean) {
      const events: string[] = [];
      let settleLoser: () => void = () => undefined;
      const loserResult = new Promise<string>((resolve, reject) => {
        // Settles on a later macrotask, as a writer that wakes after the lock is gone would, so a
        // cleanup that released the clients without awaiting the loser logs the releases first.
        // No handler is attached here: only runFirstWriteRace's observer keeps a rejection handled.
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

    async function failBeforeCommit(outcome: LoserOutcome, rollbackFails: boolean) {
      const { events, winner, loser, loserResult } = fakeRace(outcome, rollbackFails);
      const forced = new Error("forced pre-commit failure");
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const run = runFirstWriteRace(winner, loser, async ({ startLoser }) => {
          // startLoser attaches the settlement observer itself; the scenario deliberately never awaits it.
          void startLoser(() => loserResult);
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
        const events = await failBeforeCommit(outcome, false);
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
          const events = await failBeforeCommit(outcome, true);
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
    }
  });

  it("works without the legacy index: repeat write is idempotent, a different kind conflicts", async () => {
    await resetDatabase(pool);
    const db = await createChokePoint(pool).createDatabase({ name: "Pages" });
    const item = await insertItem(pool, { databaseId: db.id, properties: {} });
    await inRolledBackTransaction(async (client) => {
      await client.query("DROP INDEX docs_item_id_idx");
      const first = await getOrCreateDoc(client, item.id, "page");
      const again = await getOrCreateDoc(client, item.id, "page");
      expect(again.id).toBe(first.id);
      expect(await countDocs(client, item.id)).toBe(1);
      await expect(getOrCreateDoc(client, item.id, "canvas")).rejects.toBeInstanceOf(ConflictError);
      expect(await countDocs(client, item.id)).toBe(1);
    });
  });

  it("gives the same item id in two tenants a doc each", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      const { tenantA, tenantB, dbA, dbB } = await twoTenants(client);
      const itemId = "11111111-1111-4111-8111-111111111111";
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await insertItemWithId(client, dbA.id, itemId);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
      await insertItemWithId(client, dbB.id, itemId);

      await scopeTo(client, tenantA);
      const docA = await getOrCreateDoc(client, itemId, "page");
      await scopeTo(client, tenantB);
      const docB = await getOrCreateDoc(client, itemId, "canvas");
      expect(docB.id).not.toBe(docA.id);

      expect(await getDocByItemId(client, itemId)).toEqual(docB);
      await scopeTo(client, tenantA);
      expect(await getDocByItemId(client, itemId)).toEqual(docA);
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
      await deleteDocByItemId(client, itemA.id);

      await client.query("RESET ROLE");
      expect(await countDocs(client, itemA.id)).toBe(1);
      await scopeTo(client, tenantA);
      expect(await getDocByItemId(client, itemA.id)).toEqual(docA);
    });
  });
});
