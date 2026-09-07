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
  /** #117's live push hook subscribes here; this part wires no subscriber. */
  onEvent?: (message: AgentMessage) => void;
}

function extractResultSnapshot(lastMessage: AgentMessage | null): string | null {
  if (!lastMessage) return null;
  const { text } = lastMessage as { text?: unknown };
  return typeof text === "string" ? text : JSON.stringify(lastMessage);
}

/**
 * Runs one agent session end to end, mapping pi-agent-core's lifecycle onto `agent_runs`
 * (`agent_start`/`agent_end`) and the turn-level `agent_run_events` log (everything between).
 * `message_update` streaming deltas are read off the sequence but never persisted.
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

  const session = input.createAgentSession({
    task: input.task,
    systemPromptOverride: input.systemPromptOverride,
  });

  let lastMessage: AgentMessage | null = null;

  try {
    for await (const message of session.messages()) {
      input.onEvent?.(message);

      if (message.kind === "message_update") continue;

      if (PERSISTED_EVENT_KINDS.has(message.kind)) {
        await insertAgentRunEvent(client, run.id, message.kind as AgentRunEventKind, message);
      }

      if (message.kind === "message") lastMessage = message;
    }

    await finishAgentRun(client, run.id, "done", extractResultSnapshot(lastMessage));
  } catch (err) {
    try {
      await finishAgentRun(client, run.id, "error", err instanceof Error ? err.message : String(err));
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
