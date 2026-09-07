import type { Pool, PoolClient } from "pg";
import {
  createAgentRun,
  finishAgentRun,
  getAgentRun,
  insertAgentRunEvent,
  type AgentRunEventKind,
  type AgentRunRow,
  type AgentRunUnit,
  type TriggeredBy,
} from "@semprec/data";
import { publishRealtimeMessage } from "@semprec/realtime";
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

function extractResultSnapshot(lastMessage: AgentMessage | null): string | null {
  if (!lastMessage) return null;
  const { text } = lastMessage as { text?: unknown };
  return typeof text === "string" ? text : JSON.stringify(lastMessage);
}

/** Best-effort: a failed NOTIFY must not fail the run it's reporting on. */
async function pushLiveEvent(client: Pool | PoolClient, agentRunId: string, kind: string, payload: unknown): Promise<void> {
  try {
    await publishRealtimeMessage(client, { type: "agent_run_event", agentRunId, kind, payload });
  } catch (err) {
    console.error("Failed to publish agent_run_event realtime message", err);
  }
}

function pushRunStatus(client: Pool | PoolClient, agentRunId: string, status: "running" | "done" | "error"): Promise<void> {
  return pushLiveEvent(client, agentRunId, "run_status", { kind: "run_status", status });
}

/**
 * Runs one agent session end to end, mapping pi-agent-core's lifecycle onto `agent_runs`
 * (`agent_start`/`agent_end`) and the turn-level `agent_run_events` log (everything between).
 * Every message — including `message_update` streaming deltas — is pushed live over the
 * realtime channel as `agent_run_event`, but deltas are never persisted to Postgres.
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

  let lastMessage: AgentMessage | null = null;

  try {
    for await (const message of session.messages()) {
      input.onEvent?.(message);

      // A watcher missing a live update for a persisted kind still catches up from
      // `agent_run_events`; a missed `message_update` delta is lost, same as a dropped WS frame.
      await pushLiveEvent(client, run.id, message.kind, message);

      if (message.kind === "message_update") continue;

      if (PERSISTED_EVENT_KINDS.has(message.kind)) {
        await insertAgentRunEvent(client, run.id, message.kind as AgentRunEventKind, message);
      }

      if (message.kind === "message") lastMessage = message;
    }

    await finishAgentRun(client, run.id, "done", extractResultSnapshot(lastMessage));
    await pushRunStatus(client, run.id, "done");
  } catch (err) {
    try {
      await finishAgentRun(client, run.id, "error", err instanceof Error ? err.message : String(err));
      await pushRunStatus(client, run.id, "error");
    } catch {
      // Best-effort: the run is left 'running' if this secondary write fails, but the
      // original session error below is what the caller needs to see, not this one.
    }
    throw err;
  }

  const finished = await getAgentRun(client, run.id);
  if (!finished) throw new Error(`agent run ${run.id} vanished after finishing`);
  return finished;
}
