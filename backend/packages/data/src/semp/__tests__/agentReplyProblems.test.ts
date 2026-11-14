import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { withTransaction } from "../../db/pool.js";
import { sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { agentReplyProblemKey } from "../agentProblemKeys.js";
import { raiseAgentReplyProblem, resolveAgentReplyProblem } from "../agentReplyProblems.js";
import {
  claimSempMessage,
  finishSempMessageTurn,
  repairInterruptedSempMessages,
  retrySempReply,
} from "../sempMessagesStore.js";

/**
 * The adapter that raises and resolves the problem of a Semp reply (issue #1931), on the runtime role pool. The
 * turn handler that calls it is covered by `semprec-agents`' `sempMessageTaskProblems.test.ts`.
 */

let admin: Pool;
let runtime: Pool;
let tenantA: string;
let tenantB: string;
let tenantWithoutUser: string;

interface ProblemRow {
  id: string;
  category: string;
  kind: string;
  severity: string;
  source_table: string;
  source_id: string;
  dedupe_key: string;
  occurrence_count: number;
  resolved_at: Date | null;
  resolution_kind: string | null;
}

function readProblems(tenant: string, dedupeKey: string): Promise<ProblemRow[]> {
  return runInTenant(tenant, async () => {
    const { rows } = await runtime.query<ProblemRow>(
      `SELECT id, category, kind, severity, source_table, source_id, dedupe_key, occurrence_count, resolved_at,
              resolution_kind FROM semp_problems WHERE dedupe_key = $1 ORDER BY first_seen_at, id`,
      [dedupeKey],
    );
    return rows;
  });
}

/** Sends a message in `tenant` and returns the ids of the user message it answers and of its queued reply. */
async function sendMessage(tenant: string): Promise<{ threadId: string; userMessageId: string; replyId: string }> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      const sent = await sendSempMessage(client, { text: "hello", context: [], hasContext: false });
      const { rows } = await client.query<{ reply_to_message_id: string }>(
        "SELECT reply_to_message_id FROM semp_messages WHERE id = $1",
        [sent.assistantMessageId],
      );
      const userMessageId = rows[0]?.reply_to_message_id;
      if (userMessageId === undefined) throw new Error("The reply answers no message");
      return { threadId: sent.threadId, userMessageId, replyId: sent.assistantMessageId };
    }),
  );
}

/** Claims the queued attempt `replyId` and stores its final status, as the turn handler does. */
function finishAttempt(tenant: string, threadId: string, replyId: string, status: "done" | "error"): Promise<void> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      if (!(await claimSempMessage(client, threadId, replyId))) throw new Error("Cannot claim the fixture");
      const stored = await finishSempMessageTurn(
        client,
        replyId,
        status === "done" ? { status: "done", text: "reply", lastEventId: "1" } : { status: "error" },
      );
      if (!stored) throw new Error("Cannot finish the fixture");
    }),
  );
}

/** Claims the queued attempt `replyId` and leaves it `running`, the state a turn is in when its process dies. */
function startAttempt(tenant: string, threadId: string, replyId: string): Promise<void> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      if (!(await claimSempMessage(client, threadId, replyId))) throw new Error("Cannot claim the fixture");
    }),
  );
}

/** Runs the startup repair of the interrupted Semp messages in `tenant` and returns how many it closed. */
function repairInterrupted(tenant: string): Promise<number> {
  return runInTenant(tenant, () => withTransaction(runtime, (client) => repairInterruptedSempMessages(client)));
}

/** The id of the latest assistant attempt that answers `userMessageId`. */
function latestReplyId(tenant: string, threadId: string, userMessageId: string): Promise<string | undefined> {
  return runInTenant(tenant, async () => {
    const { rows } = await runtime.query<{ id: string }>(
      `SELECT id FROM semp_messages WHERE thread_id = $1 AND reply_to_message_id = $2 AND role = 'assistant'
        ORDER BY attempt DESC LIMIT 1`,
      [threadId, userMessageId],
    );
    return rows[0]?.id;
  });
}

