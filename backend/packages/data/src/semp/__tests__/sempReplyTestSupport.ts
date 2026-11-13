import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent, type AgentRunEventKind } from "../../agentRuns/agentRunEventsStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { claimSempMessage, finishSempMessageTurn, startSempMessageTurn } from "../sempMessagesStore.js";
import { buildSempReplySummary, type SempReplySummary } from "../sempReplySummary.js";

/**
 * Shared fixtures of the integration tests of the Semp reply summaries (issues #1860 and #1885): a turn is played
 * with the production writers (`sendSempMessage`, `startSempMessageTurn`, `insertAgentRunEvent`) and finished with
 * `buildSempReplySummary` and `finishSempMessageTurn`, exactly as the turn handler of `semprec-agents` does.
 */

/** The start of the fixed clock the played events are stamped with. */
export const CLOCK_START = Date.parse("2026-11-01T10:00:00.000Z");

export interface EventSpec {
  kind: AgentRunEventKind;
  payload: unknown;
  /** Milliseconds after `CLOCK_START` the event is stamped with. */
  atMs: number;
}

export interface PlayedTurn {
  threadId: string;
  messageId: string;
  runId: string;
  eventIds: string[];
}

export interface TurnSetup {
  admin: Pool;
  runtime: Pool;
  tenant: string;
}

/**
 * Sends a message, claims it, stores `events` on a run and starts the turn on the first of them. A stored
 * event gets its `at` from the spec by a raw `UPDATE` on the admin pool: the production writer stamps `now()`,
 * and the durations a test asserts need a clock it controls.
 */
export async function playTurn(
  setup: TurnSetup,
  events: EventSpec[],
  reuse: { threadId?: string; runId?: string } = {},
): Promise<PlayedTurn> {
  const { admin, runtime, tenant } = setup;
  return runInTenant(tenant, async () => {
    const sent = await withTransaction(runtime, async (client) => {
      const message = await sendSempMessage(client, {
        ...(reuse.threadId ? { threadId: reuse.threadId } : {}),
        text: "hello",
        context: [],
        hasContext: false,
      });
      if (!(await claimSempMessage(client, message.threadId, message.assistantMessageId)))
        throw new Error("The fixture message could not be claimed");
      return message;
    });
    const runId =
      reuse.runId ??
      (await createAgentRun(runtime, { triggeredBy: "user", unit: "session", task: "turn", threadId: sent.threadId }))
        .id;
    const eventIds: string[] = [];
    for (const spec of events) {
      const stored = await insertAgentRunEvent(runtime, runId, spec.kind, spec.payload);
      await admin.query("UPDATE agent_run_events SET at = $2 WHERE id = $1", [
        stored.id,
        new Date(CLOCK_START + spec.atMs),
      ]);
      eventIds.push(stored.id);
    }
    const first = eventIds[0];
    if (first === undefined) throw new Error("A fixture turn needs at least one event");
    await withTransaction(runtime, (client) => startSempMessageTurn(client, sent.assistantMessageId, runId, first));
    return { threadId: sent.threadId, messageId: sent.assistantMessageId, runId, eventIds };
  });
}

/** Builds the summary of a played turn the way the turn handler does, then stores the final status with it. */
export async function finishPlayedTurn(
  setup: TurnSetup,
  turn: PlayedTurn,
  outcome: "done" | "error",
): Promise<{ summary: SempReplySummary; stored: boolean }> {
  const lastEventId = turn.eventIds.at(-1);
  if (lastEventId === undefined) throw new Error("A played turn has events");
  return runInTenant(setup.tenant, () =>
    withTransaction(setup.runtime, async (client) => {
      const summary = await buildSempReplySummary(client, {
        messageId: turn.messageId,
        agentRunId: turn.runId,
        firstEventId: turn.eventIds[0] ?? lastEventId,
        lastEventId: outcome === "done" ? lastEventId : null,
      });
      const stored = await finishSempMessageTurn(
        client,
        turn.messageId,
        outcome === "done" ? { status: "done", text: "reply", lastEventId, summary } : { status: "error", summary },
      );
      return { summary, stored };
    }),
  );
}

export interface StoredReply {
  status: string;
  steps: unknown;
  duration_ms: number | null;
  tokens: unknown;
  changes: unknown;
  event_to_id: string | null;
}

/** The summary columns of a message, read on the admin pool. */
export async function readStoredReply(admin: Pool, messageId: string): Promise<StoredReply> {
  const { rows } = await admin.query<StoredReply>(
    "SELECT status, steps, duration_ms, tokens, changes, event_to_id FROM semp_messages WHERE id = $1",
    [messageId],
  );
  const row = rows[0];
  if (!row) throw new Error("The fixture message is missing");
  return row;
}

/** Creates an item of a seeded system database by its module id, written by the system as an ingest path would. */
export async function createFixtureItem(
  setup: TurnSetup,
  moduleId: string,
  properties: Record<string, unknown>,
): Promise<{ id: string; databaseId: string }> {
  return runInTenant(setup.tenant, () =>
    withTransaction(setup.runtime, async (client) => {
      const database = await getDatabaseByModuleId(client, moduleId);
      if (!database) throw new Error(`Missing database ${moduleId}`);
      const item = await createItemWithClient(
        client,
        { databaseId: database.id, properties },
        { writer: { writerKind: "system" } },
      );
      return { id: item.id, databaseId: database.id };
    }),
  );
}

interface ToolCallSpec {
  toolCallId: string;
  name: string;
  operation: string;
  targetItemId?: string;
  targetDatabaseId?: string;
  args?: unknown;
}

export function toolUseEvent(call: ToolCallSpec, atMs: number): EventSpec {
  const { toolCallId, name, operation, targetItemId, targetDatabaseId, args } = call;
  return {
    kind: "tool_use",
    atMs,
    payload: {
      kind: "tool_use",
      toolCallId,
      name,
      arguments: args ?? {},
      operation,
      ...(targetItemId ? { targetItemId } : {}),
      ...(targetDatabaseId ? { targetDatabaseId } : {}),
    },
  };
}

export function toolResultEvent(
  call: ToolCallSpec,
  atMs: number,
  outcome: { text?: string; details?: Record<string, unknown>; isError?: boolean } = {},
): EventSpec {
  const { toolCallId, name, operation, targetItemId, targetDatabaseId } = call;
  return {
    kind: "tool_result",
    atMs,
    payload: {
      kind: "tool_result",
      toolCallId,
      name,
      operation,
      ...(targetItemId ? { targetItemId } : {}),
      ...(targetDatabaseId ? { targetDatabaseId } : {}),
      result: {
        content: [{ type: "text", text: outcome.text ?? "{}" }],
        details: outcome.details ?? { error: false },
      },
      isError: outcome.isError ?? false,
    },
  };
}

export const userMessageEvent = (atMs = 0): EventSpec => ({
  kind: "user_message",
  atMs,
  payload: { kind: "user_message", text: "hello", context: [] },
});
export const turnStartEvent = (atMs: number): EventSpec => ({
  kind: "turn_start",
  atMs,
  payload: { kind: "turn_start" },
});
export const turnEndEvent = (atMs: number): EventSpec => ({ kind: "turn_end", atMs, payload: { kind: "turn_end" } });
export const assistantEvent = (text: string, atMs: number): EventSpec => ({
  kind: "message",
  atMs,
  payload: { kind: "message", role: "assistant", text, content: [] },
});
