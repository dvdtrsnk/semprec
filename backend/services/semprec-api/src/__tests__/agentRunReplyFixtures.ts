import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  buildSempReplySummary,
  claimSempMessage,
  createAgentRun,
  createPendingApprovalRequest,
  createSempChatThread,
  finishSempMessageTurn,
  insertAgentRunEvent,
  reserveGatewayCall,
  sendSempMessage,
  settleTokenGatewayCall,
  startSempMessageTurn,
  withTransaction,
  type AgentRunEventKind,
} from "@semprec/data";

/**
 * Reply-scoped read fixtures: a chat run (`unit = session`) with several replies, each played with the production
 * writers the `semprec-agents` turn handler uses.
 */

export const CLOCK_START = Date.parse("2026-11-01T10:00:00.000Z");

export interface ReplySetup {
  /** Only stamps event times. */
  admin: Pool;
  pool: Pool;
  tenant: string;
  userId: string;
}

export interface ChatRun {
  runId: string;
  threadId: string;
}

export interface ToolCallSpec {
  toolCallId: string;
  fails?: boolean;
}

export interface PlayedReply {
  /** `null` for a reply that answers none. */
  userMessageId: string | null;
  assistantMessageId: string;
  runId: string;
  eventIds: string[];
  firstEventId: string;
  lastEventId: string;
}

export async function createChatRun(setup: ReplySetup): Promise<ChatRun> {
  return runInTenant(setup.tenant, async () => {
    const threadId = await withTransaction(setup.pool, createSempChatThread);
    const run = await createAgentRun(setup.pool, {
      userId: setup.userId,
      triggeredBy: "user",
      unit: "session",
      task: "Chat",
      threadId,
    });
    return { runId: run.id, threadId };
  });
}

/** `error` stores no last event, as for a failed turn; `running` is not finished. */
export type ReplyEnd = "done" | "error" | "running";

function eventSpecs(input: { startMs: number; toolCalls: ToolCallSpec[]; answer: string }) {
  const events: { kind: AgentRunEventKind; payload: unknown; atMs: number }[] = [
    { kind: "turn_start", payload: { kind: "turn_start" }, atMs: input.startMs },
  ];
  let at = input.startMs;
  for (const call of input.toolCalls) {
    at += 100;
    events.push({
      kind: "tool_use",
      atMs: at,
      payload: {
        kind: "tool_use",
        toolCallId: call.toolCallId,
        name: "database_list",
        arguments: {},
        operation: "database.list",
      },
    });
    at += 100;
    events.push({
      kind: "tool_result",
      atMs: at,
      payload: {
        kind: "tool_result",
        toolCallId: call.toolCallId,
        name: "database_list",
        operation: "database.list",
        result: { content: [{ type: "text", text: "{}" }], details: { error: call.fails === true } },
        isError: call.fails === true,
      },
    });
  }
  at += 100;
  events.push({
    kind: "message",
    atMs: at,
    payload: { kind: "message", role: "assistant", text: input.answer, content: [] },
  });
  at += 100;
  events.push({ kind: "turn_end", payload: { kind: "turn_end" }, atMs: at });
  return events;
}

/**
 * Event times are stamped by a raw `UPDATE` on the admin pool because the production writer stamps `now()` and
 * the asserted durations need a clock the test controls.
 */
async function playTurnOf(
  setup: ReplySetup,
  run: ChatRun,
  assistantMessageId: string,
  input: { startMs: number; toolCalls: ToolCallSpec[]; end: ReplyEnd },
): Promise<{ runId: string; eventIds: string[] }> {
  const eventIds: string[] = [];
  for (const spec of eventSpecs({ startMs: input.startMs, toolCalls: input.toolCalls, answer: "reply" })) {
    const stored = await insertAgentRunEvent(setup.pool, run.runId, spec.kind, spec.payload);
    await setup.admin.query("UPDATE agent_run_events SET at = $2 WHERE id = $1", [
      stored.id,
      new Date(CLOCK_START + spec.atMs),
    ]);
    eventIds.push(stored.id);
  }
  const first = eventIds[0];
  const last = eventIds.at(-1);
  if (first === undefined || last === undefined) throw new Error("A reply fixture stores events");
  await withTransaction(setup.pool, async (client) => {
    await startSempMessageTurn(client, assistantMessageId, run.runId, first);
    if (input.end === "running") return;
    const summary = await buildSempReplySummary(client, {
      messageId: assistantMessageId,
      agentRunId: run.runId,
      firstEventId: first,
      lastEventId: input.end === "done" ? last : null,
    });
    const stored = await finishSempMessageTurn(
      client,
      assistantMessageId,
      input.end === "done"
        ? { status: "done", text: "reply", lastEventId: last, summary }
        : { status: "error", summary },
    );
    if (!stored) throw new Error("The fixture reply was not running");
  });
  return { runId: run.runId, eventIds };
}

