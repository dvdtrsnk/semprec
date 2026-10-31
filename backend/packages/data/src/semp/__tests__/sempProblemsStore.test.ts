import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { ValidationError } from "../../errors.js";
import { createDatabase } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import {
  createTenantZeroUser,
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { raiseProblem, resolveProblem, type RaiseProblemInput } from "../sempProblemsStore.js";

class RollbackSentinel extends Error {}

let pool: Pool;
let runtimePool: Pool;
let sidePool: Pool;
let tenantZero: string;
let userZero: string;
let tenantB: string;
let userB: string;

async function tenantOf(userId: string): Promise<string> {
  const { rows } = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM users WHERE id = $1", [userId]);
  return rows[0]?.tenant_id ?? "";
}

function input(overrides: Partial<RaiseProblemInput> = {}): RaiseProblemInput {
  return {
    userId: userZero,
    category: "mail",
    kind: "mailSyncFailed",
    severity: "warning",
    sourceTable: "mail_account_sync_state",
    sourceId: randomUUID(),
    dedupeKey: "mail:sync:account-1",
    ...overrides,
  };
}

/** Runs `fn` in a transaction scoped to tenant zero and commits it. */
function inZero<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantTransaction(pool, tenantZero, fn);
}

async function rowsFor(tenantId: string, dedupeKey: string) {
  const { rows } = await pool.query<{
    id: string;
    severity: string;
    occurrence_count: number;
    first_seen_at: Date;
    last_seen_at: Date;
    resolved_at: Date | null;
    resolution_kind: string | null;
  }>(
    `SELECT id, severity, occurrence_count, first_seen_at, last_seen_at, resolved_at, resolution_kind
       FROM semp_problems WHERE tenant_id = $1 AND dedupe_key = $2 ORDER BY first_seen_at, id`,
    [tenantId, dedupeKey],
  );
  return rows;
}

