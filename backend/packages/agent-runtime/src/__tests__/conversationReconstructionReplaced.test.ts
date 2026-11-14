import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  claimSempMessage,
  createAgentRun,
  finishSempMessageTurn,
  insertAgentRunEvent,
  regenerateSempReply,
  sendSempMessage,
  startSempMessageTurn,
  withTransaction,
  type AgentRunEventKind,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { reconstructBoundedThreadHistory, reconstructConversationHistory } from "../conversationReconstruction.js";
import type { CompactionAdapter } from "../compaction.js";
import type { AgentMessage, ConversationEntry } from "../types.js";

/**
 * What a wake rebuilds from the stored history of a thread once a reply was regenerated (issue gh-1930): the turn of
 * the replaced reply is not in it, whole, and nothing else is missing. Turns are played with the production writers of
 * the turn handler of `semprec-agents`, on the runtime role pool.
 */

let admin: Pool;
let runtime: Pool;
let tenant: string;

/** Never triggers compaction: the generic reconstruction then returns the walk as it is. */
const noopCompaction: CompactionAdapter = {
  estimateContextTokens: (messages) => messages.length,
  shouldCompact: () => false,
  prepareCompaction: (entries) => entries,
  compact: (prepared) => prepared as ConversationEntry[],
  contextWindow: 1_000_000,
  settings: {},
};

interface Played {
  threadId: string;
  runId: string;
  assistantMessageId: string;
  eventIds: string[];
}

interface TurnEvent {
  kind: AgentRunEventKind;
  payload: AgentMessage;
}

const userMessage = (text: string): TurnEvent => ({
  kind: "user_message",
  payload: { kind: "user_message", text, context: [] },
});
const answer = (text: string): TurnEvent => ({
  kind: "message",
  payload: { kind: "message", role: "assistant", text },
});
const toolUse = (toolCallId: string): TurnEvent => ({
  kind: "tool_use",
  payload: { kind: "tool_use", toolCallId, name: "item_get", arguments: {} },
});
const toolResult = (toolCallId: string): TurnEvent => ({
  kind: "tool_result",
  payload: {
    kind: "tool_result",
    toolCallId,
    name: "item_get",
    result: { content: [{ type: "text", text: "{}" }], details: { error: false } },
    isError: false,
  },
});

/**
 * Sends a message into `reuse.threadId` (a new thread without it), plays its turn with `events` on `reuse.runId` (a new
 * run without it) and finishes it as `outcome`, the way the turn handler stores a turn.
 */
async function playTurn(
  events: TurnEvent[],
  outcome: "done" | "error",
  reuse: { threadId?: string; runId?: string } = {},
): Promise<Played> {
  return runInTenant(tenant, async () => {
    const sent = await withTransaction(runtime, async (client) => {
      const message = await sendSempMessage(client, {
        ...(reuse.threadId === undefined ? {} : { threadId: reuse.threadId }),
        text: "Question",
        context: [],
        hasContext: false,
      });
      expect(await claimSempMessage(client, message.threadId, message.assistantMessageId)).toBe(true);
      return message;
    });
    const runId =
      reuse.runId ??
      (await createAgentRun(runtime, { threadId: sent.threadId, triggeredBy: "user", unit: "session", task: "turn" }))
        .id;
    const eventIds: string[] = [];
    for (const event of events)
      eventIds.push((await insertAgentRunEvent(runtime, runId, event.kind, event.payload)).id);
    const first = eventIds[0];
    const last = eventIds.at(-1);
    if (first === undefined || last === undefined) throw new Error("A fixture turn needs events");
    await withTransaction(runtime, async (client) => {
      await startSempMessageTurn(client, sent.assistantMessageId, runId, first);
      const summary = { steps: [], durationMs: null, tokens: { input: 0, output: 0 }, changes: [] };
      expect(
        await finishSempMessageTurn(
          client,
          sent.assistantMessageId,
          outcome === "done"
            ? { status: "done", text: "reply", lastEventId: last, summary }
            : { status: "error", errorCode: "modelError", summary },
        ),
      ).toBe(true);
    });
    return { threadId: sent.threadId, runId, assistantMessageId: sent.assistantMessageId, eventIds };
  });
}

function regenerate(played: Played): Promise<{ messageId: string }> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, (client) => regenerateSempReply(client, played.threadId, played.assistantMessageId)),
  );
}

