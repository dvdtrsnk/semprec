import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
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
 * Fixtures of the chat answers of the project run list (issue gh-1932): a `session` run that the user started with
 * the thread it answers in, and answers played through their turns with the production writers the turn handler of
 * `semprec-agents` uses (`sendSempMessage`, `claimSempMessage`, `startSempMessageTurn`, `insertAgentRunEvent`,
 * `buildSempReplySummary`, `finishSempMessageTurn`) and retried with `retrySempReply`.
 */

/** The start of the fixed clock the played events are stamped with. */
export const ANSWER_CLOCK_START = Date.parse("2026-11-01T10:00:00.000Z");

export interface AnswerSetup {
  /** The superuser pool: it only stamps event times (see `playQueuedAnswer`). */
  admin: Pool;
  /** The runtime-role pool every production write goes through. */
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
  /** The message it answers. */
  replyToMessageId: string | null;
  eventIds: string[];
}

/**
 * A chat run of the tenant's user in `projectItemId`: an unfinished `session` run started by the user, with its
 * Semp thread (`threadId` when the thread already exists, such as a tick thread, otherwise a new chat thread).
 */
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

/** Sends `text` to the thread of `session` as a user message; the ids of the message and the queued assistant message. */
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
  /** Milliseconds after `ANSWER_CLOCK_START` the turn starts. */
  startMs: number;
  /** How long the turn lasts; the stored `duration_ms` of the message. */
  durationMs: number;
  /** How the turn ends: `done` (the default), `error` (with `errorCode`) or `running` (not finished). */
  end?: "done" | "error" | "running";
  errorCode?: AgentRunErrorCode;
  /** Events between the start and the answer; their `atMs` is relative to `startMs`. */
  toolEvents?: EventSpec[];
  /** The run the turn is stored on; `session` when omitted. */
  runId?: string;
}

/**
 * Claims the queued assistant message, stores the events of its turn on a run, starts the turn on the first of them
 * and, unless it is `running`, finishes it with the summary the turn handler builds. A stored event gets its `at`
 * from the spec by a raw `UPDATE` on the admin pool: the production writer stamps `now()`, and the starts and
 * durations a test asserts need a clock it controls.
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

/** One question and its answer, played through its turn: `askQuestion` then `playQueuedAnswer`. */
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

/** Queues the next attempt at the failed reply `messageId` as the retry route does; the id of the new assistant message. */
export async function retryAnswer(setup: AnswerSetup, session: ChatSession, messageId: string): Promise<string> {
  return runInTenant(setup.tenant, async () => {
    const retried = await withTransaction(setup.runtime, (client) =>
      retrySempReply(client, session.threadId, messageId),
    );
    return retried.messageId;
  });
}

/** One settled token call attributed to the message `messageId` of the run `runId`, as the gateway attributes a model call. */
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