describe("semp problems store", () => {
  beforeAll(async () => {
    pool = getTestPool({ max: 6 });
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    sidePool = await createRuntimeRolePool(pool, "semprec_side");
    tenantZero = getTenantZeroId();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    userZero = (await createTenantZeroUser(pool)).id;
    userB = (await createTenantZeroUser(pool)).id;
    tenantB = await tenantOf(userB);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await sidePool?.end();
    await pool?.end();
  });

  it.each(["data", "side"] as const)(
    "validates project attribution on create and merge as %s runtime role",
    async (role) => {
      async function itemFor(tenant: string, moduleId: string): Promise<string> {
        return withTenantTransaction(pool, tenant, async (client) => {
          const db = await createDatabase(client, { name: moduleId, system: true, ownerModuleId: moduleId });
          return (await createItemWithClient(client, { databaseId: db.id, properties: {} })).id;
        });
      }
      const project = await itemFor(tenantZero, "projects");
      const wrongDatabase = await itemFor(tenantZero, "people");
      const foreignProject = await itemFor(tenantB, "projects");
      const rolePool = role === "data" ? runtimePool : sidePool;
      const run = (projectItemId: string | null) =>
        withTenantTransaction(rolePool, tenantZero, (client) => raiseProblem(client, input({ projectItemId })));
      const invalidProjects = [randomUUID(), "invalid", wrongDatabase, foreignProject];
      for (const invalid of invalidProjects) {
        await expect(run(invalid)).rejects.toMatchObject({
          name: "ValidationError",
          message: "Invalid projectItemId",
          details: { field: "projectItemId" },
        });
      }
      expect(await rowsFor(tenantZero, "mail:sync:account-1")).toEqual([]);
      expect((await pool.query<{ count: string }>("SELECT count(*) FROM notifications")).rows[0]?.count).toBe("0");
      expect(
        (
          await withTenantTransaction(rolePool, tenantZero, (client) =>
            raiseProblem(client, input({ dedupeKey: "mail:sync:no-project" })),
          )
        ).outcome,
      ).toBe("created");
      expect((await run(project)).outcome).toBe("created");
      expect((await run(null)).outcome).toBe("merged");
      expect(
        (await withTenantTransaction(rolePool, tenantZero, (client) => raiseProblem(client, input()))).outcome,
      ).toBe("merged");
      const before = await rowsFor(tenantZero, "mail:sync:account-1");
      const notificationsBefore = await pool.query<{ count: string }>("SELECT count(*) FROM notifications");
      for (const invalid of invalidProjects) {
        await expect(run(invalid)).rejects.toMatchObject({
          name: "ValidationError",
          message: "Invalid projectItemId",
          details: { field: "projectItemId" },
        });
      }
      expect(await rowsFor(tenantZero, "mail:sync:account-1")).toEqual(before);
      expect((await pool.query<{ count: string }>("SELECT count(*) FROM notifications")).rows).toEqual(
        notificationsBefore.rows,
      );
    },
  );

  it("merges four raises of one key into one row counting four occurrences", async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      outcomes.push((await inZero((client) => raiseProblem(client, input()))).outcome);
    }
    expect(outcomes).toEqual(["created", "merged", "merged", "merged"]);
    const rows = await rowsFor(tenantZero, "mail:sync:account-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrence_count).toBe(4);
    expect(rows[0]?.last_seen_at.getTime()).toBeGreaterThan(rows[0]?.first_seen_at.getTime() ?? Infinity);
  });

  it("starts first_seen_at at since and keeps it across later raises", async () => {
    const since = new Date("2026-01-02T03:04:05.000Z");
    await inZero((client) => raiseProblem(client, input({ since })));
    await inZero((client) => raiseProblem(client, input()));
    const rows = await rowsFor(tenantZero, "mail:sync:account-1");
    expect(rows[0]?.first_seen_at.toISOString()).toBe(since.toISOString());
    expect(rows[0]?.occurrence_count).toBe(2);
  });

  it("escalates a warning to critical once and never lowers it", async () => {
    const first = await inZero((client) => raiseProblem(client, input({ severity: "warning" })));
    expect(first.outcome).toBe("created");
    const second = await inZero((client) => raiseProblem(client, input({ severity: "critical" })));
    expect(second).toEqual({ problemId: first.problemId, outcome: "escalated" });
    const third = await inZero((client) => raiseProblem(client, input({ severity: "critical" })));
    expect(third.outcome).toBe("merged");
    const fourth = await inZero((client) => raiseProblem(client, input({ severity: "warning" })));
    expect(fourth.outcome).toBe("merged");
    const rows = await rowsFor(tenantZero, "mail:sync:account-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.severity).toBe("critical");
    expect(rows[0]?.occurrence_count).toBe(4);
  });

  it("counts a repeated occurrenceKey once and a new one again", async () => {
    await inZero((client) => raiseProblem(client, input({ occurrenceKey: "job-1" })));
    const replay = await inZero((client) => raiseProblem(client, input({ occurrenceKey: "job-1" })));
    expect(replay.outcome).toBe("merged");
    expect((await rowsFor(tenantZero, "mail:sync:account-1"))[0]?.occurrence_count).toBe(1);
    await inZero((client) => raiseProblem(client, input({ occurrenceKey: "job-2" })));
    expect((await rowsFor(tenantZero, "mail:sync:account-1"))[0]?.occurrence_count).toBe(2);
  });

  it("leaves one row when two transactions raise the same key concurrently", async () => {
    const results = await Promise.all([
      inZero((client) => raiseProblem(client, input())),
      inZero((client) => raiseProblem(client, input())),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["created", "merged"]);
    const rows = await rowsFor(tenantZero, "mail:sync:account-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrence_count).toBe(2);
  });

  it("reports an escalation once when two critical raises race over a warning", async () => {
    await inZero((client) => raiseProblem(client, input({ severity: "warning" })));
    const results = await Promise.all([
      inZero((client) => raiseProblem(client, input({ severity: "critical" }))),
      inZero((client) => raiseProblem(client, input({ severity: "critical" }))),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["escalated", "merged"]);
  });

  it("leaves no row when the raising transaction rolls back", async () => {
    await expect(
      withTenantTransaction(pool, tenantZero, async (client) => {
        await raiseProblem(client, input());
        throw new RollbackSentinel();
      }),
    ).rejects.toBeInstanceOf(RollbackSentinel);
    expect(await rowsFor(tenantZero, "mail:sync:account-1")).toEqual([]);
  });

  it("creates a second row when a raise follows a resolution of the same key", async () => {
    const first = await inZero((client) => raiseProblem(client, input()));
    expect(
      await inZero((client) =>
        resolveProblem(client, { dedupeKey: "mail:sync:account-1", resolutionKind: "recovered" }),
      ),
    ).toBe(true);
    const second = await inZero((client) => raiseProblem(client, input()));
    expect(second.outcome).toBe("created");
    expect(second.problemId).not.toBe(first.problemId);
    const rows = await rowsFor(tenantZero, "mail:sync:account-1");
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.resolved_at === null)).toHaveLength(1);
    expect(rows.find((r) => r.id === first.problemId)?.resolution_kind).toBe("recovered");
  });

  it("resolves idempotently and rejects an unknown resolution kind", async () => {
    await inZero((client) => raiseProblem(client, input()));
    const resolve = () =>
      inZero((client) => resolveProblem(client, { dedupeKey: "mail:sync:account-1", resolutionKind: "recovered" }));
    expect(await resolve()).toBe(true);
    expect(await resolve()).toBe(false);
    await expect(
      inZero((client) =>
        resolveProblem(client, { dedupeKey: "mail:sync:account-1", resolutionKind: "bogus" as "recovered" }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps tenants apart: no merge, no visibility, no resolution across tenants", async () => {
    await inZero((client) => raiseProblem(client, input()));
    const other = await withTenantTransaction(pool, tenantB, (client) =>
      raiseProblem(client, input({ userId: userB })),
    );
    expect(other.outcome).toBe("created");
    expect(await rowsFor(tenantZero, "mail:sync:account-1")).toHaveLength(1);
    expect(await rowsFor(tenantB, "mail:sync:account-1")).toHaveLength(1);

    // Row-level security as the runtime role: tenant B sees only its own row.
    await withTenantTransaction(pool, tenantB, async (client) => {
      await client.query("SET LOCAL ROLE semprec_side");
      const { rows } = await client.query<{ tenant_id: string }>("SELECT tenant_id FROM semp_problems");
      await client.query("RESET ROLE");
      expect(rows).toEqual([{ tenant_id: tenantB }]);
    });

    expect(
      await withTenantTransaction(pool, tenantB, (client) =>
        resolveProblem(client, { dedupeKey: "mail:sync:account-1", resolutionKind: "recovered" }),
      ),
    ).toBe(true);
    expect((await rowsFor(tenantZero, "mail:sync:account-1"))[0]?.resolved_at).toBeNull();
  });

  it("refuses a user of another tenant", async () => {
    await expect(inZero((client) => raiseProblem(client, input({ userId: userB })))).rejects.toThrow(
      /semp_problems_user_id_tenant_fkey/,
    );
  });
});
