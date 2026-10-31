import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestModuleItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createDatabase } from "../../chokePoint/databasesStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { runMailDatabaseKeysCutoverMigration } from "../mailDatabaseKeysCutoverMigration.js";

const keys = ["emails", "folders", "mailboxes"];
let admin: Pool;
let pool: Pool;
let tenant: string;

async function rows() {
  return (
    await pool.query<{ id: string; key: string | null; name: string | null; owner_module_id: string; xmin: string }>(
      "SELECT id, key, name, owner_module_id, xmin::text AS xmin FROM databases WHERE system AND owner_module_id = ANY($1::text[]) ORDER BY owner_module_id",
      [keys],
    )
  ).rows;
}
async function makeLegacy() {
  // A populated tenant created before mail seeds began setting canonical keys.
  await pool.query("UPDATE databases SET key = NULL WHERE system AND owner_module_id = ANY($1::text[])", [keys]);
}

describe("mail database key cutover", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("seeds all three keys and repairs legacy rows once without changing their identities", async () => {
    await runInTenant(tenant, async () => {
      const seeded = await rows();
      expect(seeded.map((row) => row.key)).toEqual(keys);
      const itemId = await createTestModuleItem(pool, "emails");
      const email = seeded.find((row) => row.owner_module_id === "emails");
      if (!email) throw new Error("Missing Emails database");
      const chokePoint = createChokePoint(pool);
      const source = await chokePoint.createDatabase({ name: "Relation fixture" });
      const property = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "email",
        name: "Email",
        targetDatabaseId: email.id,
      });
      const sourceItem = await chokePoint.createItem({ databaseId: source.id, properties: {} });
      const edge = await chokePoint.createRelation({
        relationPropertyId: property.property.id,
        callerItemId: sourceItem.id,
        targetItemId: itemId,
      });
      const content = () =>
        pool.query<{ id: string; database_id: string; properties: unknown }>(
          "SELECT id, database_id, properties FROM items WHERE database_id = $1 AND id = $2",
          [email.id, itemId],
        );
      const relations = () =>
        pool.query<{ id: string }>(
          "SELECT r.id FROM relation_definitions r JOIN properties p ON p.id = r.property_id_a WHERE p.database_id = $1 ORDER BY r.id",
          [email.id],
        );
      const beforeContent = (await content()).rows;
      const beforeRelations = (await relations()).rows;
      const edgeRows = () =>
        pool.query<{ id: string; item_a: string; item_b: string }>(
          "SELECT id, item_a, item_b FROM item_relations WHERE id = $1",
          [edge.id],
        );
      const beforeEdge = (await edgeRows()).rows;
      expect(beforeContent).toHaveLength(1);
      expect(beforeRelations.length).toBeGreaterThan(0);
      expect(beforeEdge).toHaveLength(1);
      await makeLegacy();
      const legacy = await rows();
      await runMailDatabaseKeysCutoverMigration(pool);
      const repaired = await rows();
      expect(repaired.map((row) => row.key)).toEqual(keys);
      expect(repaired.map(({ id, name, owner_module_id }) => ({ id, name, owner_module_id }))).toEqual(
        legacy.map(({ id, name, owner_module_id }) => ({ id, name, owner_module_id })),
      );
      expect((await content()).rows).toEqual(beforeContent);
      expect((await relations()).rows).toEqual(beforeRelations);
      expect((await edgeRows()).rows).toEqual(beforeEdge);
      await runMailDatabaseKeysCutoverMigration(pool);
      expect(await rows()).toEqual(repaired);
    });
  });

  it("repairs only the scoped tenant and skips an unseeded tenant", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(pool));
    await runInTenant(tenant, makeLegacy);
    await runInTenant(other, makeLegacy);
    await runInTenant(tenant, () => runMailDatabaseKeysCutoverMigration(pool));
    expect(await runInTenant(tenant, rows).then((result) => result.map((row) => row.key))).toEqual(keys);
    expect(await runInTenant(other, rows).then((result) => result.map((row) => row.key))).toEqual([null, null, null]);
    const empty = await createTestTenant(admin);
    await runInTenant(empty, () => runMailDatabaseKeysCutoverMigration(pool));
    expect(await runInTenant(empty, rows)).toEqual([]);
  });

  it("repairs a present legacy mail database when the other two do not exist", async () => {
    const partial = await createTestTenant(admin);
    await runInTenant(partial, async () => {
      await withTransaction(pool, (client) =>
        createDatabase(client, { name: "Emails", system: true, ownerModuleId: "emails" }),
      );
      await runMailDatabaseKeysCutoverMigration(pool);
      expect((await rows()).map((row) => row.key)).toEqual(["emails"]);
    });
  });

  it.each(["unexpected", "collision"] as const)("rolls back all repairs on %s", async (kind) => {
    await runInTenant(tenant, async () => {
      await makeLegacy();
      if (kind === "unexpected") {
        await pool.query("UPDATE databases SET key = 'legacyEmails' WHERE owner_module_id = 'emails' AND system");
      } else {
        await pool.query("UPDATE databases SET key = 'emails' WHERE owner_module_id = 'projects' AND system");
      }
      const before = await rows();
      await expect(runMailDatabaseKeysCutoverMigration(pool)).rejects.toThrow();
      expect(await rows()).toEqual(before);
    });
  });

  it("rolls back an earlier update when a later key update fails", async () => {
    await runInTenant(tenant, makeLegacy);
    await admin.query(`CREATE FUNCTION test_fail_mail_key() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.key = 'folders' THEN
          IF NOT EXISTS (SELECT 1 FROM databases WHERE tenant_id = NEW.tenant_id AND system AND owner_module_id = 'emails' AND key = 'emails') THEN
            RAISE EXCEPTION 'test earlier update missing';
          END IF;
          RAISE EXCEPTION 'test later update failure';
        END IF;
        RETURN NEW;
      END $$`);
    await admin.query(
      "CREATE TRIGGER test_fail_mail_key BEFORE UPDATE OF key ON databases FOR EACH ROW EXECUTE FUNCTION test_fail_mail_key()",
    );
    try {
      const before = await runInTenant(tenant, rows);
      await expect(runInTenant(tenant, () => runMailDatabaseKeysCutoverMigration(pool))).rejects.toThrow(
        "test later update failure",
      );
      expect(await runInTenant(tenant, rows)).toEqual(before);
    } finally {
      await admin.query("DROP TRIGGER test_fail_mail_key ON databases");
      await admin.query("DROP FUNCTION test_fail_mail_key()");
    }
  });

  async function exerciseConcurrentCutovers(
    boundedPool: Pool,
    other: string,
    control?: { stop: Promise<void>; onHolderSettled: (result: { ok: true } | { ok: false; error: unknown }) => void },
  ): Promise<void> {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: (pid: number) => void = () => {};
    let fail: (reason: unknown) => void = () => {};
    const ready = new Promise<number>((resolve, reject) => {
      signal = resolve;
      fail = reject;
    });
    const holder = runInTenant(tenant, () =>
      withTransaction(boundedPool, async (client) => {
        try {
          await client.query(
            "SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND owner_module_id = 'mailboxes' AND system FOR UPDATE",
          );
          const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pid = result.rows[0]?.pid;
          if (pid === undefined) throw new Error("Missing lock holder pid");
          signal(pid);
          await gate;
        } catch (error) {
          fail(error);
          throw error;
        }
      }),
    )
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .then((result) => {
        control?.onHolderSettled(result);
        return result;
      });
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    async function waitForBlocked(blockerPid: number, operation: Promise<unknown>): Promise<number> {
      const state: { finished: boolean; value: unknown } = { finished: false, value: undefined };
      void operation.then((value) => {
        state.finished = true;
        state.value = value;
      });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (state.finished) {
          if (state.value instanceof Error) throw state.value;
          if (state.value !== null) throw new Error("Cutover rejected with a non-error value", { cause: state.value });
          throw new Error("Cutover finished before blocking");
        }
        const result = await boundedPool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [blockerPid],
        );
        if (result.rows[0]) return result.rows[0].pid;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Timed out waiting for the cutover to block");
    }
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for the lock holder")), 5000);
      });
      let holderPid: number;
      try {
        holderPid = await Promise.race([
          ready,
          timeout,
          ...(control
            ? [
                control.stop.then(() => {
                  throw new Error("Test stopped before holder readiness");
                }),
              ]
            : []),
          holder.then((result) => {
            if (!result.ok) throw result.error;
            throw new Error("Lock holder finished before signaling readiness");
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      first = runInTenant(tenant, () => runMailDatabaseKeysCutoverMigration(boundedPool)).then(
        () => null,
        (error: unknown) => error,
      );
      const firstPid = await waitForBlocked(holderPid, first);
      second = runInTenant(tenant, () => runMailDatabaseKeysCutoverMigration(boundedPool)).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForBlocked(firstPid, second);
      await runInTenant(other, () => runMailDatabaseKeysCutoverMigration(boundedPool));
      expect((await runInTenant(other, rows)).map((row) => row.key)).toEqual(keys);
      await runInTenant(tenant, () =>
        withTransaction(boundedPool, (client) =>
          createDatabase(client, {
            name: "Key collision",
            key: "mailboxes",
            system: true,
            ownerModuleId: "collisionFixture",
          }),
        ),
      );
      release();
      const holderResult = await holder;
      if (!holderResult.ok) throw holderResult.error;
      expect(await first).toMatchObject({ code: "23505", constraint: "databases_key_unique" });
      expect(await second).toMatchObject({ message: "Mail database key mailboxes is already occupied" });
      const occupant = await runInTenant(tenant, () =>
        pool.query<{ key: string; owner_module_id: string }>(
          "SELECT key, owner_module_id FROM databases WHERE key = 'mailboxes'",
        ),
      );
      expect(occupant.rows).toEqual([{ key: "mailboxes", owner_module_id: "collisionFixture" }]);
      expect((await runInTenant(tenant, rows)).map((row) => row.key)).toEqual([null, null, null]);
    } finally {
      release();
      await Promise.allSettled([holder, ...(first ? [first] : []), ...(second ? [second] : [])]);
      await boundedPool.end();
    }
  }

  it("bounds exhausted checkout in the concurrent cutover helper", async () => {
    const other = await createTestTenant(admin);
    const exhausted = new Pool({
      ...pool.options,
      max: 1,
      connectionTimeoutMillis: 200,
      statement_timeout: 1000,
      query_timeout: 1500,
    });
    const held = await exhausted.connect();
    let released = false;
    const releaseHeld = () => {
      if (!released) {
        released = true;
        held.release();
      }
    };
    let stop = () => {};
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let report: (result: { ok: true } | { ok: false; error: unknown } | null) => void = () => {};
    const observed = new Promise<{ ok: true } | { ok: false; error: unknown } | null>((resolve) => {
      report = resolve;
    });
    const fallback = setTimeout(() => {
      stop();
      releaseHeld();
      report(null);
    }, 1000);
    const started = Date.now();
    const operation = exerciseConcurrentCutovers(exhausted, other, { stop: stopped, onHolderSettled: report }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const initial = await observed;
      expect(initial).toMatchObject({ ok: false, error: { message: "timeout exceeded when trying to connect" } });
      expect(released).toBe(false);
      expect(Date.now() - started).toBeLessThan(900);
    } finally {
      clearTimeout(fallback);
      stop();
      releaseHeld();
      await operation;
    }
  });

  it("serializes overlapping cutovers and rolls back on a concurrent key collision without blocking another tenant", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(pool));
    await runInTenant(tenant, makeLegacy);
    await runInTenant(other, makeLegacy);
    const boundedPool = new Pool({
      ...pool.options,
      max: 6,
      connectionTimeoutMillis: 2000,
      statement_timeout: 4000,
      query_timeout: 6000,
    });
    await exerciseConcurrentCutovers(boundedPool, other);
  });
});
