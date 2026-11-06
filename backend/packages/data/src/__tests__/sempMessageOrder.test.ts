import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { createPendingApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { decideAndEnqueueApprovalRequest } from "../mcp/approvalDecisionAction.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { finishTickRunWithMessage, getOrCreateTickThread } from "../semp/sempTickThreadStore.js";
import { getSempMessageFrontier, getSempMessageToken } from "../semp/sempMessagesStore.js";
import { createSempChatThread, sendSempMessage } from "../sempThreads/sempThreadsStore.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let other: string;
let userId: string;

describe("Semp thread message ordering", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:message-order-role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    other = await createTestTenant(admin);
    const user = await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
    });
    userId = user.id;
    await createUser(admin, { tenantId: other, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(pool));
  });
  afterAll(async () => {
    const results = await Promise.allSettled([pool.end(), admin.end()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Message order cleanup failed", { cause: errors[0] });
  });

  it("serializes all three writers after a future row and keeps rollback and tenant reads isolated", async () => {
    const fixture = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        if (!inbox?.ownerProjectItemId) throw new Error("Missing Semprec project");
        const heartbeat = await createHeartbeat(client, {
          projectItemId: inbox.ownerProjectItemId,
          name: "Ordering",
          rule: { kind: "interval", minutes: 10 },
          actionId: "core.agentRun",
        });
        const thread = await getOrCreateTickThread(client, heartbeat.id);
        const tickRun = await createAgentRun(client, {
          projectItemId: inbox.ownerProjectItemId,
          heartbeatId: heartbeat.id,
          triggeredBy: "heartbeat",
          task: "tick",
        });
        const approvalRun = await createAgentRun(client, {
          projectItemId: inbox.ownerProjectItemId,
          threadId: thread.id,
          triggeredBy: "user",
          unit: "session",
          task: "approval",
        });
        const request = await createPendingApprovalRequest(client, {
          agentRunId: approvalRun.id,
          toolName: "search_web",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
        // A future-dated legacy row cannot be emitted by the current allocator; it exercises clock-skew ordering.
        const future = await client.query<{ id: string }>(
          "INSERT INTO semp_messages (thread_id, role, text, created_at) VALUES ($1, 'assistant', 'future fixture', clock_timestamp() + interval '1 day') RETURNING id",
          [thread.id],
        );
        if (!future.rows[0]) throw new Error("Missing future fixture");
        return { thread, tickRunId: tickRun.id, requestId: request.id, futureId: future.rows[0].id };
      }),
    );
    let release!: () => void;
    let reserved!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reserved = resolve;
    });
    const completion: string[] = [];
    const sending = runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const turn = await sendSempMessage(client, {
          threadId: fixture.thread.id,
          text: "question",
          context: [],
          hasContext: false,
        });
        reserved();
        await gate;
        return turn;
      }),
    );
    let approval: Promise<void> | undefined;
    let tick: Promise<void> | undefined;
    let reportApprovalPid!: (pid: number) => void;
    let reportTickPid!: (pid: number) => void;
    const approvalPid = new Promise<number>((resolve) => {
      reportApprovalPid = resolve;
    });
    const tickPid = new Promise<number>((resolve) => {
      reportTickPid = resolve;
    });
    let first: Awaited<typeof sending> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      await Promise.race([
        ready,
        sending.then(() => {
          throw new Error("Send ended before reservation");
        }),
      ]);
      approval = runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          if (!identity.rows[0]) throw new Error("Missing approval backend identity");
          reportApprovalPid(identity.rows[0].pid);
          const result = await decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: fixture.requestId,
            decision: "rejected",
            decidedByUserId: userId,
          });
          expect(result?.outcome).toBe("decided");
        }),
      ).then(() => {
        completion.push("approval");
      });
      void approval.catch(() => {});
      tick = runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          if (!identity.rows[0]) throw new Error("Missing tick backend identity");
          reportTickPid(identity.rows[0].pid);
          expect(
            await finishTickRunWithMessage(client, {
              thread: fixture.thread,
              agentRunId: fixture.tickRunId,
              outcome: { status: "done", result: "tick result" },
            }),
          ).toBe(true);
        }),
      ).then(() => {
        completion.push("tick");
      });
      void tick.catch(() => {});
      const pids = await Promise.all([approvalPid, tickPid]);
      const deadline = Date.now() + 5_000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const rows = await admin.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'",
          [pids],
        );
        waiting = rows.rows[0]?.count ?? 0;
        if (waiting === 2) break;
        await sleep(25);
      }
      expect(waiting).toBe(2);
      expect(completion).toEqual([]);
      release();
      first = await sending;
      await Promise.all([approval, tick]);
    } catch (error) {
      failure = { error };
    }
    release();
    const settled = await Promise.allSettled([sending, ...(approval ? [approval] : []), ...(tick ? [tick] : [])]);
    const otherErrors = settled.flatMap((result) =>
      result.status === "rejected" && (!failure || result.reason !== failure.error) ? [result.reason] : [],
    );
    if (otherErrors.length)
      throw new AggregateError(failure ? [failure.error, ...otherErrors] : otherErrors, "Message order work failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
    if (!first) throw new Error("Missing first turn");
    const rows = await runInTenant(tenant, () =>
      pool.query<{ id: string; role: string; system_key: string | null; text: string | null; stamp: string }>(
        `SELECT id, role, system_key, text, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp FROM semp_messages WHERE thread_id = $1 ORDER BY created_at, id`,
        [fixture.thread.id],
      ),
    );
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows[0]?.id).toBe(fixture.futureId);
    expect(rows.rows.slice(1, 3).map((row) => row.id)).toEqual([first.messageId, first.assistantMessageId]);
    expect(
      rows.rows
        .slice(3)
        .map((row) => (row.system_key ? "approval" : "tick"))
        .sort(),
    ).toEqual(["approval", "tick"]);
    expect(new Set(rows.rows.map((row) => row.stamp)).size).toBe(5);
    for (let i = 1; i < rows.rows.length; i++) expect(rows.rows[i]!.stamp > rows.rows[i - 1]!.stamp).toBe(true);
    const latestId = rows.rows.at(-1)?.id;
    if (!latestId) throw new Error("Missing last row");
    const next = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { threadId: fixture.thread.id, text: "next", context: [], hasContext: false }),
      ),
    );
    const tokens = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => ({
        latest: await getSempMessageToken(client, latestId),
        priorReply: await getSempMessageToken(client, first.assistantMessageId),
        frontier: await getSempMessageFrontier(client, fixture.thread.id, next.messageId, next.assistantMessageId),
      })),
    );
    expect(tokens.frontier).toBe(tokens.latest);
    expect(tokens.frontier).not.toBe(tokens.priorReply);
    const foreign = await runInTenant(other, () =>
      withTransaction(pool, (client) =>
        getSempMessageFrontier(client, fixture.thread.id, next.messageId, next.assistantMessageId),
      ),
    );
    const missing = await runInTenant(other, () =>
      withTransaction(pool, (client) => getSempMessageFrontier(client, randomUUID(), randomUUID(), randomUUID())),
    );
    expect(foreign).toBeNull();
    expect(missing).toBeNull();
    let rolledBackId = "";
    await expect(
      runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const turn = await sendSempMessage(client, {
            threadId: fixture.thread.id,
            text: "rollback",
            context: [],
            hasContext: false,
          });
          rolledBackId = turn.assistantMessageId;
          const job = await client.query("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
            `sempMessage:${rolledBackId}`,
          ]);
          expect(job.rowCount).toBe(1);
          throw new Error("rollback fixture");
        }),
      ),
    ).rejects.toThrow("rollback fixture");
    const after = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => ({
        messages: (await client.query("SELECT id FROM semp_messages WHERE thread_id = $1", [fixture.thread.id]))
          .rowCount,
        job: (
          await client.query("SELECT key FROM graphile_worker.jobs WHERE key = $1", [`sempMessage:${rolledBackId}`])
        ).rowCount,
      })),
    );
    expect(after).toEqual({ messages: 7, job: 0 });
  }, 60_000);

  it("refuses stronger transaction isolation before writing a message or job", async () => {
    const threadId = await runInTenant(tenant, () => withTransaction(pool, (client) => createSempChatThread(client)));
    const counts = () =>
      runInTenant(tenant, () =>
        withTransaction(pool, async (client) => ({
          messages: (await client.query("SELECT id FROM semp_messages WHERE thread_id = $1", [threadId])).rowCount,
          jobs: (await client.query("SELECT key FROM graphile_worker.jobs WHERE key LIKE 'sempMessage:%'")).rowCount,
        })),
      );
    const before = await counts();
    for (const isolation of ["repeatable_read", "serializable"] as const) {
      await expect(
        runInTenant(tenant, () =>
          withTransaction(
            pool,
            (client) =>
              sendSempMessage(client, {
                threadId,
                text: "refused",
                context: [],
                hasContext: false,
              }),
            { isolation },
          ),
        ),
      ).rejects.toThrow("Semp message insertion requires read committed isolation");
      expect(await counts()).toEqual(before);
    }
    for (const id of [threadId, randomUUID()]) {
      await expect(
        runInTenant(other, () =>
          withTransaction(pool, (client) =>
            sendSempMessage(client, {
              threadId: id,
              text: "foreign",
              context: [],
              hasContext: false,
            }),
          ),
        ),
      ).rejects.toThrow();
      expect(await counts()).toEqual(before);
    }
    await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, {
          threadId,
          text: "accepted",
          context: [],
          hasContext: false,
        }),
      ),
    );
    const after = await counts();
    expect(after.messages).toBe(before.messages! + 2);
    expect(after.jobs).toBe(before.jobs! + 1);
  });

  it("serializes two competing sends on the same thread", async () => {
    const threadId = await runInTenant(tenant, () => withTransaction(pool, (client) => createSempChatThread(client)));
    let release!: () => void;
    let ready!: () => void;
    let reportPid!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const pid = new Promise<number>((resolve) => {
      reportPid = resolve;
    });
    const first = runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const turn = await sendSempMessage(client, { threadId, text: "first", context: [], hasContext: false });
        ready();
        await gate;
        return turn;
      }),
    );
    let second: Promise<Awaited<typeof first>> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      await Promise.race([
        held,
        first.then(() => {
          throw new Error("First send ended before reservation");
        }),
      ]);
      second = runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          if (!identity.rows[0]) throw new Error("Missing sender backend identity");
          reportPid(identity.rows[0].pid);
          return sendSempMessage(client, { threadId, text: "second", context: [], hasContext: false });
        }),
      );
      void second.catch(() => {});
      const senderPid = await pid;
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const result = await admin.query<{ wait_event_type: string | null }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [senderPid],
        );
        if (result.rows[0]?.wait_event_type === "Lock") {
          waiting = true;
          break;
        }
        await sleep(25);
      }
      expect(waiting).toBe(true);
    } catch (error) {
      failure = { error };
    }
    release();
    const results = await Promise.allSettled([first, ...(second ? [second] : [])]);
    const extra = results.flatMap((result) =>
      result.status === "rejected" && result.reason !== failure?.error ? [result.reason] : [],
    );
    if (extra.length)
      throw new AggregateError(failure ? [failure.error, ...extra] : extra, "Concurrent sends failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
    if (!second) throw new Error("Missing competing send");
    const turns = [await first, await second];
    const rows = await runInTenant(tenant, () =>
      pool.query<{ id: string; stamp: string }>(
        `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp FROM semp_messages WHERE thread_id = $1 ORDER BY created_at, id`,
        [threadId],
      ),
    );
    expect(rows.rows.map((row) => row.id)).toEqual(turns.flatMap((turn) => [turn.messageId, turn.assistantMessageId]));
    expect(new Set(rows.rows.map((row) => row.stamp)).size).toBe(4);
  });

  it("orders a transaction that started earlier after the newer reservation commits", async () => {
    const threadId = await runInTenant(tenant, () => withTransaction(pool, (client) => createSempChatThread(client)));
    let release!: () => void;
    let started!: (timestamp: string) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStart = new Promise<string>((resolve) => {
      started = resolve;
    });
    const older = runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const stamp = await client.query<{ value: string }>(
          "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value",
        );
        if (!stamp.rows[0]) throw new Error("Missing transaction timestamp");
        started(stamp.rows[0].value);
        await gate;
        return sendSempMessage(client, { threadId, text: "older start", context: [], hasContext: false });
      }),
    );
    let failure: { error: unknown } | undefined;
    let oldTurn: Awaited<typeof older> | undefined;
    let newerTurn: Awaited<typeof older> | undefined;
    try {
      const oldStart = await Promise.race([
        firstStart,
        older.then(() => {
          throw new Error("Older transaction ended early");
        }),
      ]);
      const newer = await runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const stamp = await client.query<{ value: string }>(
            "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value",
          );
          if (!stamp.rows[0]) throw new Error("Missing transaction timestamp");
          expect(stamp.rows[0].value > oldStart).toBe(true);
          return sendSempMessage(client, { threadId, text: "newer start", context: [], hasContext: false });
        }),
      );
      newerTurn = newer;
      release();
      oldTurn = await older;
    } catch (error) {
      failure = { error };
    }
    release();
    const settled = await Promise.allSettled([older]);
    const errors = settled.flatMap((result) =>
      result.status === "rejected" && (!failure || result.reason !== failure.error) ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(failure ? [failure.error, ...errors] : errors, "Transaction ordering failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
    if (!newerTurn || !oldTurn) throw new Error("Missing ordered turns");
    const rows = await runInTenant(tenant, () =>
      pool.query<{ id: string; stamp: string }>(
        `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp FROM semp_messages WHERE thread_id = $1 ORDER BY created_at, id`,
        [threadId],
      ),
    );
    expect(rows.rows.map((row) => row.id)).toEqual([
      newerTurn.messageId,
      newerTurn.assistantMessageId,
      oldTurn.messageId,
      oldTurn.assistantMessageId,
    ]);
    expect(new Set(rows.rows.map((row) => row.stamp)).size).toBe(4);
  });
});
