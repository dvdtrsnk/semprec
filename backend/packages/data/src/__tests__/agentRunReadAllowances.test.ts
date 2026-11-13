import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { assertAgentDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { allowItemsForTurn, clearForRun, isItemAllowed } from "../agentGrants/agentRunReadAllowancesStore.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { HEALTH_RECORDS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { DatabaseRow, ItemRow } from "../types.js";

// Seeding the system databases of one tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;
const FORBIDDEN = { status: 403, code: "forbidden" };

interface Fixture {
  tenantId: string;
  health: DatabaseRow;
}

let adminPool: Pool;
let dataPool: Pool;
let cp: ChokePoint;
let main: Fixture;
let other: Fixture;

function inTenant<T>(fixture: Fixture, fn: () => Promise<T>): Promise<T> {
  return runInTenant(fixture.tenantId, fn);
}

function inTransaction<T>(fn: (client: PoolClient) => Promise<T>, fixture: Fixture = main): Promise<T> {
  return inTenant(fixture, () => withTransaction(dataPool, fn));
}

async function createFixture(): Promise<Fixture> {
  const tenantId = await createTestTenant(adminPool);
  await createUser(adminPool, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const health = await runInTenant(tenantId, () =>
    withTransaction(dataPool, (client) => getDatabaseByModuleId(client, HEALTH_RECORDS_MODULE_ID)),
  );
  if (!health) throw new Error("The health records database is missing");
  return { tenantId, health };
}

/** A run of a fresh Projects item, as a run credential names it. */
async function newRun(fixture: Fixture = main): Promise<{ runId: string; projectItemId: string }> {
  return inTenant(fixture, async () => {
    const projectItemId = await createTestProjectItem(dataPool);
    const run = await createAgentRun(dataPool, { projectItemId, triggeredBy: "user", task: "allowances" });
    return { runId: run.id, projectItemId };
  });
}

function newRecord(name: string, fixture: Fixture = main): Promise<ItemRow> {
  return inTenant(fixture, () => cp.createItem({ databaseId: fixture.health.id, properties: { name } }));
}

function allow(runId: string, itemIds: string[], fixture: Fixture = main) {
  return inTransaction((client) => allowItemsForTurn(client, runId, itemIds), fixture);
}

function isAllowed(runId: string, itemId: string, fixture: Fixture = main) {
  return inTransaction((client) => isItemAllowed(client, runId, itemId), fixture);
}

function check(
  input: {
    projectItemId: string;
    databaseId: string;
    access: "read" | "write";
    allowance?: { runId: string; itemId: string };
    fixture?: Fixture;
  },
  client?: PoolClient,
) {
  const run = (c: PoolClient) =>
    assertAgentDatabaseAccess(c, {
      agentProjectItemId: input.projectItemId,
      databaseId: input.databaseId,
      access: input.access,
      ...(input.allowance
        ? { readAllowance: { agentRunId: input.allowance.runId, itemId: input.allowance.itemId } }
        : {}),
    });
  return client ? run(client) : inTransaction(run, input.fixture);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("per-turn read allowances of an agent run (issue #1849)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    await resetDatabase(adminPool);
    main = await createFixture();
    other = await createFixture();
    cp = createChokePoint(dataPool);
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await dataPool?.end();
  });

  describe("the store", () => {
    it("allows the given items for the run only, keeps an id the run already holds, and writes nothing for an empty list", async () => {
      const [first, second, third] = [await newRecord("One"), await newRecord("Two"), await newRecord("Three")];
      const run = await newRun();
      const otherRun = await newRun();

      await allow(run.runId, []);
      expect(await isAllowed(run.runId, first.id)).toBe(false);

      await allow(run.runId, [first.id, second.id]);
      await allow(run.runId, [second.id]);
      expect(await isAllowed(run.runId, first.id)).toBe(true);
      expect(await isAllowed(run.runId, second.id)).toBe(true);
      expect(await isAllowed(run.runId, third.id)).toBe(false);
      expect(await isAllowed(otherRun.runId, first.id)).toBe(false);
      const { rows } = await adminPool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM agent_run_read_allowances WHERE agent_run_id = $1",
        [run.runId],
      );
      expect(rows[0]?.n).toBe(2);
    });

    it("clears the allowances of one run, reports how many it deleted and leaves another run's alone", async () => {
      const [first, second] = [await newRecord("One"), await newRecord("Two")];
      const [run, otherRun] = [await newRun(), await newRun()];
      await allow(run.runId, [first.id, second.id]);
      await allow(otherRun.runId, [first.id]);

      expect(await inTransaction((client) => clearForRun(client, run.runId))).toBe(2);
      expect(await isAllowed(run.runId, first.id)).toBe(false);
      expect(await isAllowed(run.runId, second.id)).toBe(false);
      expect(await isAllowed(otherRun.runId, first.id)).toBe(true);
      expect(await inTransaction((client) => clearForRun(client, run.runId))).toBe(0);
    });

    it("removes the allowances of a run together with the run", async () => {
      const record = await newRecord("One");
      const run = await newRun();
      await allow(run.runId, [record.id]);

      // The schema claim (ON DELETE CASCADE): a run row nothing else references, deleted as the table owner.
      await adminPool.query("DELETE FROM agent_runs WHERE id = $1", [run.runId]);
      const { rows } = await adminPool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM agent_run_read_allowances WHERE agent_run_id = $1",
        [run.runId],
      );
      expect(rows[0]?.n).toBe(0);
    });
  });

  describe("the access check", () => {
    it("refuses a read of a sensitive database without an allowance and allows it for the allowed item, never for another item of the database", async () => {
      const [attached, sibling] = [await newRecord("Attached"), await newRecord("Sibling")];
      const run = await newRun();
      const read = (itemId: string) =>
        check({
          projectItemId: run.projectItemId,
          databaseId: main.health.id,
          access: "read",
          allowance: { runId: run.runId, itemId },
        });

      await expect(read(attached.id)).rejects.toMatchObject(FORBIDDEN);
      await allow(run.runId, [attached.id]);
      await read(attached.id);
      await expect(read(sibling.id)).rejects.toMatchObject(FORBIDDEN);
      // The same check without the allowance in its input stays what #1810 made it.
      await expect(
        check({ projectItemId: run.projectItemId, databaseId: main.health.id, access: "read" }),
      ).rejects.toMatchObject(FORBIDDEN);
    });

    it("never allows a write, with or without an allowance for the item", async () => {
      const record = await newRecord("Attached");
      const run = await newRun();
      await allow(run.runId, [record.id]);

      await expect(
        check({
          projectItemId: run.projectItemId,
          databaseId: main.health.id,
          access: "write",
          allowance: { runId: run.runId, itemId: record.id },
        }),
      ).rejects.toMatchObject(FORBIDDEN);
    });

    it("applies only the allowance of the run that reads, not that of another run of the same project", async () => {
      const record = await newRecord("Attached");
      const run = await newRun();
      const sameProjectRun = await inTenant(main, async () => {
        const created = await createAgentRun(dataPool, {
          projectItemId: run.projectItemId,
          triggeredBy: "user",
          task: "second run",
        });
        return created.id;
      });
      await allow(run.runId, [record.id]);
      const asRun = (runId: string) =>
        check({
          projectItemId: run.projectItemId,
          databaseId: main.health.id,
          access: "read",
          allowance: { runId, itemId: record.id },
        });

      await asRun(run.runId);
      await expect(asRun(sameProjectRun)).rejects.toMatchObject(FORBIDDEN);
    });

    it("opens the item of a user-created database that the user switched off for the project, and nothing else in it", async () => {
      const database = await inTenant(main, async () => {
        const created = await cp.createDatabase({ name: "Switched off" });
        await cp.createProperty({ databaseId: created.id, key: "name", name: "Name", type: "title" });
        return created;
      });
      const [attached, sibling] = await inTenant(main, () =>
        Promise.all([
          cp.createItem({ databaseId: database.id, properties: { name: "Attached" } }),
          cp.createItem({ databaseId: database.id, properties: { name: "Sibling" } }),
        ]),
      );
      const run = await newRun();
      await inTransaction((client) =>
        setAgentDatabaseGrant(client, { projectItemId: run.projectItemId, databaseId: database.id, access: "none" }),
      );
      await allow(run.runId, [attached.id]);
      const read = (itemId: string) =>
        check({
          projectItemId: run.projectItemId,
          databaseId: database.id,
          access: "read",
          allowance: { runId: run.runId, itemId },
        });

      await read(attached.id);
      await expect(read(sibling.id)).rejects.toMatchObject(FORBIDDEN);
    });

    it("answers not found for a database the tenant does not have, whatever the allowance says", async () => {
      const record = await newRecord("Attached");
      const run = await newRun();
      await allow(run.runId, [record.id]);

      await expect(
        check({
          projectItemId: run.projectItemId,
          databaseId: randomUUID(),
          access: "read",
          allowance: { runId: run.runId, itemId: record.id },
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("lets the clear of the turn's end wait for a read that passed on the allowance", async () => {
      const record = await newRecord("Attached");
      const run = await newRun();
      await allow(run.runId, [record.id]);

      const checked = deferred();
      const release = deferred();
      const read = inTransaction(async (client) => {
        await check(
          {
            projectItemId: run.projectItemId,
            databaseId: main.health.id,
            access: "read",
            allowance: { runId: run.runId, itemId: record.id },
          },
          client,
        );
        checked.resolve();
        await release.promise;
      });
      await checked.promise;

      let cleared = false;
      const clear = inTransaction((client) => clearForRun(client, run.runId)).then(() => {
        cleared = true;
      });
      // The delete is blocked on the row the read's check holds `FOR SHARE`: wait until Postgres reports it so.
      const deadline = Date.now() + 15_000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const { rows } = await adminPool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'DELETE FROM agent_run_read_allowances%'`,
        );
        blocked = (rows[0]?.n ?? 0) > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      expect(cleared).toBe(false);

      release.resolve();
      await read;
      await clear;
      expect(cleared).toBe(true);
      expect(await isAllowed(run.runId, record.id)).toBe(false);
    });
  });

  describe("tenant isolation", () => {
    it("never applies another tenant's allowance, never stores one for another tenant's run and never clears one", async () => {
      const record = await newRecord("Attached");
      const run = await newRun();
      const otherRecord = await newRecord("Other attached", other);
      const otherRun = await newRun(other);
      await allow(run.runId, [record.id]);

      // The runtime role is subject to row-level security: the other tenant sees no row of this tenant's run.
      expect(await isAllowed(run.runId, record.id, other)).toBe(false);
      expect(await inTransaction((client) => clearForRun(client, run.runId), other)).toBe(0);
      expect(await isAllowed(run.runId, record.id)).toBe(true);
      await expect(allow(run.runId, [otherRecord.id], other)).rejects.toMatchObject({ code: "23503" });
      const { rows } = await adminPool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM agent_run_read_allowances WHERE agent_run_id = $1 AND tenant_id = $2",
        [run.runId, other.tenantId],
      );
      expect(rows[0]?.n).toBe(0);

      // The same run id and item id presented to the other tenant's access check find no allowance there.
      await expect(
        check({
          projectItemId: otherRun.projectItemId,
          databaseId: other.health.id,
          access: "read",
          allowance: { runId: run.runId, itemId: record.id },
          fixture: other,
        }),
      ).rejects.toMatchObject(FORBIDDEN);
    });
  });
});
