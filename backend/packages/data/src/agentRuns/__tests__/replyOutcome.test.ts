import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { withTransaction } from "../../db/pool.js";
import { createPendingApprovalRequest } from "../../mcp/approvalRequestsStore.js";
import { createSempChatThread, sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { claimSempMessage } from "../../semp/sempMessagesStore.js";
import {
  assistantEvent,
  finishPlayedTurn,
  playTurn,
  turnEndEvent,
  turnStartEvent,
  userMessageEvent,
  type EventSpec,
  type TurnSetup,
} from "../../semp/__tests__/sempReplyTestSupport.js";
import { listSempThreadMessages } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { getAgentRunDetail, getAgentRunReplyOutcome } from "../agentRunDetail.js";
import { agentRunErrorFields } from "../agentRunErrorSummary.js";
import { createAgentRun, finishAgentRun, getAgentRun, type AgentRunRow } from "../agentRunsStore.js";

const SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REGISTRATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_REGISTRATION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let setup: TurnSetup;
let foreignTenant: string;

interface McpCall {
  toolCallId: string;
  registrationId?: string;
}

function mcpIdentity(call: McpCall) {
  return {
    toolRegistrationId: call.registrationId ?? REGISTRATION,
    serverItemId: SERVER,
    serverName: "GitHub",
    toolName: "search",
  };
}

function mcpUse(call: McpCall, atMs: number): EventSpec {
  return {
    kind: "tool_use",
    atMs,
    payload: {
      kind: "tool_use",
      toolCallId: call.toolCallId,
      name: "mcp_search_aaaaaaaa",
      arguments: { query: "anything" },
      mcp: mcpIdentity(call),
    },
  };
}

/** The result of an MCP call as `agentSessionComposition` stores it: a failure is `details.error` with `isError` false. */
function mcpResult(call: McpCall, atMs: number, failure?: Record<string, unknown>): EventSpec {
  return {
    kind: "tool_result",
    atMs,
    payload: {
      kind: "tool_result",
      toolCallId: call.toolCallId,
      name: "mcp_search_aaaaaaaa",
      mcp: mcpIdentity(call),
      result: {
        content: [{ type: "text", text: failure ? "The call failed." : "{}" }],
        details: failure ? { error: true, ...failure, connectorName: "GitHub" } : { error: false },
      },
      isError: false,
    },
  };
}

function operationUse(call: { toolCallId: string }, atMs: number): EventSpec {
  return {
    kind: "tool_use",
    atMs,
    payload: {
      kind: "tool_use",
      toolCallId: call.toolCallId,
      name: "database_list",
      arguments: {},
      operation: "database.list",
    },
  };
}

function operationResult(call: { toolCallId: string }, atMs: number, failed: boolean): EventSpec {
  return {
    kind: "tool_result",
    atMs,
    payload: {
      kind: "tool_result",
      toolCallId: call.toolCallId,
      name: "database_list",
      operation: "database.list",
      result: { content: [{ type: "text", text: "[]" }], details: { error: failed } },
      isError: false,
    },
  };
}

const TIMEOUT = { failureKind: "timeout", mcpServerItemId: SERVER, timeoutMs: 60000 };
const UNAVAILABLE = { failureKind: "unavailable" };

/** A turn whose reply ended `done` after the given tool events. */
function replyAfter(toolEvents: EventSpec[]): EventSpec[] {
  return [
    userMessageEvent(),
    turnStartEvent(10),
    ...toolEvents,
    assistantEvent("Here is the answer.", 900),
    turnEndEvent(1000),
  ];
}

/** A run of the current tenant in a fresh chat thread, as a heartbeat tick's run is. */
async function createRunInThread(input: { triggeredBy: AgentRunRow["triggeredBy"] }): Promise<{
  threadId: string;
  run: AgentRunRow;
}> {
  return runInTenant(setup.tenant, async () => {
    const threadId = await withTransaction(setup.runtime, createSempChatThread);
    const run = await createAgentRun(setup.runtime, { triggeredBy: input.triggeredBy, task: "tick", threadId });
    return { threadId, run };
  });
}

/** Plays `events` as the single reply of a new run and, unless `leaveRunning`, closes the run as done. */
async function runWithReply(
  events: EventSpec[],
  options: { leaveRunning?: boolean } = {},
): Promise<{ threadId: string; messageId: string; run: AgentRunRow }> {
  const { threadId, run } = await createRunInThread({ triggeredBy: "user" });
  const turn = await playTurn(setup, events, { threadId, runId: run.id });
  await finishPlayedTurn(setup, turn, "done");
  if (options.leaveRunning !== true) {
    await runInTenant(setup.tenant, () => finishAgentRun(setup.runtime, run.id, "done", "finished"));
  }
  const stored = await runInTenant(setup.tenant, () => getAgentRun(setup.runtime, run.id));
  if (!stored) throw new Error("The fixture run is missing");
  return { threadId, messageId: turn.messageId, run: stored };
}

async function readMessages(threadId: string, tenant = setup.tenant) {
  return runInTenant(tenant, () =>
    withTransaction(setup.runtime, (client) => listSempThreadMessages(client, threadId, 50, null)),
  );
}

async function replyRow(threadId: string, messageId: string) {
  const row = (await readMessages(threadId)).rows.find((candidate) => candidate.id === messageId);
  if (!row) throw new Error("The reply is missing from the message list");
  return row;
}

function readDetail(run: AgentRunRow, reply?: Awaited<ReturnType<typeof getAgentRunReplyOutcome>>) {
  return runInTenant(setup.tenant, () =>
    withTransaction(setup.runtime, (client) => getAgentRunDetail(client, run, reply)),
  );
}

function readReplyOutcome(run: AgentRunRow, tenant = setup.tenant) {
  return runInTenant(tenant, () => withTransaction(setup.runtime, (client) => getAgentRunReplyOutcome(client, run)));
}

describe("whether a Semp reply left a failed tool call (issue #1890)", () => {
  beforeAll(async () => {
    const admin = getTestPool();
    await resetDatabase(admin);
    const runtime: Pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const tenant = await createTestTenant(admin);
    foreignTenant = await createTestTenant(admin);
    // A run needs the tenant's user as its actor.
    for (const tenantId of [tenant, foreignTenant])
      await createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    setup = { admin, runtime, tenant };
  });

  afterAll(async () => {
    await setup?.runtime.end();
    await setup?.admin.end();
  });

  describe("the message list", () => {
    it("reads a reply that ended done after an MCP call timed out as incomplete, with the timeout and the server", async () => {
      const call = { toolCallId: "mcp-1" };
      const { threadId, messageId } = await runWithReply(
        replyAfter([mcpUse(call, 100), mcpResult(call, 400, TIMEOUT)]),
      );

      const row = await replyRow(threadId, messageId);

      expect(row.status).toBe("done");
      expect(row).toMatchObject({
        outcome: "incomplete",
        incompleteReason: "toolTimeout",
        timeoutMs: 60000,
        mcpServerItemId: SERVER,
      });
    });

    it("reads a reply as complete when the failed tool is called again and succeeds in the same reply", async () => {
      const first = { toolCallId: "mcp-1" };
      const retry = { toolCallId: "mcp-2" };
      const { threadId, messageId } = await runWithReply(
        replyAfter([mcpUse(first, 100), mcpResult(first, 400, TIMEOUT), mcpUse(retry, 450), mcpResult(retry, 500)]),
      );

      const row = await replyRow(threadId, messageId);

      expect(row.outcome).toBe("complete");
      expect(row).not.toHaveProperty("incompleteReason");
      expect(row).not.toHaveProperty("mcpServerItemId");
      expect(row).not.toHaveProperty("timeoutMs");
    });

    it("keeps a reply incomplete when the later success is a different MCP registration", async () => {
      const failed = { toolCallId: "mcp-1" };
      const other = { toolCallId: "mcp-2", registrationId: OTHER_REGISTRATION };
      const { threadId, messageId } = await runWithReply(
        replyAfter([mcpUse(failed, 100), mcpResult(failed, 400, TIMEOUT), mcpUse(other, 450), mcpResult(other, 500)]),
      );

      expect((await replyRow(threadId, messageId)).outcome).toBe("incomplete");
    });

    it("counts a generic operation whose result carries details.error as a failed step", async () => {
      const call = { toolCallId: "op-1" };
      const { threadId, messageId } = await runWithReply(
        replyAfter([operationUse(call, 100), operationResult(call, 400, true)]),
      );

      const row = await replyRow(threadId, messageId);

      expect(row).toMatchObject({ outcome: "incomplete", incompleteReason: "toolError" });
      expect(row).not.toHaveProperty("mcpServerItemId");
      expect(row).not.toHaveProperty("timeoutMs");
    });

    it("gives toolUnavailable for an unavailable server, with no server id when its registration was not resolved", async () => {
      const call = { toolCallId: "mcp-1" };
      const { threadId, messageId } = await runWithReply(
        replyAfter([mcpUse(call, 100), mcpResult(call, 400, UNAVAILABLE)]),
      );

      const row = await replyRow(threadId, messageId);

      expect(row).toMatchObject({ outcome: "incomplete", incompleteReason: "toolUnavailable" });
      expect(row).not.toHaveProperty("timeoutMs");
    });

    it("reads a reply with no failed step as complete, and every message of the thread has an outcome", async () => {
      const call = { toolCallId: "op-1" };
      const { threadId, messageId } = await runWithReply(
        replyAfter([operationUse(call, 100), operationResult(call, 400, false)]),
      );

      const page = await readMessages(threadId);

      expect(page.rows.map((row) => row.outcome)).toEqual(["complete", "complete"]);
      expect(page.rows.map((row) => row.role).sort()).toEqual(["assistant", "user"]);
      expect((await replyRow(threadId, messageId)).outcome).toBe("complete");
    });

    it("reads a message that stored no summary as complete", async () => {
      const { threadId } = await createRunInThread({ triggeredBy: "user" });
      await runInTenant(setup.tenant, () =>
        withTransaction(setup.runtime, async (client) => {
          const sent = await sendSempMessage(client, { threadId, text: "hello", context: [], hasContext: false });
          await claimSempMessage(client, threadId, sent.assistantMessageId);
        }),
      );

      const page = await readMessages(threadId);

      expect(page.rows).toHaveLength(2);
      expect(page.rows.every((row) => row.outcome === "complete")).toBe(true);
    });

    it("refuses a message whose stored steps are malformed instead of reading it as complete", async () => {
      const call = { toolCallId: "op-1" };
      const { threadId, messageId } = await runWithReply(
        replyAfter([operationUse(call, 100), operationResult(call, 400, false)]),
      );
      await setup.admin.query(`UPDATE semp_messages SET steps = '{"status": "error"}'::jsonb WHERE id = $1`, [
        messageId,
      ]);

      await expect(readMessages(threadId)).rejects.toThrow("Malformed semp_messages.steps in database row");
    });

    it("answers another tenant's thread with no message, so no outcome of it", async () => {
      const call = { toolCallId: "mcp-1" };
      const { threadId } = await runWithReply(replyAfter([mcpUse(call, 100), mcpResult(call, 400, TIMEOUT)]));

      expect((await readMessages(threadId, foreignTenant)).rows).toEqual([]);
    });
  });

  describe("the display status of a run", () => {
    it("reads a finished run whose reply is incomplete as error, with the summary naming the server", async () => {
      const call = { toolCallId: "mcp-1" };
      const { run } = await runWithReply(replyAfter([mcpUse(call, 100), mcpResult(call, 400, UNAVAILABLE)]));

      const reply = await readReplyOutcome(run);
      const detail = await readDetail(run, reply);
      const fields =
        reply?.outcome === "incomplete" ? await agentRunErrorFields(run, "en", reply) : { errorSummary: "no reply" };

      expect(run.status).toBe("done");
      expect(detail.displayStatus).toBe("error");
      expect(fields).toEqual({ errorCode: null, errorSummary: "GitHub unavailable" });
    });

    it("loads the reply itself when the caller passes none", async () => {
      const call = { toolCallId: "op-1" };
      const { run } = await runWithReply(replyAfter([operationUse(call, 100), operationResult(call, 400, true)]));

      expect((await readDetail(run)).displayStatus).toBe("error");
    });

    it("keeps done for a finished run whose reply left no failed step", async () => {
      const call = { toolCallId: "mcp-1" };
      const { run } = await runWithReply(replyAfter([mcpUse(call, 100), mcpResult(call, 400)]));

      expect((await readDetail(run)).displayStatus).toBe("done");
    });

    it("keeps running for a run that is still running with an incomplete reply", async () => {
      const call = { toolCallId: "mcp-1" };
      const { run } = await runWithReply(replyAfter([mcpUse(call, 100), mcpResult(call, 400, TIMEOUT)]), {
        leaveRunning: true,
      });

      expect(run.status).toBe("running");
      expect((await readDetail(run)).displayStatus).toBe("running");
    });

    it("keeps waiting_approval for a finished run with a pending request and an incomplete reply", async () => {
      const call = { toolCallId: "mcp-1" };
      const { run } = await runWithReply(replyAfter([mcpUse(call, 100), mcpResult(call, 400, TIMEOUT)]));
      await runInTenant(setup.tenant, () =>
        createPendingApprovalRequest(setup.runtime, {
          agentRunId: run.id,
          toolName: "probe",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        }),
      );

      expect((await readDetail(run)).displayStatus).toBe("waiting_approval");
    });

    it("keeps error for a run closed with an error code, with the summary of that code", async () => {
      const call = { toolCallId: "mcp-1" };
      const { threadId, run } = await createRunInThread({ triggeredBy: "user" });
      const turn = await playTurn(setup, replyAfter([mcpUse(call, 100), mcpResult(call, 400, TIMEOUT)]), {
        threadId,
        runId: run.id,
      });
      await finishPlayedTurn(setup, turn, "done");
      await runInTenant(setup.tenant, () => finishAgentRun(setup.runtime, run.id, "error", "modelError"));
      const failed = await runInTenant(setup.tenant, () => getAgentRun(setup.runtime, run.id));
      if (!failed) throw new Error("The fixture run is missing");

      const reply = await readReplyOutcome(failed);
      expect(reply).toMatchObject({ outcome: "incomplete" });
      expect((await readDetail(failed)).displayStatus).toBe("error");
      expect(await agentRunErrorFields(failed, "en", reply?.outcome === "incomplete" ? reply : null)).toEqual({
        errorCode: "modelError",
        errorSummary: "AI model error",
      });
    });

    it("never gives an MCP-triggered run an incomplete outcome: it has no thread and no reply", async () => {
      const run = await runInTenant(setup.tenant, async () => {
        const created = await createAgentRun(setup.runtime, { triggeredBy: "mcp", task: "External client" });
        await finishAgentRun(setup.runtime, created.id, "done", "finished");
        return created;
      });
      const finished = await runInTenant(setup.tenant, () => getAgentRun(setup.runtime, run.id));
      if (!finished) throw new Error("The fixture run is missing");

      expect(finished.threadId).toBeNull();
      expect(await readReplyOutcome(finished)).toBeNull();
      expect((await readDetail(finished)).displayStatus).toBe("done");
    });

    it("never reads an MCP-triggered run as incomplete even when its row carries a thread with an incomplete reply", async () => {
      const call = { toolCallId: "mcp-1" };
      const { threadId, run } = await createRunInThread({ triggeredBy: "mcp" });
      const turn = await playTurn(setup, replyAfter([mcpUse(call, 100), mcpResult(call, 400, TIMEOUT)]), {
        threadId,
        runId: run.id,
      });
      await finishPlayedTurn(setup, turn, "done");
      await runInTenant(setup.tenant, () => finishAgentRun(setup.runtime, run.id, "done", "finished"));
      const finished = await runInTenant(setup.tenant, () => getAgentRun(setup.runtime, run.id));
      if (!finished) throw new Error("The fixture run is missing");

      expect(finished.triggeredBy).toBe("mcp");
      expect(finished.threadId).toBe(threadId);
      expect((await replyRow(threadId, turn.messageId)).outcome).toBe("incomplete");
      expect(await readReplyOutcome(finished)).toBeNull();
      expect((await readDetail(finished)).displayStatus).toBe("done");
    });

    it.each([
      ["first", true],
      ["last", false],
    ])(
      "does not judge a run by one of several replies: a run whose %s reply is incomplete has no single outcome",
      async (_which, incompleteFirst) => {
        const failing = (id: string) =>
          replyAfter([mcpUse({ toolCallId: id }, 100), mcpResult({ toolCallId: id }, 400, TIMEOUT)]);
        const working = (id: string) =>
          replyAfter([mcpUse({ toolCallId: id }, 100), mcpResult({ toolCallId: id }, 400)]);
        const { threadId, run } = await runWithReply(incompleteFirst ? failing("mcp-1") : working("mcp-1"), {
          leaveRunning: true,
        });
        const turn = await playTurn(setup, incompleteFirst ? working("mcp-2") : failing("mcp-2"), {
          threadId,
          runId: run.id,
        });
        await finishPlayedTurn(setup, turn, "done");
        await runInTenant(setup.tenant, () => finishAgentRun(setup.runtime, run.id, "done", "finished"));
        const finished = await runInTenant(setup.tenant, () => getAgentRun(setup.runtime, run.id));
        if (!finished) throw new Error("The fixture run is missing");

        expect((await readMessages(threadId)).rows.filter((row) => row.outcome === "incomplete")).toHaveLength(1);
        expect(await readReplyOutcome(finished)).toBeNull();
        expect((await readDetail(finished)).displayStatus).toBe("done");
      },
    );

    it("sees nothing of another tenant's reply", async () => {
      const call = { toolCallId: "mcp-1" };
      const { run } = await runWithReply(replyAfter([mcpUse(call, 100), mcpResult(call, 400, TIMEOUT)]));

      expect(await readReplyOutcome(run, foreignTenant)).toBeNull();
    });
  });

  describe("reading", () => {
    it("returns the same result twice and writes no column of the message or the run", async () => {
      const call = { toolCallId: "mcp-1" };
      const { threadId, messageId, run } = await runWithReply(
        replyAfter([mcpUse(call, 100), mcpResult(call, 400, TIMEOUT)]),
      );
      const snapshot = async () => ({
        messages: (
          await setup.admin.query(
            "SELECT xmin::text AS version, to_jsonb(m) AS row FROM semp_messages m WHERE thread_id = $1 ORDER BY id",
            [threadId],
          )
        ).rows,
        runs: (
          await setup.admin.query("SELECT xmin::text AS version, to_jsonb(r) AS row FROM agent_runs r WHERE id = $1", [
            run.id,
          ])
        ).rows,
      });
      const before = await snapshot();

      const firstList = await readMessages(threadId);
      const secondList = await readMessages(threadId);
      const firstDetail = await readDetail(run);
      const secondDetail = await readDetail(run);

      expect(secondList).toEqual(firstList);
      expect(secondDetail).toEqual(firstDetail);
      expect(firstList.rows.find((row) => row.id === messageId)?.outcome).toBe("incomplete");
      expect(await snapshot()).toEqual(before);
    });
  });
});
