import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { withTransaction } from "../db/pool.js";
import { createPendingApprovalRequest, getApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { decideAndEnqueueApprovalRequest } from "../mcp/approvalDecisionAction.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { sendSempMessage } from "../sempThreads/sempThreadsStore.js";
import { getSempMessageTurn } from "../sempThreads/sempThreadsStore.js";
import { createUser } from "../auth/usersStore.js";

let admin: Pool;
let runtime: Pool;
let userId: string;
const tenant = () => getTenantZeroId();

describe("approval outcome messages", () => {
  beforeEach(async () => {
    admin ??= getTestPool();
    runtime ??= await createRuntimeRolePool(admin, "semprec_data");
    await resetDatabase(admin);
    userId = (await createTenantZeroUser(admin)).id;
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  async function fixture(withThread: boolean, withDescription = true) {
    return runInTenant(tenant(), () =>
      withTransaction(runtime, async (client) => {
        // There is no production chat-thread creation API on this tip.
        const thread = withThread
          ? (await client.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id")).rows[0]
          : null;
        const run = await createAgentRun(client, { triggeredBy: "user", task: "approval", threadId: thread?.id });
        const request = await createPendingApprovalRequest(client, {
          agentRunId: run.id,
          toolName: "test",
          riskClass: "write",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { secret: "hidden" } },
          resourceSnapshot: { kind: "test", resourceId: randomUUID(), sha256: null },
          ...(withDescription ? { description: { key: "approval.mcpInvoke", params: { toolName: "Visible" } } } : {}),
        });
        return { threadId: thread?.id, request };
      }),
    );
  }
  async function messages() {
    return runInTenant(tenant(), () =>
      runtime.query<{ system_key: string; system_params: unknown; context: unknown }>(
        "SELECT system_key, system_params, context FROM semp_messages ORDER BY created_at, id",
      ),
    );
  }
  async function tickFixture(enabled: boolean) {
    return runInTenant(tenant(), async () => {
      await seedSystem(runtime);
      return withTransaction(runtime, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        if (!inbox?.ownerProjectItemId) throw new Error("Missing project");
        const heartbeat = await createHeartbeat(client, {
          projectItemId: inbox.ownerProjectItemId,
          name: "Test",
          rule: { kind: "interval", minutes: 10 },
          actionId: "core.agentRun",
          actionConfig: { task: "Test" },
        });
        if (!enabled) await client.query("UPDATE project_heartbeats SET enabled = false WHERE id = $1", [heartbeat.id]);
        const thread = await client.query<{ id: string }>(
          "INSERT INTO semp_threads (kind, heartbeat_id) VALUES ('tick', $1) RETURNING id",
          [heartbeat.id],
        );
        const threadId = thread.rows[0]?.id;
        if (!threadId) throw new Error("Missing tick thread");
        const run = await createAgentRun(client, {
          triggeredBy: "heartbeat",
          task: "Test",
          projectItemId: inbox.ownerProjectItemId,
          heartbeatId: heartbeat.id,
          threadId,
        });
        const request = await createPendingApprovalRequest(client, {
          agentRunId: run.id,
          toolName: "test",
          riskClass: "write",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: randomUUID(), sha256: null },
        });
        return { threadId, requestId: request.id };
      });
    });
  }
  it("queues one tick acknowledgment after an earlier user turn and rolls it back with the decision", async () => {
    const fixture = await tickFixture(true);
    const prior = await runInTenant(tenant(), () =>
      withTransaction(runtime, (client) =>
        sendSempMessage(client, { threadId: fixture.threadId, text: "earlier", context: [], hasContext: false }),
      ),
    );
    const decide = () =>
      runInTenant(tenant(), () =>
        withTransaction(runtime, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: fixture.requestId,
            decision: "rejected",
            decidedByUserId: userId,
          }),
        ),
      );
    await expect(
      runInTenant(tenant(), () =>
        withTransaction(runtime, async (client) => {
          await decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: fixture.requestId,
            decision: "rejected",
            decidedByUserId: userId,
          });
          throw new Error("rollback tick decision");
        }),
      ),
    ).rejects.toThrow("rollback tick decision");
    expect((await runInTenant(tenant(), () => getApprovalRequest(runtime, fixture.requestId)))?.status).toBe("pending");
    expect((await decide())?.outcome).toBe("decided");
    expect((await decide())?.outcome).toBe("unchanged");
    const rows = await runInTenant(tenant(), () =>
      runtime.query<{
        id: string;
        role: string;
        reply_to_message_id: string | null;
        system_key: string | null;
        status: string | null;
      }>(
        "SELECT id, role, reply_to_message_id, system_key, status FROM semp_messages WHERE thread_id = $1 ORDER BY created_at, id",
        [fixture.threadId],
      ),
    );
    expect(rows.rows.map((row) => row.role)).toEqual(["user", "assistant", "system", "assistant"]);
    expect(rows.rows[1]?.id).toBe(prior.assistantMessageId);
    expect(rows.rows[2]?.system_key).toBe("approval.outcome.rejected");
    expect(rows.rows[3]).toMatchObject({ role: "assistant", status: "queued", reply_to_message_id: rows.rows[2]?.id });
    const keys = [prior.assistantMessageId, rows.rows[3]?.id].map((id) => `sempMessage:${id}`);
    const jobs = await admin.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
      [keys],
    );
    expect(jobs.rows).toEqual([...keys].sort().map((key) => ({ key })));
  });
  it("keeps the outcome without a continuation for a disabled heartbeat", async () => {
    const fixture = await tickFixture(false);
    await runInTenant(tenant(), () =>
      withTransaction(runtime, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: fixture.requestId,
          decision: "rejected",
          decidedByUserId: userId,
        }),
      ),
    );
    const rows = await runInTenant(tenant(), () =>
      runtime.query<{ role: string; system_key: string | null }>(
        "SELECT role, system_key FROM semp_messages WHERE thread_id = $1",
        [fixture.threadId],
      ),
    );
    expect(rows.rows).toEqual([{ role: "system", system_key: "approval.outcome.rejected" }]);
  });

  it("rejects foreign and missing approval references identically without exposing their results", async () => {
    const own = await tickFixture(true);
    const otherThread = await fixture(true);
    const other = await createTestTenant(admin);
    await createUser(admin, { tenantId: other, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(other, () => seedSystem(runtime));
    const foreign = await runInTenant(other, () =>
      withTransaction(runtime, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        if (!inbox?.ownerProjectItemId) throw new Error("Missing project");
        const heartbeat = await createHeartbeat(client, {
          projectItemId: inbox.ownerProjectItemId,
          name: "Foreign",
          rule: { kind: "interval", minutes: 10 },
          actionId: "core.agentRun",
          actionConfig: { task: "Foreign" },
        });
        const thread = await client.query<{ id: string }>(
          "INSERT INTO semp_threads (kind, heartbeat_id) VALUES ('tick', $1) RETURNING id",
          [heartbeat.id],
        );
        if (!thread.rows[0]) throw new Error("Missing thread");
        const run = await createAgentRun(client, {
          triggeredBy: "heartbeat",
          task: "Foreign",
          projectItemId: inbox.ownerProjectItemId,
          heartbeatId: heartbeat.id,
          threadId: thread.rows[0].id,
        });
        return createPendingApprovalRequest(client, {
          agentRunId: run.id,
          toolName: "private",
          riskClass: "write",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
      }),
    );
    const attempt = async (requestId: string, key = "approval.outcome.executed") =>
      runInTenant(tenant(), () =>
        withTransaction(runtime, async (client) => {
          // Synthetic historical source: normal outcome writers never point across threads or tenants.
          const source = await client.query<{ id: string }>(
            "INSERT INTO semp_messages (thread_id, role, system_key, system_params, context) VALUES ($1, 'system', $3, '{}'::jsonb, $2::jsonb) RETURNING id",
            [own.threadId, JSON.stringify([{ kind: "approvalRequest", approvalRequestId: requestId }]), key],
          );
          if (!source.rows[0]) throw new Error("Missing source");
          const reply = await client.query<{ id: string }>(
            "INSERT INTO semp_messages (thread_id, role, reply_to_message_id, status) VALUES ($1, 'assistant', $2, 'queued') RETURNING id",
            [own.threadId, source.rows[0].id],
          );
          if (!reply.rows[0]) throw new Error("Missing reply");
          return getSempMessageTurn(client, own.threadId, reply.rows[0].id);
        }),
      );
    const capture = (id: string) =>
      attempt(id).then(
        () => "unexpected success",
        (error: unknown) => (error instanceof Error ? error.message : "unexpected error"),
      );
    expect(await capture(foreign.id)).toBe("Approval outcome provenance mismatch");
    expect(await capture(randomUUID())).toBe("Approval outcome provenance mismatch");
    expect(await capture(otherThread.request.id)).toBe("Approval outcome provenance mismatch");
    for (const [unit, triggeredBy] of [["invocation", "user"], ["session", "heartbeat"]] as const) {
      const invalid = await runInTenant(tenant(), () => withTransaction(runtime, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        if (!inbox?.ownerProjectItemId) throw new Error("Missing project");
        // Synthetic historical origin: the regular session producer does not emit these combinations.
        const run = await createAgentRun(client, { projectItemId: inbox.ownerProjectItemId, threadId: own.threadId, unit, triggeredBy, task: "Invalid origin" });
        const request = await createPendingApprovalRequest(client, {
          agentRunId: run.id, toolName: "test", riskClass: "write",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
        const decision = await decideAndEnqueueApprovalRequest(client, { approvalRequestId: request.id, decision: "rejected", decidedByUserId: userId });
        expect(decision?.outcome).toBe("decided");
        return request.id;
      }));
      await expect(attempt(invalid, "approval.outcome.rejected")).rejects.toThrow("Approval outcome provenance mismatch");
    }
  });
  it("posts one canonical rejection on the decision transaction and ignores redelivery", async () => {
    const { threadId, request } = await fixture(true);
    // Set an old activity timestamp so the outcome must advance it.
    await runInTenant(tenant(), () =>
      runtime.query("UPDATE semp_threads SET last_activity_at = $2 WHERE id = $1", [
        threadId,
        new Date("2020-01-01T00:00:00.000Z"),
      ]),
    );
    const decide = () =>
      runInTenant(tenant(), () =>
        withTransaction(runtime, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: request.id,
            decision: "rejected",
            decidedByUserId: userId,
          }),
        ),
      );
    const before = await runInTenant(tenant(), () =>
      runtime.query<{ last_activity_at: Date }>("SELECT last_activity_at FROM semp_threads WHERE id = $1", [threadId]),
    );
    const runsBefore = await runInTenant(tenant(), () =>
      runtime.query<{ count: string }>("SELECT count(*)::text AS count FROM agent_runs"),
    );
    const jobsBefore = await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs");
    expect((await decide())?.outcome).toBe("decided");
    expect((await decide())?.outcome).toBe("unchanged");
    expect((await messages()).rows).toEqual([
      {
        system_key: "approval.outcome.rejected",
        system_params: { toolName: "Visible" },
        context: [{ kind: "approvalRequest", approvalRequestId: request.id }],
      },
    ]);
    const after = await runInTenant(tenant(), () =>
      runtime.query<{ last_activity_at: Date }>("SELECT last_activity_at FROM semp_threads WHERE id = $1", [threadId]),
    );
    expect(after.rows[0]!.last_activity_at.getTime()).toBeGreaterThan(before.rows[0]!.last_activity_at.getTime());
    expect(
      (
        await runInTenant(tenant(), () =>
          runtime.query<{ count: string }>("SELECT count(*)::text AS count FROM agent_runs"),
        )
      ).rows,
    ).toEqual(runsBefore.rows);
    expect(
      (await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs")).rows,
    ).toEqual(jobsBefore.rows);
    expect(
      (
        await runInTenant(tenant(), () =>
          runtime.query<{ role: string }>("SELECT role FROM semp_messages WHERE thread_id = $1", [threadId]),
        )
      ).rows,
    ).toEqual([{ role: "system" }]);
  });
  it("uses empty safe parameters when the request has no description", async () => {
    const { request } = await fixture(true, false);
    await runInTenant(tenant(), () =>
      withTransaction(runtime, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "rejected",
          decidedByUserId: userId,
        }),
      ),
    );
    expect((await messages()).rows).toEqual([
      {
        system_key: "approval.outcome.rejected",
        system_params: {},
        context: [{ kind: "approvalRequest", approvalRequestId: request.id }],
      },
    ]);
  });

  it("rolls back the decision and message together", async () => {
    const { request } = await fixture(true);
    await expect(
      runInTenant(tenant(), () =>
        withTransaction(runtime, async (client) => {
          await decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: request.id,
            decision: "rejected",
            decidedByUserId: userId,
          });
          throw new Error("rollback fixture");
        }),
      ),
    ).rejects.toThrow("rollback fixture");
    expect((await messages()).rows).toEqual([]);
    expect((await runInTenant(tenant(), () => getApprovalRequest(runtime, request.id)))?.status).toBe("pending");
  });
  it("does not post for a run without a thread", async () => {
    const { request } = await fixture(false);
    await runInTenant(tenant(), () =>
      withTransaction(runtime, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "rejected",
          decidedByUserId: userId,
        }),
      ),
    );
    expect((await messages()).rows).toEqual([]);
  });
});
