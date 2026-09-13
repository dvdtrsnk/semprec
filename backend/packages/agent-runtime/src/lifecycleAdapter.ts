import type { Pool, PoolClient } from "pg";
import {
  createAgentRun,
  finishAgentRun,
  finishAgentRunWithErrorNotification,
  getAgentRun,
  insertAndNotifyAgentRunEvent,
  type AgentRunEventKind,
  type AgentRunRow,
  type AgentRunUnit,
  type TriggeredBy,
} from "@semprec/data";
import { publishAgentRunDelta } from "@semprec/realtime";
import type { AgentMessage, CreateAgentSession } from "./types.js";

const PERSISTED_EVENT_KINDS: ReadonlySet<string> = new Set<AgentRunEventKind>([
  "turn_start",
  "message",
  "tool_use",
  "tool_result",
  "turn_end",
  "run_status",
]);

export interface RunAgentSessionInput {
  /** Seam for the real `pi-agent-core` `createAgentSession` (or a fake, in tests). */
  createAgentSession: CreateAgentSession;
  task: string;
  triggeredBy: TriggeredBy;
  /** Defaults to 'invocation'; #118 passes 'session' for managed conversations. */
  unit?: AgentRunUnit;
  projectItemId?: string | null;
  parentRunId?: string | null;
  heartbeatId?: string | null;
  systemPromptOverride?: (defaultPrompt: string) => string;
  /** Extra observer for every message, persisted or not (e.g. #118's session bookkeeping). */
  onEvent?: (message: AgentMessage) => void;
}

export function extractResultSnapshot(lastMessage: AgentMessage | null): string | null {
  if (!lastMessage) return null;
  const { text } = lastMessage as { text?: unknown };
  return typeof text === "string" ? text : JSON.stringify(lastMessage);
}

/**
 * Appends a recovery event first, then delegates its post-commit thin-reference announcement to
 * the data layer that owns both the row and the after-commit hook.
 */
async function recordPersistentEvent(
  client: Pool | PoolClient,
  agentRunId: string,
  kind: AgentRunEventKind,
  payload: unknown,
): Promise<void> {
  await insertAndNotifyAgentRunEvent(client, agentRunId, kind, payload);
}

/** Best-effort: a lost typing delta affects animation only; the completed message is durable. */
async function pushLiveDelta(client: Pool | PoolClient, agentRunId: string, delta: AgentMessage): Promise<void> {
  try {
    await publishAgentRunDelta(client, agentRunId, delta);
  } catch (err) {
    console.error("Failed to publish agent_run_delta realtime message", err);
  }
}

export function pushRunStatus(
  client: Pool | PoolClient,
  agentRunId: string,
  status: "running" | "done" | "error",
): Promise<void> {
  return recordPersistentEvent(client, agentRunId, "run_status", { kind: "run_status", status });
}

/**
 * Drives one turn's message stream to completion against an already-open `agent_runs` row:
 * pushes `message_update` deltas through the ephemeral stream (never persisted) and appends the
 * persisted-kind ones to `agent_run_events` in arrival order before announcing thin references.
 * Returns the turn's last
 * `message`-kind event, or null if it never produced one.
 *
 * Shared by `runAgentSession` (one turn, closing the run immediately after) and the
 * delegation registry (#229: many turns reusing one long-lived `agent_runs` row that only
 * closes on TTL expiry) — both need identical event bookkeeping, just different lifecycle
 * bookends around it.
 */
export async function runAgentTurn(
  client: Pool | PoolClient,
  agentRunId: string,
  messages: AsyncIterable<AgentMessage>,
  onEvent?: (message: AgentMessage) => void,
): Promise<AgentMessage | null> {
  let lastMessage: AgentMessage | null = null;

  for await (const message of messages) {
    onEvent?.(message);

    // A watcher missing a live update for a persisted kind catches up from `agent_run_events`;
    // a missed message_update is deliberately lost, same as a dropped WS typing frame.
    if (message.kind === "message_update") {
      await pushLiveDelta(client, agentRunId, message);
      continue;
    }

    if (PERSISTED_EVENT_KINDS.has(message.kind)) {
      await recordPersistentEvent(client, agentRunId, message.kind, message);
    }

    if (message.kind === "message") lastMessage = message;
  }

  return lastMessage;
}

/**
 * Runs one agent session end to end, mapping pi-agent-core's lifecycle onto `agent_runs`
 * (`agent_start`/`agent_end`) and the turn-level `agent_run_events` log (everything between).
 * Durable events are announced as thin post-commit references; `message_update` typing deltas
 * use the separate ephemeral stream and are never persisted to Postgres.
 */
export async function runAgentSession(client: Pool | PoolClient, input: RunAgentSessionInput): Promise<AgentRunRow> {
  const run = await createAgentRun(client, {
    projectItemId: input.projectItemId,
    parentRunId: input.parentRunId,
    heartbeatId: input.heartbeatId,
    triggeredBy: input.triggeredBy,
    unit: input.unit,
    task: input.task,
  });
  await pushRunStatus(client, run.id, "running");

  const session = input.createAgentSession({
    task: input.task,
    systemPromptOverride: input.systemPromptOverride,
  });

  try {
    const lastMessage = await runAgentTurn(client, run.id, session.messages(), input.onEvent);
    await finishAgentRun(client, run.id, "done", extractResultSnapshot(lastMessage));
    await pushRunStatus(client, run.id, "done");
  } catch (err) {
    try {
      // Issue #149: same client as the status write, so a caller-supplied transaction rolls
      // both back together; a bare pool gives the same best-effort guarantee this catch block
      // already had before the notification existed.
      await finishAgentRunWithErrorNotification(client, run.id, err instanceof Error ? err.message : String(err));
      await pushRunStatus(client, run.id, "error");
    } catch (finishErr) {
      // Preserve the session failure for the caller, but do not erase evidence that the
      // secondary lifecycle close failed and left the row running.
      console.error("Failed to record failed agent run lifecycle", finishErr);
    }
    throw err;
  }

  const finished = await getAgentRun(client, run.id);
  if (!finished) throw new Error(`agent run ${run.id} vanished after finishing`);
  return finished;
}
