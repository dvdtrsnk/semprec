import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { createAgentRun, createSempChatThread, listAgentRunEvents, withTransaction } from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import type { CompactionAdapter } from "../compaction.js";
import { reconstructConversationHistory } from "../conversationReconstruction.js";
import { runAgentTurn } from "../lifecycleAdapter.js";
import { logger } from "../logger.js";
import type { AgentMessage } from "../types.js";

const noopCompaction: CompactionAdapter = {
  estimateContextTokens: (messages) => messages.length,
  shouldCompact: () => false,
  prepareCompaction: (entries) => entries,
  compact: () => {
    throw new Error("unexpected compaction");
  },
  contextWindow: 1_000_000,
  settings: {},
};

const PRIVATE_VALUES = ["Private diagnosis", "23:15", "Old private name"];
const SENSITIVE_ITEM = JSON.stringify({
  id: "item-1",
  databaseId: "database-1",
  properties: { name: PRIVATE_VALUES[0], bedTime: PRIVATE_VALUES[1] },
});
const OPEN_ITEM = JSON.stringify({ id: "item-2", databaseId: "database-2", properties: { name: "Open note" } });

function toolPair(
  toolCallId: string,
  text: string,
  details: Record<string, unknown>,
  operation = "item.get",
): AgentMessage[] {
  return [
    { kind: "tool_use", toolCallId, name: "item_get", operation, arguments: { itemId: "item-1" } },
    {
      kind: "tool_result",
      toolCallId,
      name: "item_get",
      operation,
      result: { content: [{ type: "text", text }], details },
      isError: false,
    },
  ];
}

const TURN: AgentMessage[] = [
  { kind: "user_message", text: "read my records", context: [] },
  { kind: "turn_start" },
  ...toolPair("call-sensitive", SENSITIVE_ITEM, { error: false, sensitive: true }),
  ...toolPair("call-open", OPEN_ITEM, { error: false }),
  ...toolPair("call-patch", SENSITIVE_ITEM, {
    error: false,
    sensitive: true,
    changes: [{ key: "name", before: PRIVATE_VALUES[2], after: PRIVATE_VALUES[0] }],
  }),
  { kind: "message", role: "assistant", text: "done" },
  { kind: "turn_end" },
];

describe("stored tool results of sensitive databases (issue #1827)", () => {
  let admin: Pool;
  let runtime: Pool;

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    await createTenantZeroUser(admin);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  async function runTurn(messages: AgentMessage[]) {
    const logs = [
      vi.spyOn(logger, "error"),
      vi.spyOn(logger, "warn"),
      vi.spyOn(logger, "info"),
      vi.spyOn(logger, "debug"),
    ];
    const seen: AgentMessage[] = [];
    const fixture = await runInTenant(getTenantZeroId(), () =>
      withTransaction(runtime, async (client) => {
        const threadId = await createSempChatThread(client);
        const run = await createAgentRun(client, { threadId, triggeredBy: "user", unit: "session", task: "records" });
        return { threadId, runId: run.id };
      }),
    );
    await runInTenant(getTenantZeroId(), () =>
      runAgentTurn(
        runtime,
        fixture.runId,
        (async function* () {
          yield* messages;
        })(),
        (message) => seen.push(message),
      ),
    );
    return { ...fixture, seen, logs };
  }

  const storedToolResults = (runId: string) =>
    runInTenant(getTenantZeroId(), async () =>
      (await listAgentRunEvents(runtime, runId)).filter((event) => event.kind === "tool_result"),
    );

  it("stores a marked result as the marker without its values or its mark and a result without the mark in full", async () => {
    const { runId } = await runTurn(TURN);
    const stored = await storedToolResults(runId);
    expect(stored.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        toolCallId: "call-sensitive",
        operation: "item.get",
        result: { content: [{ type: "text", text: "[redacted: sensitive]" }], details: { error: false } },
        isError: false,
      }),
      expect.objectContaining({
        toolCallId: "call-open",
        result: { content: [{ type: "text", text: OPEN_ITEM }], details: { error: false } },
      }),
      expect.objectContaining({
        toolCallId: "call-patch",
        result: {
          content: [{ type: "text", text: "[redacted: sensitive]" }],
          details: { error: false, changes: [{ key: "name" }] },
        },
      }),
    ]);
    const everything = JSON.stringify(await runInTenant(getTenantZeroId(), () => listAgentRunEvents(runtime, runId)));
    for (const value of PRIVATE_VALUES) expect(everything).not.toContain(value);
    expect(everything).not.toContain('"sensitive"');
  });

  it("hands the running turn the real result, mark included", async () => {
    const { seen } = await runTurn(TURN);
    expect(seen).toEqual(TURN);
    const live = seen.find((message) => message.kind === "tool_result" && message.toolCallId === "call-sensitive");
    expect(JSON.stringify(live)).toContain(PRIVATE_VALUES[0]);
  });

  it("logs nothing on the redaction path", async () => {
    const { logs } = await runTurn(TURN);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("reconstructs the history after a restart with the marker, none of the values and every call paired with a result", async () => {
    const { threadId } = await runTurn(TURN);
    const history = await runInTenant(getTenantZeroId(), () =>
      reconstructConversationHistory(runtime, { threadId, triggeredBy: "user", parentRunId: null }, noopCompaction),
    );
    if (!history) throw new Error("expected a reconstructed history");
    const messages = history.entries.map((entry) => entry.message);
    const calls = messages.filter((message) => message.kind === "tool_use").map((message) => message.toolCallId);
    const results = messages.filter((message) => message.kind === "tool_result");
    expect(results.map((message) => message.toolCallId)).toEqual(calls);
    expect(calls).toEqual(["call-sensitive", "call-open", "call-patch"]);
    expect(results[0]?.result).toEqual({
      content: [{ type: "text", text: "[redacted: sensitive]" }],
      details: { error: false },
    });
    expect(results[1]?.result).toEqual({ content: [{ type: "text", text: OPEN_ITEM }], details: { error: false } });
    const reconstructed = JSON.stringify(history.entries);
    for (const value of PRIVATE_VALUES) expect(reconstructed).not.toContain(value);
  });
});
