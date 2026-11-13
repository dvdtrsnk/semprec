import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { createUser } from "../../auth/usersStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { attachLiveStepApprovals } from "../../mcp/approvalRequestsQueue.js";
import { createPendingApprovalRequest } from "../../mcp/approvalRequestsStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { listSempThreadMessages } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  createFixtureItem,
  finishPlayedTurn,
  playTurn,
  toolResultEvent,
  toolUseEvent,
  turnEndEvent,
  turnStartEvent,
  userMessageEvent,
  type TurnSetup,
} from "./sempReplyTestSupport.js";

// Seeding the tenant's system databases takes a while.
const SEEDING_TEST_TIMEOUT_MS = 90_000;

let setup: TurnSetup;
let userId: string;

/** The first page of `threadId`, read through the runtime role in the fixture tenant's scope. */
async function readHistory(threadId: string) {
  return runInTenant(setup.tenant, () =>
    withTransaction(setup.runtime, (client) => listSempThreadMessages(client, threadId, 50, null)),
  );
}

describe("the stored steps in the Semp thread message read (issue #1887)", () => {
  beforeAll(async () => {
    const admin = getTestPool();
    await resetDatabase(admin);
    const runtime = await createRuntimeRolePool(admin, "semprec_data");
    const tenant = await createTestTenant(admin);
    // A run needs the tenant's user as its actor.
    userId = (
      await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" })
    ).id;
    await runInTenant(tenant, () => seedSystem(runtime, createViewTypeRegistry()));
    setup = { admin, runtime, tenant };
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await setup?.runtime.end();
    await setup?.admin.end();
  });

  /** A turn whose delete is waiting for the approval request it created, finished with its summary. */
  async function playWaitingDelete() {
    const task = await createFixtureItem(setup, "tasks", { name: "Old task" });
    const del = { toolCallId: "del-1", name: "item_delete", operation: "item.delete", targetItemId: task.id };
    const run = await runInTenant(setup.tenant, () =>
      createAgentRun(setup.runtime, { triggeredBy: "user", unit: "session", task: "approval", userId }),
    );
    const request = await runInTenant(setup.tenant, () =>
      createPendingApprovalRequest(setup.runtime, {
        agentRunId: run.id,
        toolName: "item.delete",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: task.id, sha256: null },
        toolCallId: "del-1",
      }),
    );
    const turn = await playTurn(
      setup,
      [
        userMessageEvent(),
        turnStartEvent(5),
        toolUseEvent(del, 10),
        toolResultEvent(del, 40, { details: { error: false, approvalRequestId: request.id } }),
        turnEndEvent(50),
      ],
      { runId: run.id },
    );
    await finishPlayedTurn(setup, turn, "done");
    return { turn, requestId: request.id };
  }

  it("returns the steps the projector stored on the assistant reply, without a live approval, and no key on a message without a summary", async () => {
    const { turn, requestId } = await playWaitingDelete();

    const page = await readHistory(turn.threadId);

    const reply = page.rows.find((row) => row.id === turn.messageId);
    expect(reply?.steps).toEqual([
      expect.objectContaining({ toolCallId: "del-1", status: "wait", approvalRequestId: requestId }),
    ]);
    expect(reply?.steps?.[0]).not.toHaveProperty("approval");
    const userRow = page.rows.find((row) => row.role === "user");
    expect(userRow).toBeDefined();
    expect(userRow).not.toHaveProperty("steps");
  });

  it("reads the live state of the stored step's request for the run's owner and null for another user", async () => {
    const { turn, requestId } = await playWaitingDelete();
    const page = await readHistory(turn.threadId);

    const attached = await runInTenant(setup.tenant, () => attachLiveStepApprovals(setup.runtime, page.rows, userId));

    const reply = attached.find((row) => row.id === turn.messageId);
    expect(reply?.steps?.map((step) => [step.approvalRequestId, step.approval])).toEqual([
      [requestId, { status: "pending", executionStatus: "not_approved", conflictReason: null }],
    ]);
    const other = await runInTenant(setup.tenant, () =>
      attachLiveStepApprovals(setup.runtime, page.rows, randomUUID()),
    );
    expect(other.find((row) => row.id === turn.messageId)?.steps?.[0]?.approval).toBeNull();
  });

  it("fails on a stored steps value that is not the steps array, instead of returning it", async () => {
    const { turn } = await playWaitingDelete();
    // Raw SQL: the production writers only store what the projector builds; this is a value they cannot produce.
    await setup.admin.query(`UPDATE semp_messages SET steps = '{"not":"steps"}'::jsonb WHERE id = $1`, [
      turn.messageId,
    ]);

    await expect(readHistory(turn.threadId)).rejects.toThrow("Malformed semp_messages.steps in database row");
  });
});
