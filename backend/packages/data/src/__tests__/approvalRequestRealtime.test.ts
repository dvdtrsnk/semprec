import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createSempChatThread } from "../sempThreads/sempThreadsStore.js";
import { setInvalidationHook, setSempThreadInvalidationHook } from "../realtimeHook.js";
import {
  createPendingApprovalRequestAndPublish,
  publishApprovalRequestChange,
} from "../mcp/approvalRequestRealtime.js";

let pool: Pool;
let approvalAnnouncements: Array<{ approvalRequestId: string; userId: string | undefined }>;
let threadAnnouncements: Array<{ tenantId: string; threadId: string }>;
let agentRunAnnouncements: Array<{ agentRunId: string; userId: string | undefined }>;

function pendingInput(agentRunId: string, toolCallId?: string) {
  return {
    agentRunId,
    toolName: "search",
    riskClass: "write",
    payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
    resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    ...(toolCallId ? { toolCallId } : {}),
  } as const;
}

describe("approval request realtime announcements (issue #1789)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createTenantZeroUser(pool);
    approvalAnnouncements = [];
    threadAnnouncements = [];
    agentRunAnnouncements = [];
    setInvalidationHook((event) => {
      if (event.scope === "approvalRequest")
        approvalAnnouncements.push({ approvalRequestId: event.approvalRequestId, userId: event.userId });
      if (event.scope === "agentRuns")
        agentRunAnnouncements.push({ agentRunId: event.agentRunId, userId: event.userId });
    });
    setSempThreadInvalidationHook((event) => threadAnnouncements.push(event));
  });

  afterEach(() => {
    setInvalidationHook(() => {});
    setSempThreadInvalidationHook(() => {});
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("announces the insert of a request to the owner of its run, after the commit and with the run's thread", async () => {
    const threadId = await inTenantZero(() => withTransaction(pool, (client) => createSempChatThread(client)));
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "announce", threadId });

    agentRunAnnouncements.length = 0;

    const request = await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const created = await createPendingApprovalRequestAndPublish(client, pendingInput(run.id));
        // Nothing is published while the transaction is still open.
        expect(approvalAnnouncements).toEqual([]);
        expect(threadAnnouncements).toEqual([]);
        expect(agentRunAnnouncements).toEqual([]);
        return created;
      }),
    );

    expect(approvalAnnouncements).toEqual([{ approvalRequestId: request.id, userId: run.actorUserId }]);
    expect(agentRunAnnouncements).toEqual([{ agentRunId: run.id, userId: run.actorUserId }]);
    expect(threadAnnouncements).toEqual([{ tenantId: getTenantZeroId(), threadId }]);
  });

  it("announces only the request for a run without a thread", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "announce" });

    const request = await inTenantZero(() =>
      withTransaction(pool, (client) => createPendingApprovalRequestAndPublish(client, pendingInput(run.id))),
    );

    expect(approvalAnnouncements).toEqual([{ approvalRequestId: request.id, userId: run.actorUserId }]);
    expect(threadAnnouncements).toEqual([]);
  });

  it("announces nothing for a repeated tool call, which returns the existing request", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "announce" });
    const first = await inTenantZero(() =>
      withTransaction(pool, (client) => createPendingApprovalRequestAndPublish(client, pendingInput(run.id, "call_1"))),
    );
    approvalAnnouncements.length = 0;
    agentRunAnnouncements.length = 0;

    const repeated = await inTenantZero(() =>
      withTransaction(pool, (client) => createPendingApprovalRequestAndPublish(client, pendingInput(run.id, "call_1"))),
    );

    expect(repeated.id).toBe(first.id);
    expect(approvalAnnouncements).toEqual([]);
    expect(agentRunAnnouncements).toEqual([]);
    expect(threadAnnouncements).toEqual([]);
  });

  it("announces nothing when the creating transaction rolls back", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "announce" });
    agentRunAnnouncements.length = 0;

    await expect(
      inTenantZero(() =>
        withTransaction(pool, async (client) => {
          await createPendingApprovalRequestAndPublish(client, pendingInput(run.id));
          throw new Error("force rollback");
        }),
      ),
    ).rejects.toThrow("force rollback");

    expect(approvalAnnouncements).toEqual([]);
    expect(threadAnnouncements).toEqual([]);
    expect(agentRunAnnouncements).toEqual([]);
  });

  it("refuses to announce a change of a request whose run does not exist, and publishes nothing", async () => {
    await expect(
      inTenantZero(() =>
        withTransaction(pool, (client) =>
          publishApprovalRequestChange(client, { id: randomUUID(), agentRunId: randomUUID() }),
        ),
      ),
    ).rejects.toThrow("Expected exactly one row from agent_runs owner lookup");

    expect(approvalAnnouncements).toEqual([]);
    expect(threadAnnouncements).toEqual([]);
    expect(agentRunAnnouncements).toEqual([]);
  });

  it("refuses to announce outside a managed transaction", async () => {
    const client = await pool.connect();
    try {
      await expect(
        publishApprovalRequestChange(client, { id: randomUUID(), agentRunId: randomUUID() }),
      ).rejects.toThrow("active managed transaction");
    } finally {
      client.release();
    }

    expect(approvalAnnouncements).toEqual([]);
  });
});