describe("the problem of a Semp reply (issue #1931)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    tenantWithoutUser = await createTestTenant(admin);
    for (const tenantId of [tenantA, tenantB]) {
      await createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    }
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("raises one active agents warning keyed by the answered message, sourced at the failed message", async () => {
    const sent = await sendMessage(tenantA);
    await finishAttempt(tenantA, sent.threadId, sent.replyId, "error");

    const raised = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => raiseAgentReplyProblem(client, sent.replyId)),
    );

    expect(raised).toMatchObject({ outcome: "created" });
    expect(await readProblems(tenantA, `agents:reply:${sent.userMessageId}`)).toEqual([
      {
        id: raised?.problemId,
        category: "agents",
        kind: "reply",
        severity: "warning",
        source_table: "semp_messages",
        source_id: sent.replyId,
        dedupe_key: agentReplyProblemKey(sent.userMessageId),
        occurrence_count: 1,
        resolved_at: null,
        resolution_kind: null,
      },
    ]);
  });

  it("merges a failed retry into the same problem and counts it, and a replay of the same attempt adds nothing", async () => {
    const sent = await sendMessage(tenantA);
    await finishAttempt(tenantA, sent.threadId, sent.replyId, "error");
    await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => raiseAgentReplyProblem(client, sent.replyId)),
    );
    const retried = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => retrySempReply(client, sent.threadId, sent.replyId)),
    );
    await finishAttempt(tenantA, sent.threadId, retried.messageId, "error");

    const second = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => raiseAgentReplyProblem(client, retried.messageId)),
    );
    const replay = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => raiseAgentReplyProblem(client, retried.messageId)),
    );

    expect(second).toMatchObject({ outcome: "merged" });
    expect(replay).toMatchObject({ outcome: "merged" });
    const rows = await readProblems(tenantA, agentReplyProblemKey(sent.userMessageId));
    expect(rows).toHaveLength(1);
    // Only the latest attempt can be retried, so the source follows it (the first attempt is no longer retryable).
    expect(rows[0]).toMatchObject({ occurrence_count: 2, resolved_at: null, source_id: retried.messageId });
    expect(await latestReplyId(tenantA, sent.threadId, sent.userMessageId)).toBe(retried.messageId);
  });

  it("resolves the problem as recovered when a later attempt succeeded, and resolving again changes nothing", async () => {
    const sent = await sendMessage(tenantA);
    await finishAttempt(tenantA, sent.threadId, sent.replyId, "error");
    await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => raiseAgentReplyProblem(client, sent.replyId)),
    );
    const retried = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => retrySempReply(client, sent.threadId, sent.replyId)),
    );
    await finishAttempt(tenantA, sent.threadId, retried.messageId, "done");

    const first = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => resolveAgentReplyProblem(client, retried.messageId)),
    );
    const again = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => resolveAgentReplyProblem(client, retried.messageId)),
    );

    expect(first).toBe(true);
    expect(again).toBe(false);
    const rows = await readProblems(tenantA, agentReplyProblemKey(sent.userMessageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resolution_kind: "recovered" });
    expect(rows[0]?.resolved_at).toBeInstanceOf(Date);
  });

  it("resolves nothing when the reply never had a problem", async () => {
    const sent = await sendMessage(tenantA);
    await finishAttempt(tenantA, sent.threadId, sent.replyId, "done");

    const resolved = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => resolveAgentReplyProblem(client, sent.replyId)),
    );

    expect(resolved).toBe(false);
    expect(await readProblems(tenantA, agentReplyProblemKey(sent.userMessageId))).toEqual([]);
  });

  it("raises and resolves nothing for a message that answers no message", async () => {
    const sent = await sendMessage(tenantA);
    // The column is nullable and the send path always sets it; a raw UPDATE on the admin pool builds the state
    // (a reply that answers nothing) that no production writer leaves on a queued reply.
    await admin.query("UPDATE semp_messages SET reply_to_message_id = NULL WHERE id = $1", [sent.replyId]);

    const raised = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => raiseAgentReplyProblem(client, sent.replyId)),
    );
    const resolved = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => resolveAgentReplyProblem(client, sent.replyId)),
    );

    expect(raised).toBeNull();
    expect(resolved).toBe(false);
    const { rows } = await admin.query<{ count: string }>(
      "SELECT count(*) FROM semp_problems WHERE tenant_id = $1 AND source_id = $2",
      [tenantA, sent.replyId],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("raises nothing for a tenant that has no user to show the problem to", async () => {
    const sent = await sendMessage(tenantWithoutUser);
    await finishAttempt(tenantWithoutUser, sent.threadId, sent.replyId, "error");

    const raised = await runInTenant(tenantWithoutUser, () =>
      withTransaction(runtime, (client) => raiseAgentReplyProblem(client, sent.replyId)),
    );

    expect(raised).toBeNull();
    const { rows } = await admin.query<{ count: string }>("SELECT count(*) FROM semp_problems WHERE tenant_id = $1", [
      tenantWithoutUser,
    ]);
    expect(rows[0]?.count).toBe("0");
  });

  it("keeps the problem of one tenant out of another's view and out of its resolve", async () => {
    const sent = await sendMessage(tenantA);
    await finishAttempt(tenantA, sent.threadId, sent.replyId, "error");
    await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => raiseAgentReplyProblem(client, sent.replyId)),
    );
    const key = agentReplyProblemKey(sent.userMessageId);

    // Tenant A's message id is used inside tenant B's scope: row-level security hides the message, so B can
    // neither raise nor resolve a problem for it.
    const raisedByB = await runInTenant(tenantB, () =>
      withTransaction(runtime, (client) => raiseAgentReplyProblem(client, sent.replyId)),
    );
    const resolvedByB = await runInTenant(tenantB, () =>
      withTransaction(runtime, (client) => resolveAgentReplyProblem(client, sent.replyId)),
    );

    expect(await readProblems(tenantB, key)).toEqual([]);
    expect(raisedByB).toBeNull();
    expect(resolvedByB).toBe(false);
    const rows = await readProblems(tenantA, key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ occurrence_count: 1, resolved_at: null });
  });

  it("raises the problem of a reply the startup repair closed as interrupted, sourced at that attempt", async () => {
    const sent = await sendMessage(tenantA);
    await startAttempt(tenantA, sent.threadId, sent.replyId);

    expect(await repairInterrupted(tenantA)).toBe(1);

    const stored = await runInTenant(tenantA, () =>
      runtime.query<{ status: string; error_code: string | null }>(
        "SELECT status, error_code FROM semp_messages WHERE id = $1",
        [sent.replyId],
      ),
    );
    expect(stored.rows[0]).toEqual({ status: "error", error_code: "interrupted" });
    const rows = await readProblems(tenantA, agentReplyProblemKey(sent.userMessageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: "agents",
      kind: "reply",
      severity: "warning",
      source_id: sent.replyId,
      occurrence_count: 1,
      resolved_at: null,
    });
  });

  it("merges the repair of an interrupted retry into the problem of the reply and moves its source to the retry", async () => {
    const sent = await sendMessage(tenantA);
    await finishAttempt(tenantA, sent.threadId, sent.replyId, "error");
    await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => raiseAgentReplyProblem(client, sent.replyId)),
    );
    const retried = await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) => retrySempReply(client, sent.threadId, sent.replyId)),
    );
    await startAttempt(tenantA, sent.threadId, retried.messageId);

    expect(await repairInterrupted(tenantA)).toBe(1);

    const rows = await readProblems(tenantA, agentReplyProblemKey(sent.userMessageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ occurrence_count: 2, resolved_at: null, source_id: retried.messageId });
  });

  it("closes an interrupted reply of a tenant without a user and raises no problem for it", async () => {
    const sent = await sendMessage(tenantWithoutUser);
    await startAttempt(tenantWithoutUser, sent.threadId, sent.replyId);

    expect(await repairInterrupted(tenantWithoutUser)).toBe(1);

    const { rows } = await admin.query<{ status: string; problems: string }>(
      `SELECT status, (SELECT count(*) FROM semp_problems WHERE tenant_id = $1) AS problems
         FROM semp_messages WHERE id = $2`,
      [tenantWithoutUser, sent.replyId],
    );
    expect(rows[0]).toEqual({ status: "error", problems: "0" });
  });

  it("raises no problem when the repair finds no running reply", async () => {
    const sent = await sendMessage(tenantB);
    await finishAttempt(tenantB, sent.threadId, sent.replyId, "done");

    expect(await repairInterrupted(tenantB)).toBe(0);

    expect(await readProblems(tenantB, agentReplyProblemKey(sent.userMessageId))).toEqual([]);
  });
});