/** The `message` events of the turns a wake would replay, in order: what the model is shown of the answers. */
const answersOf = (entries: readonly ConversationEntry[] | undefined): string[] =>
  (entries ?? []).flatMap((entry) =>
    entry.message.kind === "message" && typeof entry.message.text === "string" ? [entry.message.text] : [],
  );

describe("the history a wake rebuilds after a regeneration", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    // A run needs the tenant's user as its actor.
    await createTenantZeroUser(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    tenant = getTenantZeroId();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it.each([
    ["the bounded reconstruction", (threadId: string) => reconstructBoundedThreadHistory(runtime, threadId)],
    [
      "the generic reconstruction",
      (threadId: string) =>
        reconstructConversationHistory(runtime, { threadId, triggeredBy: "user", parentRunId: null }, noopCompaction),
    ],
  ])(
    "leaves the whole turn of the replaced reply out, with its tool call and result, in %s",
    async (_name, rebuild) => {
      const kept = await playTurn(
        [userMessage("an earlier question"), toolUse("kept-1"), toolResult("kept-1"), answer("KEPT ANSWER")],
        "done",
      );
      const replaced = await playTurn(
        [userMessage("a question"), toolUse("gone-1"), toolResult("gone-1"), answer("REPLACED ANSWER")],
        "done",
        { threadId: kept.threadId, runId: kept.runId },
      );
      await regenerate(replaced);

      const history = await runInTenant(tenant, () => rebuild(kept.threadId));

      expect(answersOf(history?.entries)).toEqual(["KEPT ANSWER"]);
      const stored = JSON.stringify(history?.entries);
      expect(stored).not.toContain("gone-1");
      expect(stored).not.toContain("REPLACED ANSWER");
      expect(stored).toContain("kept-1");
      // The entries of the kept turn are the stored ones, in order.
      expect(history?.entries.map((entry) => entry.id)).toEqual(kept.eventIds);
    },
  );

  it("rebuilds nothing when the replaced reply was the whole conversation", async () => {
    const only = await playTurn([userMessage("a question"), answer("REPLACED ANSWER")], "done");
    await regenerate(only);

    expect(await runInTenant(tenant, () => reconstructBoundedThreadHistory(runtime, only.threadId))).toBeNull();
  });

  it("keeps the turn of a failed attempt that was retried, which no regeneration replaced", async () => {
    const failed = await playTurn(
      [userMessage("a question"), toolUse("failed-1"), toolResult("failed-1"), answer("PARTIAL ANSWER")],
      "error",
    );
    const answered = await playTurn([userMessage("a question"), answer("RETRIED ANSWER")], "done", {
      threadId: failed.threadId,
    });

    const history = await runInTenant(tenant, () => reconstructBoundedThreadHistory(runtime, failed.threadId));

    expect(answersOf(history?.entries)).toEqual(["PARTIAL ANSWER", "RETRIED ANSWER"]);
    expect(history?.entries.map((entry) => entry.id)).toEqual([...failed.eventIds, ...answered.eventIds]);
  });

  it("fails the reconstruction instead of handing the model half a tool call, when a replaced range cuts a call from its result", async () => {
    const kept = await playTurn([userMessage("an earlier question"), answer("KEPT ANSWER")], "done");
    const cut = await playTurn(
      [userMessage("a question"), toolUse("cut-1"), toolResult("cut-1"), answer("REPLACED ANSWER")],
      "done",
      { threadId: kept.threadId, runId: kept.runId },
    );
    await regenerate(cut);
    // Raw statement: the turn handler stores a range that holds a whole turn, so no production writer cuts a call from
    // its result; this stores the corrupt range the reconstruction has to refuse (the range ends at the `tool_use`).
    await admin.query("UPDATE semp_messages SET event_to_id = $2::bigint WHERE id = $1", [
      cut.assistantMessageId,
      cut.eventIds[1],
    ]);

    await expect(runInTenant(tenant, () => reconstructBoundedThreadHistory(runtime, kept.threadId))).rejects.toThrow(
      /tool_result entry/,
    );
    await expect(
      runInTenant(tenant, () =>
        reconstructConversationHistory(
          runtime,
          { threadId: kept.threadId, triggeredBy: "user", parentRunId: null },
          noopCompaction,
        ),
      ),
    ).rejects.toThrow(/tool_result entry/);
  });
});
