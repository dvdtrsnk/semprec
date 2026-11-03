import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RISK_CLASSES, runInTenant } from "@semprec/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createTenantZeroUser,
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createUser as createRawUser } from "../auth/usersStore.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { withTransaction } from "../db/pool.js";
import { getOrCreateTickThread } from "../semp/sempTickThreadStore.js";
import {
  type ApprovalDescription,
  createPendingApprovalRequest,
  getApprovalRequest,
  getApprovalRequestForOwner,
  decideApprovalRequest,
  listPendingApprovalRequests,
  claimApprovalRequestExecution,
  recordApprovalRequestOutcome,
} from "../mcp/approvalRequestsStore.js";

let pool: Pool;
let ownerId: string;

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

async function createPendingRequest(): Promise<string> {
  const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
  const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { query: "hi" } };
  const created = await createPendingApprovalRequest(pool, {
    agentRunId: run.id,
    toolName: "search_web",
    riskClass: "unclassified",
    payload,
    resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
  });
  return created.id;
}

describe("approvalRequestsStore reason (issue #1420)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    ownerId = await createUser();
  });

  async function insertWithReason(reason: string | null | undefined) {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    return createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "search_web",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      ...(reason === undefined ? {} : { reason }),
    });
  }

  it("stores the reason and reads it back", async () => {
    const created = await insertWithReason("You last filled in Mood in August.");
    expect(created.reason).toBe("You last filled in Mood in August.");
    expect((await getApprovalRequest(pool, created.id))!.reason).toBe("You last filled in Mood in August.");
  });

  it("reads null when no reason was given", async () => {
    expect((await insertWithReason(undefined)).reason).toBeNull();
    expect((await insertWithReason(null)).reason).toBeNull();
  });

  it("accepts a reason of exactly 500 characters and rejects 501 at the database", async () => {
    expect((await insertWithReason("x".repeat(500))).reason).toHaveLength(500);
    await expect(insertWithReason("x".repeat(501))).rejects.toThrow(/approval_requests_reason_length_check/);
  });
});

