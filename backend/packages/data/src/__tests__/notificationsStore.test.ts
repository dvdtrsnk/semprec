import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createTestTenant,
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { randomUUID } from "node:crypto";
import { inTenantZero } from "../testSupport/testDb.js";
import { runInTenant } from "@semprec/shared";
import { seedSystem } from "../seed/seedSystem.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createPendingApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { decideAndEnqueueApprovalRequest } from "../mcp/approvalDecisionAction.js";
import { writeNotification } from "../notifications/notify.js";
import {
  listUnreadNotificationsForUser,
  visitNotification,
  markAllNotificationsRead,
  resolveNotificationsBySource,
  listResolvedNotificationIds,
  getNotificationById,
} from "../notifications/notificationsStore.js";
import {
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  type NotificationCreatedEvent,
  type NotificationReadStateEvent,
} from "../realtimeHook.js";

let pool: Pool;
type NotificationActorRecord = {
  label: string;
  status: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: unknown;
  timedOut: boolean;
  consumed: boolean;
  primary?: { error: unknown };
};
const pendingNotificationActors = new Set<Promise<unknown>>();
const notificationActorRecords = new Map<Promise<unknown>, NotificationActorRecord>();
function notificationActorDiagnostic(): AggregateError | undefined {
  const records = [...notificationActorRecords.values()].filter(
    (record) => record.timedOut || record.status === "pending",
  );
  if (records.length === 0) return undefined;
  const errors: unknown[] = [];
  const primaries = new Set<{ error: unknown }>();
  for (const record of records) {
    if (record.primary && !primaries.has(record.primary)) {
      primaries.add(record.primary);
      errors.push(record.primary.error);
    }
    if (record.status === "pending") errors.push(new Error(`${record.label} remains pending`));
    else if (record.status === "rejected" && !record.consumed) errors.push(record.error);
    else if (
      !record.consumed &&
      typeof record.value === "object" &&
      record.value !== null &&
      "ok" in record.value &&
      record.value.ok === false &&
      "error" in record.value
    )
      errors.push(record.value.error);
    else errors.push(new Error(`${record.label} crossed its deadline`));
  }
  return new AggregateError(errors, "Notification actors remain unsafe");
}
function observeNotificationActor<T>(actor: Promise<T>): Promise<T> {
  const record: NotificationActorRecord = {
    label: `notification actor ${notificationActorRecords.size + 1}`,
    status: "pending",
    timedOut: false,
    consumed: false,
  };
  notificationActorRecords.set(actor, record);
  pendingNotificationActors.add(actor);
  void actor.then(
    (value) => {
      record.status = "fulfilled";
      record.value = value;
      pendingNotificationActors.delete(actor);
    },
    (error: unknown) => {
      record.status = "rejected";
      record.error = error;
      pendingNotificationActors.delete(actor);
    },
  );
  return actor;
}
async function boundNotificationActor<T>(actor: Promise<T>, deadlineMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      actor,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const record = notificationActorRecords.get(actor);
          if (record) record.timedOut = true;
          reject(new Error("Notification actor did not settle"));
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("notificationsStore (issue #152)", () => {
  beforeEach(async () => {
    const unsafe = notificationActorDiagnostic();
    if (unsafe) throw unsafe;
    pool ??= getTestPool();
    await resetDatabase(pool);
    tenantOfUser.clear();
  });

  afterEach(() => {
    setNotificationReadStateHook(() => {});
  });

  afterAll(async () => {
    const unsafe = notificationActorDiagnostic();
    if (unsafe) throw unsafe;
    await pool?.end();
  });

  /** The tenant each test user is bound to: a notification may only name its own tenant's user (issue #1066). */
  const tenantOfUser = new Map<string, string>();

  /** The first user is tenant zero's; each later one gets a tenant of its own, as a tenant has one user. */
  async function createTestUser(locale?: "en" | "cs"): Promise<string> {
    const passwordHash = await hashPassword("s3cret-password");
    const tenantId = tenantOfUser.size === 0 ? getTenantZeroId() : await createTestTenant(pool);
    const user = await createUser(pool, {
      email: `${Math.random()}@example.test`,
      passwordHash,
      tenantId,
      ...(locale ? { locale } : {}),
    });
    tenantOfUser.set(user.id, tenantId);
    return user.id;
  }

  async function writeTestNotification(userId: string, sourceId: string, linkHref: string | null = null) {
    const tenantId = tenantOfUser.get(userId);
    if (!tenantId) throw new Error(`writeTestNotification: ${userId} was not created by createTestUser`);
    await withTenantTransaction(pool, tenantId, (client) =>
      writeNotification(client, {
        userId,
        kind: "heartbeat_error",
        titleParams: { name: sourceId },
        linkHref,
        sourceTable: "project_heartbeats",
        sourceId,
        transitionInstance: "job-1",
      }),
    );
  }

  it("retains a late notification actor failure after a bounded deadline", async () => {
    let resolveLate!: (value: { ok: false; error: unknown }) => void;
    const error = new Error("late notification actor failure");
    const actor = observeNotificationActor(
      new Promise<{ ok: false; error: unknown }>((resolve) => {
        resolveLate = resolve;
      }),
    );
    try {
      await expect(boundNotificationActor(actor, 1)).rejects.toThrow("Notification actor did not settle");
      const record = notificationActorRecords.get(actor);
      if (!record) throw new Error("Missing actor record");
      record.primary = { error: 0 };
      expect(notificationActorDiagnostic()?.errors[0]).toBe(0);
      expect(await boundNotificationActor(Promise.resolve("independent"))).toBe("independent");
      resolveLate({ ok: false, error });
      await actor;
      const diagnostic = notificationActorDiagnostic();
      expect(diagnostic?.errors).toEqual([0, error]);
      expect(notificationActorRecords.get(actor)?.value).toEqual({ ok: false, error });
    } finally {
      resolveLate({ ok: false, error });
      await actor;
      notificationActorRecords.delete(actor);
    }
  });

  it("lets a concurrent second writer validate and insert after the first rolls back", async () => {
    const user = await createTestUser("en");
    const tenant = tenantOfUser.get(user);
    if (!tenant) throw new Error("Missing tenant");
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstReady: (identity: { pid: number; started: string }) => void = () => {};
    let secondReady: (identity: { pid: number; started: string }) => void = () => {};
    const firstSignal = new Promise<{ pid: number; started: string }>((resolve) => {
      firstReady = resolve;
    });
    const secondSignal = new Promise<{ pid: number; started: string }>((resolve) => {
      secondReady = resolve;
    });
    const intentional = new Error("First notification transaction rolled back");
    let primary: { error: unknown } | undefined;
    let first: Promise<{ ok: true; value: string } | { ok: false; error: unknown }> | undefined;
    let second: Promise<{ ok: true; value: string } | { ok: false; error: unknown }> | undefined;
    try {
      await runInTenant(tenant, () => seedSystem(runtime));
      const database = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => getDatabaseByModuleId(client, "projects")),
      );
      if (!database) throw new Error("Missing Projects database");
      const project = await runInTenant(tenant, () =>
        createChokePoint(runtime).createItem({ databaseId: database.id, properties: { name: "Concurrent" } }),
      );
      const input = {
        userId: user,
        kind: "agent_guidance_drift_resolved" as const,
        linkHref: null,
        sourceTable: "agent_guidance_drift_findings",
        sourceId: "concurrent",
        transitionInstance: "decision",
        payload: { projectItemId: project.id, kind: "behavior" },
      };
      const identity = async (client: import("pg").PoolClient) => {
        const result = await client.query<{ pid: number; started: string }>(
          "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        );
        if (!result.rows[0]) throw new Error("Missing backend identity");
        return result.rows[0];
      };
      first = observeNotificationActor(
        runInTenant(tenant, () =>
          withTransaction(runtime, async (client) => {
            const own = await identity(client);
            await writeNotification(client, input);
            firstReady(own);
            await gate;
            throw intentional;
          }),
        ).then(
          (value: string) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      let firstReadyReceived = false;
      const firstIdentity = await boundNotificationActor(
        Promise.race([
          firstSignal,
          first.then((result) => {
            if (!result.ok && !firstReadyReceived) {
              const record = first && notificationActorRecords.get(first);
              if (record) record.consumed = true;
            }
            throw result.ok ? new Error("First actor ended before reservation") : result.error;
          }),
        ]),
      );
      firstReadyReceived = true;
      second = observeNotificationActor(
        runInTenant(tenant, () =>
          withTransaction(runtime, async (client) => {
            secondReady(await identity(client));
            return writeNotification(client, input);
          }),
        ).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      let secondReadyReceived = false;
      const secondIdentity = await boundNotificationActor(
        Promise.race([
          secondSignal,
          second.then((result) => {
            if (!result.ok && !secondReadyReceived) {
              const record = second && notificationActorRecords.get(second);
              if (record) record.consumed = true;
            }
            throw result.ok ? new Error("Second actor ended before observation") : result.error;
          }),
        ]),
      );
      secondReadyReceived = true;
      await expect
        .poll(
          async () => {
            const result = await pool.query<{ blockers: number[] }>(
              "SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz",
              [secondIdentity.pid, secondIdentity.started],
            );
            return result.rows[0]?.blockers ?? [];
          },
          { timeout: 5000 },
        )
        .toContain(firstIdentity.pid);
      const owner = await pool.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
        [firstIdentity.pid, firstIdentity.started],
      );
      expect(owner.rows).toEqual([{ present: true }]);
    } catch (error) {
      primary = { error };
    }
    release();
    const actors = [first, second].filter((actor): actor is NonNullable<typeof actor> => actor !== undefined);
    const settled = await Promise.allSettled(actors.map((actor) => boundNotificationActor(actor)));
    for (const actor of actors) {
      const record = notificationActorRecords.get(actor);
      if (record?.timedOut && primary) record.primary = primary;
    }
    const errors: unknown[] = primary ? [primary.error] : [];
    const outcomes = settled.map((result) => {
      if (result.status === "rejected") {
        errors.push(result.reason);
        return undefined;
      }
      return result.value;
    });
    if (
      outcomes[0] &&
      !outcomes[0].ok &&
      outcomes[0].error !== intentional &&
      !notificationActorRecords.get(first!)?.consumed
    )
      errors.push(outcomes[0].error);
    if (outcomes[1] && !outcomes[1].ok && !notificationActorRecords.get(second!)?.consumed)
      errors.push(outcomes[1].error);
    if (pendingNotificationActors.size === 0) {
      try {
        await runtime.end();
      } catch (error) {
        errors.push(error);
      }
    } else errors.push(new Error("Notification actor remains unsettled; pool remains open"));
    if (errors.length)
      throw new AggregateError(errors, "Concurrent notification test failed", { cause: primary?.error ?? errors[0] });
    expect(outcomes[0]).toMatchObject({ ok: false, error: intentional });
    expect(outcomes[1]).toMatchObject({ ok: true, value: expect.any(String) });
    const rows = await runInTenant(tenant, () =>
      pool.query<{ id: string; payload: unknown }>("SELECT id, payload FROM notifications WHERE source_id = $1", [
        "concurrent",
      ]),
    );
    if (!outcomes[1]?.ok) throw new Error("Missing second notification");
    expect(rows.rows).toEqual([
      {
        id: outcomes[1].value,
        payload: {
          projectItemId: expect.any(String),
          kind: "behavior",
          resolutionTitle: "Instructions of project Concurrent match what Semp does again",
        },
      },
    ]);
    expect(
      (
        await pool.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
          `notification-fanout:${outcomes[1].value}`,
        ])
      ).rows,
    ).toHaveLength(1);
  });

  it("defaults an absent legacy kind but refuses a present null before any notification", async () => {
    const user = await createTestUser("en");
    const tenant = tenantOfUser.get(user);
    if (!tenant) throw new Error("Missing tenant");
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let failure: { error: unknown } | undefined;
    try {
      await runInTenant(tenant, () => seedSystem(runtime));
      const database = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => getDatabaseByModuleId(client, "projects")),
      );
      if (!database) throw new Error("Missing Projects database");
      const project = await runInTenant(tenant, () =>
        createChokePoint(runtime).createItem({ databaseId: database.id, properties: { name: "Project" } }),
      );
      const common = {
        userId: user,
        kind: "agent_guidance_drift_resolved" as const,
        linkHref: null,
        sourceTable: "agent_guidance_drift_findings",
        sourceId: "kind-test",
        transitionInstance: "decision",
      };
      const jobsBefore = await pool.query<{ id: string; key: string | null }>(
        "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
      );
      await expect(
        runInTenant(tenant, () =>
          withTransaction(runtime, (tx) =>
            writeNotification(tx, {
              ...common,
              payload: { projectItemId: project.id, kind: null },
            }),
          ),
        ),
      ).rejects.toThrow("Invalid guidance drift kind");
      expect(
        (
          await runInTenant(tenant, () =>
            runtime.query("SELECT id FROM notifications WHERE source_id = $1", [common.sourceId]),
          )
        ).rows,
      ).toEqual([]);
      expect(
        (await pool.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
          .rows,
      ).toEqual(jobsBefore.rows);
      const id = await runInTenant(tenant, () =>
        withTransaction(runtime, (tx) =>
          writeNotification(tx, {
            ...common,
            payload: { projectItemId: project.id },
          }),
        ),
      );
      const rows = await runInTenant(tenant, () =>
        runtime.query<{ payload: unknown }>("SELECT payload FROM notifications WHERE id = $1", [id]),
      );
      expect(rows.rows).toEqual([
        {
          payload: {
            projectItemId: project.id,
            kind: "permission",
            resolutionTitle: "Instructions of project Project match the permissions again",
          },
        },
      ]);
    } catch (error) {
      failure = { error };
    }
    try {
      await runtime.end();
    } catch (cleanupError) {
      if (failure)
        throw new AggregateError([failure.error, cleanupError], "Notification test cleanup failed", {
          // The original test failure is primary; cleanupError is retained in the aggregate.
          // eslint-disable-next-line preserve-caught-error
          cause: failure.error,
        });
      throw cleanupError;
    }
    if (failure) throw failure.error;
  });

  it("keeps resolved notification callbacks on the managed transaction owner", async () => {
    const user = await createTestUser("en");
    const tenant = tenantOfUser.get(user);
    if (!tenant) throw new Error("Missing tenant");
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    runtime.options.max = 1;
    const events: NotificationCreatedEvent[] = [];
    let primary: { error: unknown } | undefined;
    try {
      await runInTenant(tenant, () => seedSystem(pool));
      const projects = await runInTenant(tenant, () =>
        withTransaction(runtime, (tx) => getDatabaseByModuleId(tx, "projects")),
      );
      if (!projects) throw new Error("Missing Projects database");
      const project = await runInTenant(tenant, () =>
        createChokePoint(runtime).createItem({ databaseId: projects.id, properties: { name: "Project" } }),
      );
      const input = (sourceId: string) => ({
        userId: user,
        kind: "agent_guidance_drift_resolved" as const,
        linkHref: null,
        sourceTable: "agent_guidance_drift_findings",
        sourceId,
        transitionInstance: "decision",
        payload: { projectItemId: project.id, kind: "behavior" },
      });
      const rows = (sourceId: string) =>
        runInTenant(tenant, () =>
          runtime.query<{ id: string }>("SELECT id FROM notifications WHERE source_id = $1", [sourceId]),
        );
      const job = (id: string) =>
        pool.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
          `notification-fanout:${id}`,
        ]);
      setNotificationCreatedHook((event) => events.push(event));
      await runInTenant(tenant, async () => {
        const manualWrite = async (source: string, commit: boolean) => {
          const client = await runtime.connect();
          let active = false;
          let releaseError: Error | undefined;
          try {
            await client.query("BEGIN");
            active = true;
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
            const identity = await client.query<{ pid: number; started: string }>(
              "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
            );
            if (!identity.rows[0]) throw new Error("Missing connection identity");
            const id = await writeNotification(client, input(source));
            await client.query(commit ? "COMMIT" : "ROLLBACK");
            active = false;
            return { id, identity: identity.rows[0] };
          } catch (error) {
            if (active) {
              try {
                await client.query("ROLLBACK");
              } catch (cleanupError) {
                releaseError = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
                throw new AggregateError([error, cleanupError], "Manual transaction and rollback failed", {
                  // The operation error remains primary; the rollback error is retained above.
                  // eslint-disable-next-line preserve-caught-error
                  cause: error,
                });
              }
            }
            throw error;
          } finally {
            client.release(releaseError);
          }
        };
        const rolledBack = await manualWrite("manual-rollback", false);
        const later = await withTransaction(runtime, async (tx) => {
          const identity = await tx.query<{ pid: number; started: string }>(
            "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
          );
          await tx.query("SELECT 1");
          return identity.rows[0];
        });
        expect(later).toEqual(rolledBack.identity);
        expect((await rows("manual-rollback")).rows).toEqual([]);
        expect((await job(rolledBack.id)).rows).toEqual([]);
        expect(events).toEqual([]);
        const manual = await manualWrite("manual-commit", true);
        await withTransaction(runtime, async (tx) => {
          await tx.query("SELECT 1");
        });
        expect((await rows("manual-commit")).rows).toEqual([{ id: manual.id }]);
        expect((await job(manual.id)).rows).toEqual([{ key: `notification-fanout:${manual.id}` }]);
        expect(events).toEqual([]);
        const managedId = await withTransaction(runtime, (tx) => writeNotification(tx, input("managed-commit")));
        expect(events).toEqual([{ userId: user, notificationId: managedId }]);
        expect(await withTransaction(runtime, (tx) => writeNotification(tx, input("managed-commit")))).toBe(managedId);
        expect(events).toEqual([{ userId: user, notificationId: managedId }]);
        let rollbackId = "";
        await expect(
          withTransaction(runtime, async (tx) => {
            rollbackId = await writeNotification(tx, input("managed-rollback"));
            throw new Error("intentional rollback");
          }),
        ).rejects.toThrow("intentional rollback");
        expect((await rows("managed-rollback")).rows).toEqual([]);
        expect((await job(rollbackId)).rows).toEqual([]);
        expect(events).toEqual([{ userId: user, notificationId: managedId }]);
      });
    } catch (error) {
      primary = { error };
    }
    setNotificationCreatedHook(() => {});
    try {
      await runtime.end();
    } catch (error) {
      if (primary)
        throw new AggregateError([primary.error, error], "Notification test and cleanup failed", {
          // The test error remains primary; the pool cleanup error is retained above.
          // eslint-disable-next-line preserve-caught-error
          cause: primary.error,
        });
      throw error;
    }
    if (primary) throw primary.error;
  });

  it("does not commit a failed provisional resolved notification in a manual transaction", async () => {
    const user = await createTestUser();
    const tenant = tenantOfUser.get(user);
    if (!tenant) throw new Error("Missing tenant");
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let failure: { error: unknown } | undefined;
    try {
      await runInTenant(tenant, async () => {
        const client = await runtime.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
          await expect(
            writeNotification(client, {
              userId: user,
              kind: "agent_guidance_drift_resolved",
              linkHref: null,
              sourceTable: "agent_guidance_drift_findings",
              sourceId: "missing",
              transitionInstance: "manual",
              payload: { projectItemId: "00000000-0000-4000-8000-000000000000", kind: "behavior" },
            }),
          ).rejects.toThrow("Guidance drift project not found");
          await client.query("COMMIT");
        } finally {
          client.release();
        }
        const rows = await runtime.query<{ id: string }>("SELECT id FROM notifications WHERE source_id = $1", [
          "missing",
        ]);
        expect(rows.rows).toEqual([]);
      });
    } catch (error) {
      failure = { error };
    }
    try {
      await runtime.end();
    } catch (cleanupError) {
      if (failure)
        throw new AggregateError([failure.error, cleanupError], "Notification test cleanup failed", {
          // The original test failure is primary; cleanupError is retained in the aggregate.
          // eslint-disable-next-line preserve-caught-error
          cause: failure.error,
        });
      throw cleanupError;
    }
    if (failure) throw failure.error;
  });

  it("drains tied resolved rows with full microsecond boundaries under the runtime tenant role", async () => {
    const user = await createTestUser();
    const foreignUser = await createTestUser();
    const tenant = tenantOfUser.get(user)!;
    const foreignTenant = tenantOfUser.get(foreignUser)!;
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const failures: unknown[] = [];
    try {
      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'semprec_data'",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const seed = async (tenantId: string, userId: string, count: number) =>
        withTenantTransaction(runtime, tenantId, async (client) => {
          const run = await createAgentRun(client, {
            triggeredBy: "user",
            userId,
            task: "Resolved notification fixture",
          });
          const ids: string[] = [];
          for (let i = 0; i < count; i++)
            ids.push(
              await writeNotification(client, {
                userId,
                kind: "agent_run_error",
                sourceTable: "agent_runs",
                sourceId: run.id,
                transitionInstance: `transition-${i}`,
                linkHref: null,
              }),
            );
          await resolveNotificationsBySource(client, { sourceTable: "agent_runs", sourceId: run.id });
          // Synthetic timestamp fixture: the production resolver always uses the database clock.
          const fixed = await client.query(
            "UPDATE notifications SET resolved_at = $3::timestamptz WHERE tenant_id = app_tenant_default() AND user_id = $1 AND id = ANY($2::uuid[]) AND resolved_at IS NOT NULL",
            [userId, ids, "2025-01-01T00:00:00.123456Z"],
          );
          expect(fixed.rowCount).toBe(count);
          return ids.sort();
        });
      const expected = await seed(tenant, user, 503);
      const foreign = await seed(foreignTenant, foreignUser, 1);
      const unresolved = await withTenantTransaction(runtime, tenant, async (client) => {
        const run = await createAgentRun(client, { triggeredBy: "user", userId: user, task: "Unresolved fixture" });
        return writeNotification(client, {
          userId: user,
          kind: "agent_run_error",
          sourceTable: "agent_runs",
          sourceId: run.id,
          transitionInstance: "unresolved",
          linkHref: null,
        });
      });
      await withTenantTransaction(runtime, tenant, async (client) => {
        const first = await listResolvedNotificationIds(client, user, "2000-01-01T00:00:00Z", 900);
        expect(first).toHaveLength(500);
        const boundary = first.at(-1)!;
        expect(boundary.resolvedAt).toBe("2025-01-01T00:00:00.123456Z");
        const second = await listResolvedNotificationIds(client, user, boundary.resolvedAt, 500, boundary.id);
        expect(second).toHaveLength(3);
        expect([...first, ...second].map((row) => row.id)).toEqual(expected);
        expect([...first, ...second].every((row) => row.resolvedAt === boundary.resolvedAt)).toBe(true);
        expect(await listResolvedNotificationIds(client, user, boundary.resolvedAt, 500)).toEqual([]);
        expect(await listResolvedNotificationIds(client, user, "2025-01-01T00:00:00.123000Z", 1)).toEqual([first[0]]);
        expect(
          await listResolvedNotificationIds(client, user, second.at(-1)!.resolvedAt, 500, second.at(-1)!.id),
        ).toEqual([]);
        expect([...first, ...second].map((row) => row.id)).not.toContain(foreign[0]);
        expect([...first, ...second].map((row) => row.id)).not.toContain(unresolved);
        const before = await client.query<{ value: string }>(
          "SELECT to_char(($1::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value",
          [boundary.resolvedAt],
        );
        expect(await listResolvedNotificationIds(client, user, before.rows[0]!.value, 1)).toEqual([first[0]]);
      });
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await runtime.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Resolved notification test and cleanup failed");
  });

  describe("listUnreadNotificationsForUser", () => {
    it("projects legacy and current mail stalls safely without rewriting stored payloads or other kinds", async () => {
      const userId = await createTestUser();
      const mailboxItemId = randomUUID();
      const marker = "synthetic provider secret";
      const payloads = [
        { mailboxItemId, lastError: marker },
        { mailboxItemId, reason: "connectionLimit", lastError: marker, extra: marker },
        { mailboxItemId, reason: marker },
      ];
      const ids: string[] = [];
      for (const [index, payload] of payloads.entries()) {
        ids.push(
          await inTenantZero(() =>
            withTransaction(pool, (client) =>
              writeNotification(client, {
                userId,
                kind: "mail_sync_stalled",
                linkHref: null,
                sourceTable: "tenant_observability_checks",
                sourceId: randomUUID(),
                transitionInstance: `legacy-${index}`,
                payload,
              }),
            ),
          ),
        );
      }
      const otherId = await inTenantZero(() =>
        withTransaction(pool, (client) =>
          writeNotification(client, {
            userId,
            kind: "heartbeat_error",
            titleParams: { name: "fixture" },
            linkHref: null,
            sourceTable: "project_heartbeats",
            sourceId: randomUUID(),
            transitionInstance: "other",
            payload: { lastError: marker },
          }),
        ),
      );
      for (const [index, id] of ids.entries()) {
        expect((await getNotificationById(pool, id))?.payload).toEqual({
          mailboxItemId,
          reason: index === 1 ? "connectionLimit" : "other",
        });
        const stored = await pool.query<{ payload: unknown }>("SELECT payload FROM notifications WHERE id = $1", [id]);
        expect(stored.rows[0]?.payload).toEqual(payloads[index]);
      }
      expect((await getNotificationById(pool, otherId))?.payload).toEqual({ lastError: marker });
      expect(
        (await listUnreadNotificationsForUser(pool, userId)).filter((row) => row.kind === "mail_sync_stalled"),
      ).toHaveLength(3);
    });

    it("rejects an invalid mailbox id without echoing its value", async () => {
      const userId = await createTestUser();
      const secret = "invalid-private-mailbox-value";
      const id = await inTenantZero(() =>
        withTransaction(pool, (client) =>
          writeNotification(client, {
            userId,
            kind: "mail_sync_stalled",
            linkHref: null,
            sourceTable: "tenant_observability_checks",
            sourceId: randomUUID(),
            transitionInstance: "invalid",
            payload: { mailboxItemId: secret },
          }),
        ),
      );
      await expect(getNotificationById(pool, id)).rejects.toThrow("Invalid mail sync notification mailbox id");
      await expect(getNotificationById(pool, id)).rejects.not.toThrow(secret);
    });
    it.each([[null], [[]], ["invalid"], [1]])("refuses a malformed stored payload %j", async (payload) => {
      const userId = await createTestUser();
      await writeTestNotification(userId, "payload-test");
      const [row] = await listUnreadNotificationsForUser(pool, userId);
      if (!row) throw new Error("Missing notification fixture");
      // JSONB historically permits non-object values, which production writers do not create.
      await pool.query("UPDATE notifications SET payload = $2::jsonb WHERE id = $1", [row.id, JSON.stringify(payload)]);
      await expect(getNotificationById(pool, row.id)).rejects.toThrow("Invalid notification payload");
      await expect(listUnreadNotificationsForUser(pool, userId)).rejects.toThrow("Invalid notification payload");
    });
    it("returns only the caller's unread rows, ordered by creation then id", async () => {
      const userId = await createTestUser();
      const otherUserId = await createTestUser();

      await writeTestNotification(userId, "hb-1");
      await writeTestNotification(userId, "hb-2");
      await writeTestNotification(otherUserId, "hb-other");

      const unread = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));
      expect(unread.map((n) => n.sourceId)).toEqual(["hb-1", "hb-2"]);
    });

    it("returns the stored localized body through the list reader", async () => {
      const userId = await createTestUser();
      await withTransaction(pool, (client) =>
        writeNotification(client, {
          userId,
          kind: "heartbeat_error",
          titleParams: { name: "body" },
          bodyKey: "notification.body.canUndo",
          linkHref: null,
          sourceTable: "project_heartbeats",
          sourceId: "body",
          transitionInstance: "one",
        }),
      );
      const rows = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body).toBe("Lze ji později vzít zpět.");
    });

    it("excludes a notification once it has been read", async () => {
      const userId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      const [before] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));

      await withTransaction(pool, (client) => visitNotification(client, userId, before!.id));

      const after = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));
      expect(after).toHaveLength(0);
    });
  });

  describe("visitNotification", () => {
    it("marks an unread notification read and returns it", async () => {
      const userId = await createTestUser();
      await writeTestNotification(userId, "hb-1", "?page=heartbeats");
      const [unread] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));

      const visited = await withTransaction(pool, (client) => visitNotification(client, userId, unread!.id));
      expect(visited?.readAt).not.toBeNull();
      expect(visited?.linkHref).toBe("?page=heartbeats");
    });

    it("is idempotent: a repeat visit returns the same target without changing readAt", async () => {
      const userId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      const [unread] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));

      const first = await withTransaction(pool, (client) => visitNotification(client, userId, unread!.id));
      const second = await withTransaction(pool, (client) => visitNotification(client, userId, unread!.id));
      expect(second?.readAt).toBe(first?.readAt);
    });

    it("returns null for an unknown notification id", async () => {
      const userId = await createTestUser();
      const result = await withTransaction(pool, (client) =>
        visitNotification(client, userId, "00000000-0000-0000-0000-000000000000"),
      );
      expect(result).toBeNull();
    });

    it("returns null when the notification belongs to a different user", async () => {
      const userId = await createTestUser();
      const otherUserId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      const [unread] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));

      const result = await withTransaction(pool, (client) => visitNotification(client, otherUserId, unread!.id));
      expect(result).toBeNull();

      // The other user's mistaken attempt must not have marked it read.
      const stillUnread = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));
      expect(stillUnread).toHaveLength(1);
    });

    it("fires the read-state realtime hook only on the transition, not on a repeat visit", async () => {
      const userId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      const [unread] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));

      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      await withTransaction(pool, (client) => visitNotification(client, userId, unread!.id));
      await withTransaction(pool, (client) => visitNotification(client, userId, unread!.id));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ userId, notificationIds: [unread!.id] });
    });
  });

  describe("markAllNotificationsRead", () => {
    it("marks every unread notification for the user read and fires one realtime event", async () => {
      const userId = await createTestUser();
      const otherUserId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      await writeTestNotification(userId, "hb-2");
      await writeTestNotification(otherUserId, "hb-other");

      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      const updated = await withTransaction(pool, (client) => markAllNotificationsRead(client, userId));
      expect(updated).toHaveLength(2);
      expect(events).toHaveLength(1);
      expect(events[0]!.userId).toBe(userId);
      expect(new Set(events[0]!.notificationIds)).toEqual(new Set(updated.map((n) => n.id)));

      const otherUnread = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, otherUserId));
      expect(otherUnread).toHaveLength(1);
    });

    it("fires no realtime event and returns an empty list when there is nothing unread", async () => {
      const userId = await createTestUser();
      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      const updated = await withTransaction(pool, (client) => markAllNotificationsRead(client, userId));
      expect(updated).toEqual([]);
      expect(events).toHaveLength(0);
    });
  });

  describe("approval decisions resolve their notification (issue #1463)", () => {
    async function createApprovalWithNotification(userId: string) {
      const run = await createAgentRun(pool, {
        triggeredBy: "user",
        task: "test",
        projectItemId: randomUUID(),
        userId,
      });
      const request = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "search_web",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });
      await withTenantTransaction(pool, tenantOfUser.get(userId)!, (client) =>
        writeNotification(client, {
          userId,
          kind: "approval_pending",
          titleParams: { name: "search_web" },
          linkHref: null,
          sourceTable: "approval_requests",
          sourceId: request.id,
          transitionInstance: "pending",
        }),
      );
      return request;
    }

    async function stateOf(sourceId: string) {
      const { rows } = await pool.query<{ read_at: Date | null; resolved_at: Date | null }>(
        "SELECT read_at, resolved_at FROM notifications WHERE source_id = $1",
        [sourceId],
      );
      return rows;
    }

    function decide(userId: string, approvalRequestId: string, fail = false) {
      return inTenantZero(() =>
        withTransaction(pool, async (client) => {
          const result = await decideAndEnqueueApprovalRequest(client, {
            approvalRequestId,
            decision: "rejected",
            decidedByUserId: userId,
          });
          if (fail) throw new Error("rollback");
          return result;
        }),
      );
    }

    it("resolves and reads the notification and publishes one read-state event", async () => {
      const userId = await createTestUser();
      const request = await createApprovalWithNotification(userId);
      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      const result = await decide(userId, request.id);

      expect(result!.outcome).toBe("decided");
      const [row] = await stateOf(request.id);
      expect(row!.resolved_at).not.toBeNull();
      expect(row!.read_at).not.toBeNull();
      expect(events).toHaveLength(1);
      expect(events[0]!.userId).toBe(userId);
      expect(events[0]!.notificationIds).toHaveLength(1);
    });

    it("changes nothing and sends no event when the decision is replayed", async () => {
      const userId = await createTestUser();
      const request = await createApprovalWithNotification(userId);
      await decide(userId, request.id);
      const before = await stateOf(request.id);
      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      const replay = await decide(userId, request.id);

      expect(replay!.outcome).toBe("unchanged");
      expect(await stateOf(request.id)).toEqual(before);
      expect(events).toHaveLength(0);
    });

    it("serializes competing resolutions of the same source and emits one event", async () => {
      const userId = await createTestUser();
      const request = await createApprovalWithNotification(userId);
      const tenant = getTenantZeroId();
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));
      let releaseHolder: () => void = () => {};
      let holderReady: (pid: number) => void = () => {};
      let competitorReady: (pid: number) => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holderPid = new Promise<number>((resolve) => {
        holderReady = resolve;
      });
      const competitorPid = new Promise<number>((resolve) => {
        competitorReady = resolve;
      });
      async function bounded<T>(promise: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Barrier timed out")), 5000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      const holder = withTenantTransaction(runtimePool, tenant, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing holder PID");
        const rows = await resolveNotificationsBySource(client, {
          sourceTable: "approval_requests",
          sourceId: request.id,
        });
        holderReady(pid);
        await barrier;
        return rows;
      });
      const holderSettled = Promise.allSettled([holder]);
      let competitorSettled: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        const firstPid = await bounded(
          Promise.race([
            holderPid,
            holder.then(() => {
              throw new Error("Holder ended before barrier");
            }),
          ]),
        );
        const competitor = withTenantTransaction(runtimePool, tenant, async (client) => {
          const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          if (pid === undefined) throw new Error("Missing competitor PID");
          competitorReady(pid);
          return resolveNotificationsBySource(client, { sourceTable: "approval_requests", sourceId: request.id });
        });
        competitorSettled = Promise.allSettled([competitor]);
        const secondPid = await bounded(
          Promise.race([
            competitorPid,
            competitor.then(() => {
              throw new Error("Competitor ended before blocking");
            }),
          ]),
        );
        await vi.waitFor(
          async () => {
            const { rows } = await pool.query<{ blocked: boolean }>(
              "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
              [firstPid, secondPid],
            );
            expect(rows[0]?.blocked).toBe(true);
          },
          { timeout: 5000, interval: 20 },
        );
        releaseHolder();
        expect(await holder).toHaveLength(1);
        expect(await competitor).toHaveLength(0);
        expect(events).toHaveLength(1);
        expect(events[0]?.userId).toBe(userId);
      } finally {
        releaseHolder();
        await holderSettled;
        await competitorSettled;
        await runtimePool.end();
      }
    });

    it("leaves the notification unresolved when the decision transaction rolls back", async () => {
      const userId = await createTestUser();
      const request = await createApprovalWithNotification(userId);
      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      await expect(decide(userId, request.id, true)).rejects.toThrow("rollback");

      expect(await stateOf(request.id)).toEqual([{ read_at: null, resolved_at: null }]);
      expect(events).toHaveLength(0);
    });

    it("resolves only the named source, across users, and keeps an already read row's readAt", async () => {
      const userId = await createTestUser();
      const otherUserId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      await writeTestNotification(otherUserId, "hb-1");
      await writeTestNotification(userId, "hb-2");
      const [first] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));
      await withTransaction(pool, (client) => visitNotification(client, userId, first!.id));
      const readAt = (await stateOf("hb-1")).find((row) => row.read_at)!.read_at;
      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      const resolved = await withTransaction(pool, (client) =>
        resolveNotificationsBySource(client, { sourceTable: "project_heartbeats", sourceId: "hb-1" }),
      );

      expect(resolved).toHaveLength(2);
      expect((await stateOf("hb-1")).every((row) => row.resolved_at && row.read_at)).toBe(true);
      expect((await stateOf("hb-1")).some((row) => row.read_at!.getTime() === readAt!.getTime())).toBe(true);
      expect(await stateOf("hb-2")).toEqual([{ read_at: null, resolved_at: null }]);
      expect(events).toHaveLength(1);
      expect(events[0]!.userId).toBe(otherUserId);
    });

    it.each([
      ["different", "source-b"],
      ["same", "source-a"],
    ])("resolves a tenant's source without changing another tenant's %s source", async (_label, foreignSource) => {
      const userA = await createTestUser();
      const userB = await createTestUser();
      const tenantA = tenantOfUser.get(userA);
      const tenantB = tenantOfUser.get(userB);
      if (!tenantA || !tenantB) throw new Error("Missing tenant fixture");
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const write = (tenant: string, userId: string, sourceId: string) =>
          withTenantTransaction(runtimePool, tenant, (client) =>
            writeNotification(client, {
              userId,
              kind: "heartbeat_error",
              titleParams: { name: sourceId },
              linkHref: null,
              sourceTable: "project_heartbeats",
              sourceId,
              transitionInstance: "job-1",
            }),
          );
        const a = await write(tenantA, userA, "source-a");
        const b = await write(tenantB, userB, foreignSource);
        const events: NotificationReadStateEvent[] = [];
        setNotificationReadStateHook((event) => events.push(event));
        const resolved = await withTenantTransaction(runtimePool, tenantA, (client) =>
          resolveNotificationsBySource(client, { sourceTable: "project_heartbeats", sourceId: "source-a" }),
        );
        expect(resolved).toHaveLength(1);
        const own = await withTenantTransaction(runtimePool, tenantA, (client) => getNotificationById(client, a));
        const foreign = await withTenantTransaction(runtimePool, tenantB, (client) => getNotificationById(client, b));
        expect(own).toMatchObject({ id: a, readAt: expect.any(String), resolvedAt: expect.any(String) });
        expect(foreign).toMatchObject({ id: b, readAt: null, resolvedAt: null });
        expect(events).toEqual([expect.objectContaining({ userId: userA, notificationIds: [a] })]);
        const second = await withTenantTransaction(runtimePool, tenantB, (client) =>
          resolveNotificationsBySource(client, { sourceTable: "project_heartbeats", sourceId: foreignSource }),
        );
        expect(second).toHaveLength(1);
        expect(
          await withTenantTransaction(runtimePool, tenantB, (client) => getNotificationById(client, b)),
        ).toMatchObject({
          id: b,
          readAt: expect.any(String),
          resolvedAt: expect.any(String),
        });
        expect(await withTenantTransaction(runtimePool, tenantA, (client) => getNotificationById(client, a))).toEqual(
          own,
        );
        expect(events).toEqual([
          expect.objectContaining({ userId: userA, notificationIds: [a] }),
          expect.objectContaining({ userId: userB, notificationIds: [b] }),
        ]);
      } finally {
        await runtimePool.end();
      }
    });
  });
});
