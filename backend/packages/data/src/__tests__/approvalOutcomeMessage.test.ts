import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { withTransaction } from "../db/pool.js";
import { createPendingApprovalRequest, getApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { decideAndEnqueueApprovalRequest } from "../mcp/approvalDecisionAction.js";

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