describe("approval_requests.risk_class closed set (issue #1423)", () => {
  const migrationSql = readFileSync(
    fileURLToPath(new URL("../db/migrations/0094_approval_requests_risk_class_check.sql", import.meta.url)),
    "utf8",
  );

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    ownerId = await createUser();
  });

  async function insertRaw(riskClass: string): Promise<string> {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO approval_requests (agent_run_id, tool_name, risk_class, payload, resource_snapshot)
       VALUES ($1, 'search_web', $2, '{}'::jsonb, '{"kind":"test","resourceId":"test","sha256":null}'::jsonb) RETURNING id`,
      [run.id, riskClass],
    );
    return rows[0]!.id;
  }

  it("rejects an unknown class at the database", async () => {
    await expect(insertRaw("high")).rejects.toThrow(/approval_requests_risk_class_check/);
    for (const value of RISK_CLASSES) await insertRaw(value);
  });

  it("backfills a legacy unknown class to unclassified when the migration runs", async () => {
    await pool.query("ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_risk_class_check");
    const legacyId = await insertRaw("high");
    const knownId = await insertRaw("destructive");

    await pool.query(migrationSql);

    expect((await getApprovalRequest(pool, legacyId))!.riskClass).toBe("unclassified");
    expect((await getApprovalRequest(pool, knownId))!.riskClass).toBe("destructive");
    await expect(insertRaw("high")).rejects.toThrow(/approval_requests_risk_class_check/);
  });
});

describe("approvalRequestsStore toolCallId (issue #1618)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    ownerId = await createUser();
  });

  async function insert(agentRunId: string, toolCallId?: string | null) {
    return createPendingApprovalRequest(pool, {
      agentRunId,
      toolName: "search_web",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      ...(toolCallId === undefined ? {} : { toolCallId }),
    });
  }

  it("stores the tool call id and reads it back", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const created = await insert(run.id, "call_1");
    expect(created.toolCallId).toBe("call_1");
    expect((await getApprovalRequest(pool, created.id))!.toolCallId).toBe("call_1");
  });

  it("leaves tool_call_id NULL when none is supplied, and allows several such requests per run", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const first = await insert(run.id);
    const second = await insert(run.id, null);
    expect(first.toolCallId).toBeNull();
    expect(second.toolCallId).toBeNull();
    expect(second.id).not.toBe(first.id);
  });

  it("returns the existing request for a repeated (run, tool call id) and keeps one row", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const first = await insert(run.id, "call_1");
    const again = await insert(run.id, "call_1");
    expect(again.id).toBe(first.id);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM approval_requests WHERE agent_run_id = $1", [
      run.id,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it("deduplicates overlapping requests under the tenant runtime role", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const input = {
      agentRunId: run.id,
      toolName: "search_web",
      riskClass: "unclassified" as const,
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      toolCallId: "overlap",
    };
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reportHolder = (_pid: number) => {};
    let reportContender = (_pid: number) => {};
    const holderReady = new Promise<number>((resolve) => {
      reportHolder = resolve;
    });
    const contenderReady = new Promise<number>((resolve) => {
      reportContender = resolve;
    });
    const bounded = async <T>(promise: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Approval overlap coordination timed out")), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const holder = runInTenant(getTenantZeroId(), () =>
      withTransaction(runtime, async (client) => {
        await client.query("SET LOCAL statement_timeout = '5s'");
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing holder PID");
        const result = await createPendingApprovalRequest(client, input);
        reportHolder(pid);
        await gate;
        return result;
      }),
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let contender:
      Promise<{ value: Awaited<ReturnType<typeof createPendingApprovalRequest>> } | { error: unknown }> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const first = await bounded(
        Promise.race([holderReady.then((pid) => ({ pid })), holder.then((outcome) => ({ outcome }))]),
      );
      if ("outcome" in first) throw new Error("Holder settled before overlap", { cause: first.outcome });
      contender = runInTenant(getTenantZeroId(), () =>
        withTransaction(runtime, async (client) => {
          await client.query("SET LOCAL statement_timeout = '5s'");
          const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          if (pid === undefined) throw new Error("Missing contender PID");
          reportContender(pid);
          return createPendingApprovalRequest(client, input);
        }),
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const second = await bounded(
        Promise.race([contenderReady.then((pid) => ({ pid })), contender.then((outcome) => ({ outcome }))]),
      );
      if ("outcome" in second) throw new Error("Contender settled before overlap", { cause: second.outcome });
      let blocked = false;
      const deadline = Date.now() + 2500;
      while (!blocked && Date.now() < deadline) {
        const observed = await pool.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [first.pid, second.pid],
        );
        blocked = observed.rows[0]?.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } catch (error) {
      failure = { error };
    }
    release();
    const outcomes = await Promise.all([holder, ...(contender ? [contender] : [])]);
    const errors: unknown[] = outcomes.flatMap((outcome) => ("error" in outcome ? [outcome.error] : []));
    try {
      await runtime.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(failure ? [failure.error, ...errors] : errors, "Approval overlap failed");
    if (failure) throw failure.error;
    const [first, second] = outcomes;
    if (!first || !second || !("value" in first) || !("value" in second)) throw new Error("Missing overlap results");
    expect(second.value.id).toBe(first.value.id);
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM approval_requests WHERE agent_run_id = $1 AND tool_call_id = $2",
      [run.id, input.toolCallId],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("creates separate requests for the same tool call id in different runs or different ids in one run", async () => {
    const runA = await createAgentRun(pool, { triggeredBy: "user", task: "a", userId: ownerId });
    const runB = await createAgentRun(pool, { triggeredBy: "user", task: "b", userId: ownerId });
    const a1 = await insert(runA.id, "call_1");
    const b1 = await insert(runB.id, "call_1");
    const a2 = await insert(runA.id, "call_2");
    expect(new Set([a1.id, b1.id, a2.id]).size).toBe(3);
  });
});

describe("approvalRequestsStore description (issue #1683)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    ownerId = await createUser();
  });

  async function insert(runId: string, description?: ApprovalDescription) {
    return createPendingApprovalRequest(pool, {
      agentRunId: runId,
      toolName: "search_web",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      ...(description === undefined ? {} : { description }),
    });
  }

  it("stores the description and reads it back", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const description: ApprovalDescription = {
      key: "approval.viewDelete",
      params: { viewName: "Open", databaseName: null, count: 3 },
    };
    const created = await insert(run.id, description);
    expect(created.description).toEqual(description);
    expect((await getApprovalRequest(pool, created.id))!.description).toEqual(description);
  });

  it("returns null for a row without a description and leaves every other field unchanged", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const created = await insert(run.id);
    await pool.query(`UPDATE approval_requests SET description = NULL WHERE id = $1`, [created.id]);
    const read = await getApprovalRequest(pool, created.id);
    expect(read).toEqual(created);
    expect(read!.description).toBeNull();
    expect(read!.toolName).toBe("search_web");
  });

  it.each([
    ["a non-object", "approval.x"],
    ["a missing key", { params: {} }],
    ["missing params", { key: "approval.x" }],
    ["a nested param value", { key: "approval.x", params: { a: { b: 1 } } }],
    ["a malformed endsInheritance", { key: "approval.x", params: {}, endsInheritance: [{ itemId: 1 }] }],
  ])("rejects a row whose description is %s", async (_label, description) => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const created = await insert(run.id);
    await pool.query(`UPDATE approval_requests SET description = $2::jsonb WHERE id = $1`, [
      created.id,
      JSON.stringify(description),
    ]);
    await expect(getApprovalRequest(pool, created.id)).rejects.toThrow("Malformed description in database row");
  });
});

describe("approvalRequestsStore thread activity (issue #1728)", () => {
  const OLD = "2020-01-01T00:00:00Z";

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    ownerId = await createUser();
  });

  async function insertThread(activityAt = OLD): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO semp_threads (kind, last_activity_at) VALUES ('chat', $1) RETURNING id",
      [activityAt],
    );
    return rows[0]!.id;
  }

  async function activity(threadId: string): Promise<number> {
    const { rows } = await pool.query<{ t: Date }>("SELECT last_activity_at AS t FROM semp_threads WHERE id = $1", [
      threadId,
    ]);
    return rows[0]!.t.getTime();
  }

  function genericPayload(runId: string) {
    return {
      operationName: "deleteView",
      canonicalInput: {},
      actor: { runId, agentProjectItemId: randomUUID(), userId: ownerId },
      resourceSnapshot: { kind: "view", resourceId: "v", sha256: null },
    };
  }

  function mcpPayload() {
    return { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} };
  }

  it.each([
    ["generic operation", true],
    ["MCP tool call", false],
  ])("raises the thread's activity to the creation time for a %s request", async (_label, generic) => {
    const threadId = await insertThread();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "t", userId: ownerId, threadId });
    const before = Date.now();
    await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "tool",
      riskClass: "unclassified",
      payload: generic ? genericPayload(run.id) : mcpPayload(),
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    expect(await activity(threadId)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("leaves every thread untouched for a run without a thread", async () => {
    const threadId = await insertThread();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "t", userId: ownerId });
    await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "tool",
      riskClass: "unclassified",
      payload: mcpPayload(),
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    expect(await activity(threadId)).toBe(new Date(OLD).getTime());
  });

  it("leaves the activity unchanged when the request transaction rolls back", async () => {
    const threadId = await insertThread();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "t", userId: ownerId, threadId });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await createPendingApprovalRequest(client, {
        agentRunId: run.id,
        toolName: "tool",
        riskClass: "unclassified",
        payload: mcpPayload(),
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await activity(threadId)).toBe(new Date(OLD).getTime());
  });

  it("bumps the thread a delegated run is linked to", async () => {
    const threadId = await insertThread();
    const parent = await createAgentRun(pool, { triggeredBy: "user", task: "t", userId: ownerId, threadId });
    const child = await createAgentRun(pool, { triggeredBy: "supervisor", task: "sub", parentRunId: parent.id });
    await createPendingApprovalRequest(pool, {
      agentRunId: child.id,
      toolName: "tool",
      riskClass: "unclassified",
      payload: mcpPayload(),
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    expect(await activity(threadId)).toBeGreaterThan(new Date(OLD).getTime());
  });

  it("raises the persisted activity of the requesting tick thread", async () => {
    const heartbeats = await withTransaction(pool, (client) =>
      client.query<{ id: string; project_item_id: string }>(
        "SELECT id, project_item_id FROM project_heartbeats WHERE action_id = 'core.agentRun' LIMIT 1",
      ),
    );
    const heartbeat = heartbeats.rows[0];
    if (!heartbeat) throw new Error("Missing seeded agent heartbeat");
    const thread = await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) => getOrCreateTickThread(client, heartbeat.id)),
    );
    // The public tick writer cannot set a historical activity timestamp.
    const reset = await withTransaction(pool, (client) =>
      client.query("UPDATE semp_threads SET last_activity_at = $2 WHERE id = $1", [thread.id, OLD]),
    );
    expect(reset.rowCount).toBe(1);
    const run = await createAgentRun(pool, {
      triggeredBy: "heartbeat",
      task: "tick",
      userId: ownerId,
      threadId: thread.id,
      heartbeatId: heartbeat.id,
      projectItemId: heartbeat.project_item_id,
    });
    const request = await withTransaction(pool, (client) =>
      createPendingApprovalRequest(client, {
        agentRunId: run.id,
        toolName: "tool",
        riskClass: "unclassified",
        payload: mcpPayload(),
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      }),
    );
    const rows = await withTransaction(pool, (client) =>
      client.query<{ activity: Date; requested: Date; kind: string }>(
        "SELECT t.last_activity_at AS activity, t.kind, r.requested_at AS requested FROM semp_threads t JOIN approval_requests r ON r.id = $2 WHERE t.id = $1",
        [thread.id, request.id],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.kind).toBe("tick");
    expect(rows.rows[0]!.activity.getTime()).toBe(rows.rows[0]!.requested.getTime());
    expect(rows.rows[0]!.activity.getTime()).toBeGreaterThan(new Date(OLD).getTime());
  });

  it("never moves activity backwards when a newer activity committed after the transaction started", async () => {
    const threadId = await insertThread();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "t", userId: ownerId, threadId });
    const client = await pool.connect();
    const future = new Date(Date.now() + 3_600_000);
    try {
      await client.query("BEGIN");
      await client.query("SELECT now()"); // fixes the transaction start time
      await pool.query("UPDATE semp_threads SET last_activity_at = $2 WHERE id = $1", [threadId, future]);
      await createPendingApprovalRequest(client, {
        agentRunId: run.id,
        toolName: "tool",
        riskClass: "unclassified",
        payload: mcpPayload(),
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await activity(threadId)).toBe(future.getTime());
  });

  it("preserves later committed activity when an older request waits on the thread row", async () => {
    const threadId = await insertThread();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "t", userId: ownerId, threadId });
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let startRequest = () => {};
    let finishUpdate = () => {};
    let reportOld = (_pid: number) => {};
    let reportNew = (_pid: number) => {};
    const requestGate = new Promise<void>((resolve) => {
      startRequest = resolve;
    });
    const updateGate = new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    const oldReady = new Promise<number>((resolve) => {
      reportOld = resolve;
    });
    const newReady = new Promise<number>((resolve) => {
      reportNew = resolve;
    });
    const bounded = async <T>(promise: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Activity overlap coordination timed out")), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const future = new Date(Date.now() + 3_600_000);
    const old = runInTenant(getTenantZeroId(), () =>
      withTransaction(runtime, async (client) => {
        await client.query("SET LOCAL statement_timeout = '5s'");
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid, now()")).rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing request PID");
        reportOld(pid);
        await requestGate;
        return createPendingApprovalRequest(client, {
          agentRunId: run.id,
          toolName: "tool",
          riskClass: "unclassified",
          payload: mcpPayload(),
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
      }),
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let newer: Promise<{ value: void } | { error: unknown }> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const first = await bounded(
        Promise.race([oldReady.then((pid) => ({ pid })), old.then((outcome) => ({ outcome }))]),
      );
      if ("outcome" in first) throw new Error("Request ended before overlap", { cause: first.outcome });
      newer = runInTenant(getTenantZeroId(), () =>
        withTransaction(runtime, async (client) => {
          await client.query("SET LOCAL statement_timeout = '5s'");
          const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          if (pid === undefined) throw new Error("Missing update PID");
          const updated = await client.query("UPDATE semp_threads SET last_activity_at = $2 WHERE id = $1", [
            threadId,
            future,
          ]);
          expect(updated.rowCount).toBe(1);
          reportNew(pid);
          await updateGate;
        }),
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const second = await bounded(
        Promise.race([newReady.then((pid) => ({ pid })), newer.then((outcome) => ({ outcome }))]),
      );
      if ("outcome" in second) throw new Error("Update ended before overlap", { cause: second.outcome });
      startRequest();
      let blocked = false;
      const deadline = Date.now() + 2500;
      while (!blocked && Date.now() < deadline) {
        const observed = await pool.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [second.pid, first.pid],
        );
        blocked = observed.rows[0]?.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } catch (error) {
      failure = { error };
    }
    startRequest();
    finishUpdate();
    const outcomes = await Promise.all([old, ...(newer ? [newer] : [])]);
    const errors: unknown[] = outcomes.flatMap((outcome) => ("error" in outcome ? [outcome.error] : []));
    try {
      await runtime.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(failure ? [failure.error, ...errors] : errors, "Activity overlap failed");
    if (failure) throw failure.error;
    expect(outcomes).toHaveLength(2);
    expect(await activity(threadId)).toBe(future.getTime());
  });
});

describe("approvalRequestsStore (issue #130)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    ownerId = await createUser();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates a pending request that snapshots the invocation and can be read back", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { query: "hi" } };

    const created = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "search_web",
      riskClass: "unclassified",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });

    expect(created.status).toBe("pending");
    expect(created.decidedAt).toBeNull();
    expect(created.decidedBy).toBeNull();
    expect(created.agentRunId).toBe(run.id);
    expect(created.toolName).toBe("search_web");
    expect(created.riskClass).toBe("unclassified");
    expect(created.payload).toEqual(payload);

    const fetched = await getApprovalRequest(pool, created.id);
    expect(fetched).toEqual(created);
  });

  it("returns null for an unknown id", async () => {
    expect(await getApprovalRequest(pool, randomUUID())).toBeNull();
  });

  describe("resource_snapshot shape at the read boundary", () => {
    it("reads back a snapshot whose sha256 is null", async () => {
      const id = await createPendingRequest();
      await pool.query(`UPDATE approval_requests SET resource_snapshot = $2 WHERE id = $1`, [
        id,
        JSON.stringify({ kind: "item", resourceId: "item-1", sha256: null }),
      ]);

      const read = await getApprovalRequest(pool, id);
      expect(read?.resourceSnapshot).toEqual({ kind: "item", resourceId: "item-1", sha256: null });
    });

    it("reads back a snapshot that carries a sha256", async () => {
      const id = await createPendingRequest();
      await pool.query(`UPDATE approval_requests SET resource_snapshot = $2 WHERE id = $1`, [
        id,
        JSON.stringify({ kind: "item", resourceId: "item-1", sha256: "abc" }),
      ]);

      const read = await getApprovalRequest(pool, id);
      expect(read?.resourceSnapshot).toEqual({ kind: "item", resourceId: "item-1", sha256: "abc" });
    });

    it.each([
      ["a JSON null", null],
      ["a non-object", "item-1"],
      ["a missing kind", { resourceId: "item-1", sha256: null }],
      ["a non-string resourceId", { kind: "item", resourceId: 1, sha256: null }],
      ["a missing sha256", { kind: "item", resourceId: "item-1" }],
      ["a non-string sha256", { kind: "item", resourceId: "item-1", sha256: 1 }],
    ])("rejects a row whose snapshot is %s instead of passing it through", async (_label, snapshot) => {
      const id = await createPendingRequest();
      await pool.query(`UPDATE approval_requests SET resource_snapshot = $2::jsonb WHERE id = $1`, [
        id,
        JSON.stringify(snapshot),
      ]);

      await expect(getApprovalRequest(pool, id)).rejects.toThrow("Malformed resource_snapshot in database row");
    });
  });

  describe("decideApprovalRequest (issue #131)", () => {
    it("transitions a pending request to approved and records who/when", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;

      const decided = await decideApprovalRequest(pool, id, "approved", userId);

      expect(decided).not.toBeNull();
      expect(decided!.status).toBe("approved");
      expect(decided!.decidedBy).toBe(userId);
      expect(decided!.decidedAt).not.toBeNull();
    });

    it("transitions a pending request to rejected", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;

      const decided = await decideApprovalRequest(pool, id, "rejected", userId);

      expect(decided!.status).toBe("rejected");
    });

    it("returns null and makes no change for a request that is already decided", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;
      await decideApprovalRequest(pool, id, "approved", userId);

      const second = await decideApprovalRequest(pool, id, "rejected", ownerId);

      expect(second).toBeNull();
      const stored = await getApprovalRequest(pool, id);
      expect(stored!.status).toBe("approved");
      expect(stored!.decidedBy).toBe(userId);
    });

    it("returns null for an unknown id", async () => {
      const userId = ownerId;
      expect(await decideApprovalRequest(pool, randomUUID(), "approved", userId)).toBeNull();
    });

    it("only one of two concurrent decisions by the owner wins", async () => {
      const id = await createPendingRequest();

      const [a, b] = await Promise.all([
        decideApprovalRequest(pool, id, "approved", ownerId),
        decideApprovalRequest(pool, id, "rejected", ownerId),
      ]);

      const winners = [a, b].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      const stored = await getApprovalRequest(pool, id);
      expect(stored!.status).toBe(winners[0]!.status);
      expect(stored!.decidedBy).toBe(winners[0]!.decidedBy);
    });

    it("returns null and changes nothing when the decider is not the run's actor (issue #1028)", async () => {
      const id = await createPendingRequest();
      const foreignUser = await createUser();

      expect(await decideApprovalRequest(pool, id, "approved", foreignUser)).toBeNull();

      const stored = await getApprovalRequest(pool, id);
      expect(stored!.status).toBe("pending");
      expect(stored!.decidedBy).toBeNull();
    });

    it("returns null for a foreign caller even after the owner decided (issue #1028)", async () => {
      const id = await createPendingRequest();
      await decideApprovalRequest(pool, id, "approved", ownerId);

      expect(await decideApprovalRequest(pool, id, "rejected", await createUser())).toBeNull();
      expect((await getApprovalRequest(pool, id))!.decidedBy).toBe(ownerId);
    });

    it("getApprovalRequestForOwner returns the row only for its run's actor (issue #1028)", async () => {
      const id = await createPendingRequest();

      expect((await getApprovalRequestForOwner(pool, id, ownerId))!.id).toBe(id);
      expect(await getApprovalRequestForOwner(pool, id, await createUser())).toBeNull();
    });

    it("listPendingApprovalRequests returns only the owner's pending requests (issue #1028)", async () => {
      const ownRequestId = await createPendingRequest();
      // Another account's run lives in that account's own tenant: a run's actor must be its own
      // tenant's user (agent_runs_actor_user_id_tenant_fkey, issue #1066).
      const foreignTenant = await createTestTenant(pool);
      const foreignUser = await createRawUser(pool, {
        email: `${randomUUID()}@example.com`,
        passwordHash: "unused",
        tenantId: foreignTenant,
      });
      await withTenantTransaction(pool, foreignTenant, async (client) => {
        const foreignRun = await createAgentRun(client, { triggeredBy: "user", task: "other", userId: foreignUser.id });
        await createPendingApprovalRequest(client, {
          agentRunId: foreignRun.id,
          toolName: "search_web",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
      });

      const ids = (await listPendingApprovalRequests(pool, ownerId)).map((request) => request.id);

      expect(ids).toEqual([ownRequestId]);
    });
  });

  describe("claimApprovalRequestExecution / recordApprovalRequestOutcome (issue #131)", () => {
    it("claims an approved, unexecuted request exactly once", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;
      await decideApprovalRequest(pool, id, "approved", userId);

      const first = await claimApprovalRequestExecution(pool, id);
      const second = await claimApprovalRequestExecution(pool, id);

      expect(first).not.toBeNull();
      expect(first!.executedAt).not.toBeNull();
      expect(second).toBeNull();
    });

    it("does not claim a pending or rejected request", async () => {
      const pendingId = await createPendingRequest();
      expect(await claimApprovalRequestExecution(pool, pendingId)).toBeNull();

      const rejectedId = await createPendingRequest();
      const userId = ownerId;
      await decideApprovalRequest(pool, rejectedId, "rejected", userId);
      expect(await claimApprovalRequestExecution(pool, rejectedId)).toBeNull();
    });

    it("records the execution outcome on the claimed row", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;
      await decideApprovalRequest(pool, id, "approved", userId);
      await claimApprovalRequestExecution(pool, id);

      await recordApprovalRequestOutcome(pool, id, { error: false, result: "ok" });

      const stored = await getApprovalRequest(pool, id);
      expect(stored!.executionError).toBe(false);
      expect(stored!.executionResult).toBe("ok");
      expect(stored!.executionStatus).toBe("succeeded");
    });

    it("records a failed outcome as 'conflict', not 'succeeded' (issue #89)", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;
      await decideApprovalRequest(pool, id, "approved", userId);
      await claimApprovalRequestExecution(pool, id);

      await recordApprovalRequestOutcome(pool, id, { error: true, result: "it broke" });

      const stored = await getApprovalRequest(pool, id);
      expect(stored!.executionError).toBe(true);
      expect(stored!.executionResult).toBe("it broke");
      expect(stored!.executionStatus).toBe("conflict");
    });

    it("round-trips classified MCP failures and refuses malformed metadata", async () => {
      const id = await createPendingRequest();
      await decideApprovalRequest(pool, id, "approved", ownerId);
      await claimApprovalRequestExecution(pool, id);
      const failure = { failureKind: "timeout" as const, mcpServerItemId: randomUUID(), timeoutMs: 60000 };
      await recordApprovalRequestOutcome(pool, id, {
        error: true,
        result: "failed",
        outcomeKind: "callFailed",
        failure,
      });
      expect((await getApprovalRequest(pool, id))?.executionResult).toEqual({
        text: "failed",
        outcomeKind: "callFailed",
        failure,
      });
      await pool.query("UPDATE approval_requests SET execution_result_jsonb = $2::jsonb WHERE id = $1", [
        id,
        JSON.stringify({
          text: "failed",
          failure: { failureKind: "timeout", mcpServerItemId: "x", timeoutMs: "secret" },
        }),
      ]);
      await expect(getApprovalRequest(pool, id)).rejects.toThrow("Invalid MCP failure metadata");
      await pool.query("UPDATE approval_requests SET execution_result_jsonb = $2::jsonb WHERE id = $1", [
        id,
        JSON.stringify({
          text: "failed",
          failure: { failureKind: "timeout", mcpServerItemId: "not-a-uuid", timeoutMs: 60000 },
        }),
      ]);
      await expect(getApprovalRequest(pool, id)).rejects.toThrow("Invalid MCP failure metadata");
      await expect(
        recordApprovalRequestOutcome(pool, id, {
          error: true,
          result: "failed",
          // @ts-expect-error Exercise malformed data crossing the write boundary.
          failure: { failureKind: "timeout", timeoutMs: "secret" },
        }),
      ).rejects.toThrow("Invalid MCP failure metadata");
    });

    it("rejects failure metadata on successful MCP outcomes at write and read boundaries", async () => {
      const id = await createPendingRequest();
      await decideApprovalRequest(pool, id, "approved", ownerId);
      const failure = { failureKind: "auth" as const, mcpServerItemId: randomUUID() };
      await expect(recordApprovalRequestOutcome(pool, id, { error: false, result: "ok", failure })).rejects.toThrow(
        "Invalid MCP failure metadata",
      );
      expect((await getApprovalRequest(pool, id))?.executionStatus).toBe("queued");
      await pool.query(
        "UPDATE approval_requests SET execution_error = false, execution_result_jsonb = $2::jsonb WHERE id = $1",
        [id, JSON.stringify({ text: "ok", failure })],
      );
      await expect(getApprovalRequest(pool, id)).rejects.toThrow("Invalid MCP failure metadata");
    });

    it("preserves an existing generic-operation result with its own failure field", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
      const snapshot = { kind: "item.delete", resourceId: randomUUID(), sha256: null };
      const request = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "item.delete",
        riskClass: "destructive",
        payload: {
          operationName: "item.delete",
          canonicalInput: {},
          actor: { runId: run.id, agentProjectItemId: randomUUID(), userId: ownerId },
          resourceSnapshot: snapshot,
        },
        resourceSnapshot: snapshot,
      });
      const result = { failure: { legacy: "domain data" } };
      await pool.query("UPDATE approval_requests SET execution_result_jsonb = $2::jsonb WHERE id = $1", [
        request.id,
        JSON.stringify(result),
      ]);
      expect((await getApprovalRequest(pool, request.id))?.executionResult).toEqual(result);
      await pool.query(
        "UPDATE approval_requests SET payload = jsonb_set(payload, '{operationName}', $2::jsonb) WHERE id = $1",
        [request.id, JSON.stringify("legacy.retiredOperation")],
      );
      expect((await getApprovalRequest(pool, request.id))?.executionResult).toEqual(result);
    });

    it("rejects malformed payload discriminators and MCP fields before reading failure metadata", async () => {
      const id = await createPendingRequest();
      const server = randomUUID();
      const registration = randomUUID();
      const outcome = { text: "failed", failure: { failureKind: "auth", mcpServerItemId: server } };
      const malformed: unknown[] = [
        null,
        [],
        "text",
        { operationName: 4 },
        { operationName: "" },
        { mcpToolRegistrationId: "bad", mcpServerItemId: server, args: {} },
        { mcpToolRegistrationId: registration, mcpServerItemId: "bad", args: {} },
        { mcpToolRegistrationId: registration, mcpServerItemId: server, args: [] },
      ];
      for (const payload of malformed) {
        await pool.query(
          "UPDATE approval_requests SET payload = $2::jsonb, execution_error = true, execution_result_jsonb = $3::jsonb WHERE id = $1",
          [id, JSON.stringify(payload), JSON.stringify(outcome)],
        );
        await expect(getApprovalRequest(pool, id)).rejects.toThrow("Invalid approval outcome payload");
      }
      await pool.query("UPDATE approval_requests SET payload = $2::jsonb WHERE id = $1", [
        id,
        JSON.stringify({ mcpToolRegistrationId: registration, mcpServerItemId: server, args: {}, legacy: true }),
      ]);
      expect((await getApprovalRequest(pool, id))?.executionResult).toEqual(outcome);
    });
  });
});
