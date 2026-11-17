import type { PoolClient } from "pg";
import { sumSettledSempMessageTokens } from "../aiGateway/aiGatewayCallsStore.js";
import { listSempTurnEvents } from "../agentRuns/agentRunEventsStore.js";
import { projectSempReplyChanges, type SempReplyChange } from "./sempReplyChanges.js";
import { projectSempReplySteps, sempTurnDurationMs, type SempReplyStep } from "./sempReplySteps.js";
import { loadSempReplyTargets } from "./sempReplyTargets.js";
import { pairSempToolCalls } from "./sempReplyToolCalls.js";

/** What is stored on the assistant message when its turn ends. */
export interface SempReplySummary {
  steps: SempReplyStep[];
  /** The time of the whole turn, not the sum of its steps; `null` when its events hold no `turn_start`. */
  durationMs: number | null;
  tokens: { input: number; output: number };
  /** The items the reply changed; `[]` when it changed nothing. */
  changes: SempReplyChange[];
}

/**
 * Builds the summary of the turn that produced `messageId` from its run events between `firstEventId` and
 * `lastEventId` (`null` for an errored turn) and the gateway calls attributed to it. Reads with `client`, so a
 * caller storing the final status passes its transaction's client.
 */
export async function buildSempReplySummary(
  client: PoolClient,
  input: { messageId: string; agentRunId: string; firstEventId: string; lastEventId: string | null },
): Promise<SempReplySummary> {
  const events = await listSempTurnEvents(client, input.agentRunId, input.firstEventId, input.lastEventId);
  const targets = await loadSempReplyTargets(client, pairSempToolCalls(events));
  return {
    steps: projectSempReplySteps({ events, targets }),
    changes: projectSempReplyChanges({ events, targets }),
    durationMs: sempTurnDurationMs(events),
    tokens: await sumSettledSempMessageTokens(client, input.messageId),
  };
}