/** Every call of `toolCalls` is a `tool_use` event and its result. */
export async function playReply(
  setup: ReplySetup,
  run: ChatRun,
  input: { userText: string; startMs: number; toolCalls?: ToolCallSpec[]; end?: ReplyEnd },
): Promise<PlayedReply> {
  return runInTenant(setup.tenant, async () => {
    const sent = await withTransaction(setup.pool, (client) =>
      sendSempMessage(client, { threadId: run.threadId, text: input.userText, context: [], hasContext: false }),
    );
    return playQueuedAssistant(setup, run, sent.assistantMessageId, { ...input, userMessageId: sent.messageId });
  });
}

/** As `playReply` does, for an already queued message; `userMessageId` is `null` for none. */
export async function playQueuedAssistant(
  setup: ReplySetup,
  run: ChatRun,
  assistantMessageId: string,
  input: { userMessageId: string | null; startMs: number; toolCalls?: ToolCallSpec[]; end?: ReplyEnd },
): Promise<PlayedReply> {
  return runInTenant(setup.tenant, async () => {
    const claimed = await withTransaction(setup.pool, (client) =>
      claimSempMessage(client, run.threadId, assistantMessageId),
    );
    if (!claimed) throw new Error("The fixture message could not be claimed");
    const played = await playTurnOf(setup, run, assistantMessageId, {
      startMs: input.startMs,
      toolCalls: input.toolCalls ?? [],
      end: input.end ?? "done",
    });
    return playedReply(input.userMessageId, assistantMessageId, played);
  });
}

function playedReply(
  userMessageId: string | null,
  assistantMessageId: string,
  played: { runId: string; eventIds: string[] },
): PlayedReply {
  const first = played.eventIds[0];
  const last = played.eventIds.at(-1);
  if (first === undefined || last === undefined) throw new Error("A reply fixture stores events");
  return {
    userMessageId,
    assistantMessageId,
    runId: played.runId,
    eventIds: played.eventIds,
    firstEventId: first,
    lastEventId: last,
  };
}

/**
 * Inserted by SQL because no production write makes a reply that answers no message; shaped as
 * `insertSempUserTurn` gives the first assistant message. Its `attempt` is one above the latest attempt at the
 * same reply, as the retry numbers it, and its `created_at` is later than every earlier message.
 */
export async function queueAssistantMessage(setup: ReplySetup, run: ChatRun, replyTo: string | null): Promise<string> {
  return runInTenant(setup.tenant, () =>
    withTransaction(setup.pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO semp_messages (thread_id, role, reply_to_message_id, status, attempt, created_at)
         VALUES ($1, 'assistant', $2, 'queued',
           (SELECT COALESCE(max(attempt), 0) + 1 FROM semp_messages WHERE role = 'assistant' AND reply_to_message_id = $2),
           clock_timestamp()) RETURNING id`,
        [run.threadId, replyTo],
      );
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error("The fixture message was not inserted");
      return id;
    }),
  );
}

export function createApproval(setup: ReplySetup, runId: string, toolCallId: string | null): Promise<string> {
  return runInTenant(setup.tenant, async () => {
    const request = await createPendingApprovalRequest(setup.pool, {
      agentRunId: runId,
      toolName: "probe",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      toolCallId,
    });
    return request.id;
  });
}

/** Attributed to `messageId` the way the gateway attributes a model call. */
export function settleCall(
  setup: ReplySetup,
  runId: string,
  messageId: string | null,
  usage: { inputTokens: number; outputTokens: number; costUsd: number },
): Promise<void> {
  return runInTenant(setup.tenant, async () => {
    const reserved = await reserveGatewayCall(setup.pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: usage.costUsd,
      agentRunId: runId,
      sempMessageId: messageId,
    });
    await settleTokenGatewayCall(setup.pool, reserved.id, usage);
  });
}
