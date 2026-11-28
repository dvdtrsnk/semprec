import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { createAgentRun } from "../agentRunsStore.js";
import { insertAgentRunEvent, type AgentRunEventKind } from "../agentRunEventsStore.js";
import { withTransaction } from "../../db/pool.js";
import { reserveGatewayCall, settleTokenGatewayCall } from "../../aiGateway/aiGatewayCallsStore.js";
import {
  claimSempMessage,
  finishSempMessageTurn,
  retrySempReply,
  startSempMessageTurn,
} from "../../semp/sempMessagesStore.js";
import { buildSempReplySummary } from "../../semp/sempReplySummary.js";
import { createSempChatThread, sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import type { AgentRunErrorCode } from "../agentRunErrorCodes.js";
import type { EventSpec } from "../../semp/__tests__/sempReplyTestSupport.js";

/**
 * Chat-answer fixtures for the project run list, played through the production writers the agents turn handler
 * uses.
 */

export const ANSWER_CLOCK_START = Date.parse("2026-11-01T10:00:00.000Z");

export interface AnswerSetup {
  /** Superuser pool; only stamps event times (see `playQueuedAnswer`). */
  admin: Pool;
  runtime: Pool;
  tenant: string;
  userId: string;
}

export interface ChatSession {
  runId: string;
  threadId: string;
}

export interface PlayedAnswer {
  assistantMessageId: string;
  replyToMessageId: string | null;
  eventIds: string[];
}

/** An unfinished user-started `session` run with its thread (`threadId` reuses an existing one, e.g. a tick thread). */
export async function createChatSession(
  setup: AnswerSetup,
  projectItemId: string,
  options: { threadId?: string; task?: string } = {},
): Promise<ChatSession> {
  return runInTenant(setup.tenant, async () => {
    const threadId = options.threadId ?? (await withTransaction(setup.runtime, createSempChatThread));
    const run = await createAgentRun(setup.runtime, {
      projectItemId,
      triggeredBy: "user",
      unit: "session",
      task: options.task ?? "Chat",
      threadId,
      userId: setup.userId,
    });
    return { runId: run.id, threadId };
  });
}

/** Returns the ids of the user message and the queued assistant message. */
export async function askQuestion(
  setup: AnswerSetup,
  session: ChatSession,
  text: string,
): Promise<{ messageId: string; assistantMessageId: string }> {
  return runInTenant(setup.tenant, () =>
    withTransaction(setup.runtime, (client) =>
      sendSempMessage(client, { threadId: session.threadId, text, context: [], hasContext: false }),
    ),
  );
}

export interface AnswerPlay {
  /** Milliseconds after `ANSWER_CLOCK_START`. */
  startMs: number;
  /** The stored `duration_ms`. */
  durationMs: number;
  /** Default `done`; `running` leaves the turn unfinished. */
  end?: "done" | "error" | "running";
  errorCode?: AgentRunErrorCode;
  /** `atMs` is relative to `startMs`. */
  toolEvents?: EventSpec[];
  /** Defaults to `session`. */
  runId?: string;
}

/**
 * Event `at` is set by a raw `UPDATE` on the admin pool: the production writer stamps `now()`, and tests need a
 * controlled clock.
 */
export async function playQueuedAnswer(
  setup: AnswerSetup,
  session: ChatSession,
  assistantMessageId: string,
  replyToMessageId: string | null,
  play: AnswerPlay,
): Promise<PlayedAnswer> {
  const runId = play.runId ?? session.runId;
  const end = play.end ?? "done";
  const specs: { kind: AgentRunEventKind; payload: unknown; atMs: number }[] = [
    { kind: "turn_start", atMs: play.startMs, payload: { kind: "turn_start" } },
    ...(play.toolEvents ?? []).map((spec) => ({ ...spec, atMs: play.startMs + spec.atMs })),
  ];
  if (end === "done") {
    specs.push({
      kind: "message",
      atMs: play.startMs + play.durationMs - 1,
      payload: { kind: "message", role: "assistant", text: "reply", content: [] },
    });
  }
  if (end !== "running") {
    specs.push({
      kind: "turn_end",
      atMs: play.startMs + play.durationMs,
      payload: { kind: "turn_end" },
    });
  }
  return runInTenant(setup.tenant, async () => {
    const claimed = await withTransaction(setup.runtime, (client) =>
      claimSempMessage(client, session.threadId, assistantMessageId),
    );
    if (!claimed) throw new Error("The fixture message could not be claimed");
    const eventIds: string[] = [];
    for (const spec of specs) {
      const stored = await insertAgentRunEvent(setup.runtime, runId, spec.kind, spec.payload);
      await setup.admin.query("UPDATE agent_run_events SET at = $2 WHERE id = $1", [
        stored.id,
        new Date(ANSWER_CLOCK_START + spec.atMs),
      ]);
      eventIds.push(stored.id);
    }
    const first = eventIds[0];
    const last = eventIds.at(-1);
    if (first === undefined || last === undefined) throw new Error("A fixture turn stores events");
    await withTransaction(setup.runtime, async (client) => {
      await startSempMessageTurn(client, assistantMessageId, runId, first);
      if (end === "running") return;
      const summary = await buildSempReplySummary(client, {
        messageId: assistantMessageId,
        agentRunId: runId,
        firstEventId: first,
        lastEventId: end === "done" ? last : null,
      });
      const stored = await finishSempMessageTurn(
        client,
        assistantMessageId,
        end === "done"
          ? { status: "done", text: "reply", lastEventId: last, summary }
          : { status: "error", errorCode: play.errorCode ?? "modelError", summary },
      );
      if (!stored) throw new Error("The fixture message was not running");
    });
    return { assistantMessageId, replyToMessageId, eventIds };
  });
}

export async function playAnswer(
  setup: AnswerSetup,
  session: ChatSession,
  text: string,
  play: AnswerPlay,
): Promise<PlayedAnswer & { userMessageId: string }> {
  const sent = await askQuestion(setup, session, text);
  const played = await playQueuedAnswer(setup, session, sent.assistantMessageId, sent.messageId, play);
  return { ...played, userMessageId: sent.messageId };
}

/** As the retry route does; returns the new assistant message id. */
export async function retryAnswer(setup: AnswerSetup, session: ChatSession, messageId: string): Promise<string> {
  return runInTenant(setup.tenant, async () => {
    const retried = await withTransaction(setup.runtime, (client) =>
      retrySempReply(client, session.threadId, messageId),
    );
    return retried.messageId;
  });
}

export async function settleAnswerCall(
  setup: AnswerSetup,
  runId: string,
  messageId: string | null,
  costUsd: number,
): Promise<void> {
  await runInTenant(setup.tenant, async () => {
    const reserved = await reserveGatewayCall(setup.runtime, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: costUsd,
      agentRunId: runId,
      sempMessageId: messageId,
    });
    await settleTokenGatewayCall(setup.runtime, reserved.id, { inputTokens: 10, outputTokens: 5, costUsd });
  });
}
