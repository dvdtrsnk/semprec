import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { ValidationError } from "../../errors.js";
import { setNotificationCreatedHook, type NotificationCreatedEvent } from "../../realtimeHook.js";
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
    project_item_id: string | null;
    severity: string;
    occurrence_count: number;
    first_seen_at: Date;
    last_seen_at: Date;
    resolved_at: Date | null;
    resolution_kind: string | null;
  }>(
    `SELECT id, project_item_id, severity, occurrence_count, first_seen_at, last_seen_at, resolved_at, resolution_kind
       FROM semp_problems WHERE tenant_id = $1 AND dedupe_key = $2 ORDER BY first_seen_at, id`,
    [tenantId, dedupeKey],
  );
  return rows;
}

async function overlapRaises(firstInput: RaiseProblemInput, secondInput: RaiseProblemInput) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: (value: { pid: number; outcome: string }) => void = () => {};
  let fail: (reason: unknown) => void = () => {};
  const ready = new Promise<{ pid: number; outcome: string }>((resolve, reject) => {
    signal = resolve;
    fail = reject;
  });
  const first = inZero(async (client) => {
    try {
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = rows[0]?.pid;
      if (pid === undefined) throw new Error("Missing backend pid");
      const result = await raiseProblem(client, firstInput);
      signal({ pid, outcome: result.outcome });
      await gate;
      return result;
    } catch (error) {
      fail(error);
      throw error;
    }
  });
  let second: Promise<Awaited<ReturnType<typeof raiseProblem>>> | undefined;
  try {
    const held = await ready;
    second = inZero((client) => raiseProblem(client, secondInput));
    await expect
      .poll(
        async () => {
          const result = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [held.pid],
          );
          return result.rows[0]?.count;
        },
        { timeout: 5000 },
      )
      .toBe("1");
    release();
    return [held.outcome, (await first).outcome, (await second).outcome];
  } finally {
    release();
    await Promise.allSettled(second ? [first, second] : [first]);
  }
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
      const checkRejectedInTransaction = async () => {
        await withTenantTransaction(rolePool, tenantZero, async (client) => {
          const problems = () =>
            client.query<{ id: string; project_item_id: string | null; occurrence_count: number }>(
              "SELECT id, project_item_id, occurrence_count FROM semp_problems ORDER BY id",
            );
          const notifications = () => client.query<{ id: string }>("SELECT id FROM notifications ORDER BY id");
          const beforeProblems = await problems();
          const beforeNotifications = await notifications();
          for (const invalid of invalidProjects) {
            await expect(raiseProblem(client, input({ projectItemId: invalid }))).rejects.toMatchObject({
              name: "ValidationError",
              message: "Invalid projectItemId",
              details: { field: "projectItemId" },
            });
            expect((await problems()).rows).toEqual(beforeProblems.rows);
            expect((await notifications()).rows).toEqual(beforeNotifications.rows);
          }
        });
      };
      await checkRejectedInTransaction();
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
      expect((await rowsFor(tenantZero, "mail:sync:account-1"))[0]?.project_item_id).toBe(project);
      expect((await run(project)).outcome).toBe("merged");
      expect((await run(null)).outcome).toBe("merged");
      expect(
        (await withTenantTransaction(rolePool, tenantZero, (client) => raiseProblem(client, input()))).outcome,
      ).toBe("merged");
      const before = await rowsFor(tenantZero, "mail:sync:account-1");
      const notificationsBefore = await pool.query<{ count: string }>("SELECT count(*) FROM notifications");
      await checkRejectedInTransaction();
      expect(await rowsFor(tenantZero, "mail:sync:account-1")).toEqual(before);
      expect((await pool.query<{ count: string }>("SELECT count(*) FROM notifications")).rows).toEqual(
        notificationsBefore.rows,
      );
    },
  );

  it("merges four raises of one key into one row counting four occurrences", async () => {
    const outcomes: string[] = [];
    const since = new Date("2026-01-02T03:04:05.000Z");
    for (let i = 0; i < 4; i++) {
      outcomes.push((await inZero((client) => raiseProblem(client, input(i === 0 ? { since } : {})))).outcome);
    }
    expect(outcomes).toEqual(["created", "merged", "merged", "merged"]);
    const rows = await rowsFor(tenantZero, "mail:sync:account-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrence_count).toBe(4);
    expect(rows[0]?.first_seen_at.toISOString()).toBe(since.toISOString());
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
    const notifications: NotificationCreatedEvent[] = [];
    setNotificationCreatedHook((event) => notifications.push(event));
    try {
      expect(await overlapRaises(input(), input())).toEqual(["created", "created", "merged"]);
      const rows = await rowsFor(tenantZero, "mail:sync:account-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.occurrence_count).toBe(2);
      expect(notifications).toHaveLength(1);
      await inZero(async () => {});
      expect(notifications).toHaveLength(1);
    } finally {
      setNotificationCreatedHook(() => {});
    }
  });

  it("reports an escalation once when two critical raises race over a warning", async () => {
    await inZero((client) => raiseProblem(client, input({ severity: "warning" })));
    expect(await overlapRaises(input({ severity: "critical" }), input({ severity: "critical" }))).toEqual([
      "escalated",
      "escalated",
      "merged",
    ]);
    const notifications = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM notifications WHERE kind = 'semp_problem'",
    );
    expect(notifications.rows[0]?.count).toBe("2");
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
    await withTenantTransaction(sidePool, tenantB, async (client) => {
      const { rows } = await client.query<{ tenant_id: string }>("SELECT tenant_id FROM semp_problems");
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
